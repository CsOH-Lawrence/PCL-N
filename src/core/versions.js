'use strict';
/**
 * 本地版本管理：扫描、详情、删除、模组 / 资源包 / 光影 / 数据包 / 存档 列表与启停。
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { paths, versionDir } = require('./paths');
const { readJsonSync, isFile, isDir, size, listDir, remove, ensureDirAsync, timestamp } = require('./fsutil');
const { resolveVersionJson, describeVersion } = require('./mojang');
const { readZipJson } = require('./zip');
const config = require('./config');
const { createLogger } = require('./log');

const log = createLogger('versions');

const ICON_CACHE = new Map();

/** 解析版本的游戏目录（版本隔离） */
function resolveGameDir(versionId) {
    const s = config.getVersionSettings(versionId);
    if (s.isolation === 'version') return path.join(paths.versionsDir, versionId);
    if (s.isolation === 'custom' && s.isolationDir) return s.isolationDir;
    return paths.gameDir;
}

function subDir(versionId, name) {
    return path.join(resolveGameDir(versionId), name);
}

function guessIsolation(id) {
    const s = config.getVersionSettings(id);
    if (s.isolation) return s.isolation;
    const vd = path.join(paths.versionsDir, id);
    return isDir(path.join(vd, 'mods')) || isDir(path.join(vd, 'config')) || isDir(path.join(vd, 'saves')) ? 'version' : 'global';
}

/** 扫描所有已安装版本 */
async function scanVersions() {
    const dir = paths.versionsDir;
    const entries = await listDir(dir);
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const jsonFile = path.join(dir, e.name, e.name + '.json');
        if (!isFile(jsonFile)) continue;
        const raw = readJsonSync(jsonFile);
        if (!raw) continue;
        let merged = raw;
        let chainError = null;
        try {
            const r = await resolveVersionJson(e.name);
            merged = r.json;
        } catch (err) {
            chainError = err.message;
        }
        const desc = describeVersion(merged);
        let stat = null;
        try { stat = fs.statSync(jsonFile); } catch { /* ignore */ }
        const installedMarker = readJsonSync(path.join(dir, e.name, '.pcln-installed.json'));
        const iconFile = path.join(dir, e.name, 'icon.png');
        const isolation = guessIsolation(e.name);
        // 从继承链中找出真正的原版版本号（如 fabric-loader-x-1.21.1 → 1.21.1）
        let chainIds = [];
        try { chainIds = (await resolveVersionJson(e.name)).chainIds; } catch { /* ignore */ }
        const mcFromChain = chainIds.find((c) => /^\d+\.\d+(\.\d+)?$/.test(c));
        const modsDir = isolation === 'version'
            ? path.join(dir, e.name, 'mods')
            : path.join(paths.gameDir, 'mods');
        out.push({
            id: e.name,
            name: raw.name || e.name,
            type: desc.type,
            loader: desc.loader,
            loaderVersion: desc.loaderVersion,
            mcVersion: mcFromChain || desc.minecraftVersion,
            javaVersion: desc.javaVersion,
            releaseTime: merged.releaseTime || null,
            lastPlayed: config.getVersionSettings(e.name).lastPlayed || installedMarker?.installedAt || null,
            hasIcon: isFile(iconFile),
            isolation,
            gameDir: resolveGameDir(e.name),
            error: chainError,
            modCount: isolation === 'version' ? countFiles(modsDir, '.jar') : 0,
        });
    }
    out.sort((a, b) => {
        const ta = Date.parse(a.lastPlayed || a.releaseTime || 0) || 0;
        const tb = Date.parse(b.lastPlayed || b.releaseTime || 0) || 0;
        return tb - ta;
    });
    return out;
}

function countFiles(dir, ext) {
    try {
        return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).length;
    } catch { return 0; }
}

async function getVersionDetail(id) {
    const file = path.join(versionDir(id), id + '.json');
    const raw = readJsonSync(file);
    if (!raw) throw new Error('版本不存在: ' + id);
    const { json, chain, chainIds } = await resolveVersionJson(id);
    const desc = describeVersion(json);
    return {
        id,
        raw,
        merged: json,
        chain: chainIds,
        ...desc,
        settings: config.getVersionSettings(id),
        gameDir: resolveGameDir(id),
        isolation: guessIsolation(id),
        hasJar: isFile(path.join(versionDir(id), id + '.jar')) || chainIds.some((c) => isFile(path.join(versionDir(c), c + '.jar'))),
    };
}

