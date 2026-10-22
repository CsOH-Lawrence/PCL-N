'use strict';
/**
 * 启动器核心：构建 JVM / 游戏参数，启动 Minecraft 进程，捕获日志与退出状态。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { paths, versionDir } = require('./paths');
const { resolveVersionJson, resolveLibraries, describeVersion } = require('./mojang');
const { extractNatives } = require('./install');
const { findJava } = require('./java');
const config = require('./config');
const versions = require('./versions');
const { ensureDirAsync, isDir, isFile, listDir, timestamp } = require('./fsutil');
const { createLogger } = require('./log');

const log = createLogger('launch');

const bus = new EventEmitter();
bus.setMaxListeners(50);

let running = null; // { id, child, startedAt, logFile }
let launching = false;

function offlineUuid(name) {
    const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
    md5[6] = (md5[6] & 0x0f) | 0x30;
    md5[8] = (md5[8] & 0x3f) | 0x80;
    const hex = md5.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function replaceVars(value, vars) {
    return String(value).replace(/\$\{([^}]+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

function pickGcArgs(mode, memoryMb) {
    if (mode === 'g1' || (mode === 'auto' && memoryMb >= 4096)) {
        return ['-XX:+UseG1GC', '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20', '-XX:MaxGCPauseMillis=50', '-XX:G1HeapRegionSize=32M'];
    }
    if (mode === 'zgc') return ['-XX:+UseZGC'];
    if (mode === 'serial' || (mode === 'auto' && memoryMb < 2048)) return ['-XX:+UseSerialGC'];
    return ['-XX:+UseG1GC', '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20', '-XX:MaxGCPauseMillis=50'];
}

/**
 * 构建启动参数。
 * @returns {Promise<object>} { java, args, cwd, classpath, mainClass, versionId }
 */
