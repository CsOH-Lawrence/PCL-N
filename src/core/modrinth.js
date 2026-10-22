'use strict';
/**
 * Modrinth 集成：搜索项目、查询版本、下载并安装模组 / 整合包 / 资源包 / 光影 / 数据包。
 */
const path = require('path');
const { fetchJson, downloadFile } = require('./http');
const { createLogger } = require('./log');
const { ensureDirAsync, isFile, size } = require('./fsutil');

const log = createLogger('modrinth');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'PlainCraftLauncherN/1.0 (Minecraft launcher)' };

const FOLDER = {
    mod: 'mods',
    modpack: 'modpacks',
    resourcepack: 'resourcepacks',
    shader: 'shaderpacks',
    datapack: 'datapacks',
    plugin: 'plugins',
};

const TYPE_TEXT = {
    mod: '模组', modpack: '整合包', resourcepack: '资源包', shader: '光影', datapack: '数据包', plugin: '插件',
};

let tagCache = { at: 0, gameVersions: [], loaders: [], categories: [] };

async function getTags() {
    if (Date.now() - tagCache.at < 10 * 60 * 1000) return tagCache;
    const [gameVersions, loaders, categories] = await Promise.all([
        fetchJson(`${API}/tag/game_version`, { headers: HEADERS, retries: 2 }).catch(() => []),
        fetchJson(`${API}/tag/loader`, { headers: HEADERS, retries: 2 }).catch(() => []),
        fetchJson(`${API}/tag/category`, { headers: HEADERS, retries: 2 }).catch(() => []),
    ]);
    tagCache = {
        at: Date.now(),
        gameVersions: (gameVersions || []).filter((v) => v.version_type !== 'old_beta' || true),
        loaders: loaders || [],
        categories: categories || [],
    };
    return tagCache;
}

async function getGameVersions() {
    const tags = await getTags();
    const releases = tags.gameVersions.filter((v) => v.version_type === 'release');
    return releases.map((v) => ({ version: v.version, type: v.version_type, major: v.major, date: v.date }));
}

/**
 * 搜索项目
 * @param {object} opts { query, projectType, gameVersion, loader, categories, limit, offset, sort }
 */
async function search(opts = {}) {
    const facets = [];
    if (opts.projectType) facets.push([`project_type:${opts.projectType}`]);
    if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
    if (opts.loader) facets.push([`categories:${opts.loader}`]);
    for (const c of opts.categories || []) facets.push([`categories:${c}`]);
    const params = new URLSearchParams();
    params.set('query', opts.query || '');
    params.set('limit', String(opts.limit || 20));
    params.set('offset', String(opts.offset || 0));
    params.set('index', opts.sort || 'relevance');
    params.set('facets', JSON.stringify(facets));
    const url = `${API}/search?${params.toString()}`;
    const data = await fetchJson(url, { headers: HEADERS, retries: 2, timeoutMs: 15000 });
    return {
        hits: (data.hits || []).map(normalizeHit),
        total: data.total_hits || 0,
        offset: data.offset || 0,
        limit: data.limit || 20,
    };
}

function normalizeHit(h) {
    return {
        id: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        author: h.author,
        type: h.project_type,
        categories: h.categories || [],
        downloads: h.downloads || 0,
        followers: h.followers || 0,
        icon: h.icon_url,
        versions: h.versions || [],
        gameVersions: h.versions || [],
        clientSide: h.client_side,
        serverSide: h.server_side,
        license: h.license,
        updated: h.date_modified,
    };
}

async function getProject(idOrSlug) {
    const p = await fetchJson(`${API}/project/${encodeURIComponent(idOrSlug)}`, { headers: HEADERS, retries: 2 });
    return {
        ...normalizeHit(p),
        id: p.id,
        body: p.body || '',
        gallery: (p.gallery || []).map((g) => g.url),
        sourceUrl: p.source_url,
        issuesUrl: p.issues_url,
        wikiUrl: p.wiki_url,
        discordUrl: p.discord_url,
        donationUrls: p.donation_urls || [],
        loaders: p.loaders || [],
    };
}

