'use strict';
/**
 * Java 管理：扫描系统已安装运行时、匹配版本、按需下载（Adoptium Temurin）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { paths } = require('./paths');
const { downloadFile, fetchJson } = require('./http');
const { ensureDirAsync, isFile, listDir, exists, removeSync } = require('./fsutil');
const { createLogger } = require('./log');

const log = createLogger('java');

let cache = { at: 0, list: [] };
const CACHE_TTL = 60 * 1000;

function runCapture(exe, args, timeout = 8000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

/** 解析 "java -XshowSettings:properties -version" 输出 */
function parseJavaOutput(text) {
    const get = (key) => {
        const m = text.match(new RegExp(`${key}\\s*=\\s*(.+)`));
        return m ? m[1].trim() : '';
    };
    const versionStr = get('java.version') || (text.match(/version "([^"]+)"/) || [])[1] || '';
    const major = (() => {
        if (!versionStr) return 0;
        const clean = versionStr.replace(/^(\d+\.)?(\d+)/, (m, a, b) => (a === '1.' ? b : m));
        const n = parseInt(clean.split(/[._-]/)[0], 10);
        return Number.isFinite(n) ? n : 0;
    })();
    return {
        version: versionStr,
        major,
        arch: get('os.arch') || '',
        vendor: get('java.vendor') || '',
        vmName: get('java.vm.name') || '',
    };
}

async function inspectJava(javaExe) {
    if (!isFile(javaExe)) return null;
    const { stdout, stderr, err } = await runCapture(javaExe, ['-XshowSettings:properties', '-version']);
    if (err && err.code === 'ENOENT') return null;
    const info = parseJavaOutput(stdout + '\n' + stderr);
    if (!info.major) return null;
    return {
        path: javaExe,
        home: path.dirname(path.dirname(javaExe)),
        ...info,
        bits: /64/.test(info.arch) ? 64 : 32,
        is64: /64/.test(info.arch) || /x86_64|amd64/i.test(info.arch),
        source: 'system',
    };
}

function findJavaInDir(dir) {
    const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
    const candidates = [
        path.join(dir, 'bin', exe),
        path.join(dir, 'bin', 'java.exe'),
        path.join(dir, 'jre', 'bin', exe),
        path.join(dir, 'jre', 'bin', 'java.exe'),
        path.join(dir, 'Contents', 'Home', 'bin', 'java'), // macOS
    ];
    for (const c of candidates) if (isFile(c)) return c;
    return null;
}

async function scanDirs(baseDirs) {
    const found = [];
    for (const base of baseDirs) {
        if (!exists(base)) continue;
        const entries = await listDir(base);
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const exe = findJavaInDir(path.join(base, e.name));
            if (exe) found.push(exe);
            // 再深一层（如 Java\jdk-17\bin）
            const sub = await listDir(path.join(base, e.name));
            for (const s of sub) {
                if (!s.isDirectory()) continue;
                const exe2 = findJavaInDir(path.join(base, e.name, s.name));
                if (exe2) found.push(exe2);
            }
        }
    }
    return found;
}

/** 读取注册表里的 Java 安装路径（Windows） */
async function scanRegistry() {
    if (process.platform !== 'win32') return [];
    const keys = [
        'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
        'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
        'HKLM\\SOFTWARE\\JavaSoft\\JRE',
        'HKLM\\SOFTWARE\\JavaSoft\\JDK',
        'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment',
        'HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK',
        'HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE',
        'HKLM\\SOFTWARE\\Microsoft\\JDK',
        'HKLM\\SOFTWARE\\Azul Systems\\Zulu',
        'HKLM\\SOFTWARE\\BellSoft\\LibericaJDK',
        'HKLM\\SOFTWARE\\Amazon Corretto',
    ];
    const found = [];
    for (const key of keys) {
        const { stdout, err } = await runCapture('reg', ['query', key, '/s'], 5000);
        if (err) continue;
        for (const line of stdout.split(/\r?\n/)) {
            const m = line.match(/(JavaHome|InstallationPath|JavaHome64|Path)\s+REG_SZ\s+(.+)/);
            if (m) {
                const home = m[2].trim().replace(/\\$/, '');
                const exe = findJavaInDir(home);
                if (exe) found.push(exe);
            }
        }
    }
    return found;
}

/** 扫描启动器自带的 Java（数据目录 java/） */
async function scanBundled() {
    const base = paths.javaDir;
    const found = [];
    if (!exists(base)) return found;
    for (const e of await listDir(base)) {
        if (!e.isDirectory()) continue;
        const exe = findJavaInDir(path.join(base, e.name));
        if (exe) found.push(exe);
    }
    return found;
}

function whichJava() {
    const name = process.platform === 'win32' ? 'java.exe' : 'java';
    const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const p = path.join(dir, name.replace(/\.exe$/i, ext.toLowerCase()));
            if (isFile(p)) return p;
        }
    }
    return null;
}

