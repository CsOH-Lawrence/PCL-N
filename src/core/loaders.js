'use strict';
/**
 * 模组加载器安装：Fabric / Quilt（profile JSON），Forge / NeoForge（官方安装器）。
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { paths } = require('./paths');
const { fetchJson, fetchText, downloadFile } = require('./http');
const { installVersion } = require('./install');
const { ensureDirAsync, writeJson, exists, listDir, remove } = require('./fsutil');
const { findJava } = require('./java');
const { createLogger } = require('./log');

const log = createLogger('loader');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';

const LOADERS = [
    { id: 'fabric', name: 'Fabric', desc: '轻量、更新最快的模组加载器，适合绝大多数模组' },
    { id: 'quilt', name: 'Quilt', desc: 'Fabric 的分支，兼容大部分 Fabric 模组' },
    { id: 'forge', name: 'Forge', desc: '老牌模组加载器，模组生态庞大' },
    { id: 'neoforge', name: 'NeoForge', desc: 'Forge 社区分支，1.20.2 之后的主流选择' },
];

function getLoaders() {
    return LOADERS;
}

/* ------------------------------- Fabric -------------------------------- */

async function listFabricVersions(mcVersion) {
    const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`, {
        urls: [
            `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`,
            `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
        ],
        retries: 2,
    });
    if (!Array.isArray(list)) return [];
    return list.map((e) => ({
        version: e.loader?.version,
        stable: !!e.loader?.stable,
        // Fabric API / 中间映射版本
        intermediary: e.intermediary?.version || '',
        build: e.loader?.build || 0,
    })).filter((e) => e.version);
}

async function installFabric(mcVersion, loaderVersion, opts = {}) {
    const { task, signal } = opts;
    if (task) { task.phase = 'meta'; task.detail = '正在获取 Fabric 版本信息…'; task.touch(); }
    let loader = loaderVersion;
    if (!loader || loader === 'latest' || loader === 'stable') {
        const list = await listFabricVersions(mcVersion);
        const stable = list.find((v) => v.stable) || list[0];
        if (!stable) throw new Error('Fabric 不支持该游戏版本');
        loader = stable.version;
    }
    const profile = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/profile/json`, {
        urls: [
            `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/profile/json`,
            `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/profile/json`,
        ],
        retries: 3,
        timeoutMs: 30000,
    });
    const id = profile.id;
    if (!id) throw new Error('Fabric 返回的版本信息无效');
    await ensureDirAsync(path.join(paths.versionsDir, id));
    await writeJson(path.join(paths.versionsDir, id, id + '.json'), profile);
    if (task) { task.detail = `正在安装 Fabric ${loader}`; task.touch(); }
    await installVersion(id, { task, signal });
    return { id, loader: 'fabric', loaderVersion: loader, minecraftVersion: mcVersion };
}

/* -------------------------------- Quilt -------------------------------- */

async function listQuiltVersions(mcVersion) {
    const list = await fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`, { retries: 2 });
    if (!Array.isArray(list)) return [];
    return list.map((e) => ({ version: e.loader?.version, stable: !!e.loader?.stable })).filter((e) => e.version);
}

