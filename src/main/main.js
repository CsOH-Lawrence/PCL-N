'use strict';
/** Electron 主进程：窗口、生命周期、IPC 注册 */
const { app, BrowserWindow, shell, dialog, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { initPaths, paths } = require('../core/paths');
const config = require('../core/config');
const httpLayer = require('../core/http');
const { createLogger, getLogFile, getLogs, bus: logBus } = require('../core/log');
const { tasks, bus: taskBus } = require('../core/tasks');
const launch = require('../core/launch');
const auth = require('../core/auth');
const { registerIpc } = require('./ipc');

const log = createLogger('main');

let mainWindow = null;
const APP_NAME = 'Plain Craft Launcher N';

// 固定数据目录，避免因 productName 导致路径变化
app.setName(APP_NAME);
if (process.env.PCLN_DATA_DIR) {
    app.setPath('userData', path.resolve(process.env.PCLN_DATA_DIR));
} else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // electron-builder 的便携版：数据放在 exe 同目录的 PCL-N-Data，实现真正的绿色版
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PCL-N-Data'));
} else {
    app.setPath('userData', path.join(app.getPath('appData'), 'PlainCraftLauncher'));
}
if (process.platform === 'win32') app.setAppUserModelId('com.pcln.launcher');

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    const cfg = config.get();
    mainWindow = new BrowserWindow({
        width: cfg.window?.width || 1100,
        height: cfg.window?.height || 700,
        minWidth: 980,
        minHeight: 620,
        frame: false,
        show: false,
        backgroundColor: '#f2f3f5',
        title: APP_NAME,
        icon: path.join(__dirname, '../../assets/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (cfg.window?.maximized) mainWindow.maximize();
        if (process.env.PCLN_SHOT_DIR) runScreenshots(mainWindow).catch((e) => { console.error(e); app.quit(); });
    });

    const saveBounds = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMaximized()) {
            config.set({ window: { maximized: true } });
            return;
        }
        const [width, height] = mainWindow.getSize();
        config.set({ window: { width, height, maximized: false } });
    };
    let saveTimer = null;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 400); };
    mainWindow.on('resize', scheduleSave);
    mainWindow.on('maximize', scheduleSave);
    mainWindow.on('unmaximize', scheduleSave);

    mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));

    mainWindow.on('closed', () => { mainWindow = null; });

    // 外链用系统浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) {
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        }
    });

    return mainWindow;
}

function broadcast(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** 开发辅助：自动截取各页面并退出（PCLN_SHOT_DIR） */
async function runScreenshots(win) {
    const dir = process.env.PCLN_SHOT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const pages = (process.env.PCLN_SHOT_PAGES || 'home,download,settings,help').split(',');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1600);
    for (const page of pages) {
        await win.webContents.executeJavaScript(
            `(function(){ try { if (window.App) { App.setPage(${JSON.stringify(page)}); } } catch (e) { return String(e); } return 'ok'; })()`
        ).catch(() => {});
        await wait(1200);
        // 让后台窗口也刷新合成帧，避免截图拿到上一帧
        win.webContents.invalidate();
        await wait(250);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, page + '.png'), img.toPNG());
        log.info('截图已保存: ' + path.join(dir, page + '.png'));
    }
    if (process.env.PCLN_SHOT_JS) {
        const result = await win.webContents.executeJavaScript(process.env.PCLN_SHOT_JS)
            .catch((e) => 'ERR: ' + (e && e.message ? e.message : String(e)));
        log.info('SHOT_JS 执行结果: ' + JSON.stringify(result));
        await wait(Number(process.env.PCLN_SHOT_WAIT || 2600));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'extra.png'), img.toPNG());
    }
    app.quit();
}

app.setName(APP_NAME);

app.whenReady().then(() => {
    // 数据目录 & 游戏目录
    const userData = app.getPath('userData');
    initPaths({ dataDir: userData });    config.load();
    // 用户在设置里改过游戏目录
    const cfg = config.get();
    if (cfg.gameDir && cfg.gameDir !== paths.gameDir) {
        const { setGameDir } = require('../core/paths');
        try { setGameDir(cfg.gameDir); } catch (e) { log.warn('游戏目录不可用: ' + cfg.gameDir); }
    }
    httpLayer.setDownloadSource(cfg.download?.source || 'auto');
    log.info(`启动器启动，数据目录: ${userData}，游戏目录: ${paths.gameDir}`);

    // 事件转发
    taskBus.on('update', (list) => broadcast('task:update', list));
    launch.bus.on('log', (e) => broadcast('launch:log', e));
    launch.bus.on('started', (e) => {
        broadcast('launch:started', e);
        const mode = config.get().ui?.closeAfterLaunch;
        if (mode === 'close') app.quit();
        else if (mode === 'minimize' && mainWindow) mainWindow.minimize();
    });
    launch.bus.on('exit', (e) => broadcast('launch:exit', e));
    logBus.on('log', (entry) => broadcast('log:line', entry));

    // 账号：变更 / 自动登录结果
    auth.bus.on('change', (state) => broadcast('auth:state', state));
    auth.bus.on('refresh', (result) => broadcast('auth:refresh', result));

    registerIpc({ getWindow: () => mainWindow, broadcast });

    createWindow();

    // 启动时自动登录（后台静默刷新微软令牌）
    auth.load();
    auth.autoLogin().then((res) => {
        if (res?.refreshed) log.info('自动登录成功：' + (res.account?.name || ''));
        else if (res?.error) log.warn('自动登录未完成：' + res.error);
    }).catch((e) => log.warn('自动登录异常', e));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    // 保存窗口状态
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
        const [width, height] = mainWindow.getSize();
        config.set({ window: { width, height } });
    }
});

process.on('uncaughtException', (e) => {
    log.error('未捕获异常', e);
    try {
        dialog.showErrorBox('启动器发生错误', String(e && e.stack ? e.stack : e));
    } catch { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
    log.error('未处理的 Promise 拒绝', e);
});
