'use strict';
/**
 * 路径管理：启动器数据目录、游戏目录、各类缓存/日志目录。
 * 通过 initPaths 注入（Electron 主进程传入 app.getPath('userData')），
 * 也支持纯 Node 环境测试。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const state = {
    dataDir: null,
    gameDir: null,
    initialized: false,
};

function defaultDataDir() {
    if (process.env.PCLN_DATA_DIR) return process.env.PCLN_DATA_DIR;
    const base = process.env.APPDATA || path.join(os.homedir(), '.config');
    return path.join(base, 'PlainCraftLauncher');
}

function defaultGameDir() {
    if (process.env.PCLN_GAME_DIR) return process.env.PCLN_GAME_DIR;
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
    }
    return path.join(os.homedir(), '.minecraft');
}

function ensureDir(dir) {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
}

function initPaths(opts = {}) {
    state.dataDir = process.env.PCLN_DATA_DIR
        ? path.resolve(process.env.PCLN_DATA_DIR)
        : opts.dataDir ? path.resolve(opts.dataDir) : defaultDataDir();
    state.gameDir = process.env.PCLN_GAME_DIR
        ? path.resolve(process.env.PCLN_GAME_DIR)
        : opts.gameDir ? path.resolve(opts.gameDir) : defaultGameDir();
    state.initialized = true;
    for (const d of [state.dataDir, paths.logsDir, paths.cacheDir, paths.assetsCacheDir]) ensureDir(d);
    return paths;
}

function getDataDir() {
    if (!state.initialized) initPaths();
    return state.dataDir;
}

function getGameDir() {
    if (!state.initialized) initPaths();
    return state.gameDir;
}

function setGameDir(dir) {
    state.gameDir = path.resolve(dir);
    ensureDir(state.gameDir);
    return state.gameDir;
}

/** 常用子路径集合（惰性求值，避免循环依赖） */
const paths = {};
Object.defineProperties(paths, {
    dataDir: { get: () => getDataDir() },
    gameDir: { get: () => getGameDir() },
    configFile: { get: () => path.join(getDataDir(), 'config.json') },
    versionsDir: { get: () => path.join(getGameDir(), 'versions') },
    librariesDir: { get: () => path.join(getGameDir(), 'libraries') },
    assetsDir: { get: () => path.join(getGameDir(), 'assets') },
    logsDir: { get: () => path.join(getDataDir(), 'logs') },
    cacheDir: { get: () => path.join(getDataDir(), 'cache') },
    assetsCacheDir: { get: () => path.join(getDataDir(), 'cache', 'assets') },
    metaCacheDir: { get: () => path.join(getDataDir(), 'cache', 'meta') },
    javaDir: { get: () => path.join(getDataDir(), 'java') },
    packsDir: { get: () => path.join(getGameDir(), 'packs') },
});

/** 某个版本的目录 */
function versionDir(id) {
    return path.join(getGameDir(), 'versions', id);
}

/** 某个版本隔离后的游戏目录（整合包隔离模式会用到） */
function versionGameDir(id) {
    return path.join(getGameDir(), 'versions', id);
}

function safeFileName(name, fallback = 'untitled') {
    const s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
    return s || fallback;
}

module.exports = {
    initPaths, getDataDir, getGameDir, setGameDir, paths, versionDir, versionGameDir,
    ensureDir, defaultGameDir, defaultDataDir, safeFileName,
};
