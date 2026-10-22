'use strict';
/**
 * 生成演示用的版本目录（只用于截图 / 界面测试，不含真实游戏文件）
 *   node scripts/make-demo.js
 * 结果写入 .demo-game，供 PCLN_GAME_DIR 使用。
 */
const fs = require('fs');
const path = require('path');

process.env.PCLN_DATA_DIR = process.env.PCLN_DATA_DIR || 'D:/Code/plain-craft-launcher/.demo-data';
process.env.PCLN_GAME_DIR = process.env.PCLN_GAME_DIR || 'D:/Code/plain-craft-launcher/.demo-game';

const { initPaths, paths } = require('../src/core/paths');
initPaths({});
const config = require('../src/core/config');
config.load();
const { fetchJson } = require('../src/core/http');

function writeVersion(id, json) {
    const dir = path.join(paths.versionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(json, null, 2));
    return dir;
}

(async () => {
    const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = manifest.versions.find((v) => v.id === '1.21.1');
    const vanilla = await fetchJson(entry.url);
    writeVersion('1.21.1', vanilla);

    const fabric = await fetchJson('https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.5/profile/json');
    writeVersion(fabric.id, fabric);

    const packId = 'Create+ 整合包';
    const packDir = writeVersion(packId, {
        id: packId, inheritsFrom: fabric.id, name: packId, type: 'release',
        minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5',
    });
    for (const d of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves']) {
        fs.mkdirSync(path.join(packDir, d), { recursive: true });
    }
    for (const m of ['create-1.21.1-6.0.0.jar', 'flywheel-0.6.11.jar', 'jei-1.21.1-19.2.0.112.jar', 'ponder-1.0.60.jar', 'copycats-2.1.4.jar']) {
        fs.writeFileSync(path.join(packDir, 'mods', m), '');
    }
    fs.mkdirSync(path.join(packDir, 'saves', '创造世界'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'resourcepacks', 'Faithful 32x.zip'), '');
    fs.writeFileSync(path.join(packDir, 'shaderpacks', 'ComplementaryReimagined_r5.2.zip'), '');

    console.log('demo versions:', fs.readdirSync(paths.versionsDir).join(', '));
})();
