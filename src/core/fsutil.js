'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./log');

const log = createLogger('fs');

function ensureDir(dir) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function ensureDirAsync(dir) {
    if (dir) await fsp.mkdir(dir, { recursive: true });
    return dir;
}

function exists(p) {
    try { fs.accessSync(p); return true; } catch { return false; }
}

function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function size(p) {
    try { return fs.statSync(p).size; } catch { return -1; }
}

async function readJson(file, fallback = null) {
    try {
        const text = await fsp.readFile(file, 'utf8');
        return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
        if (fallback !== null) return fallback;
        throw e;
    }
}

function readJsonSync(file, fallback = null) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        return fallback;
    }
}

async function writeJson(file, value, pretty = true) {
    await ensureDirAsync(path.dirname(file));
    const tmp = file + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
    await fsp.rename(tmp, file);
    return value;
}

function writeJsonSync(file, value, pretty = true) {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
    try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    return value;
}

function sha1File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const s = fs.createReadStream(file);
        s.on('data', (d) => hash.update(d));
        s.on('error', reject);
        s.on('end', () => resolve(hash.digest('hex')));
    });
}

function sha512File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha512');
        const s = fs.createReadStream(file);
        s.on('data', (d) => hash.update(d));
        s.on('error', reject);
        s.on('end', () => resolve(hash.digest('hex')));
    });
}

async function remove(p) {
    try { await fsp.rm(p, { recursive: true, force: true }); } catch (e) { log.warn('删除失败 ' + p, e); }
}

function removeSync(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log.warn('删除失败 ' + p, e); }
}

async function copyDir(src, dest, opts = {}) {
    await ensureDirAsync(dest);
    let entries;
    try { entries = await fsp.readdir(src, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) await copyDir(s, d, opts);
        else if (entry.isFile()) {
            await ensureDirAsync(path.dirname(d));
            await fsp.copyFile(s, d);
        }
    }
    if (opts.onFile) opts.onFile(dest);
}

async function listDir(dir) {
    try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function totalSize(dir) {
    let sum = 0;
    const entries = await listDir(dir);
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) sum += await totalSize(p);
        else if (e.isFile()) sum += size(p);
    }
    return sum;
}

/** 简单并发池 */
async function runPool(items, limit, worker) {
    const arr = Array.from(items);
    let index = 0;
    const errors = [];
    const runners = new Array(Math.max(1, Math.min(limit, arr.length))).fill(0).map(async () => {
        while (index < arr.length) {
            const i = index++;
            try { await worker(arr[i], i); } catch (e) { errors.push(e); }
        }
    });
    await Promise.all(runners);
    return errors;
}

function parseSize(n) {
    if (!Number.isFinite(n)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
    ensureDir, ensureDirAsync, exists, isFile, isDir, size, readJson, readJsonSync, writeJson, writeJsonSync,
    sha1File, sha512File, remove, removeSync, copyDir, listDir, totalSize, runPool, parseSize, timestamp, fsp,
};
