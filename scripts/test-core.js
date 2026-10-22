'use strict';
/**
 * 核心逻辑自检脚本（无需 Electron）：
 *   node scripts/test-core.js meta      仅检查元数据 / 搜索 / 崩溃分析
 *   node scripts/test-core.js install   完整安装某个版本（可指定版本号）
 *   node scripts/test-core.js launch    构建启动命令（不启动进程）
 *   node scripts/test-core.js run       真正启动游戏（可选版本号）
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { initPaths } = require('../src/core/paths');

const dataDir = process.env.PCLN_DATA_DIR || path.join(ROOT, '.test-data');
const gameDir = process.env.PCLN_GAME_DIR || path.join(ROOT, '.test-game');
initPaths({ dataDir, gameDir });

const config = require('../src/core/config');
config.load();
const http = require('../src/core/http');
const mojang = require('../src/core/mojang');
const install = require('../src/core/install');
const modrinth = require('../src/core/modrinth');
const crash = require('../src/core/crash');
const tasksModule = require('../src/core/tasks');
const tasks = tasksModule.tasks;
const taskBus = tasksModule.bus;
const launch = require('../src/core/launch');
const versions = require('../src/core/versions');

const cmd = process.argv[2] || 'meta';
const versionArg = process.argv[3];

async function metaTest() {
    console.log('=== 路径 ===');
    console.log('dataDir:', dataDir);
    console.log('gameDir:', gameDir);

    console.log('\n=== 版本清单 ===');
    const manifest = await mojang.getVersionManifest();
    console.log('latest.release =', manifest.latest.release, '总版本数 =', manifest.versions.length);
    const target = versionArg || manifest.latest.release;

    console.log('\n=== 解析版本', target, '===');
    const r = await mojang.resolveVersionJson(target);
    const desc = mojang.describeVersion(r.json);
    console.log('chain:', r.chain, 'mainClass:', r.json.mainClass, 'java:', desc.javaVersion);
    const plan = await install.buildInstallPlan(target);
    console.log('client:', plan.clientFiles.length, 'libs:', plan.libFiles.length, 'natives:', plan.nativeFiles.length, 'assets:', plan.assetObjects.length);
    console.log('asset total size:', (plan.assetObjects.reduce((s, o) => s + o.size, 0) / 1048576).toFixed(1), 'MB');
    console.log('classpath 数量:', plan.classpath.length);

    console.log('\n=== 加载器列表 ===');
    const fabric = await require('../src/core/loaders').listFabricVersions(target);
    console.log('fabric 版本数:', fabric.length, '最新:', fabric[0]?.version);

    console.log('\n=== Modrinth 搜索 ===');
    const res = await modrinth.search({ query: '', projectType: 'mod', gameVersion: '1.21.1', loader: 'fabric', limit: 3 });
    console.log('total:', res.total);
    for (const h of res.hits) console.log(' -', h.title, '|', h.downloads, '|', h.description?.slice(0, 40));

    console.log('\n=== 崩溃分析 ===');
    const sample = `java.lang.OutOfMemoryError: Java heap space
Exit Code: -1073741819
Failed to download https://example.com/a.jar
Mixin apply failed: mod.mixins.json`;
    const a = crash.analyzeText(sample);
    console.log(a.summary);
    for (const c of a.causes) console.log(' -', c.title);

    console.log('\n=== Java ===');
    const javas = await require('../src/core/java').detectJava(true);
    for (const j of javas) console.log(' -', j.major, j.version, j.path, j.is64 ? '64bit' : '32bit');

    console.log('\n=== 已安装版本 ===');
    const list = await versions.scanVersions();
    for (const v of list) console.log(' -', v.id, v.loader, 'mods:', v.modCount, 'isolation:', v.isolation);
    console.log('\nOK');
}

async function installTest() {
    const manifest = await mojang.getVersionManifest();
    const id = versionArg || manifest.latest.release;
    const task = tasks.create({ title: '安装 Minecraft ' + id, kind: 'install' });
    let lastLen = 0;
    taskBus.on('update', () => {
        const t = tasks.get(task.id);
        if (!t) return;
        const pct = t.total ? ((t.current / t.total) * 100).toFixed(1) : '0';
        const line = `[${t.phase}] ${pct}%  ${t.current}/${t.total}  ${(t.detail || '').slice(0, 40).padEnd(40)}`;
        process.stdout.write('\r' + line.padEnd(lastLen));
        lastLen = line.length;
    });
    const t0 = Date.now();
    try {
        const res = await install.installVersion(id, { task, signal: task.controller.signal });
        console.log('\n安装完成:', res, '耗时', ((Date.now() - t0) / 1000).toFixed(1), 's');
        tasks.finish(task, 'done');
    } catch (e) {
        console.log('\n安装失败:', e.message);
        tasks.finish(task, 'failed', e);
        process.exitCode = 1;
    }
    // 校验
    const v = await install.verifyVersion(id);
    console.log('校验: 共', v.total, '个文件，问题', v.problems.length);
    process.exit(0);
}

async function launchTest() {
    const manifest = await mojang.getVersionManifest();
    const id = versionArg || manifest.latest.release;
    const cmdRes = await launch.buildLaunchCommand(id, {});
    console.log('Java:', cmdRes.java.path, cmdRes.java.version);
    console.log('cwd:', cmdRes.cwd);
    console.log('classpath 条目:', cmdRes.classpath.length);
    console.log('\n参数:');
    for (const a of cmdRes.args) console.log('  ', a);
    process.exit(0);
}

async function runTest() {
    const manifest = await mojang.getVersionManifest();
    const id = versionArg || manifest.latest.release;
    const res = await launch.launch(id);
    console.log('退出:', res);
    if (res.analysis) console.log('分析:', res.analysis.summary, res.analysis.causes.map((c) => c.title));
    process.exit(0);
}

(async () => {
    try {
        if (cmd === 'meta') await metaTest();
        else if (cmd === 'install') await installTest();
        else if (cmd === 'launch') await launchTest();
        else if (cmd === 'run') await runTest();
        else console.log('未知命令', cmd);
    } catch (e) {
        console.error('测试失败:', e);
        process.exit(1);
    }
})();
