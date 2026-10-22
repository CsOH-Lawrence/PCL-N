'use strict';
/** preload：向渲染进程暴露受控 API */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const listeners = new Map();
function on(channel, handler) {
    const wrapped = (_e, data) => handler(data);
    ipcRenderer.on(channel, wrapped);
    listeners.set(handler, { channel, wrapped });
    return () => {
        ipcRenderer.removeListener(channel, wrapped);
        listeners.delete(handler);
    };
}

contextBridge.exposeInMainWorld('pcln', {
    // 基础信息
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url),
    logFile: () => invoke('app:logFile'),
    logs: (limit) => invoke('app:logs', limit),

    // 窗口控制
    windowMinimize: () => invoke('window:minimize'),
    windowMaximize: () => invoke('window:maximize'),
    windowClose: () => invoke('window:close'),
    windowState: () => invoke('window:state'),
    onWindowState: (cb) => on('window:state', cb),

    // 配置
    configGet: () => invoke('config:get'),
    configSet: (patch) => invoke('config:set', patch),
    versionSettingsGet: (id) => invoke('config:versionGet', id),
    versionSettingsSet: (id, patch) => invoke('config:versionSet', { id, patch }),

    // 版本
    versions: () => invoke('versions:list'),
    versionDetail: (id) => invoke('versions:detail', id),
    versionDelete: (id, onlySettings) => invoke('versions:delete', { id, onlySettings }),
    versionRename: (id, name) => invoke('versions:rename', { id, name }),
    versionIcon: (id) => invoke('versions:icon', id),
    installVanilla: (id) => invoke('versions:install', { id }),
    verifyVersion: (id) => invoke('versions:verify', { id }),
    installLoader: (payload) => invoke('versions:installLoader', payload),
    loaderVersions: (loader, mc) => invoke('loaders:versions', { loader, mc }),

    // 模组 / 资源包 / 光影 / 数据包
    mods: (id) => invoke('mods:list', id),
    modToggle: (filePath) => invoke('mods:toggle', filePath),
    modDelete: (filePath) => invoke('mods:delete', filePath),
    resourcePacks: (id) => invoke('packs:resource', id),
    shaderPacks: (id) => invoke('packs:shader', id),
    datapacks: (id, world) => invoke('packs:datapack', { id, world }),
    saves: (id) => invoke('saves:list', id),

    // 账号 / 自动登录
    authState: () => invoke('auth:state'),
    authAddOffline: (name) => invoke('auth:addOffline', { name }),
    authMsLogin: () => invoke('auth:msLogin'),
    authSelect: (id) => invoke('auth:select', { id }),
    authRemove: (id) => invoke('auth:remove', { id }),
    authRefresh: (id) => invoke('auth:refresh', { id }),
    authAutoLogin: (value) => invoke('auth:autoLogin', { value }),
    onAuthState: (cb) => on('auth:state', cb),
    onAuthRefresh: (cb) => on('auth:refresh', cb),

    // 下载
    manifest: (force) => invoke('download:manifest', force),
    searchProjects: (opts) => invoke('modrinth:search', opts),
    gameVersions: () => invoke('modrinth:gameVersions'),
    projectInfo: (id) => invoke('modrinth:project', id),
    projectVersions: (id, opts) => invoke('modrinth:versions', { id, ...opts }),
    installProject: (payload) => invoke('modrinth:install', payload),
    installModpack: (payload) => invoke('modpack:install', payload),
    chooseFile: (opts) => invoke('dialog:openFile', opts),
    detectModpack: (file) => invoke('modpack:detect', file),
    installModpackFile: (payload) => invoke('modpack:installFile', payload),
    installJava: (major) => invoke('java:download', major),
    listJava: (force) => invoke('java:list', force),

    // 启动
    launch: (versionId, opts) => invoke('launch:start', { versionId, opts }),
    killGame: () => invoke('launch:kill'),
    running: () => invoke('launch:running'),

    // 任务
    taskList: () => invoke('task:list'),
    taskCancel: (id) => invoke('task:cancel', id),
    taskClear: () => invoke('task:clear'),

    // 帮助
    analyze: (payload) => invoke('help:analyze', payload),
    analyzeText: (text) => invoke('help:analyzeText', text),
    openLog: () => invoke('help:openLog'),
    helpKb: () => invoke('help:kb'),
    pickCrash: () => invoke('help:pickCrash'),

    // 系统
    openPath: (p) => invoke('shell:openPath', p),
    showItem: (p) => invoke('shell:showItem', p),
    chooseDir: (opts) => invoke('dialog:openDir', opts),

    // 事件
    onTaskUpdate: (cb) => on('task:update', cb),
    onTaskResult: (cb) => on('task:result', cb),
    onLaunchLog: (cb) => on('launch:log', cb),
    onLaunchExit: (cb) => on('launch:exit', cb),
    onLaunchStarted: (cb) => on('launch:started', cb),
    onLogLine: (cb) => on('log:line', cb),
    onToast: (cb) => on('app:toast', cb),
});
