'use strict';
/**
 * 整合包安装：Modrinth (.mrpack) / CurseForge (manifest.json) / 通用压缩包（含 PCL 导出）。
 * 安装为一个独立隔离的版本目录，避免污染全局游戏目录。
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { paths } = require('./paths');
const { listZip, extractZip, readZipJson, readZipFile } = require('./zip');
const { downloadFile, downloadBatch } = require('./http');
const curseforge = require('./curseforge');
const { installVersion } = require('./install');
const loaders = require('./loaders');
const modrinth = require('./modrinth');
const { ensureDirAsync, exists, isFile, isDir, readJsonSync, writeJson, size, remove, listDir } = require('./fsutil');
const { createLogger } = require('./log');

const log = createLogger('modpack');

const LOADER_KEYS = ['fabric-loader', 'quilt-loader', 'forge', 'neoforge'];

function safeName(name, fallback = '整合包') {
    return String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || fallback;
}

/** 识别整合包类型与元信息 */
async function detectPack(file) {
    const entries = await listZip(file);
    const names = entries.map((e) => e.name.replace(/\\/g, '/'));
    const hasIndexOf = (n) => names.includes(n);
    if (hasIndexOf('modrinth.index.json')) {
        const index = await readZipJson(file, 'modrinth.index.json');
        const deps = index.dependencies || {};
        const loaderKey = LOADER_KEYS.find((k) => deps[k]);
        return {
            kind: 'mrpack',
            name: index.name || path.basename(file, path.extname(file)),
            version: index.versionId || '',
            mcVersion: deps.minecraft || '',
            loader: loaderKey ? loaderKey.replace('-loader', '') : 'vanilla',
            loaderVersion: loaderKey ? deps[loaderKey] : '',
            files: (index.files || []).length,
            summary: index.summary || '',
            file,
        };
    }
    if (hasIndexOf('manifest.json')) {
        const manifest = await readZipJson(file, 'manifest.json');
        if (manifest && manifest.minecraft) {
            const ml = (manifest.minecraft.modLoaders || [])[0];
            const loaderId = ml?.id || '';
            const loader = loaderId.startsWith('forge') ? 'forge' : loaderId.startsWith('fabric') ? 'fabric'
                : loaderId.startsWith('neoforge') ? 'neoforge' : loaderId.startsWith('quilt') ? 'quilt' : 'vanilla';
            return {
                kind: 'curseforge',
                name: manifest.name || path.basename(file, path.extname(file)),
                version: manifest.version || '',
                mcVersion: manifest.minecraft.version || '',
                loader,
                loaderVersion: loaderId.replace(/^(forge|fabric|neoforge|quilt)-?/i, ''),
                files: (manifest.files || []).length,
                summary: manifest.author || '',
                file,
            };
        }
    }
    // 通用压缩包：查找版本 JSON
    const versionJson = names.find((n) => /^(\.minecraft\/)?versions\/[^/]+\/[^/]+\.json$/i.test(n));
    let mcVersion = '';
    if (versionJson) {
        const json = await readZipJson(file, versionJson).catch(() => null);
        mcVersion = json?.inheritsFrom || json?.id || '';
    }
    return {
        kind: 'generic',
        name: path.basename(file, path.extname(file)),
        version: '',
        mcVersion,
        loader: 'vanilla',
        loaderVersion: '',
        files: entries.length,
        summary: versionJson ? '包含版本文件的通用整合包' : '通用压缩包',
        file,
    };
}

