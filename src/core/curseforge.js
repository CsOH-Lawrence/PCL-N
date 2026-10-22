'use strict';
/**
 * CurseForge 支持：整合包内文件的查询与下载。
 * 不使用任何 API Key —— 直接调用 CurseForge 官网公开的网页接口：
 *   GET /api/v1/mods/{projectId}/files/{fileId}            → 文件名与大小
 *   GET /api/v1/mods/{projectId}/files/{fileId}/download   → 302 到 CDN，返回文件本体
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureDirAsync, isFile, size } = require('./fsutil');
const { createLogger } = require('./log');

const log = createLogger('curseforge');

const WEB_BASE = 'https://www.curseforge.com/api/v1';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const infoCache = new Map();

function safeName(name) {
    return String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

async function fetchJsonRetry(url, opts = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < (opts.retries ?? 3); attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': BROWSER_UA,
                    Accept: 'application/json, text/plain, */*',
                    ...(opts.headers || {}),
                },
                signal: opts.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const err = new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        } catch (e) {
            lastErr = e;
            if (opts.signal?.aborted) throw new Error('已取消');
            if (e.status === 403 || e.status === 404) break; // 不重试
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
    }
    throw lastErr || new Error('请求失败');
}

/** 查询文件元信息（文件名 / 大小） */
async function fileInfo(projectId, fileId) {
    const cacheKey = `${projectId}:${fileId}`;
    if (infoCache.has(cacheKey)) return infoCache.get(cacheKey);
    const json = await fetchJsonRetry(`${WEB_BASE}/mods/${projectId}/files/${fileId}`);
    const data = json?.data;
    if (!data) throw new Error('CurseForge 未返回文件信息');
    const info = {
        fileName: data.fileName,
        fileLength: data.fileLength || 0,
        displayName: data.displayName || '',
        downloadUrl: `${WEB_BASE}/mods/${projectId}/files/${fileId}/download`,
    };
    infoCache.set(cacheKey, info);
    return info;
}

/** 流式下载（跟随重定向，带进度） */
async function streamDownload(url, dest, opts = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
        if (opts.signal.aborted) throw new Error('已取消');
        opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 60000);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
            signal: controller.signal,
            redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || opts.size || 0;
        await ensureDirAsync(path.dirname(dest));
        const tmp = dest + '.part';
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
        await fsp.rm(dest, { force: true }).catch(() => {});
        await fsp.rename(tmp, dest);
        return { bytes: written, total };
    } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
}

/**
 * 下载整合包内某个文件到目标目录。
 * @returns {Promise<{file:string, skipped:boolean}>}
 */
async function downloadModFile(projectId, fileId, targetDir, opts = {}) {
    const info = await fileInfo(projectId, fileId);
    const dest = path.join(targetDir, safeName(info.fileName));
    if (isFile(dest) && info.fileLength && size(dest) === info.fileLength) {
        if (opts.onProgress) opts.onProgress(info.fileLength, info.fileLength, info.fileLength);
        return { file: dest, skipped: true };
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await streamDownload(info.downloadUrl, dest, {
                size: info.fileLength,
                signal: opts.signal,
                onProgress: opts.onProgress,
            });
            if (info.fileLength && size(dest) !== info.fileLength) throw new Error('文件大小不一致');
            return { file: dest, skipped: false };
        } catch (e) {
            lastErr = e;
            if (opts.signal?.aborted) throw new Error('已取消');
            log.warn(`下载失败(${attempt + 1}) ${info.fileName}: ${e.message}`);
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr || new Error('下载失败');
}

module.exports = { fileInfo, downloadModFile, safeName, BROWSER_UA, WEB_BASE };
