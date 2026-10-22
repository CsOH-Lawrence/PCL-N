'use strict';
/**
 * 游戏本体安装：客户端 jar、依赖库、资源文件、资源索引（含老版本 virtual 资源映射）。
 * 同时负责“校验并修复”与加载器版本（继承版本）的文件安装。
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { paths } = require('./paths');
const { downloadFile, downloadBatch, fetchJson, candidates } = require('./http');
const {
    getVersionManifest, fetchVersionJson, resolveVersionJson, resolveLibraries, assetObjectPath, assetUrl,
} = require('./mojang');
const { ensureDirAsync, exists, writeJson, readJson, readJsonSync, size, isFile, runPool } = require('./fsutil');
const { extractZip } = require('./zip');
const { createLogger } = require('./log');

const log = createLogger('install');

const NATIVE_EXCLUDE = [
    'META-INF/', 'EXCLUDE', '.git', '.svn', 'md5', 'sha1',
];
const NATIVE_ALLOWED = ['.dll', '.so', '.dylib', '.jnilib'];

function versionDir(id) { return path.join(paths.versionsDir, id); }
function versionJsonPath(id) { return path.join(versionDir(id), id + '.json'); }
function versionJarPath(id) { return path.join(versionDir(id), id + '.jar'); }
function nativesDir(id) { return path.join(versionDir(id), 'natives'); }

/** 读取版本链（从子到父的原始 JSON 数组） */
async function readChain(id) {
    const chain = [];
    const seen = new Set();
    let current = null;
    const localFile = versionJsonPath(id);
    if (isFile(localFile)) current = readJsonSync(localFile);
    if (!current) current = await fetchVersionJson(id);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        chain.push(current);
        if (!current.inheritsFrom) break;
        const parentFile = versionJsonPath(current.inheritsFrom);
        current = isFile(parentFile) ? readJsonSync(parentFile) : await fetchVersionJson(current.inheritsFrom).catch(() => null);
    }
    return chain;
}

/** 收集安装计划：客户端 jar、依赖库、natives、资源文件清单 */
async function buildInstallPlan(id) {
    const chain = await readChain(id);
    if (!chain.length) throw new Error('找不到版本 ' + id);
    const merged = await resolveVersionJson(id);

    const clientDownloads = [];
    for (const raw of chain) {
        if (raw.downloads?.client?.url) {
            clientDownloads.push({
                url: raw.downloads.client.url,
                dest: versionJarPath(raw.id),
                size: raw.downloads.client.size || 0,
                sha1: raw.downloads.client.sha1 || null,
                name: `${raw.id}.jar`,
                versionId: raw.id,
            });
        }
    }

    const allLibs = [];
    for (const raw of [...chain].reverse()) {
        if (Array.isArray(raw.libraries)) allLibs.push(...raw.libraries);
    }
    const resolved = resolveLibraries(allLibs, { features: merged.json.features || {} });
    const libFiles = resolved.downloads.map((d) => ({
        url: d.url,
        dest: path.join(paths.librariesDir, d.path),
        size: d.size || 0,
        sha1: d.sha1 || null,
        name: d.path,
    }));
    const nativeFiles = resolved.natives.map((d) => ({
        url: d.url,
        dest: path.join(paths.librariesDir, d.path),
        size: d.size || 0,
        sha1: d.sha1 || null,
        name: d.path,
        native: true,
    }));

    // 资源索引
    let assetObjects = [];
    let assetIndexFile = null;
    const indexInfo = merged.json.assetIndex;
    if (indexInfo?.id) {
        assetIndexFile = path.join(paths.assetsDir, 'indexes', indexInfo.id + '.json');
        const indexJson = await loadAssetIndex(indexInfo, assetIndexFile);
        assetObjects = Object.entries(indexJson.objects || {}).map(([name, obj]) => ({
            name,
            hash: obj.hash,
            size: obj.size || 0,
        }));
    }

    return {
        id,
        merged: merged.json,
        chain,
        clientFiles: clientDownloads,
        libFiles,
        nativeFiles,
        assetObjects,
        assetIndexFile,
        assetIndexInfo: indexInfo || null,
        nativeJars: resolved.natives,
        classpath: resolved.classpath,
    };
}

