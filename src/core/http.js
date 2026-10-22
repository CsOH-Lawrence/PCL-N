'use strict';
/**
 * 网络层：文件下载（断点重试、镜像回退、限速统计）与 JSON 请求。
 * 所有对 Mojang / Fabric / Forge 的请求都走这里，方便统一切换下载源。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./log');
const { ensureDirAsync, runPool } = require('./fsutil');

const log = createLogger('http');

const MIRROR = 'https://bmclapi2.bangbang93.com';
let sourceMode = 'auto'; // auto | mirror | official

const USER_AGENT = 'PlainCraftLauncherN/1.0 (Minecraft launcher; +https://github.com/pcln)';

function setDownloadSource(mode) {
    if (['auto', 'mirror', 'official'].includes(mode)) sourceMode = mode;
}

function getDownloadSource() {
    return sourceMode;
}

/** 把 Mojang 官方链接映射到 BMCLAPI 镜像 */
function mirrorUrl(url) {
    if (!url || !/^https?:/i.test(url)) return url;
    let u;
    try { u = new URL(url); } catch { return url; }
    const host = u.hostname.toLowerCase();
    const p = u.pathname;
    if (host === 'resources.download.minecraft.net') return `${MIRROR}/assets${p}`;
    if (host === 'libraries.minecraft.net') return `${MIRROR}/maven${p}`;
    if (host === 'piston-meta.mojang.com' || host === 'launchermeta.mojang.com' || host === 'launcher.mojang.com') {
        if (p.startsWith('/mc/game/version_manifest')) return `${MIRROR}/mc/game/version_manifest_v2.json`;
        return MIRROR + p;
    }
    if (host === 'maven.fabricmc.net') return `${MIRROR}/maven${p}`;
    if (host === 'maven.minecraftforge.net') return `${MIRROR}/maven${p}`;
    if (host === 'maven.quiltmc.org' || host === 'maven.quiltmc.org') return `${MIRROR}/maven${p}`;
    if (host === 'meta.fabricmc.net') return `${MIRROR}/fabric-meta${p}`;
    return url;
}

function candidates(url) {
    const m = mirrorUrl(url);
    if (sourceMode === 'official') return [url];
    if (sourceMode === 'mirror') return m === url ? [url] : [m, url];
    // auto：官方优先（速度正常时最稳），失败后回退镜像
    return m === url ? [url] : [url, m];
}

/** 上游版本 JSON 专用镜像地址 */
function versionJsonUrls(versionId, officialUrl) {
    const urls = [];
    if (sourceMode !== 'official') urls.push(`${MIRROR}/version/${encodeURIComponent(versionId)}/json`);
    if (officialUrl) urls.push(officialUrl);
    return [...new Set(urls)];
}

function versionClientUrls(versionId, officialUrl) {
    const urls = [];
    if (sourceMode !== 'official') urls.push(`${MIRROR}/version/${encodeURIComponent(versionId)}/client`);
    if (officialUrl) urls.push(officialUrl);
    return [...new Set(urls)];
}

class DownloadError extends Error {
    constructor(message, url, status) {
        super(message);
        this.name = 'DownloadError';
        this.url = url;
        this.status = status;
    }
}

async function downloadOnce(url, dest, opts) {
    const timeout = opts.timeoutMs || 20000;
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('已取消'));
    if (opts.signal) {
        if (opts.signal.aborted) throw new Error('已取消');
        opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer = setTimeout(() => controller.abort(new Error('连接超时')), timeout);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
            signal: controller.signal,
            redirect: 'follow',
        });
        if (!res.ok) throw new DownloadError(`HTTP ${res.status}`, url, res.status);
        const total = Number(res.headers.get('content-length')) || opts.size || 0;
        const tmp = dest + '.part';
        await ensureDirAsync(path.dirname(dest));
        const out = fs.createWriteStream(tmp);
        let written = 0;
        try {
            for await (const chunk of res.body) {
                written += chunk.length;
                if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
                if (opts.onProgress) opts.onProgress(chunk.length, written, total);
            }
        } finally {
            await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        }
        clearTimeout(timer);
        let hash = null;
        if (opts.sha1) {
            hash = await sha1(tmp);
            if (hash.toLowerCase() !== String(opts.sha1).toLowerCase()) {
                await fsp.unlink(tmp).catch(() => {});
                throw new DownloadError('文件校验失败 (SHA1 不匹配)', url);
            }
        }
        // Windows 上 rename 不能覆盖已存在文件
        await fsp.rm(dest, { force: true }).catch(() => {});
        await fsp.rename(tmp, dest);
        return { url, bytes: written, sha1: hash };
    } catch (e) {
        if (e.name === 'AbortError' || /aborted/i.test(e.message)) {
            if (opts.signal?.aborted) throw new Error('已取消');
            throw new DownloadError('连接超时', url);
        }
        if (e instanceof DownloadError) throw e;
        throw new DownloadError(e.message || '网络错误', url);
    } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
}