/** 创建整合包版本（以继承方式指向加载器版本） */
async function createPackVersion(packName, opts) {
    const { inheritsFrom, mcVersion, loader, loaderVersion, icon, source } = opts;
    const id = safeName(packName);
    const dir = path.join(paths.versionsDir, id);
    if (isDir(dir) && exists(path.join(dir, id + '.json'))) {
        // 已存在同名版本：加时间后缀
        const alt = `${id}-${Date.now().toString(36).slice(-4)}`;
        return createPackVersion(alt, opts);
    }
    await ensureDirAsync(dir);
    const json = {
        id,
        inheritsFrom,
        name: id,
        type: 'release',
        mainClass: undefined,
        minecraftVersion: mcVersion,
        loader,
        loaderVersion,
        modpack: {
            source: source || 'local',
            installedAt: new Date().toISOString(),
            originalName: packName,
        },
    };
    delete json.mainClass;
    await writeJson(path.join(dir, id + '.json'), json);
    if (icon) {
        try {
            await downloadFile(icon, path.join(dir, 'icon.png'), { retries: 2 });
        } catch { /* 图标可选 */ }
    }
    const config = require('./config');
    config.setVersionSettings(id, { isolation: 'version' });
    return { id, dir };
}

async function ensureBaseVersion(mcVersion, loader, loaderVersion, opts = {}) {
    const { task, signal } = opts;
    if (!mcVersion) throw new Error('整合包未提供 Minecraft 版本信息');
    if (loader === 'vanilla') {
        if (task) { task.phase = 'loader'; task.detail = `正在安装 Minecraft ${mcVersion}`; task.touch(); }
        await installVersion(mcVersion, { task, signal });
        return { id: mcVersion, loader: 'vanilla', loaderVersion: '' };
    }
    if (task) { task.phase = 'loader'; task.detail = `正在安装 ${loader} ${loaderVersion || '最新版'}`; task.touch(); }
    if (loader === 'fabric') return loaders.installFabric(mcVersion, loaderVersion, { task, signal });
    if (loader === 'quilt') return loaders.installQuilt(mcVersion, loaderVersion, { task, signal });
    if (loader === 'forge') return loaders.installForge(mcVersion, loaderVersion, { task, signal });
    if (loader === 'neoforge') return loaders.installNeoForge(mcVersion, loaderVersion, { task, signal });
    throw new Error('不支持的加载器: ' + loader);
}

/** 安装 Modrinth 整合包 */
async function installMrpack(file, opts = {}) {
    const { task, signal } = opts;
    const index = await readZipJson(file, 'modrinth.index.json');
    if (!index) throw new Error('无效的 .mrpack 文件（缺少 modrinth.index.json）');
    const deps = index.dependencies || {};
    const mcVersion = deps.minecraft;
    const loaderKey = LOADER_KEYS.find((k) => deps[k]);
    const loader = loaderKey ? loaderKey.replace('-loader', '') : 'vanilla';
    const loaderVersion = loaderKey ? deps[loaderKey] : '';
    const base = await ensureBaseVersion(mcVersion, loader, loaderVersion, { task, signal });

    const packName = safeName(opts.name || index.name || path.basename(file, '.mrpack'));
    const pack = await createPackVersion(packName, {
        inheritsFrom: base.id, mcVersion, loader, loaderVersion, source: 'modrinth',
        icon: opts.icon,
    });
    const gameDir = pack.dir;

    // 下载 pack 声明的文件
    const files = (index.files || []).filter((f) => !f.env || f.env.client !== 'unsupported');
    const downloads = [];
    for (const f of files) {
        const rel = String(f.path || '').replace(/\\/g, '/');
        if (!rel || rel.includes('..')) continue;
        const url = (f.downloads || []).find((u) => /^https?:/i.test(u));
        if (!url) continue;
        downloads.push({
            url,
            dest: path.join(gameDir, rel),
            size: f.fileSize || 0,
            sha1: f.hashes?.sha1 || null,
            name: rel,
        });
    }
    if (task) {
        task.phase = 'files';
        task.total = downloads.length;
        task.current = 0;
        task.detail = `共 ${downloads.length} 个文件`;
        task.touch();
    }
    await downloadBatch(downloads, {
        concurrency: 6,
        signal,
        onProgress: (p) => {
            if (!task) return;
            task.current = p.current;
            task.bytesDone = p.bytesDone;
            task.bytesTotal = p.bytesTotal;
            task.detail = String(p.currentFile || '').slice(0, 80);
            task.touch();
        },
    });
    if (signal?.aborted) throw new Error('已取消');

    // 解压 overrides / client-overrides
    if (task) { task.phase = 'overrides'; task.detail = '正在解压覆盖文件…'; task.total = 0; task.current = 0; task.touch(); }
    await extractZip(file, gameDir, {
        prefix: 'overrides/',
        filter: (n) => n.startsWith('overrides/') && !n.startsWith('server-overrides/'),
    });
    await extractZip(file, gameDir, {
        prefix: 'client-overrides/',
        filter: (n) => n.startsWith('client-overrides/'),
    });
    await writeJson(path.join(pack.dir, 'modrinth.index.json'), index);
    return { id: pack.id, dir: pack.dir, mcVersion, loader, loaderVersion, files: downloads.length, name: packName };
}