/** 确保资源索引文件就绪，返回索引 JSON */
async function loadAssetIndex(indexInfo, file) {
    if (isFile(file) && size(file) > 100) {
        try {
            const { readJsonSync } = require('./fsutil');
            const cached = readJsonSync(file);
            if (cached && cached.objects) return cached;
        } catch { /* 重新下载 */ }
    }
    const urls = [indexInfo.url];
    if (indexInfo.url) urls.push(indexInfo.url.replace('https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com'));
    const json = await fetchJson(indexInfo.url, { urls, retries: 3, timeoutMs: 30000 });
    await writeJson(file, json, false);
    return json;
}

class Progress {
    constructor(task) {
        this.task = task;
        this.files = [];
        this.bytes = 0;
        this.done = 0;
        this.total = 0;
        this.totalBytes = 0;
    }
    addPlan(files) {
        for (const f of files) { this.files.push(f); this.totalBytes += f.size || 0; }
        this.total = this.files.length;
        if (this.task) {
            this.task.total = this.total;
            this.task.bytesTotal = this.totalBytes;
            this.task.current = this.done;
            this.task.touch();
        }
    }
    phase(name) {
        if (this.task) { this.task.phase = name; this.task.touch(); }
    }
    bump(bytes) {
        this.done++;
        this.bytes += bytes || 0;
        if (this.task) {
            this.task.current = this.done;
            this.task.bytesDone = this.bytes;
            this.task.touch();
        }
    }
}

/** 解压 natives */
async function extractNatives(nativeJars, targetDir) {
    await ensureDirAsync(targetDir);
    let count = 0;
    for (const jar of nativeJars) {
        const file = path.join(paths.librariesDir, jar.path);
        if (!isFile(file)) continue;
        try {
            await extractZip(file, targetDir, {
                filter: (name) => {
                    const lower = name.toLowerCase();
                    if (NATIVE_EXCLUDE.some((ex) => name.startsWith(ex))) return false;
                    return NATIVE_ALLOWED.some((ext) => lower.endsWith(ext));
                },
            });
            count++;
        } catch (e) {
            log.warn('解压 natives 失败 ' + jar.path, e);
        }
    }
    return count;
}

/**
 * 安装 / 修复一个版本。
 * @param {string} id 版本 ID
 * @param {object} options { task, signal, verifyAll }
 */
