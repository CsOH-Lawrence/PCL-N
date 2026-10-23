'use strict';
/**
 * 检查 CI 打出来的 macOS 产物（Actions 下载的 artifact zip）
 *   node scripts/inspect-mac-build.js PCL-N-macos-universal.zip
 * 输出：内部文件、.app 结构、Info.plist 关键字段、主程序是否 universal、是否签名
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { listZip, extractZip, readZipFile } = require('../src/core/zip');

const file = process.argv[2] || 'PCL-N-macos-universal.zip';

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

(async () => {
    if (!fs.existsSync(file)) throw new Error('文件不存在: ' + file);
    console.log('产物:', path.basename(file), mb(fs.statSync(file).size));

    console.log('\n=== 外层 zip 内容 ===');
    const outer = await listZip(file);
    for (const e of outer.filter((x) => !x.isDir)) console.log(' -', e.name, mb(e.size));

    const dmg = outer.find((e) => e.name.toLowerCase().endsWith('.dmg'));
    const innerZip = outer.find((e) => e.name.toLowerCase().endsWith('.zip'));
    if (dmg) {
        console.log('\n=== dmg 校验 ===');
        const tmpDmg = path.join(os.tmpdir(), 'pcln-check.dmg');
        const data = await readZipFile(file, dmg.name);
        fs.writeFileSync(tmpDmg, data);
        const fd = fs.openSync(tmpDmg, 'r');
        const trailer = Buffer.alloc(512);
        fs.readSync(fd, trailer, 0, 512, data.length - 512);
        fs.closeSync(fd);
        const magic = trailer.subarray(0, 4).toString('ascii');
        console.log('大小:', mb(data.length), '| koly 尾部签名:', magic, magic === 'koly' ? '(有效 UDIF)' : '(异常)');
        fs.unlinkSync(tmpDmg);
    }
    if (!innerZip) { console.log('\n没有内层 zip，跳过 .app 检查'); return; }

    console.log('\n=== 解出内层 zip 并检查 .app ===');
    const work = path.join(os.tmpdir(), 'pcln-mac-check');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const innerPath = path.join(work, 'inner.zip');
    fs.writeFileSync(innerPath, await readZipFile(file, innerZip.name));
    const entries = await listZip(innerPath);
    const appRoot = entries.find((e) => e.name.includes('.app/'));
    console.log(' .app 根目录:', appRoot ? appRoot.name.split('.app/')[0] + '.app' : '未找到');
    console.log(' 文件数:', entries.filter((e) => !e.isDir).length);

    const appRootPath = appRoot ? appRoot.name.split('.app/')[0] + '.app' : null;
    const plistEntry = entries.find((e) => e.name === `${appRootPath}/Contents/Info.plist`)
        || entries.find((e) => e.name.endsWith('.app/Contents/Info.plist'));
    if (plistEntry) {
        const buf = await readZipFile(innerPath, plistEntry.name);
        const text = buf.toString('utf8');
        const pick = (key) => {
            const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
            return m ? m[1] : '(未找到)';
        };
        console.log('\n=== Info.plist ===');
        console.log(' CFBundleIdentifier :', pick('CFBundleIdentifier'));
        console.log(' CFBundleName       :', pick('CFBundleName'));
        console.log(' CFBundleVersion    :', pick('CFBundleShortVersionString') + ' (' + pick('CFBundleVersion') + ')');
        console.log(' LSMinimumSystemVersion:', pick('LSMinimumSystemVersion'));
    }

    const exeEntry = entries.find((e) => /\.app\/Contents\/MacOS\/[^/]+$/.test(e.name));
    if (exeEntry) {
        console.log('\n=== 主程序 ===');
        console.log(' 路径:', exeEntry.name, '| 大小:', mb(exeEntry.size));
        const buf = await readZipFile(innerPath, exeEntry.name);
        const magic = buf.readUInt32BE(0);
        const isFat = magic === 0xcafebabe || magic === 0xcafebabf;
        if (isFat) {
            const count = buf.readUInt32BE(4);
            const archs = [];
            for (let i = 0; i < count; i++) {
                const off = 8 + i * 20;
                const cpu = buf.readUInt32BE(off);
                archs.push({ 0x01000007: 'x86_64', 0x0100000c: 'arm64', 0x00000007: 'i386' }[cpu] || 'cpu=0x' + cpu.toString(16));
            }
            console.log(' 架构: universal fat binary →', archs.join(' + '));
        } else {
            console.log(' 架构: 单架构 (magic=0x' + magic.toString(16) + ')');
        }
    }

    const signed = entries.some((e) => e.name.includes('_CodeSignature/CodeResources'));
    console.log('\n=== 签名 ===');
    console.log(signed ? '包含 _CodeSignature（ad-hoc 或已签名，需公证才能免 Gatekeeper 提示）' : '未找到签名目录');
    fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => {
    console.error('检查失败:', e.message);
    process.exit(1);
});
