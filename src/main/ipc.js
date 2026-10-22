'use strict';
/** IPC：渲染进程与核心逻辑之间的桥 */
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const { paths, setGameDir, versionDir } = require('../core/paths');
const config = require('../core/config');
const httpLayer = require('../core/http');
const mojang = require('../core/mojang');
const install = require('../core/install');
const loaders = require('../core/loaders');
const versions = require('../core/versions');
const modrinth = require('../core/modrinth');
const modpack = require('../core/modpack');
const launch = require('../core/launch');
const java = require('../core/java');
const crash = require('../core/crash');
const auth = require('../core/auth');
const { tasks } = require('../core/tasks');
const { createLogger, getLogFile, getLogs } = require('../core/log');
const { isFile, isDir, listDir } = require('../core/fsutil');

const log = createLogger('ipc');

function registerIpc({ getWindow, broadcast }) {
    const win = () => getWindow();

    /** 创建任务并在后台执行，立即返回 taskId */
    function startTask(title, kind, fn) {
        const task = tasks.create({ title, kind });
        Promise.resolve()
            .then(() => fn(task, task.controller.signal))
            .then((res) => {
                if (task.status === 'cancelled') return;
                tasks.finish(task, 'done');
                broadcast('task:result', { taskId: task.id, kind, ok: true, result: res ?? null });
            })
            .catch((e) => {
                if (task.status === 'cancelled') return;
                log.error('任务失败: ' + title, e);
                tasks.finish(task, 'failed', e);
                broadcast('task:result', { taskId: task.id, kind, ok: false, error: e.message || String(e) });
            });
        return { taskId: task.id };
    }

    const handle = (channel, fn) => {
        ipcMain.handle(channel, async (event, payload) => {
            try {
                return await fn(event, payload);
            } catch (e) {
                log.warn(`IPC ${channel} 出错: ${e.message}`);
                throw new Error(e.message || String(e));
            }
        });
    };

    /* ------------------------------ 应用信息 ------------------------------ */
    handle('app:info', () => ({
        version: app.getVersion(),
        name: 'Plain Craft Launcher N',
        dataDir: paths.dataDir,
        gameDir: paths.gameDir,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        running: launch.getRunning(),
    }));
    handle('app:openExternal', (e, url) => {
        if (/^https?:/i.test(String(url))) return shell.openExternal(String(url));
        return false;
    });
    handle('app:logFile', () => getLogFile());
    handle('app:logs', (e, limit) => getLogs(limit || 500));

    /* ------------------------------- 窗口 -------------------------------- */
    handle('window:minimize', () => win()?.minimize());
    handle('window:maximize', () => {
        const w = win();
        if (!w) return false;
        if (w.isMaximized()) w.unmaximize(); else w.maximize();
        return w.isMaximized();
    });
    handle('window:close', () => win()?.close());
    handle('window:state', () => ({ maximized: !!win()?.isMaximized() }));

    /* ------------------------------- 配置 -------------------------------- */
    handle('config:get', () => config.get());
    handle('config:set', (e, patch) => {
        const next = config.set(patch || {});
        if (patch?.gameDir) {
            try { setGameDir(patch.gameDir); } catch (err) { throw new Error('游戏目录无效: ' + err.message); }
        }
        if (patch?.download?.source) httpLayer.setDownloadSource(patch.download.source);
        return next;
    });
    handle('config:versionGet', (e, id) => config.getVersionSettings(id));
    handle('config:versionSet', (e, { id, patch }) => config.setVersionSettings(id, patch || {}));

    /* ------------------------------- 版本 -------------------------------- */
    handle('versions:list', () => versions.scanVersions());
    handle('versions:detail', (e, id) => versions.getVersionDetail(id));
    handle('versions:delete', async (e, { id, onlySettings }) => {
        const res = await versions.deleteVersion(id, { onlySettings });
        return res;
    });
    handle('versions:rename', (e, { id, name }) => versions.renameVersion(id, name));
    handle('versions:icon', (e, id) => {
        const file = path.join(versionDir(id), 'icon.png');
        if (!isFile(file)) return null;
        if (fs.statSync(file).size > 512 * 1024) return null;
        return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
    });

    handle('versions:install', (e, { id }) => startTask(`安装 Minecraft ${id}`, 'install', (task, signal) =>
        install.installVersion(id, { task, signal })));

    handle('versions:verify', (e, { id }) => startTask(`校验并修复 ${id}`, 'install', async (task, signal) => {
        const res = await install.verifyVersion(id);
        if (!res.problems.length) return { fixed: 0, total: res.total };
        task.detail = `发现 ${res.problems.length} 个问题文件，正在修复…`;
        task.touch();
        await install.installVersion(id, { task, signal });
        return { fixed: res.problems.length, total: res.total };
    }));

    handle('versions:installLoader', (e, payload) => {
        const { mc, loader, version: loaderVersion, installMc } = payload || {};
        const loaderName = loaders.getLoaders().find((l) => l.id === loader)?.name || loader;
        return startTask(`安装 ${loaderName} ${loaderVersion || ''} (${mc})`, 'install', async (task, signal) => {
            if (!isDir(path.join(paths.versionsDir, mc))) {
                task.detail = `正在安装原版 ${mc}…`;
                task.touch();
                await install.installVersion(mc, { task, signal });
            }
            let res;
            if (loader === 'fabric') res = await loaders.installFabric(mc, loaderVersion, { task, signal });
            else if (loader === 'quilt') res = await loaders.installQuilt(mc, loaderVersion, { task, signal });
            else if (loader === 'forge') res = await loaders.installForge(mc, loaderVersion, { task, signal });
            else if (loader === 'neoforge') res = await loaders.installNeoForge(mc, loaderVersion, { task, signal });
            else throw new Error('未知加载器: ' + loader);
            // 加载器版本默认开启版本隔离，避免模组互相污染
            if (res?.id) config.setVersionSettings(res.id, { isolation: 'version' });
            return res;
        });
    });

    handle('loaders:versions', async (e, { loader, mc }) => {
        if (!mc) throw new Error('请先选择游戏版本');
        if (loader === 'fabric') return loaders.listFabricVersions(mc);
        if (loader === 'quilt') return loaders.listQuiltVersions(mc);
        if (loader === 'forge') return loaders.listForgeVersions(mc);
        if (loader === 'neoforge') return loaders.listNeoForgeVersions(mc);
        return [];
    });

    /* ---------------------------- 模组与资源包 ---------------------------- */
    handle('mods:list', async (e, id) => {
        const list = await versions.listMods(id);
        return list;
    });
    handle('mods:toggle', (e, filePath) => versions.toggleMod(filePath));
    handle('mods:delete', (e, filePath) => versions.deleteMod(filePath));
    handle('packs:resource', (e, id) => versions.listResourcePacks(id));
    handle('packs:shader', (e, id) => versions.listShaderPacks(id));
    handle('packs:datapack', (e, { id, world }) => versions.listDatapacks(id, world));
    handle('saves:list', (e, id) => versions.listSaves(id));

    /* ------------------------------- 下载 -------------------------------- */
    handle('download:manifest', async (e, force) => {        const m = await mojang.getVersionManifest(!!force);
        return {
            latest: m.latest,
            versions: (m.versions || []).map((v) => ({
                id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url,
                sha1: v.sha1, complianceLevel: v.complianceLevel,
            })),
        };
    });

    handle('modrinth:search', (e, opts) => modrinth.search(opts || {}));
    handle('modrinth:gameVersions', () => modrinth.getGameVersions());
    handle('modrinth:project', (e, id) => modrinth.getProject(id));
    handle('modrinth:versions', (e, { id, gameVersion, loader }) => modrinth.listVersions(id, { gameVersion, loader }));

    handle('modrinth:install', (e, payload) => {
        const { projectId, versionId, targetVersion, projectType, loader, world } = payload || {};
        if (!targetVersion) throw new Error('请先在主页选择一个游戏版本');
        return startTask(`下载 ${projectType ? modrinth.TYPE_TEXT[projectType] || '内容' : '内容'}`, 'download', async (task, signal) => {
            const project = await modrinth.getProject(projectId);
            let version = null;
            if (versionId) version = await modrinth.getVersion(versionId);
            else {
                const detail = await versions.getVersionDetail(targetVersion);
                const mcVersion = detail.minecraftVersion || targetVersion;
                const list = await modrinth.listVersions(project.id, { gameVersion: mcVersion, loader });
                version = modrinth.pickVersion(list, { gameVersion: mcVersion, loader });
            }
            if (!version) throw new Error('没有找到适用于当前游戏版本的文件');
            // 整合包走专门流程
            if (project.type === 'modpack') {
                task.title = `安装整合包 ${project.title}`;
                const res = await modpack.installFromModrinth(project, version, { task, signal });
                return res;
            }
            const folder = modrinth.folderForType(project.type);
            let targetDir;
            if (project.type === 'datapack' && world) {
                targetDir = path.join(versions.resolveGameDir(targetVersion), 'saves', world, 'datapacks');
            } else {
                targetDir = path.join(versions.resolveGameDir(targetVersion), folder);
            }
            task.title = `下载 ${project.title}`;
            task.detail = version.versionNumber;
            task.touch();
            const res = await modrinth.installProject({
                project, version, targetDir, signal,
                onProgress: (delta, written, total) => {
                    task.bytesDone = written;
                    task.bytesTotal = total;
                    task.touch();
                },
            });
            return { ...res, targetDir, projectType: project.type };
        });
    });

    handle('modpack:install', (e, payload) => {
        const { projectId, versionId, name } = payload || {};
        return startTask(`安装整合包`, 'modpack', async (task, signal) => {
            const project = await modrinth.getProject(projectId);
            const version = versionId ? await modrinth.getVersion(versionId) : null;
            if (!version) throw new Error('请选择整合包版本');
            task.title = `安装整合包 ${project.title}`;
            return modpack.installFromModrinth(project, version, { task, signal, name: name || project.title });
        });
    });

    handle('dialog:openFile', async (e, opts = {}) => {        const result = await dialog.showOpenDialog(win(), {
            title: opts.title || '选择文件',
            properties: ['openFile'],
            filters: opts.filters || [{ name: '整合包', extensions: ['zip', 'mrpack'] }, { name: '所有文件', extensions: ['*'] }],
        });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    handle('dialog:openDir', async (e, opts = {}) => {
        const result = await dialog.showOpenDialog(win(), {
            title: opts.title || '选择文件夹',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: opts.defaultPath,
        });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    handle('modpack:detect', async (e, file) => {
        if (!file || !isFile(file)) throw new Error('文件不存在');
        return modpack.detectPack(file);
    });

    handle('modpack:installFile', async (e, payload) => {
        const { file, name, baseVersion } = payload || {};
        if (!file || !isFile(file)) throw new Error('文件不存在');
        const info = await modpack.detectPack(file);
        return {
            ...startTask(`安装整合包 ${name || info.name}`, 'modpack', (task, signal) =>
                modpack.installPack(file, { task, signal, name: name || info.name, baseVersion })),
            info,
        };
    });

    /* ------------------------------- Java -------------------------------- */
    handle('java:list', async (e, force) => {
        const list = await java.detectJava(!!force);
        return list.map((j) => ({
            path: j.path, home: j.home, version: j.version, major: j.major,
            vendor: j.vendor, bits: j.bits, is64: j.is64, source: j.source,
        }));
    });
    handle('java:download', (e, major) => startTask(`下载 Java ${major}`, 'download', async (task, signal) => {
        const info = await java.downloadJava(major, { task, signal });
        return { path: info.path, version: info.version, major: info.major };
    }));

    /* ------------------------------- 启动 -------------------------------- */
    handle('launch:start', async (e, { versionId, opts }) => {
        if (launch.getRunning()) throw new Error('游戏已在运行中');
        // 预检：Java 与文件是否齐备
        const cmd = await launch.buildLaunchCommand(versionId, opts || {});
        const task = tasks.create({ title: `启动 ${versionId}`, kind: 'launch', cancellable: false });
        tasks.finish(task, 'done');
        // 异步启动，日志 / 退出通过事件推送
        launch.launch(versionId, opts || {}).catch((err) => {
            log.error('启动失败', err);
            tasks.create({ title: `启动失败: ${err.message}`, kind: 'launch', cancellable: false });
            broadcast('launch:exit', { versionId, crashed: true, error: err.message, analysis: null, logFile: null });
        });
        return { ok: true, java: cmd.java.path, javaVersion: cmd.java.version };
    });
    handle('launch:kill', () => launch.killRunning());
    handle('launch:running', () => launch.getRunning());

    /* ------------------------------- 任务 -------------------------------- */
    handle('task:list', () => tasks.list());
    handle('task:cancel', (e, id) => tasks.cancel(id));
    handle('task:clear', () => { tasks.clearFinished(); return tasks.list(); });

    /* ------------------------------- 账号 -------------------------------- */
    handle('auth:state', () => auth.publicState());

    handle('auth:addOffline', (e, { name }) => {
        const account = auth.addOffline(name);
        broadcast('auth:state', auth.publicState());
        return account;
    });

    handle('auth:select', (e, { id }) => {
        const s = auth.select(id);
        broadcast('auth:state', s);
        return s;
    });

    handle('auth:remove', (e, { id }) => {
        const s = auth.remove(id);
        broadcast('auth:state', s);
        return s;
    });

    handle('auth:autoLogin', (e, { value }) => {
        const v = auth.setAutoLogin(value);
        broadcast('auth:state', auth.publicState());
        return v;
    });

    handle('auth:refresh', async (e, { id } = {}) => {
        const account = id ? auth.getById(id) : auth.getActive();
        if (!account) throw new Error('没有可用的账号');
        if (account.type !== 'microsoft') return { ok: true, account: auth.publicState().active, note: '离线账号无需刷新' };
        await auth.refreshMicrosoft(account);
        const s = auth.publicState();
        broadcast('auth:state', s);
        return { ok: true, account: s.active };
    });

    /** 打开微软登录窗口，等待授权回调 */
    handle('auth:msLogin', async () => {
        const parent = win();
        const authWin = new BrowserWindow({
            width: 520,
            height: 720,
            parent: parent || undefined,
            modal: !!parent,
            show: true,
            autoHideMenuBar: true,
            title: '微软账号登录',
            backgroundColor: '#ffffff',
            webPreferences: {
                partition: 'persist:pcln-msauth',
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        authWin.setMenuBarVisibility(false);
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, value) => {
                if (settled) return;
                settled = true;
                if (!authWin.isDestroyed()) authWin.destroy();
                fn(value);
            };
            const onUrl = (url) => {
                if (settled || !auth.isRedirect(url)) return;
                settled = true;
                let code = null;
                try { code = auth.extractCode(url); } catch (e) {
                    if (!authWin.isDestroyed()) authWin.destroy();
                    return reject(e);
                }
                if (!authWin.isDestroyed()) authWin.destroy();
                if (!code) return reject(new Error('微软登录未返回授权码，请重试'));
                auth.loginWithCode(code).then((account) => {
                    broadcast('auth:state', auth.publicState());
                    resolve(account);
                }).catch(reject);
            };
            authWin.webContents.on('will-redirect', (ev, url) => onUrl(url));
            authWin.webContents.on('will-navigate', (ev, url) => onUrl(url));
            authWin.webContents.on('did-navigate', (ev, url) => onUrl(url));
            authWin.webContents.on('did-fail-load', (ev, code, desc) => {
                if (code === -3) return; // 用户主动取消
                done(reject, new Error(`无法打开微软登录页面：${desc}（${code}）`));
            });
            authWin.on('closed', () => {
                if (!settled) { settled = true; reject(new Error('已取消登录')); }
            });
            authWin.loadURL(auth.buildAuthUrl()).catch((err) => done(reject, new Error('无法打开微软登录页面：' + err.message)));
        });
    });

    /* ------------------------------- 帮助 -------------------------------- */
    handle('help:analyze', async (e, payload = {}) => {
        if (payload.text) return crash.analyzeText(payload.text);
        if (payload.file) return crash.analyzeFile(payload.file);
        const dir = payload.versionId ? versions.resolveGameDir(payload.versionId) : paths.gameDir;
        const res = await crash.analyzeGameDir(dir);
        if (!res) {
            return {
                ok: true, summary: '没有找到崩溃报告或游戏日志。可以手动选择一个 crash-report 文件，或先启动一次游戏再回到这里。',
                causes: [], mods: [], memory: null, javaVersion: null, exitCode: null,
            };
        }
        return res;
    });
    handle('help:analyzeText', (e, text) => crash.analyzeText(text || ''));
    handle('help:openLog', () => shell.openPath(getLogFile()));
    handle('help:kb', () => crash.RULES.map((r) => ({ id: r.id, title: r.title, solution: r.solution, level: r.level })));
    handle('help:pickCrash', async () => {
        const result = await dialog.showOpenDialog(win(), {
            title: '选择崩溃报告',
            properties: ['openFile'],
            filters: [{ name: '崩溃报告 / 日志', extensions: ['txt', 'log', 'gz'] }, { name: '所有文件', extensions: ['*'] }],
        });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    /* ------------------------------- 系统 -------------------------------- */
    handle('shell:openPath', async (e, p) => {
        if (!p) return false;
        try {
            if (isDir(p)) { await shell.openPath(p); return true; }
            shell.showItemInFolder(p);
            return true;
        } catch (err) { throw new Error('打开失败: ' + err.message); }
    });
    handle('shell:showItem', (e, p) => { if (p && isFile(p)) shell.showItemInFolder(p); return true; });
}

module.exports = { registerIpc };