async function installQuilt(mcVersion, loaderVersion, opts = {}) {
    const { task, signal } = opts;
    let loader = loaderVersion;
    if (!loader || loader === 'latest' || loader === 'stable') {
        const list = await listQuiltVersions(mcVersion);
        const stable = list.find((v) => v.stable) || list[0];
        if (!stable) throw new Error('Quilt 不支持该游戏版本');
        loader = stable.version;
    }
    const profile = await fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/profile/json`, {
        retries: 3, timeoutMs: 30000,
    });
    const id = profile.id || `quilt-loader-${loader}-${mcVersion}`;
    await ensureDirAsync(path.join(paths.versionsDir, id));
    await writeJson(path.join(paths.versionsDir, id, id + '.json'), profile);
    await installVersion(id, { task, signal });
    return { id, loader: 'quilt', loaderVersion: loader, minecraftVersion: mcVersion };
}

/* -------------------------------- Forge -------------------------------- */

function parseMavenVersions(xml) {
    const out = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1].trim());
    return out;
}

async function listForgeVersions(mcVersion) {
    const xml = await fetchText(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, {
        urls: [
            `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`,
            'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml',
        ],
        retries: 2, timeoutMs: 20000,
    });
    const all = parseMavenVersions(xml);
    return all.filter((v) => v.startsWith(mcVersion + '-'))
        .map((v) => v.slice(mcVersion.length + 1))
        .reverse()
        .map((v) => ({ version: v, stable: true }));
}

async function installForge(mcVersion, forgeVersion, opts = {}) {
    const { task, signal } = opts;
    let ver = forgeVersion;
    if (!ver || ver === 'latest') {
        const list = await listForgeVersions(mcVersion);
        if (!list.length) throw new Error(`Forge 不支持 Minecraft ${mcVersion}`);
        ver = list[0].version;
    }
    const full = `${mcVersion}-${ver}`;
    const installerName = `forge-${full}-installer.jar`;
    const installerUrl = `${FORGE_MAVEN}/net/minecraftforge/forge/${full}/${installerName}`;
    const installer = path.join(paths.cacheDir, 'installers', installerName);
    if (task) { task.phase = 'loader'; task.detail = '正在下载 Forge 安装器…'; task.touch(); }
    await downloadFile(installerUrl, installer, {
        urls: [installerUrl, `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${full}/${installerName}`],
        signal, timeoutMs: 60000, retries: 2,
    });
    if (task) { task.detail = '正在运行 Forge 安装器（可能需要数分钟）…'; task.touch(); }
    const wanted = mcVersion.startsWith('1.') && parseInt(mcVersion.split('.')[1], 10) <= 16 ? 8 : mcVersion >= '1.20.5' ? 21 : 17;
    await runInstallerJar(installer, mcVersion, { task, signal, javaMajor: wanted });
    const id = await findInstalledLoaderVersion('forge', ver, mcVersion);
    if (task) { task.detail = '正在补齐依赖库与资源文件…'; task.touch(); }
    await installVersion(id, { task, signal });
    return { id, loader: 'forge', loaderVersion: ver, minecraftVersion: mcVersion };
}

/* ------------------------------ NeoForge ------------------------------- */

function neoForgePrefix(mcVersion) {
    if (mcVersion === '1.20.1') return '47.';
    const parts = mcVersion.split('.');
    return `${parts[1]}.${parts[2] || 0}`;
}

async function listNeoForgeVersions(mcVersion) {
    const xml = await fetchText(`${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`, { retries: 2, timeoutMs: 20000 });
    const all = parseMavenVersions(xml);
    const prefix = neoForgePrefix(mcVersion);
    const matched = all.filter((v) => v.startsWith(prefix + '.'));
    return matched.reverse().map((v) => ({ version: v, stable: true }));
}

async function installNeoForge(mcVersion, neoVersion, opts = {}) {
    const { task, signal } = opts;
    let ver = neoVersion;
    if (!ver || ver === 'latest') {
        const list = await listNeoForgeVersions(mcVersion);
        if (!list.length) throw new Error(`NeoForge 不支持 Minecraft ${mcVersion}`);
        ver = (list.find((v) => /^\d+\.\d+\.\d+$/.test(v.version)) || list[0]).version;
    }
    const installerName = `neoforge-${ver}-installer.jar`;
    const installerUrl = `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${ver}/${installerName}`;
    const installer = path.join(paths.cacheDir, 'installers', installerName);
    if (task) { task.phase = 'loader'; task.detail = '正在下载 NeoForge 安装器…'; task.touch(); }
    await downloadFile(installerUrl, installer, { signal, timeoutMs: 60000, retries: 2 });
    if (task) { task.detail = '正在运行 NeoForge 安装器（可能需要数分钟）…'; task.touch(); }
    const major = ver.startsWith('21.') || ver.startsWith('20.5') ? 21 : 17;
    await runInstallerJar(installer, mcVersion, { task, signal, javaMajor: major });
    const id = await findInstalledLoaderVersion('neoforge', ver, mcVersion);
    if (task) { task.detail = '正在补齐依赖库与资源文件…'; task.touch(); }
    await installVersion(id, { task, signal });
    return { id, loader: 'neoforge', loaderVersion: ver, minecraftVersion: mcVersion };
}

/* ------------------------------ 通用安装器 ------------------------------ */

/** Forge / NeoForge 安装器要求游戏目录中存在 launcher_profiles.json */
async function ensureLauncherProfile() {
    const file = path.join(paths.gameDir, 'launcher_profiles.json');
    if (exists(file)) return file;
    await ensureDirAsync(paths.gameDir);
    const data = {
        profiles: {},
        settings: { enableSnapshots: false, keepLauncherOpen: false, showMenu: false },
        selectedProfile: '',
        clientToken: '',
        authenticationDatabase: {},
        launcherVersion: { name: '2.1.1', format: 21, profilesFormat: 21 },
    };
    await writeJson(file, data);
    return file;
}

function consoleJava(javaPath) {
    const alt = String(javaPath).replace(/javaw\.exe$/i, 'java.exe');
    return isFile(alt) ? alt : javaPath;
}

function runInstallerJar(installer, mcVersion, opts = {}) {
    const { task, signal } = opts;
    return new Promise(async (resolve, reject) => {
        const found = await findJava(opts.javaMajor || 17);
        if (!found) return reject(new Error('未找到可用于运行安装器的 Java，请先在设置中安装 Java'));
        const java = { ...found, path: consoleJava(found.path) };
        await ensureLauncherProfile().catch(() => {});
        const args = ['-jar', installer, '--installClient', paths.gameDir];
        log.info(`运行安装器: ${java.path} ${args.join(' ')}`);
        const child = execFile(java.path, args, {
            cwd: paths.gameDir,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            timeout: 15 * 60 * 1000,
        }, (err, stdout, stderr) => {
            const output = String(stdout || '') + String(stderr || '');
            log.info('安装器输出:\n' + output.slice(-8000));
            if (err) {
                const hint = analyzeInstallerError(output);
                return reject(new Error(`安装器运行失败：${hint}`));
            }
            resolve(output);
        });
        if (child.stdout) child.stdout.on('data', (d) => {
            const text = String(d);
            if (task) { task.detail = text.trim().split('\n').pop().slice(0, 90); task.touch(); }
            log.debug('[installer] ' + text.trim());
        });
        if (child.stderr) child.stderr.on('data', (d) => log.debug('[installer:err] ' + String(d).trim()));
        if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch { /* ignore */ } reject(new Error('已取消')); }, { once: true });
        if (task) { task.detail = '安装器运行中…'; task.touch(); }
    });
}

function analyzeInstallerError(output) {
    if (/Could not find or load main class/i.test(output)) return '安装器无法启动，可能是 Java 版本不匹配';
    if (/Failed to download/i.test(output) || /Could not download/i.test(output)) return '下载依赖库失败，请检查网络或切换下载源';
    if (/java\.lang\.UnsupportedClassVersionError/i.test(output)) return 'Java 版本过低，请安装更高版本的 Java';
    const last = output.trim().split('\n').filter(Boolean).slice(-3).join(' ');
    return last ? last.slice(0, 200) : '未知错误';
}

/** 安装后查找新生成的版本目录 */
async function findInstalledLoaderVersion(loader, loaderVersion, mcVersion) {
    const dir = paths.versionsDir;
    const entries = await listDir(dir);
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const candidates = names.filter((n) => {
        const lower = n.toLowerCase();
        if (loader === 'forge') return lower.includes('forge') && !lower.includes('neoforge') && (lower.includes(loaderVersion) || lower.includes(mcVersion));
        if (loader === 'neoforge') return lower.includes('neoforge') && (lower.includes(loaderVersion) || lower.includes(mcVersion));
        return false;
    });
    if (!candidates.length) throw new Error('安装器未能生成版本目录，请查看日志');
    // 选择修改时间最新的
    let best = candidates[0];
    let bestTime = 0;
    for (const c of candidates) {
        try {
            const st = fs.statSync(path.join(dir, c, c + '.json'));
            if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = c; }
        } catch { /* ignore */ }
    }
    return best;
}

module.exports = {
    getLoaders, listFabricVersions, installFabric, listQuiltVersions, installQuilt,
    listForgeVersions, installForge, listNeoForgeVersions, installNeoForge, runInstallerJar, parseMavenVersions,
};