async function deleteVersion(id, opts = {}) {
    const dir = versionDir(id);
    if (!isDir(dir)) throw new Error('版本不存在');
    if (opts.onlySettings) {
        config.removeVersionSettings(id);
        return { deleted: false };
    }
    config.removeVersionSettings(id);
    await remove(dir);
    log.info('已删除版本 ' + id);
    return { deleted: true };
}

/** 重命名版本（目录 + json id） */
async function renameVersion(id, newName) {
    const safe = String(newName).replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!safe) throw new Error('名称不能为空');
    if (safe === id) return { id };
    const src = versionDir(id);
    const dest = versionDir(safe);
    if (isDir(dest)) throw new Error('已存在同名版本');
    await fsp.rename(src, dest);
    const oldJson = path.join(dest, id + '.json');
    const raw = readJsonSync(oldJson);
    if (raw) {
        raw.id = safe;
        await fsp.writeFile(path.join(dest, safe + '.json'), JSON.stringify(raw, null, 2), 'utf8');
        await fsp.unlink(oldJson).catch(() => {});
        const oldJar = path.join(dest, id + '.jar');
        if (isFile(oldJar)) await fsp.rename(oldJar, path.join(dest, safe + '.jar')).catch(() => {});
    }
    const vs = config.getVersionSettings(id);
    if (Object.keys(vs).length) { config.setVersionSettings(safe, vs); config.removeVersionSettings(id); }
    return { id: safe };
}

/* ------------------------------ 模组管理 ------------------------------ */

const modMetaCache = new Map();

async function readModMeta(jarPath) {
    const st = fs.statSync(jarPath);
    const key = jarPath + ':' + st.size + ':' + st.mtimeMs;
    if (modMetaCache.has(key)) return modMetaCache.get(key);
    let meta = { name: path.basename(jarPath), version: '', description: '', loader: '' };
    try {
        const fabric = await readZipJson(jarPath, 'fabric.mod.json');
        if (fabric) {
            meta = {
                name: fabric.name || meta.name,
                version: fabric.version || '',
                description: trimText(fabric.description) || '',
                loader: 'fabric',
                id: fabric.id || '',
                authors: Array.isArray(fabric.authors) ? fabric.authors.map((a) => (typeof a === 'string' ? a : a.name)).join(', ') : '',
            };
        } else {
            const tomlBuf = await require('./zip').readZipFile(jarPath, 'META-INF/mods.toml') || await require('./zip').readZipFile(jarPath, 'META-INF/neoforge.mods.toml');
            if (tomlBuf) {
                const text = tomlBuf.toString('utf8');
                const g = (k) => (text.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1] || '';
                meta = { name: g('displayName') || meta.name, version: g('version') || '', description: g('description') || '', loader: 'forge' };
            } else {
                const quilt = await readZipJson(jarPath, 'quilt.mod.json');
                if (quilt) {
                    meta = {
                        name: quilt.quilt_loader?.metadata?.name || meta.name,
                        version: quilt.quilt_loader?.version || '',
                        description: trimText(quilt.quilt_loader?.metadata?.description) || '',
                        loader: 'quilt',
                    };
                } else {
                    const mcmod = await readZipJson(jarPath, 'mcmod.info');
                    if (mcmod) {
                        const first = Array.isArray(mcmod) ? mcmod[0] : mcmod.modList?.[0];
                        if (first) meta = { name: first.name || meta.name, version: first.version || '', description: trimText(first.description) || '', loader: 'forge' };
                    }
                }
            }
        }
    } catch { /* 非标准 jar */ }
    if (meta.version && meta.version.includes('${')) meta.version = '';
    modMetaCache.set(key, meta);
    return meta;
}

function trimText(t) {
    if (typeof t === 'string') return t.slice(0, 300);
    if (t && typeof t === 'object') return String(t.text || t.translate || '').slice(0, 300);
    return '';
}

