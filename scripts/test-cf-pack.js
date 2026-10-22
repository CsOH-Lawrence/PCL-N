'use strict';
/**
 * CurseForge 整合包安装自测（无需 API Key）：
 *   node scripts/test-cf-pack.js
 * 会查询一个真实的 CurseForge 文件、构造最小 manifest 整合包，然后完整走一遍安装流程。
 */
const fs = require('fs');
const path = require('path');

process.env.PCLN_DATA_DIR = process.env.PCLN_DATA_DIR || path.join(__dirname, '..', '.cftest-data');
process.env.PCLN_GAME_DIR = process.env.PCLN_GAME_DIR || path.join(__dirname, '..', '.cftest-game');

const { initPaths, paths } = require('../src/core/paths');
initPaths({});
const config = require('../src/core/config');
config.load();
const curseforge = require('../src/core/curseforge');
const modpack = require('../src/core/modpack');
const { tasks } = require('../src/core/tasks');

/* ---------------- 极简 ZIP 写入（store，不压缩） ---------------- */
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function writeZip(file, entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        chunks.push(local, nameBuf, data);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt32LE(0, 10);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...chunks, centralBuf, eocd]));
}

(async () => {
    console.log('=== 查询 CurseForge 文件（网页接口，无 Key） ===');
    const listUrl = 'https://www.curseforge.com/api/v1/mods/238222/files?pageIndex=0&pageSize=5&gameVersion=1.21.1';
    const res = await fetch(listUrl, { headers: { 'User-Agent': curseforge.BROWSER_UA, Accept: 'application/json' } });
    const json = await res.json();
    const file = (json.data || [])[0];
    if (!file) throw new Error('没有拿到 JEI 的文件列表');
    console.log('选中文件:', file.fileName, file.fileLength, 'bytes, id=' + file.id);

    console.log('\n=== 构造最小 CurseForge 整合包 ===');
    const tmpDir = path.join(paths.cacheDir, 'cf-test');
    fs.mkdirSync(tmpDir, { recursive: true });
    const manifest = {
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: 'CF 测试整合包',
        version: '1.0.0',
        author: 'PCL-N',
        minecraft: { version: '1.21.1', modLoaders: [] },
        files: [{ projectID: 238222, fileID: file.id, required: true }],
        overrides: 'overrides',
    };
    const zipPath = path.join(tmpDir, 'cf-test-pack.zip');
    writeZip(zipPath, [
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
        { name: 'overrides/config/cf-test.txt', data: Buffer.from('由 PCL-N 测试生成') },
    ]);
    console.log('整合包:', zipPath);

    console.log('\n=== 准备基础版本（用空壳 JSON 避免重复下载） ===');
    const baseDir = path.join(paths.versionsDir, '1.21.1');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, '1.21.1.json'), JSON.stringify({
        id: '1.21.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [],
    }, null, 2));

    console.log('\n=== 安装（无 Key，走官网接口） ===');
    const task = tasks.create({ title: '安装 CF 测试整合包' });
    const started = Date.now();
    const result = await modpack.installCurseForgeZip(zipPath, { task, signal: task.controller.signal });
    tasks.finish(task, 'done');
    console.log('结果:', result, ((Date.now() - started) / 1000).toFixed(1) + 's');

    const modsDir = path.join(result.dir, 'mods');
    const installed = fs.readdirSync(modsDir);
    console.log('mods:', installed.map((f) => `${f} (${fs.statSync(path.join(modsDir, f)).size} bytes)`));
    console.log('overrides 解压:', fs.existsSync(path.join(result.dir, 'config', 'cf-test.txt')));

    const expected = path.join(modsDir, file.fileName);
    if (!fs.existsSync(expected) || fs.statSync(expected).size !== file.fileLength) {
        throw new Error('下载的文件不完整');
    }
    console.log('\n✅ CurseForge 无 Key 安装流程通过');

    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
})().catch((e) => {
    console.error('FAIL', e);
    process.exit(1);
});
