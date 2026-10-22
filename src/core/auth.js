'use strict';
/**
 * 账号与自动登录
 * - 离线账号：任意名字，按 OfflinePlayer 规则生成 UUID
 * - 微软正版：内嵌浏览器完成 OAuth 授权 → XBL → XSTS → Minecraft Services，
 *   把 refresh_token / access_token 保存在启动器数据目录，启动时静默刷新实现“自动登录”。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { paths } = require('./paths');
const { createLogger } = require('./log');
const { readJsonSync, exists } = require('./fsutil');

const log = createLogger('auth');
const bus = new EventEmitter();

// 官方启动器公开的 Xbox Live 客户端 ID（社区启动器通用）
const CLIENT_ID = '00000000402b5328';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const XSTS_ERRORS = {
    2148916233: '该微软账号还没有 Xbox 账号，请先到 xbox.com 创建（或登录一次 Xbox 应用）',
    2148916234: 'Xbox Live 要求补充信息（可能是地区/隐私设置），请到 xbox.com 完善资料',
    2148916235: '该微软账号所在地区不支持 Xbox Live',
    2148916236: '该账号需要进行成年人验证',
    2148916237: '该账号需要进行成年人验证',
    2148916238: '未成年账号需要先加入 Microsoft 家庭组才能登录',
};

let state = { accounts: [], activeId: '', autoLogin: true };
let loaded = false;

function accountsFile() {
    return path.join(paths.dataDir, 'accounts.json');
}

function load() {
    if (loaded) return state;
    loaded = true;
    try {
        if (exists(accountsFile())) {
            const raw = readJsonSync(accountsFile(), null);
            if (raw && Array.isArray(raw.accounts)) {
                state = {
                    accounts: raw.accounts.filter((a) => a && a.type && a.name),
                    activeId: raw.activeId || '',
                    autoLogin: raw.autoLogin !== false,
                };
                if (!state.accounts.some((a) => a.id === state.activeId)) state.activeId = state.accounts[0]?.id || '';
                if (!state.activeId && state.accounts.length) state.activeId = state.accounts[0].id;
            }
        }
    } catch (e) {
        log.warn('账号文件读取失败，将重新开始', e);
    }
    return state;
}

function save() {
    try {
        writeJsonSync(accountsFile(), state);
        try { fs.chmodSync(accountsFile(), 0o600); } catch { /* Windows 忽略 */ }
    } catch (e) {
        log.error('账号保存失败', e);
    }
    bus.emit('change', publicState());
}

function writeJsonSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function offlineUuid(name) {
    const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
    md5[6] = (md5[6] & 0x0f) | 0x30;
    md5[8] = (md5[8] & 0x3f) | 0x80;
    const hex = md5.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 对外暴露的账号信息（不含 token） */
function publicAccount(a) {
    if (!a) return null;
    return {
        id: a.id,
        type: a.type,
        name: a.name,
        uuid: a.uuid,
        skin: a.type === 'microsoft' ? 'https://mc-heads.net/avatar/' + encodeURIComponent(a.uuid) + '/64' : null,
        expiresAt: a.expiresAt || 0,
        expired: a.type === 'microsoft' ? Date.now() > (a.expiresAt || 0) : false,
        xuid: a.xuid || '',
        addedAt: a.addedAt || 0,
        note: a.note || '',
    };
}

function publicState() {
    load();
    return {
        accounts: state.accounts.map(publicAccount),
        activeId: state.activeId,
        active: publicAccount(state.accounts.find((a) => a.id === state.activeId)),
        autoLogin: state.autoLogin,
    };
}

function getActive() {
    load();
    return state.accounts.find((a) => a.id === state.activeId) || null;
}

function getById(id) {
    load();
    return state.accounts.find((a) => a.id === id) || null;
}

/* ------------------------------ 离线账号 ------------------------------ */

function addOffline(name) {
    load();
    const clean = String(name || '').trim().slice(0, 16);
    if (!clean) throw new Error('用户名不能为空');
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{1,16}$/.test(clean)) {
        throw new Error('用户名只能包含字母、数字、下划线或中文，长度 1~16');
    }
    if (state.accounts.some((a) => a.type === 'offline' && a.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error('已存在同名离线账号');
    }
    const account = {
        id: 'offline-' + crypto.randomUUID(),
        type: 'offline',
        name: clean,
        uuid: offlineUuid(clean),
        accessToken: '0',
        addedAt: Date.now(),
    };
    state.accounts.push(account);
    state.activeId = account.id;
    save();
    log.info('添加离线账号 ' + clean);
    return publicAccount(account);
}

/* ---------------------------- 微软正版登录 ---------------------------- */

function buildAuthUrl() {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        scope: SCOPE,
        redirect_uri: REDIRECT_URI,
        prompt: 'select_account',
        locale: 'zh_CN',
    });
    return `https://login.live.com/oauth20_authorize.srf?${params.toString()}`;
}