async function buildLaunchCommand(versionId, opts = {}) {
    const { json, chain } = await resolveVersionJson(versionId);
    const desc = describeVersion(json);
    const settings = config.resolved(versionId);
    const gameDir = versions.resolveGameDir(versionId);

    // 0) 账号：自动刷新微软令牌（自动登录核心）
    const auth = require('./auth');
    const activeAccount = auth.getActive();
    if (activeAccount?.type === 'microsoft') {
        try {
            await auth.ensureFresh(activeAccount);
        } catch (e) {
            const err = new Error('微软账号登录状态已失效，请重新登录：' + e.message);
            err.code = 'AUTH_EXPIRED';
            throw err;
        }
    }
    const creds = auth.getLaunchAuth();

    // 1) Java
    const requiredMajor = json.javaVersion?.majorVersion || 8;
    let java = null;
    if (settings.javaPath && settings.javaPath !== 'auto') {
        java = await findJava(requiredMajor, settings.javaPath);
    }
    if (!java) java = await findJava(requiredMajor);
    if (!java) {
        const err = new Error(`未找到可用的 Java ${requiredMajor}，请到「设置 - Java」中安装，或手动指定 Java 路径。`);
        err.code = 'JAVA_NOT_FOUND';
        err.requiredMajor = requiredMajor;
        throw err;
    }

    // 2) 依赖库 & 客户端 jar
    const allLibs = [];
    for (const raw of [...chain].reverse()) if (Array.isArray(raw.libraries)) allLibs.push(...raw.libraries);
    const resolved = resolveLibraries(allLibs, { features: json.features || {} });
    const jarId = json.jar && json.jar !== versionId ? json.jar : (chain.find((c) => c.downloads?.client?.url)?.id || versionId);
    const jarPath = path.join(versionDir(jarId), jarId + '.jar');
    const classpath = [];
    // 客户端 jar 需要在 classpath 中，老版本可能没有（1.4 之前用 minecraft.jar）
    const libPaths = resolved.classpath.map((p) => path.join(paths.librariesDir, p));
    for (const p of libPaths) if (isFile(p)) classpath.push(p);
    if (isFile(jarPath)) classpath.push(jarPath);
    if (!classpath.length) throw new Error('缺少游戏文件，请先安装该版本（可在版本设置中选择「校验并修复」）');

    // 3) natives
    const natDir = path.join(versionDir(versionId), 'natives');
    if (resolved.natives.length) {
        const empty = !isDir(natDir) || (await listDir(natDir)).length === 0;
        if (empty) await extractNatives(resolved.natives, natDir);
    } else {
        await ensureDirAsync(natDir);
    }

    // 4) 资源目录（老版本 virtual 资源）
    const indexName = json.assets || json.assetIndex?.id || 'legacy';
    let assetsRoot = paths.assetsDir;
    const virtualDir = path.join(paths.assetsDir, 'virtual', indexName);
    if (isDir(virtualDir)) assetsRoot = virtualDir;

    // 5) 变量表
    const username = creds.username || settings.username || 'Steve';
    const uuid = creds.uuid || settings.uuid || offlineUuid(username);
    const vars = {
        auth_player_name: username,
        version_name: json.id || versionId,
        game_directory: gameDir,
        assets_root: assetsRoot,
        game_assets: assetsRoot,
        assets_index_name: indexName,
        auth_uuid: uuid,
        auth_access_token: creds.accessToken || '0',
        auth_session: creds.accessToken || '0',
        accessToken: creds.accessToken || '0',
        clientid: '',
        auth_xuid: creds.xuid || '',
        user_type: creds.userType || 'legacy',
        user_properties: '{}',
        version_type: json.type || 'release',
        resolution_width: String(settings.width || 854),
        resolution_height: String(settings.height || 480),
        library_directory: paths.librariesDir,
        classpath_separator: process.platform === 'win32' ? ';' : ':',
        classpath: classpath.join(process.platform === 'win32' ? ';' : ':'),
        launcher_name: 'PCLN',
        launcher_version: '1.0',
        natives_directory: natDir,
        primary_jar: jarPath,
        quickPlayPath: '',
        quickPlaySingleplayer: '',
        quickPlayMultiplayer: '',
        quickPlayRealms: '',
    };

    // 6) JVM 参数
    const memory = opts.maxMemory || settings.maxMemory || 4096;
    const minMemory = Math.min(settings.minMemory || 512, memory);
    const jvmArgs = [];
    jvmArgs.push(`-Xmx${memory}M`, `-Xms${minMemory}M`);
    if (java.is64 || java.major <= 8) {
        if (java.major >= 9) jvmArgs.push('-XX:+UnlockExperimentalVMOptions');
        jvmArgs.push(...pickGcArgs(settings.gc, memory));
    }
    jvmArgs.push(
        `-Djava.library.path=${natDir}`,
        `-Dminecraft.launcher.brand=PlainCraftLauncherN`,
        `-Dminecraft.launcher.version=1.0`,
        `-Dfile.encoding=UTF-8`,
        `-Dstdout.encoding=UTF-8`,
        `-Dstderr.encoding=UTF-8`,
        `-Dminecraft.api.env=official`,
        `-Dminecraft.api.auth.host=https://authserver.mojang.com`,
        `-Dminecraft.api.account.host=https://api.mojang.com`,
        `-Dminecraft.api.session.host=https://session.minecraft.net`,
        `-Dminecraft.api.services.host=https://api.minecraftservices.com`,
    );
    // log4j 漏洞防护 + 日志配置
    if (json.logging?.client?.argument && json.logging.client.file?.id) {
        const logFile = path.join(paths.assetsDir, 'log_configs', json.logging.client.file.id);
        if (isFile(logFile)) jvmArgs.push(json.logging.client.argument.replace('${path}', logFile));
    }
    if (json.logging?.client?.argument?.includes('log4j')) jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');

    // 版本 JSON 自带的 jvm 参数（如 1.17+ 的 -Dos.name / --add-opens）
    if (Array.isArray(json.arguments?.jvm)) {
        for (const item of json.arguments.jvm) {
            if (typeof item === 'string') {
                jvmArgs.push(replaceVars(item, vars));
            } else if (item && typeof item === 'object') {
                const { evaluateRules } = require('./mojang');
                if (evaluateRules(item.rules, { ...(json.features || {}), ...(opts.features || {}) })) {
                    const values = Array.isArray(item.value) ? item.value : [item.value];
                    for (const v of values) if (v) jvmArgs.push(replaceVars(v, vars));
                }
            }
        }
    }

    // -cp / mainClass 由版本 JSON 提供，若缺失则补充
    if (!jvmArgs.some((a) => a === '-cp' || a === '-classpath')) {
        jvmArgs.push('-cp', classpath.join(process.platform === 'win32' ? ';' : ':'));
    }
    if (settings.extraJvmArgs) {
        for (const a of settings.extraJvmArgs.match(/"[^"]*"|\S+/g) || []) jvmArgs.push(a.replace(/^"|"$/g, ''));
    }
    if (opts.nativeDebug) jvmArgs.push('-Dorg.lwjgl.util.Debug=true');

    // 7) 游戏参数
    const gameArgs = [];
    if (Array.isArray(json.arguments?.game)) {
        for (const item of json.arguments.game) {
            if (typeof item === 'string') gameArgs.push(replaceVars(item, vars));
            else if (item && typeof item === 'object') {
                const { evaluateRules } = require('./mojang');
                const features = { ...(json.features || {}), is_demo_user: !!settings.demo, has_custom_resolution: true, ...(opts.features || {}) };
                if (evaluateRules(item.rules, features)) {
                    const values = Array.isArray(item.value) ? item.value : [item.value];
                    for (const v of values) if (v) gameArgs.push(replaceVars(v, vars));
                }
            }
        }
    } else if (json.minecraftArguments) {
        for (const a of json.minecraftArguments.split(' ')) if (a) gameArgs.push(replaceVars(a, vars));
    }

    // 分辨率 / 全屏
    if (!gameArgs.includes('--width')) gameArgs.push('--width', String(settings.width || 854));
    if (!gameArgs.includes('--height')) gameArgs.push('--height', String(settings.height || 480));
    if (settings.fullscreen && !gameArgs.includes('--fullscreen')) gameArgs.push('--fullscreen');
    if (settings.extraGameArgs) {
        for (const a of settings.extraGameArgs.match(/"[^"]*"|\S+/g) || []) gameArgs.push(a.replace(/^"|"$/g, ''));
    }

    const mainClass = json.mainClass;
    if (!mainClass) throw new Error('版本 JSON 缺少 mainClass，无法启动');

    const args = [...jvmArgs, mainClass, ...gameArgs];
    return {
        java,
        args,
        cwd: gameDir,
        gameDir,
        classpath,
        mainClass,
        versionId,
        versionName: json.id,
        minecraftVersion: desc.minecraftVersion,
        requiredMajor,
        account: creds.account || null,
        commandLine: `"${java.path}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
    };
}

/** 启动游戏 */
async function launch(versionId, opts = {}) {
    if (running) throw new Error(`游戏已经在运行（${running.id}），请先关闭`);
    if (launching) throw new Error('正在启动中，请稍候');
    launching = true;
    let cmd;
    try {
        cmd = await buildLaunchCommand(versionId, opts);
    } catch (e) {
        launching = false;
        throw e;
    }
    const logDir = path.join(cmd.gameDir, 'logs');
    await ensureDirAsync(logDir);
    const logFile = path.join(logDir, `pcln-${timestamp()}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    log.info(`启动 ${versionId}，Java ${cmd.java.version} (${cmd.java.path})`);
    log.info('启动命令: ' + cmd.commandLine.split(' ').slice(0, 8).join(' ') + ' ...');
    stream.write(`[PCLN] 启动命令: ${cmd.commandLine}\n`);

    const child = spawn(cmd.java.path, cmd.args, {
        cwd: cmd.cwd,
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: (() => { const e = { ...process.env }; delete e.JAVA_TOOL_OPTIONS; delete e._JAVA_OPTIONS; return e; })(),
    });

    running = { id: versionId, child, startedAt: Date.now(), logFile, cmd };
    launching = false;
    config.setVersionSettings(versionId, { lastPlayed: new Date().toISOString() });

    const emit = (line, stream_) => bus.emit('log', { versionId, line, stream: stream_ });

    const handle = (data, s) => {
        const text = String(data);
        stream.write(text);
        for (const line of text.split(/\r?\n/)) if (line.trim()) emit(line, s);
    };
    child.stdout.on('data', (d) => handle(d, 'stdout'));
    child.stderr.on('data', (d) => handle(d, 'stderr'));

    return new Promise((resolve) => {
        let done = false;
        const finish = async (code, signal) => {
            if (done) return;
            done = true;
            const duration = Date.now() - running.startedAt;
            const crashed = code !== 0 && duration > 5000 && code !== null;
            const result = {
                versionId, code, signal, duration, crashed,
                logFile,
                crashReport: null,
                analysis: null,
            };
            try {
                const crash = await findCrashReport(cmd.gameDir);
                if (crash) {
                    result.crashReport = crash.path;
                    const analyzer = require('./crash').analyzeFile;
                    result.analysis = await analyzer(crash.path);
                }
            } catch (e) { log.warn('崩溃报告分析失败', e); }
            stream.end();
            running = null;
            bus.emit('exit', result);
            log.info(`游戏退出，代码 ${code}`);
            resolve(result);
        };
        child.on('exit', (code, signal) => finish(code, signal));
        child.on('error', (err) => {
            log.error('启动失败', err);
            if (done) return;
            done = true;
            stream.end();
            running = null;
            resolve({ versionId, code: -1, signal: null, crashed: true, error: err.message, logFile, crashReport: null, analysis: null });
        });
        setTimeout(() => {
            if (running && running.child === child) {
                bus.emit('started', { versionId, pid: child.pid, logFile, startedAt: Date.now() });
            }
        }, 300);
    });
}

/** 查找最新的崩溃报告 */
async function findCrashReport(gameDir) {
    const dir = path.join(gameDir, 'crash-reports');
    if (!isDir(dir)) return null;
    const entries = await listDir(dir);
    const reports = entries.filter((e) => e.isFile() && /\.txt$/i.test(e.name)).map((e) => ({
        name: e.name, path: path.join(dir, e.name),
        mtime: (() => { try { return fs.statSync(path.join(dir, e.name)).mtimeMs; } catch { return 0; } })(),
    })).sort((a, b) => b.mtime - a.mtime);
    if (!reports.length) return null;
    // 只认 10 分钟内生成的报告
    if (Date.now() - reports[0].mtime > 10 * 60 * 1000) return null;
    return reports[0];
}

function getRunning() {
    return running ? { id: running.id, pid: running.child?.pid, startedAt: running.startedAt, logFile: running.logFile } : null;
}

function killRunning() {
    if (!running) return false;
    try { running.child.kill(); } catch { /* ignore */ }
    return true;
}

module.exports = { buildLaunchCommand, launch, getRunning, killRunning, offlineUuid, bus, findCrashReport };
