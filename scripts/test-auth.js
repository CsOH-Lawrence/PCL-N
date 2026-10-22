'use strict';
/**
 * 账号与自动登录自测（不需要 Electron）：
 *   node scripts/test-auth.js
 * 会创建离线账号、校验启动参数里的账号信息，并验证微软登录接口是否可达。
 */
const fs = require('fs');
const path = require('path');

process.env.PCLN_DATA_DIR = process.env.PCLN_DATA_DIR || 'D:/Code/plain-craft-launcher/.atest';
process.env.PCLN_GAME_DIR = process.env.PCLN_GAME_DIR || 'D:/Code/plain-craft-launcher/.atest-game';

const { initPaths, paths } = require('../src/core/paths');
initPaths({});
const config = require('../src/core/config');
config.load();
const auth = require('../src/core/auth');
const launch = require('../src/core/launch');

(async () => {
    console.log('=== 离线账号 ===');
    const steve = auth.addOffline('Steve');
    const alex = auth.addOffline('Alex');
    console.log('添加:', steve.name, steve.uuid, '|', alex.name);
    console.log('当前账号:', auth.publicState().active.name);
    auth.select(steve.id);

    console.log('\n=== 启动凭据 ===');
    console.log(auth.getLaunchAuth());

    console.log('\n=== 启动参数（用假版本验证账号注入） ===');
    const dir = path.join(paths.versionsDir, 'TestVer');
    fs.mkdirSync(dir, { recursive: true });
    const versionJson = {
        id: 'TestVer',
        mainClass: 'net.minecraft.client.main.Main',
        type: 'release',
        libraries: [],
        arguments: {
            game: [
                '--username', '${auth_player_name}',
                '--uuid', '${auth_uuid}',
                '--accessToken', '${auth_access_token}',
                '--userType', '${user_type}',
                '--xuid', '${auth_xuid}',
            ],
        },
        assetIndex: { id: 'legacy' },
        assets: 'legacy',
    };
    fs.writeFileSync(path.join(dir, 'TestVer.json'), JSON.stringify(versionJson, null, 2));
    fs.writeFileSync(path.join(dir, 'TestVer.jar'), '');
    const cmd = await launch.buildLaunchCommand('TestVer');
    const idx = cmd.args.indexOf('--username');
    console.log('账号来源:', cmd.account?.type, cmd.account?.name);
    console.log('参数:', cmd.args.slice(idx, idx + 11).join(' '));

    console.log('\n=== 微软登录链路 ===');
    console.log('授权地址:', auth.buildAuthUrl());
    const fake = 'https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.example&lc=1033';
    console.log('回调解析:', auth.extractCode(fake), '| 是回调:', auth.isRedirect(fake));
    try {
        await auth.loginWithCode('fake-code');
    } catch (e) {
        console.log('使用假授权码登录（预期失败）:', e.message);
    }

    console.log('\n=== 清理 ===');
    console.log('移除账号后剩:', auth.remove(alex.id).accounts.length);
    fs.rmSync(path.join(paths.versionsDir, 'TestVer'), { recursive: true, force: true });
    console.log('OK');
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
})().catch((e) => {
    console.error('FAIL', e);
    process.exit(1);
});
