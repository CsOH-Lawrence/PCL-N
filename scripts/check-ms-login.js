'use strict';
/** 开发辅助：打开微软登录窗口并截图，验证授权页面能正常加载 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

process.env.PCLN_DATA_DIR = process.env.PCLN_DATA_DIR || 'D:/Code/plain-craft-launcher/.atest';
process.env.PCLN_GAME_DIR = process.env.PCLN_GAME_DIR || 'D:/Code/plain-craft-launcher/.atest-game';

const { initPaths } = require('../src/core/paths');
initPaths({});
const config = require('../src/core/config');
config.load();
const auth = require('../src/core/auth');

const OUT = process.env.PCLN_MS_SHOT || path.join(__dirname, '..', '.ms-shot.png');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 520,
        height: 720,
        show: true,
        title: '微软账号登录',
        webPreferences: { partition: 'persist:pcln-msauth-test', contextIsolation: true, sandbox: true },
    });
    win.webContents.on('did-finish-load', async () => {
        const url = win.webContents.getURL();
        console.log('登录页已加载:', url.slice(0, 120));
        await new Promise((r) => setTimeout(r, 2500));
        try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(OUT, img.toPNG());
            console.log('截图已保存:', OUT);
        } catch (e) {
            console.log('截图失败:', e.message);
        }
        app.quit();
    });
    win.webContents.on('did-fail-load', (e, code, desc) => {
        console.log('加载失败:', code, desc);
        app.quit();
    });
    win.loadURL(auth.buildAuthUrl());
    setTimeout(() => { console.log('超时退出'); app.quit(); }, 20000);
});
