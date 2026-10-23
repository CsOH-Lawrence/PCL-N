'use strict';
/**
 * 诊断：同一签名 URL 下单连接 vs 多连接（Range）的下载速度
 *   $env:SIGNED_URL="https://productionresultssa*.blob.core.windows.net/..."; node scripts/test-blob-speed.js
 */
const url = process.env.SIGNED_URL;
if (!url) {
    console.error('缺少 SIGNED_URL 环境变量');
    process.exit(1);
}
const SECONDS = Number(process.env.SECONDS || 10);
const CONNS = Number(process.env.CONNS || 6);

async function run(conns) {
    let total = 0;
    let done = 0;
    const started = Date.now();
    const controllers = [];
    const tasks = [];
    for (let i = 0; i < conns; i++) {
        const start = i * 20_000_000;
        const end = start + 20_000_000 - 1;
        const ctl = new AbortController();
        controllers.push(ctl);
        tasks.push((async () => {
            try {
                const res = await fetch(url, {
                    headers: { Range: `bytes=${start}-${end}` },
                    signal: ctl.signal,
                });
                if (!res.ok && res.status !== 206) {
                    console.log(`  连接 ${i}: HTTP ${res.status}`);
                    return;
                }
                for await (const chunk of res.body) {
                    total += chunk.length;
                }
            } catch (e) {
                // 超时中断是正常的
            } finally {
                done++;
            }
        })());
    }
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    controllers.forEach((c) => { try { c.abort(); } catch { /* ignore */ } });
    await Promise.allSettled(tasks);
    const secs = (Date.now() - started) / 1000;
    return { total, secs, mbps: total / secs / 1048576, done };
}

(async () => {
    console.log(`单连接，测 ${SECONDS} 秒…`);
    const one = await run(1);
    console.log(`  单连接: ${one.mbps.toFixed(2)} MB/s (${(one.total / 1048576).toFixed(1)} MB)`);

    console.log(`\n${CONNS} 连接分段，测 ${SECONDS} 秒…`);
    const many = await run(CONNS);
    console.log(`  ${CONNS} 连接合计: ${many.mbps.toFixed(2)} MB/s (${(many.total / 1048576).toFixed(1)} MB)`);
    console.log(`\n提速倍数: ${(many.mbps / Math.max(one.mbps, 0.01)).toFixed(1)}x`);
})().catch((e) => {
    console.error('失败:', e.message);
    process.exit(1);
});