function isRedirect(url) {
    return String(url).toLowerCase().startsWith('https://login.live.com/oauth20_desktop.srf');
}

function extractCode(url) {
    try {
        const u = new URL(url);
        const err = u.searchParams.get('error');
        if (err) {
            const desc = u.searchParams.get('error_description') || err;
            throw new Error('微软登录被拒绝：' + desc);
        }
        return u.searchParams.get('code');
    } catch (e) {
        if (e instanceof TypeError) return null;
        throw e;
    }
}

async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}${json?.errorMessage ? ': ' + json.errorMessage : ''}`);
        err.status = res.status;
        err.body = json;
        err.text = text;
        throw err;
    }
    return json;
}

async function postForm(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!res.ok) {
        const err = new Error(json?.error_description || json?.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json;
}

/** 用授权码换取 token，再走 Xbox → Minecraft 拿到正版会话 */
async function loginWithCode(code) {
    let token;
    try {
        token = await postForm(TOKEN_URL, {
            client_id: CLIENT_ID,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            scope: SCOPE,
        });
    } catch (e) {
        if (/invalid_grant|invalid code|code.*(expired|not valid)/i.test(e.message)) {
            throw new Error('微软登录失败：授权码无效或已过期，请重新登录');
        }
        throw new Error('微软登录失败：' + e.message);
    }
    if (!token?.access_token) throw new Error('微软未返回访问令牌');
    return finishLogin(token);
}

/** 用 refresh_token 静默刷新（自动登录核心） */
async function refreshMicrosoft(account) {
    if (!account?.refreshToken) throw new Error('该账号没有保存的登录凭据，请重新登录');
    let token;
    try {
        token = await postForm(TOKEN_URL, {
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: account.refreshToken,
            redirect_uri: REDIRECT_URI,
            scope: SCOPE,
        });
    } catch (e) {
        if (String(e.message).includes('invalid_grant')) {
            const err = new Error('登录凭据已失效，请重新登录微软账号');
            err.code = 'REAUTH';
            throw err;
        }
        throw e;
    }
    if (!token?.access_token) throw new Error('刷新令牌失败');
    return finishLogin(token, account);
}

async function finishLogin(msToken, existing = null) {
    // 1) Xbox Live 用户令牌
    const xbl = await postJson(XBL_URL, {
        Properties: {
            AuthMethod: 'RPS',
            SiteName: 'user.auth.xboxlive.com',
            RpsTicket: 'd=' + msToken.access_token,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
    });
    const uhs = xbl?.DisplayClaims?.xui?.[0]?.uhs;
    const xuid = xbl?.DisplayClaims?.xui?.[0]?.xid || '';
    if (!xbl?.Token || !uhs) throw new Error('Xbox Live 验证失败，请稍后重试');

    // 2) XSTS 授权
    let xsts;
    try {
        xsts = await postJson(XSTS_URL, {
            Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT',
        });
    } catch (e) {
        const xerr = e.body?.XErr;
        if (xerr && XSTS_ERRORS[xerr]) throw new Error(XSTS_ERRORS[xerr]);
        if (xerr) throw new Error('Xbox Live 授权失败（错误码 ' + xerr + '）');
        throw new Error('Xbox Live 授权失败：' + e.message);
    }
    if (!xsts?.Token) throw new Error('Xbox Live 授权失败，请稍后重试');
    const xuid2 = xsts?.DisplayClaims?.xui?.[0]?.xid || xuid;

    // 3) 换取 Minecraft 访问令牌
    const mc = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
    if (!mc?.access_token) throw new Error('Minecraft 登录失败');

    // 4) 查询游戏档案（同时校验是否拥有游戏）
    const res = await fetch(MC_PROFILE_URL, { headers: { Authorization: 'Bearer ' + mc.access_token } });
    if (res.status === 404) throw new Error('该微软账号没有购买 Minecraft（或档案未创建）');
    if (!res.ok) throw new Error('无法获取 Minecraft 档案（HTTP ' + res.status + '）');
    const profile = await res.json();
    if (!profile?.id || !profile?.name) throw new Error('Minecraft 档案数据异常');

    const account = {
        id: existing?.id || 'ms-' + profile.id,
        type: 'microsoft',
        name: profile.name,
        uuid: profile.id,
        accessToken: mc.access_token,
        refreshToken: msToken.refresh_token || existing?.refreshToken || '',
        expiresAt: Date.now() + (Number(mc.expires_in) || 86400) * 1000,
        xuid: xuid2,
        addedAt: existing?.addedAt || Date.now(),
    };

    load();
    const idx = state.accounts.findIndex((a) => a.id === account.id || (a.type === 'microsoft' && a.uuid === account.uuid));
    if (idx >= 0) state.accounts[idx] = account;
    else state.accounts.push(account);
    state.activeId = account.id;
    save();
    log.info(`微软账号登录成功：${account.name} (${account.uuid})`);
    return publicAccount(account);
}

/** 确保账号 token 可用（启动前调用，实现自动续期） */
async function ensureFresh(account) {
    if (!account || account.type !== 'microsoft') return account;
    const left = (account.expiresAt || 0) - Date.now();
    if (left > 5 * 60 * 1000 && account.accessToken) return account;
    log.info('正在刷新微软账号令牌…');
    await refreshMicrosoft(account);
    return getById(account.id);
}

/** 启动时自动登录：恢复上次账号并尝试静默续期 */
async function autoLogin() {
    load();
    if (!state.autoLogin) return { account: publicAccount(getActive()), refreshed: false };
    const active = getActive();
    if (!active) return { account: null, refreshed: false };
    if (active.type !== 'microsoft') return { account: publicAccount(active), refreshed: false };
    try {
        await ensureFresh(active);
        bus.emit('refresh', { ok: true, account: publicAccount(getActive()) });
        return { account: publicAccount(getActive()), refreshed: true };
    } catch (e) {
        log.warn('自动登录失败：' + e.message);
        bus.emit('refresh', { ok: false, error: e.message, needRelogin: e.code === 'REAUTH', account: publicAccount(active) });
        return { account: publicAccount(active), refreshed: false, error: e.message, needRelogin: e.code === 'REAUTH' };
    }
}

/** 交给启动器使用的凭据 */
function getLaunchAuth() {
    load();
    const account = getActive();
    if (!account) {
        return { username: null, uuid: null, accessToken: '0', userType: 'legacy', xuid: '', source: 'none' };
    }
    if (account.type === 'offline') {
        return {
            username: account.name,
            uuid: account.uuid || offlineUuid(account.name),
            accessToken: '0',
            userType: 'legacy',
            xuid: '',
            source: 'offline',
            account: publicAccount(account),
        };
    }
    return {
        username: account.name,
        uuid: account.uuid,
        accessToken: account.accessToken || '0',
        userType: 'msa',
        xuid: account.xuid || '',
        source: 'microsoft',
        account: publicAccount(account),
    };
}

function remove(id) {
    load();
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((a) => a.id !== id);
    if (state.activeId === id) state.activeId = state.accounts[0]?.id || '';
    save();
    log.info(`移除账号 ${id}，剩余 ${state.accounts.length}/${before}`);
    return publicState();
}

function select(id) {
    load();
    if (id && !state.accounts.some((a) => a.id === id)) throw new Error('账号不存在');
    state.activeId = id || '';
    save();
    return publicState();
}

function setAutoLogin(value) {
    load();
    state.autoLogin = !!value;
    save();
    return state.autoLogin;
}

module.exports = {
    load, save, list: publicState, publicState, getActive, getById,
    addOffline, offlineUuid, buildAuthUrl, isRedirect, extractCode,
    loginWithCode, refreshMicrosoft, ensureFresh, autoLogin,
    getLaunchAuth, remove, select, setAutoLogin, bus, CLIENT_ID,
};