async function installVersion(id, options = {}) {
    const { task, signal } = options;
    const progress = new Progress(task);
    if (task) { task.phase = 'meta'; task.detail = '正在获取版本信息…'; task.touch(); }

    const plan = await buildInstallPlan(id);
    // 落盘版本 JSON（保持原始链）
    for (const raw of plan.chain) {
        await writeJson(versionJsonPath(raw.id), raw);
    }
    for (const c of plan.clientFiles) {
        await ensureDirAsync(path.dirname(c.dest));
    }

    if (task) {
        task.detail = `Minecraft ${plan.merged.id}`;
    }

    // 1) 客户端 jar
    progress.phase('client');
    for (const f of plan.clientFiles) {
        await downloadFile(f.url, f.dest, {
            size: f.size, sha1: f.sha1, signal,
            urls: require('./http').versionClientUrls(f.versionId, f.url),
            retries: 2,
        });
        progress.bump(f.size);
    }

    // 2) 依赖库
    progress.addPlan([...plan.libFiles, ...plan.nativeFiles]);
    progress.phase('libraries');
    const libs = [...plan.libFiles, ...plan.nativeFiles];
    if (task) { task.total = progress.total; task.touch(); }
    await downloadBatch(libs, {
        concurrency: 8,
        signal,
        onProgress: (p) => {
            if (!task) return;
            task.bytesDone = p.bytesDone;
            task.current = p.current;
            task.detail = p.currentFile ? String(p.currentFile).slice(0, 80) : '';
            task.touch();
        },
    });
    if (signal?.aborted) throw new Error('已取消');
    progress.done = libs.length;
    progress.bytes = task?.bytesDone || 0;

    // 3) 解压 natives
    if (plan.nativeJars.length) {
        progress.phase('libraries');
        await extractNatives(plan.nativeJars, nativesDir(id));
    }

    // 4) 资源文件
    if (plan.assetObjects.length) {
        progress.addPlan(plan.assetObjects.map((o) => ({
            url: assetUrl(o.hash),
            dest: path.join(paths.assetsDir, 'objects', assetObjectPath(o.hash)),
            size: o.size,
            name: o.name,
        })));
        progress.phase('assets');
        if (task) { task.total = progress.total; task.touch(); }
        const assetFs = plan.assetObjects.map((o) => ({
            url: assetUrl(o.hash),
            dest: path.join(paths.assetsDir, 'objects', assetObjectPath(o.hash)),
            size: o.size,
            name: o.name,
        }));
        let base = task?.bytesDone || 0;
        let baseCurrent = plan.libFiles.length + plan.nativeFiles.length;
        await downloadBatch(assetFs, {
            concurrency: 12,
            signal,
            onProgress: (p) => {
                if (!task) return;
                task.bytesDone = base + p.bytesDone;
                task.current = baseCurrent + p.current;
                task.touch();
            },
        });
        if (signal?.aborted) throw new Error('已取消');

        // 老版本资源映射
        if (plan.assetIndexInfo?.virtual) {
            await linkVirtualAssets(plan.assetIndexInfo.id, plan.assetObjects);
        } else if (plan.assetIndexInfo?.map_to_resources) {
            await linkLegacyResources(plan.assetIndexInfo.id, plan.assetObjects);
        }
    }

    // 5) 日志配置（1.12+ 的 log4j 配置）
    if (plan.merged.logging?.client?.file?.url) {
        const lf = plan.merged.logging.client.file;
        const dest = path.join(paths.assetsDir, 'log_configs', lf.id || 'client.xml');
        await downloadFile(lf.url, dest, { size: lf.size || 0, sha1: lf.sha1 || null, signal }).catch(() => {});
    }

    // 安装标记
    await writeJson(path.join(versionDir(id), '.pcln-installed.json'), {
        id,
        installedAt: new Date().toISOString(),
        files: progress.total,
        version: '1.0',
    });

    if (task) {
        task.phase = 'finished';
        task.current = task.total;
        task.bytesDone = task.bytesTotal || task.bytesDone;
        task.touch();
    }
    log.info(`版本 ${id} 安装完成，共 ${progress.total} 个文件`);
    return { id, files: progress.total, bytes: progress.bytes };
}

/** 老版本资源：objects → assets/virtual/<index> */
async function linkVirtualAssets(indexName, objects) {
    const dir = path.join(paths.assetsDir, 'virtual', indexName);
    await ensureDirAsync(dir);
    await runPool(objects, 8, async (o) => {
        const src = path.join(paths.assetsDir, 'objects', assetObjectPath(o.hash));
        const dest = path.join(dir, o.name);
        if (!isFile(src)) return;
        await ensureDirAsync(path.dirname(dest));
        await fsp.copyFile(src, dest).catch(() => {});
    });
}

/** 极老版本：objects → assets/minecraft 结构 */
async function linkLegacyResources(indexName, objects) {
    const dir = path.join(paths.assetsDir, 'minecraft');
    await runPool(objects, 8, async (o) => {
        const src = path.join(paths.assetsDir, 'objects', assetObjectPath(o.hash));
        const dest = path.join(dir, o.name);
        if (!isFile(src)) return;
        await ensureDirAsync(path.dirname(dest));
        await fsp.copyFile(src, dest).catch(() => {});
    });
}

/** 校验：返回缺失 / 尺寸不符的文件数量 */
async function verifyVersion(id) {
    const plan = await buildInstallPlan(id);
    const problems = [];
    const check = (files) => {
        for (const f of files) {
            const s = size(f.dest);
            if (s < 0) problems.push({ path: f.dest, reason: 'missing' });
            else if (f.size && s !== f.size) problems.push({ path: f.dest, reason: 'size' });
        }
    };
    check(plan.clientFiles);
    check(plan.libFiles);
    check(plan.assetObjects.map((o) => ({ dest: path.join(paths.assetsDir, 'objects', assetObjectPath(o.hash)), size: o.size })));
    return { id, problems, total: plan.clientFiles.length + plan.libFiles.length + plan.assetObjects.length };
}

module.exports = {
    installVersion, buildInstallPlan, verifyVersion, readChain, extractNatives,
    versionDir, versionJsonPath, versionJarPath, nativesDir, loadAssetIndex,
};