function sha1(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha1');
        const s = fs.createReadStream(file);
        s.on('data', (d) => h.update(d));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * 下载文件到 dest，自动重试与镜像回退。
 * @param {string} url 官方链接（会自动尝试镜像）
 * @param {string} dest 目标路径
 * @param {object} opts { size, sha1, signal, onProgress(delta, written, total), retries, timeoutMs, skipIfExists=true, urls }
 */
async function downloadFile(url, dest, opts = {}) {
    const retries = opts.retries ?? 2;
    const skipIfExists = opts.skipIfExists !== false;
    if (skipIfExists) {
        try {
            const st = await fsp.stat(dest);
            if (st.isFile() && st.size > 0) {
                if (!opts.size || st.size === opts.size) {
                    if (!opts.sha1 || (await sha1(dest)).toLowerCase() === String(opts.sha1).toLowerCase()) {
                        if (opts.onProgress && opts.size) opts.onProgress(opts.size, opts.size, opts.size);
                        return { skipped: true, bytes: st.size };
                    }
                }
            }
        } catch { /* 不存在则继续下载 */ }
    }
    const urls = opts.urls && opts.urls.length ? opts.urls : candidates(url);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const u of urls) {
            try {
                const r = await downloadOnce(u, dest, { ...opts, timeoutMs: (opts.timeoutMs || 20000) * (attempt > 0 ? 1.5 : 1) });
                return r;
            } catch (e) {
                lastErr = e;
                if (/已取消/.test(e.message)) throw e;
                log.debug(`下载失败(${attempt + 1}) ${u} -> ${e.message}`);
            }
        }
        if (opts.signal?.aborted) throw new Error('已取消');
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    throw new DownloadError(lastErr ? lastErr.message : '下载失败', url, lastErr?.status);
}

/**
 * 批量下载：聚合进度。
 * files: [{ url, dest, size, sha1, name }]
 * opts: { concurrency, onProgress(progress), signal, task }
 */
async function downloadBatch(files, opts = {}) {
    const concurrency = opts.concurrency || 8;
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const progress = {
        current: 0, total: files.length, bytesDone: 0, bytesTotal: totalBytes,
        speed: 0, currentFile: '',
    };
    let lastT = Date.now();
    let lastBytes = 0;
    let speed = 0;
    const emit = () => {
        const now = Date.now();
        if (now - lastT >= 400) {
            speed = Math.round((progress.bytesDone - lastBytes) / ((now - lastT) / 1000));
            lastBytes = progress.bytesDone;
            lastT = now;
            progress.speed = Math.max(0, speed);
            if (opts.onProgress) opts.onProgress(progress);
        }
    };
    let failed = 0;
    if (opts.onProgress) opts.onProgress(progress);
    await runPool(files, concurrency, async (f) => {
        if (opts.signal?.aborted) throw new Error('已取消');
        progress.currentFile = f.name || path.basename(f.dest);
        try {
            await downloadFile(f.url, f.dest, {
                size: f.size, sha1: f.sha1, signal: opts.signal,
                timeoutMs: opts.timeoutMs, retries: opts.retries ?? 2,
                urls: f.urls,
                onProgress: (delta) => {
                    progress.bytesDone += delta;
                    emit();
                    if (opts.onFileProgress) opts.onFileProgress(f, progress);
                },
            });
        } catch (e) {
            failed++;
            if (/已取消/.test(e.message)) return;
            log.warn(`跳过失败文件 ${f.name || f.dest}: ${e.message}`);
        }
        progress.current++;
        if (opts.onProgress) opts.onProgress(progress);
    });
    progress.speed = 0;
    if (opts.onProgress) opts.onProgress(progress);
    return { ...progress, failed };
}

const jsonCache = new Map();

async function fetchText(url, opts = {}) {
    const urls = opts.urls || candidates(url);
    let lastErr = null;
    for (let attempt = 0; attempt < (opts.retries ?? 2); attempt++) {
        for (const u of urls) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
            try {
                const res = await fetch(u, {
                    headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                clearTimeout(timer);
                return text;
            } catch (e) {
                lastErr = e;
                clearTimeout(timer);
                log.debug(`请求失败 ${u}: ${e.message}`);
            }
        }
        if (opts.retries) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    throw new Error(lastErr ? lastErr.message : '网络请求失败');
}

async function fetchJson(url, opts = {}) {
    const cacheKey = (opts.urls ? opts.urls.join('|') : url) + '|' + (opts.source || '');
    const ttl = opts.cacheTtl ?? 0;
    if (ttl > 0) {
        const c = jsonCache.get(cacheKey);
        if (c && Date.now() - c.t < ttl) return c.v;
    }
    const text = await fetchText(url, opts);
    let json;
    try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { throw new Error('返回内容不是有效 JSON: ' + url); }
    if (ttl > 0) jsonCache.set(cacheKey, { t: Date.now(), v: json });
    return json;
}

/** 从 JSON 列表里挑选：优先官方 */
async function fetchFirstJson(urls, opts = {}) {
    let lastErr = null;
    for (const u of urls) {
        try { return await fetchJson(u, { ...opts, urls: [u] }); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('全部请求失败');
}

module.exports = {
    downloadFile, downloadBatch, fetchJson, fetchText, fetchFirstJson,
    mirrorUrl, candidates, versionJsonUrls, versionClientUrls,
    setDownloadSource, getDownloadSource, DownloadError, USER_AGENT, MIRROR,
};