/** 扫描全部 Java，返回去重后的列表 */
async function detectJava(force = false) {
    if (!force && Date.now() - cache.at < CACHE_TTL && cache.list.length) return cache.list;
    const bases = [];
    if (process.platform === 'win32') {
        for (const envk of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
            const root = process.env[envk];
            if (!root) continue;
            bases.push(path.join(root, 'Java'), path.join(root, 'Eclipse Adoptium'), path.join(root, 'Microsoft'),
                path.join(root, 'Zulu'), path.join(root, 'BellSoft'), path.join(root, 'Amazon Corretto'),
                path.join(root, 'AdoptOpenJDK'), path.join(root, 'Semeru'), path.join(root, 'GraalVM'));
        }
        if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
        if (process.env.USERPROFILE) bases.push(path.join(process.env.USERPROFILE, '.jdks'));
    } else {
        bases.push('/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', path.join(os.homedir(), '.jdks'));
    }
    const [dirs, registry, bundled, pathJava] = await Promise.all([
        scanDirs(bases), scanRegistry(), scanBundled(), Promise.resolve(whichJava()),
    ]);
    const all = [...new Set([...dirs, ...registry, ...bundled, ...(pathJava ? [pathJava] : [])])];
    const infos = [];
    for (const exe of all) {
        const info = await inspectJava(exe).catch(() => null);
        if (info) infos.push(info);
    }
    const seen = new Set();
    const list = infos.filter((i) => {
        const key = path.resolve(i.home || i.path).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => b.major - a.major);
    cache = { at: Date.now(), list };
    log.info(`检测到 ${list.length} 个 Java 运行时: ` + list.map((i) => i.major).join(', '));
    return list;
}

/** 根据所需主版本挑选 Java */
async function findJava(requiredMajor, preferredPath) {
    if (preferredPath && preferredPath !== 'auto') {
        const info = await inspectJava(preferredPath).catch(() => null);
        if (info) return info;
    }
    const list = await detectJava();
    if (!list.length) return null;
    const exact = list.filter((j) => j.major === requiredMajor);
    if (exact.length) return exact.find((j) => j.is64) || exact[0];
    const higher = list.filter((j) => j.major > requiredMajor).sort((a, b) => a.major - b.major);
    if (higher.length) return higher[0];
    const lower = list.filter((j) => j.major < requiredMajor).sort((a, b) => b.major - a.major);
    return lower[0] || null;
}

/** 下载 Java（Adoptium Temurin JRE），返回 java 可执行文件路径 */
async function downloadJava(major, opts = {}) {
    const { task, signal } = opts;
    const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : 'x86';
    const os_ = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${os_}&vendor=eclipse`;
    if (task) { task.phase = 'meta'; task.detail = '正在获取 Java 下载信息…'; task.touch(); }
    const assets = await fetchJson(api, { retries: 3, timeoutMs: 20000 });
    if (!Array.isArray(assets) || !assets.length) throw new Error('找不到适用于当前系统的 Java ' + major);
    const pkg = assets[0].binary?.package;
    const link = pkg?.link;
    if (!link) throw new Error('Java 下载地址解析失败');
    const fileName = pkg.name || `jre-${major}.zip`;
    const destDir = path.join(paths.javaDir, `jre-${major}-${arch}`);
    const tmpZip = path.join(paths.cacheDir, fileName);
    ensureDirAsync(paths.cacheDir);
    const total = pkg.size || 0;
    if (task) {
        task.total = total; task.bytesTotal = total; task.phase = 'download'; task.detail = fileName; task.touch();
    }
    await downloadFile(link, tmpZip, {
        size: total, signal, retries: 3, timeoutMs: 60000,
        onProgress: (delta, written) => {
            if (!task) return;
            task.bytesDone = written;
            task.touch();
        },
    });
    if (task) { task.phase = 'extract'; task.detail = '正在解压 Java…'; task.current = 0; task.total = 0; task.touch(); }
    removeSync(destDir);
    await ensureDirAsync(destDir);
    const { extractZip } = require('./zip');
    await extractZip(tmpZip, destDir, {
        filter: (name) => !name.endsWith('/'),
        onProgress: (done, totalEntries) => {
            if (task) { task.current = done; task.total = totalEntries; task.touch(); }
        },
    });
    await fsp.unlink(tmpZip).catch(() => {});
    // 找到 java 可执行文件（压缩包内通常有一层目录）
    const candidates = [];
    for (const e of await listDir(destDir)) {
        const p = path.join(destDir, e.name);
        if (!e.isDirectory()) continue;
        const exe = findJavaInDir(p);
        if (exe) candidates.push(exe);
    }
    const direct = findJavaInDir(destDir);
    if (direct) candidates.push(direct);
    if (!candidates.length) throw new Error('Java 解压后未找到可执行文件');
    const info = await inspectJava(candidates[0]);
    if (!info) throw new Error('下载的 Java 无法运行');
    cache = { at: 0, list: [] };
    log.info(`Java ${major} 下载完成: ${info.path}`);
    return info;
}

module.exports = { detectJava, findJava, downloadJava, inspectJava, parseJavaOutput, whichJava };