/** 安装 CurseForge 整合包（无需 API Key，走 CurseForge 官网公开接口下载模组文件） */
async function installCurseForgeZip(file, opts = {}) {
    const { task, signal } = opts;
    const manifest = await readZipJson(file, 'manifest.json');
    if (!manifest) throw new Error('无效的 CurseForge 整合包（缺少 manifest.json）');
    const mcVersion = manifest.minecraft?.version;
    const ml = (manifest.minecraft?.modLoaders || [])[0];
    const loaderId = ml?.id || '';
    const loader = loaderId.startsWith('forge') ? 'forge' : loaderId.startsWith('fabric') ? 'fabric'
        : loaderId.startsWith('neoforge') ? 'neoforge' : loaderId.startsWith('quilt') ? 'quilt' : 'vanilla';
    const loaderVersion = loaderId.replace(/^(forge|fabric|neoforge|quilt)-?/i, '');
    const base = await ensureBaseVersion(mcVersion, loader, loaderVersion, { task, signal });

    const packName = safeName(opts.name || manifest.name || path.basename(file, '.zip'));
    const pack = await createPackVersion(packName, {
        inheritsFrom: base.id, mcVersion, loader, loaderVersion, source: 'curseforge', icon: opts.icon,
    });

    if (task) { task.phase = 'overrides'; task.detail = '正在解压覆盖文件…'; task.touch(); }
    const overridesDir = manifest.overrides || 'overrides';
    await extractZip(file, pack.dir, { prefix: overridesDir + '/' });

    const cfFiles = manifest.files || [];
    const modsDir = path.join(pack.dir, 'mods');
    await ensureDirAsync(modsDir);
    let downloaded = 0;
    let skipped = 0;
    if (task) {
        task.phase = 'files';
        task.total = cfFiles.length;
        task.current = 0;
        task.detail = '正在下载整合包模组…';
        task.touch();
    }
    const { runPool } = require('./fsutil');
    await runPool(cfFiles, 4, async (f) => {
        if (signal?.aborted) throw new Error('已取消');
        try {
            const res = await curseforge.downloadModFile(f.projectID, f.fileID, modsDir, {
                signal,
                onProgress: (delta) => {
                    if (!task) return;
                    task.bytesDone = (task.bytesDone || 0) + delta;
                    task.touch();
                },
            });
            if (res.skipped) skipped++;
            else downloaded++;
        } catch (e) {
            skipped++;
            log.warn(`CurseForge 文件下载失败 ${f.projectID}/${f.fileID}: ${e.message}`);
        }
        if (task) { task.current++; task.touch(); }
    });
    if (signal?.aborted) throw new Error('已取消');
    const warning = skipped > 0
        ? `有 ${skipped} 个模组文件未能自动下载（可能作者关闭了第三方下载），可从 CurseForge 手动下载后放进 mods 文件夹`
        : null;
    if (warning) log.warn(warning);
    return {
        id: pack.id, dir: pack.dir, mcVersion, loader, loaderVersion,
        files: downloaded, skipped, warning,
    };
}

