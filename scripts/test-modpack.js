'use strict';
/** 整合包安装测试：node scripts/test-modpack.js [modrinth-slug-or-id] */
process.env.PCLN_GAME_DIR = process.env.PCLN_GAME_DIR || 'D:/Code/plain-craft-launcher/.test-game';
process.env.PCLN_DATA_DIR = process.env.PCLN_DATA_DIR || 'D:/Code/plain-craft-launcher/.test-data';
const { initPaths } = require('../src/core/paths');
initPaths({});
const config = require('../src/core/config');
config.load();
const modrinth = require('../src/core/modrinth');
const modpack = require('../src/core/modpack');
const { tasks, bus } = require('../src/core/tasks');
const versions = require('../src/core/versions');

const slug = process.argv[2] || 'fabulously-optimized';

(async () => {
    const project = await modrinth.getProject(slug);
    console.log('整合包:', project.title, project.id, '类型:', project.type);
    const list = await modrinth.listVersions(project.id, {});
    console.log('可用版本:', list.slice(0, 5).map((v) => v.versionNumber + '/' + v.gameVersions[0]));
    const version = list.find((v) => v.type === 'release') || list[0];
    console.log('选择版本:', version.versionNumber, version.files[0]?.filename);
    const task = tasks.create({ title: '安装整合包 ' + project.title });
    let last = '';
    bus.on('update', () => {
        const t = tasks.get(task.id);
        if (!t) return;
        const line = `[${t.phase}] ${t.current}/${t.total} ${(t.detail || '').slice(0, 60)}`;
        if (line !== last) { last = line; process.stdout.write('\r' + line.padEnd(110)); }
    });
    const t0 = Date.now();
    try {
        const res = await modpack.installFromModrinth(project, version, { task, signal: task.controller.signal });
        tasks.finish(task, 'done');
        console.log('\n安装完成:', res, ((Date.now() - t0) / 1000).toFixed(1) + 's');
        const mods = await versions.listMods(res.id);
        console.log('模组数量:', mods.length, mods.slice(0, 6).map((m) => m.name));
        const detail = await versions.getVersionDetail(res.id);
        console.log('版本 JSON:', JSON.stringify(detail.raw).slice(0, 220));
        console.log('继承链:', detail.chain, '游戏目录:', detail.gameDir);
        const launch = require('../src/core/launch');
        const cmd = await launch.buildLaunchCommand(res.id);
        console.log('启动命令 OK, classpath', cmd.classpath.length, 'java', cmd.java.version);
    } catch (e) {
        tasks.finish(task, 'failed', e);
        console.error('\n失败:', e);
        process.exitCode = 1;
    }
    process.exit(0);
})();