/** 某项目的版本列表 */
async function listVersions(idOrSlug, opts = {}) {
    const params = new URLSearchParams();
    if (opts.gameVersion) params.set('game_versions', JSON.stringify([opts.gameVersion]));
    if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
    const q = params.toString();
    const versions = await fetchJson(`${API}/project/${encodeURIComponent(idOrSlug)}/version${q ? '?' + q : ''}`, {
        headers: HEADERS, retries: 2, timeoutMs: 15000,
    });
    if (!Array.isArray(versions)) return [];
    return versions.map(normalizeVersion);
}

function normalizeVersion(v) {
    return {
        id: v.id,
        name: v.name,
        versionNumber: v.version_number,
        gameVersions: v.game_versions || [],
        loaders: v.loaders || [],
        type: v.version_type,
        date: v.date_published,
        downloads: v.downloads || 0,
        files: (v.files || []).map((f) => ({
            url: f.url, filename: f.filename, size: f.size, primary: !!f.primary, hashes: f.hashes || {},
        })),
        dependencies: (v.dependencies || []).map((d) => ({
            projectId: d.project_id, versionId: d.version_id, type: d.dependency_type,
        })),
    };
}

async function getVersion(versionId) {
    const v = await fetchJson(`${API}/version/${encodeURIComponent(versionId)}`, { headers: HEADERS, retries: 2 });
    return normalizeVersion(v);
}

function primaryFile(version) {
    if (!version?.files?.length) return null;
    return version.files.find((f) => f.primary) || version.files[0];
}

function folderForType(type) {
    return FOLDER[type] || 'mods';
}

function safeName(name) {
    return String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/**
 * 下载项目文件到指定目录。
 * @param {object} opts { project, version, targetDir, task, signal, recursive }
 */
async function installProject(opts) {
    const { project, version, targetDir, signal } = opts;
    const file = primaryFile(version);
    if (!file) throw new Error('该项目没有可下载的文件');
    await ensureDirAsync(targetDir);
    const dest = path.join(targetDir, safeName(file.filename));
    const existed = isFile(dest) && size(dest) === file.size;
    await downloadFile(file.url, dest, {
        size: file.size,
        signal,
        retries: 3,
        onProgress: opts.onProgress,
    });
    let deps = [];
    if (opts.recursive !== false && version.dependencies?.length) {
        deps = await installDependencies(version.dependencies, {
            targetDir, signal, seen: new Set([project.id, project.slug]), version, depth: 1,
        });
    }
    return {
        file: dest,
        filename: file.filename,
        skipped: existed,
        dependencies: deps,
        projectId: project.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
    };
}

async function installDependencies(dependencies, ctx) {
    const installed = [];
    for (const dep of dependencies) {
        if (dep.type !== 'required') continue;
        try {
            let version = null;
            if (dep.versionId) version = await getVersion(dep.versionId);
            else if (dep.projectId) {
                const versions = await listVersions(dep.projectId, {});
                version = versions[0];
            }
            if (!version) continue;
            const project = dep.projectId ? await getProject(dep.projectId) : null;
            if (!project) continue;
            if (ctx.seen?.has(project.id) || ctx.seen?.has(project.slug)) continue;
            ctx.seen?.add(project.id);
            const depFolder = folderForType(project.type);
            const target = path.join(path.dirname(ctx.targetDir), depFolder);
            const res = await installProject({
                project, version, targetDir: target, signal: ctx.signal, recursive: false,
            });
            installed.push({ name: project.title, file: res.file, type: project.type });
            log.info(`安装依赖 ${project.title} -> ${res.filename}`);
        } catch (e) {
            log.warn('依赖安装失败: ' + (dep.projectId || dep.versionId), e);
        }
    }
    return installed;
}

/** 选择最合适的版本：优先正式版，其次与游戏版本 / 加载器精确匹配 */
function pickVersion(versions, { gameVersion, loader } = {}) {
    if (!versions.length) return null;
    let list = versions;
    if (gameVersion) list = list.filter((v) => v.gameVersions.includes(gameVersion));
    if (loader) {
        const filtered = list.filter((v) => v.loaders.some((l) => l.toLowerCase() === loader.toLowerCase()));
        if (filtered.length) list = filtered;
    }
    if (!list.length) list = versions;
    return list.find((v) => v.type === 'release') || list[0];
}

module.exports = {
    search, getProject, listVersions, getVersion, installProject, installDependencies,
    pickVersion, primaryFile, folderForType, getTags, getGameVersions, normalizeHit, normalizeVersion,
    TYPE_TEXT, FOLDER, API,
};
