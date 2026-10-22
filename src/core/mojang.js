'use strict';
/**
 * Minecraft 版本元数据：版本清单、版本 JSON 继承合并、规则判定、依赖库解析、资源索引。
 */
const path = require('path');
const { fetchJson, versionJsonUrls, candidates } = require('./http');
const { paths } = require('./paths');
const { readJsonSync, exists } = require('./fsutil');
const { createLogger } = require('./log');

const log = createLogger('mojang');

const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MIRROR_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json';

let manifestCache = { at: 0, data: null };

async function getVersionManifest(force = false) {
    if (!force && manifestCache.data && Date.now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
    const data = await fetchJson(OFFICIAL_MANIFEST, {
        urls: [OFFICIAL_MANIFEST, MIRROR_MANIFEST],
        retries: 3,
        timeoutMs: 15000,
    });
    if (!data || !Array.isArray(data.versions)) throw new Error('版本清单格式异常');
    manifestCache = { at: Date.now(), data };
    return data;
}

function findManifestVersion(manifest, id) {
    return (manifest.versions || []).find((v) => v.id === id) || null;
}

/** 获取某个版本（远程）的 JSON，返回 { json, url } */
async function fetchVersionJson(id) {
    const manifest = await getVersionManifest().catch(() => null);
    const entry = manifest ? findManifestVersion(manifest, id) : null;
    const urls = versionJsonUrls(id, entry?.url || null);
    // 未在清单中的（如加载器版本）只尝试镜像
    return fetchJson(urls[0], { urls, retries: 2, timeoutMs: 20000 });
}

function localVersionJson(id) {
    const file = path.join(paths.versionsDir, id, id + '.json');
    if (!exists(file)) return null;
    const json = readJsonSync(file);
    if (!json) return null;
    return json;
}

/** 已安装的版本 JSON（如未安装则返回 null） */
function getInstalledVersionJson(id) {
    return localVersionJson(id);
}

/**
 * 合并继承版本（vanilla inheritsFrom、Fabric/Forge profile 的 inheritsFrom）
 * 规则参考官方启动器：libraries/arguments 父在前，标量子覆盖。
 */
function mergeVersionJson(child, parent) {
    const out = { ...parent, ...child };
    delete out.inheritsFrom;
    out.libraries = [...(parent.libraries || []), ...(child.libraries || [])];
    if (parent.arguments || child.arguments) {
        const p = parent.arguments || {};
        const c = child.arguments || {};
        out.arguments = {
            game: [...(p.game || []), ...(c.game || [])],
            jvm: [...(p.jvm || []), ...(c.jvm || [])],
        };
    }
    if (parent.minecraftArguments && !child.minecraftArguments) {
        out.minecraftArguments = parent.minecraftArguments;
    } else if (child.minecraftArguments) {
        out.minecraftArguments = child.minecraftArguments;
    }
    if (!child.assetIndex && parent.assetIndex) out.assetIndex = parent.assetIndex;
    if (!child.downloads && parent.downloads) out.downloads = parent.downloads;
    if (!child.javaVersion && parent.javaVersion) out.javaVersion = parent.javaVersion;
    if (!child.mainClass && parent.mainClass) out.mainClass = parent.mainClass;
    if (!child.type && parent.type) out.type = parent.type;
    if (!child.releaseTime && parent.releaseTime) out.releaseTime = parent.releaseTime;
    if (!child.assets && parent.assets) out.assets = parent.assets;
    // jar 指向继承的客户端 jar
    out.jar = child.jar || parent.jar || child.inheritsFrom || parent.id || child.id;
    out.id = child.id || parent.id;
    return out;
}

/**
 * 递归解析版本 JSON（自动向上查找本地 & 远程的父版本）
 * 返回 { json, chain: [id...] }
 */
async function resolveVersionJson(id) {
    const rawChain = [];
    const chainIds = [];
    const seen = new Set();
    let current = localVersionJson(id);
    if (!current) current = await fetchVersionJson(id);
    rawChain.push(current);
    chainIds.push(current.id || id);
    let merged = current;
    let parentId = current.inheritsFrom;
    while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        let parent = localVersionJson(parentId);
        if (!parent) parent = await fetchVersionJson(parentId);
        if (!parent) break;
        rawChain.push(parent);
        chainIds.push(parentId);
        merged = mergeVersionJson(merged, parent);
        parentId = parent.inheritsFrom;
    }
    merged.id = id;
    return { json: merged, chain: rawChain, chainIds, raw: current };
}