/** 安装通用压缩包（含 PCL / HMCL 导出、直接包含 .minecraft 结构的包） */
async function installGenericZip(file, opts = {}) {
    const { task, signal } = opts;
    const entries = await listZip(file);
    const names = entries.map((e) => e.name.replace(/\\/g, '/'));
    const hasDotMinecraft = names.some((n) => n.startsWith('.minecraft/'));
    const versionEntry = names.find((n) => /^(\.minecraft\/)?versions\/[^/]+\/[^/]+\.json$/i.test(n));
    const prefix = hasDotMinecraft ? '.minecraft/' : '';
    const packName = safeName(opts.name || path.basename(file, path.extname(file)));

    let versionJson = null;
    let baseVersion = opts.baseVersion || '';
    if (versionEntry) {
        versionJson = await readZipJson(file, versionEntry);
        if (!baseVersion) baseVersion = versionJson?.inheritsFrom || versionJson?.id || '';
    }
    if (!baseVersion) throw new Error('无法从压缩包判断游戏版本，请先安装一个原版版本，并在安装时指定它');

    // 确保基础版本存在
    if (task) { task.phase = 'loader'; task.detail = `正在准备基础版本 ${baseVersion}`; task.touch(); }
    if (!isDir(path.join(paths.versionsDir, baseVersion))) {
        await installVersion(baseVersion, { task, signal });
    }

    const pack = await createPackVersion(packName, {
        inheritsFrom: baseVersion,
        mcVersion: versionJson?.minecraftVersion || baseVersion,
        loader: versionJson?.loader || 'vanilla',
        loaderVersion: '',
        source: 'export',
        icon: opts.icon,
    });

    if (task) { task.phase = 'overrides'; task.detail = '正在解压整合包…'; task.touch(); }
    await extractZip(file, pack.dir, {
        prefix,
        filter: (n) => {
            // 忽略原版本 JSON / jar，本启动器使用自己的继承版本
            if (/^versions\/[^/]+\/[^/]+\.(json|jar)$/i.test(n)) return false;
            return true;
        },
    });
    // 用 pack 自己的版本 JSON 覆盖（保留继承关系）
    await writeJson(path.join(pack.dir, pack.id + '.json'), {
        id: pack.id,
        inheritsFrom: baseVersion,
        name: pack.id,
        type: 'release',
        minecraftVersion: versionJson?.minecraftVersion || baseVersion,
        loader: versionJson?.loader || 'vanilla',
        modpack: { source: 'export', installedAt: new Date().toISOString(), originalName: packName },
    });
    return { id: pack.id, dir: pack.dir, mcVersion: baseVersion, loader: versionJson?.loader || 'vanilla', files: entries.length, name: packName };
}

/** 从 Modrinth 下载并安装整合包 */
async function installFromModrinth(project, version, opts = {}) {
    const file = modrinth.primaryFile(version);
    if (!file) throw new Error('整合包没有可下载文件');
    const dest = path.join(paths.cacheDir, 'modpacks', file.filename);
    await ensureDirAsync(path.dirname(dest));
    if (opts.task) { opts.task.phase = 'modpack'; opts.task.detail = '正在下载整合包…'; opts.task.touch(); }
    await downloadFile(file.url, dest, {
        size: file.size, signal: opts.signal, retries: 3,
        onProgress: (delta, written) => {
            if (!opts.task) return;
            opts.task.bytesDone = written;
            opts.task.bytesTotal = file.size;
            opts.task.touch();
        },
    });
    const result = await installMrpack(dest, {
        ...opts,
        name: opts.name || project?.title,
        icon: opts.icon || project?.icon,
    });
    return { ...result, projectId: project?.id, versionId: version?.id, summary: project?.description };
}

/** 统一入口 */
async function installPack(file, opts = {}) {
    const info = await detectPack(file);
    if (info.kind === 'mrpack') return installMrpack(file, { ...opts, name: opts.name || info.name, icon: opts.icon });
    if (info.kind === 'curseforge') return installCurseForgeZip(file, { ...opts, name: opts.name || info.name, icon: opts.icon });
    return installGenericZip(file, { ...opts, name: opts.name || info.name, icon: opts.icon });
}

module.exports = {
    detectPack, installPack, installMrpack, installCurseForgeZip, installGenericZip,
    installFromModrinth, createPackVersion, ensureBaseVersion,
};
