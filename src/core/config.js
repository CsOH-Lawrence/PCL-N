'use strict';
/** 启动器配置：读取 / 合并默认值 / 原子写入 / 变更事件 */
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { paths } = require('./paths');
const { createLogger } = require('./log');

const log = createLogger('config');
const bus = new EventEmitter();

function defaults() {
    return {
        schema: 1,
        gameDir: paths.gameDir,
        window: { width: 1100, height: 700, maximized: false },
        java: {
            path: 'auto',            // auto | 绝对路径
            memoryMode: 'auto',      // auto | custom
            minMemory: 512,
            maxMemory: 4096,
            gc: 'auto',              // auto | g1 | zgc | serial
            extraArgs: '',
        },
        download: {
            source: 'auto',          // auto | mirror | official
            concurrency: 8,
            timeoutMs: 20000,
            retries: 3,
        },
        launch: {
            username: 'Steve',
            uuid: '',
            width: 854,
            height: 480,
            fullscreen: false,
            extraArgs: '',
            demo: false,
            jvmArgs: '',
        },
        ui: {
            theme: 'light',
            accent: 'blue',
            background: '',          // 背景图片路径
            backgroundOpacity: 0.9,
            closeAfterLaunch: 'keep', // keep | close | minimize
            musicVolume: 0,
        },
        versions: {},                // 每个版本的独立设置
        modrinth: { enabled: true },
        lastVersion: '',
        lastPage: 'home',
        firstRun: true,
    };
}

function mergeDeep(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
            out[k] = mergeDeep(base[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

let config = defaults();

function load() {
    try {
        if (fs.existsSync(paths.configFile)) {
            const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf8').replace(/^\uFEFF/, ''));
            config = mergeDeep(defaults(), raw);
            if (!config.gameDir) config.gameDir = paths.gameDir;
        } else {
            config = defaults();
            save();
        }
    } catch (e) {
        log.warn('配置文件读取失败，使用默认值', e);
        config = defaults();
    }
    return config;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
        const tmp = paths.configFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
        fs.renameSync(tmp, paths.configFile);
    } catch (e) {
        log.error('配置保存失败', e);
    }
}

function get() {
    return config;
}

function set(patch) {
    config = mergeDeep(config, patch);
    save();
    bus.emit('change', diffRoots(patch));
    return config;
}

function diffRoots(patch) {
    if (!patch || typeof patch !== 'object') return [];
    return Object.keys(patch);
}

function getVersionSettings(versionId) {
    return config.versions?.[versionId] || {};
}

function setVersionSettings(versionId, patch) {
    config.versions = config.versions || {};
    config.versions[versionId] = mergeDeep(config.versions[versionId] || {}, patch);
    save();
    bus.emit('change', ['versions']);
    return config.versions[versionId];
}

function removeVersionSettings(versionId) {
    if (config.versions?.[versionId]) {
        delete config.versions[versionId];
        save();
    }
}

/** 解析最终生效的版本设置（版本设置 > 全局设置） */
function resolved(versionId) {
    const v = getVersionSettings(versionId);
    const g = config;
    return {
        javaPath: v.javaPath || g.java.path,
        maxMemory: v.maxMemory ?? g.java.maxMemory,
        minMemory: v.minMemory ?? g.java.minMemory,
        gc: v.gc || g.java.gc,
        extraJvmArgs: [g.java.extraArgs, g.launch.jvmArgs, v.jvmArgs].filter(Boolean).join(' ').trim(),
        extraGameArgs: [g.launch.extraArgs, v.gameArgs].filter(Boolean).join(' ').trim(),
        isolation: v.isolation || 'global',
        width: v.width ?? g.launch.width,
        height: v.height ?? g.launch.height,
        username: v.username || g.launch.username,
        uuid: v.uuid || g.launch.uuid,
        demo: v.demo ?? g.launch.demo,
        fullscreen: v.fullscreen ?? g.launch.fullscreen,
    };
}

module.exports = { load, save, get, set, defaults, bus, getVersionSettings, setVersionSettings, removeVersionSettings, resolved };