/** 解析依赖库坐标  net.fabricmc:fabric-loader:0.16.5 → net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar */
function mavenToPath(name, ext = 'jar') {
    const parts = String(name).split(':');
    if (parts.length < 3) return null;
    const [group, artifact, version] = parts;
    const classifier = parts[3] ? '-' + parts[3] : '';
    return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier}.${ext}`;
}

function getLibraryArtifact(lib) {
    if (lib.downloads?.artifact) {
        const a = lib.downloads.artifact;
        return { path: a.path || mavenToPath(lib.name), url: a.url, size: a.size, sha1: a.sha1 };
    }
    if (lib.name && lib.url) {
        const p = mavenToPath(lib.name);
        const base = lib.url.endsWith('/') ? lib.url : lib.url + '/';
        return { path: p, url: base + p, size: 0, sha1: null };
    }
    if (lib.name) {
        const p = mavenToPath(lib.name);
        return { path: p, url: `https://libraries.minecraft.net/${p}`, size: 0, sha1: null };
    }
    return null;
}

/** 规则判定（os.name / os.arch / features） */
function evaluateRules(rules, features = {}) {
    if (!rules || !rules.length) return true;
    let allowed = false;
    for (const rule of rules) {
        if (!ruleMatches(rule, features)) continue;
        allowed = rule.action === 'allow';
    }
    return allowed;
}

function ruleMatches(rule, features) {
    if (rule.os) {
        const name = { win32: 'windows', darwin: 'osx' }[process.platform] || process.platform;
        const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : process.arch;
        if (rule.os.name && rule.os.name !== name) return false;
        if (rule.os.arch && rule.os.arch !== arch) return false;
        if (rule.os.version) {
            try { if (!new RegExp(rule.os.version).test(require('os').release())) return false; } catch { /* ignore */ }
        }
    }
    if (rule.features) {
        for (const [k, v] of Object.entries(rule.features)) {
            const actual = !!features[k];
            if (actual !== !!v) return false;
        }
    }
    return true;
}

/**
 * 解析依赖库列表 → classpath + natives，并生成下载计划。
 * @returns {{ classpath: string[], nativeJars: {path:string,url:string,size:number,sha1:string}[], downloads: object[] }}
 */
function resolveLibraries(libraries, env = {}) {
    const features = env.features || {};
    const classpath = [];
    const natives = [];
    const downloads = [];
    const seen = new Set();
    for (const lib of libraries) {
        if (!evaluateRules(lib.rules, features)) continue;
        // 带 natives 的老式库：主 jar 用于 classpath，natives classifier 单独解压
        if (lib.natives) {
            const map = lib.natives;
            const osKey = { win32: 'windows', darwin: 'osx' }[process.platform] || process.platform;
            let classifier = map[osKey] || map.windows;
            if (classifier) {
                classifier = classifier.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
                const dl = lib.downloads?.classifiers?.[classifier];
                if (dl) {
                    natives.push({ path: dl.path, url: dl.url, size: dl.size, sha1: dl.sha1 });
                } else {
                    const p = mavenToPath(lib.name, 'jar')?.replace(/\.jar$/, `-${classifier}.jar`);
                    const base = lib.url || 'https://libraries.minecraft.net/';
                    if (p) natives.push({ path: p, url: base.endsWith('/') ? base + p : base + '/' + p, size: 0, sha1: null });
                }
            }
        }
        const art = getLibraryArtifact(lib);
        if (art && art.path) {
            if (!seen.has(art.path)) {
                seen.add(art.path);
                downloads.push(art);
                classpath.push(art.path);
            }
        } else if (lib.name && !lib.natives) {
            log.debug('无法解析依赖库 ' + lib.name);
        }
    }
    return { classpath, natives, downloads };
}

function assetObjectPath(hash) {
    return `${hash.slice(0, 2)}/${hash}`;
}

function assetUrl(hash) {
    return `https://resources.download.minecraft.net/${assetObjectPath(hash)}`;
}

/** 版本描述（用于界面显示） */
function describeVersion(json) {
    const libs = json.libraries || [];
    const has = (kw) => libs.some((l) => String(l.name || '').includes(kw));
    let loader = 'vanilla';
    if (has('fabric-loader')) loader = 'fabric';
    else if (has('quilt-loader')) loader = 'quilt';
    else if (has('neoforge')) loader = 'neoforge';
    else if (has('forge') || has('minecraftforge')) loader = 'forge';
    else if (has('optifine')) loader = 'optifine';
    return {
        id: json.id,
        type: json.type || 'release',
        releaseTime: json.releaseTime || null,
        time: json.time || null,
        javaVersion: json.javaVersion?.majorVersion || 8,
        mainClass: json.mainClass || '',
        assets: json.assets || 'legacy',
        loader,
        loaderVersion: json.loaderVersion || '',
        minecraftVersion: json.minecraftVersion || (/^\d/.test(json.id || '') ? String(json.id).split(/[-_ ]/)[0] : ''),
    };
}

module.exports = {
    getVersionManifest, findManifestVersion, fetchVersionJson, resolveVersionJson,
    mergeVersionJson, mavenToPath, getLibraryArtifact, evaluateRules, resolveLibraries,
    assetObjectPath, assetUrl, describeVersion, localVersionJson, getInstalledVersionJson,
    OFFICIAL_MANIFEST, MIRROR_MANIFEST, candidates,
};