async function listMods(versionId) {
    const dirs = new Set([subDir(versionId, 'mods'), path.join(paths.versionsDir, versionId, 'mods')]);
    const seen = new Set();
    const files = [];
    for (const dir of dirs) {
        const entries = await listDir(dir);
        for (const e of entries) {
            if (!e.isFile()) continue;
            const lower = e.name.toLowerCase();
            const isJar = lower.endsWith('.jar') || lower.endsWith('.jar.disabled');
            if (!isJar) continue;
            const full = path.join(dir, e.name);
            if (seen.has(full)) continue;
            seen.add(full);
            files.push({ dir, name: e.name, full, disabled: lower.endsWith('.disabled') });
        }
    }
    const { runPool } = require('./fsutil');
    const out = [];
    await runPool(files, 8, async (f) => {
        const meta = await readModMeta(f.full).catch(() => ({ name: f.name }));
        out.push({
            file: f.name,
            path: f.full,
            dir: f.dir,
            enabled: !f.disabled,
            size: size(f.full),
            name: meta.name || f.name,
            version: meta.version || '',
            description: meta.description || '',
            loader: meta.loader || '',
            mtime: (() => { try { return fs.statSync(f.full).mtimeMs; } catch { return 0; } })(),
        });
    });
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
}

async function toggleMod(filePath) {
    if (!isFile(filePath)) throw new Error('文件不存在');
    if (/\.disabled$/i.test(filePath)) {
        const dest = filePath.replace(/\.disabled$/i, '');
        if (isFile(dest)) throw new Error('同名文件已存在');
        await fsp.rename(filePath, dest);
        return { path: dest, enabled: true };
    }
    const dest = filePath + '.disabled';
    await fsp.rename(filePath, dest);
    return { path: dest, enabled: false };
}

async function deleteMod(filePath) {
    await remove(filePath);
    modMetaCache.delete(filePath);
    return true;
}

/* ---------------------------- 资源包 / 光影 ---------------------------- */

async function listResourcePacks(versionId) {
    const dir = subDir(versionId, 'resourcepacks');
    const entries = await listDir(dir);
    const out = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        let meta = null;
        try {
            if (e.isFile() && /\.zip$/i.test(e.name)) {
                meta = await readZipJson(full, 'pack.mcmeta');
            } else if (e.isDirectory()) {
                meta = readJsonSync(path.join(full, 'pack.mcmeta'));
            }
        } catch { /* ignore */ }
        const mcmeta = meta?.pack || {};
        out.push({
            file: e.name,
            path: full,
            isDir: e.isDirectory(),
            size: e.isDirectory() ? 0 : size(full),
            description: trimText(mcmeta.description) || e.name,
            format: mcmeta.pack_format || 0,
        });
    }
    return out;
}

async function listShaderPacks(versionId) {
    const dir = subDir(versionId, 'shaderpacks');
    const entries = await listDir(dir);
    return entries.map((e) => ({
        file: e.name,
        path: path.join(dir, e.name),
        isDir: e.isDirectory(),
        size: e.isDirectory() ? 0 : size(path.join(dir, e.name)),
    }));
}

async function listSaves(versionId) {
    const dir = subDir(versionId, 'saves');
    const entries = await listDir(dir);
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        const level = readJsonSync(path.join(full, 'level.dat'), null);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        out.push({ name: e.name, path: full, mtime, hasDatapacks: isDir(path.join(full, 'datapacks')) });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

async function listDatapacks(versionId, world) {
    const base = world ? path.join(subDir(versionId, 'saves'), world, 'datapacks') : subDir(versionId, 'datapacks');
    const entries = await listDir(base);
    return entries.map((e) => ({
        file: e.name,
        path: path.join(base, e.name),
        isDir: e.isDirectory(),
        size: e.isDirectory() ? 0 : size(path.join(base, e.name)),
    }));
}

module.exports = {
    scanVersions, getVersionDetail, deleteVersion, renameVersion, resolveGameDir,
    listMods, toggleMod, deleteMod, listResourcePacks, listShaderPacks, listSaves, listDatapacks,
    subDir, readModMeta,
};
