'use strict';
/**
 * 极简 ZIP 读取器（支持 store / deflate，ZIP64 基础支持），
 * 用于读取整合包、资源包、模组包内的文件，无需第三方依赖。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { ensureDirAsync } = require('./fsutil');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

async function readCentralDirectory(file) {
    const fh = await fsp.open(file, 'r');
    try {
        const stat = await fh.stat();
        const size = stat.size;
        const tailLen = Math.min(size, 66000);
        const tail = Buffer.alloc(tailLen);
        await fh.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);

        // ZIP64
        if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
            const locOff = eocd - 20;
            if (locOff >= 0 && tail.readUInt32LE(locOff) === ZIP64_LOCATOR_SIG) {
                const z64Off = Number(tail.readBigUInt64LE(locOff + 8));
                const z64 = Buffer.alloc(56);
                await fh.read(z64, 0, 56, z64Off);
                if (z64.readUInt32LE(0) === ZIP64_EOCD_SIG) {
                    count = Number(z64.readBigUInt64LE(32));
                    cdSize = Number(z64.readBigUInt64LE(40));
                    cdOffset = Number(z64.readBigUInt64LE(48));
                }
            }
        }

        const cd = Buffer.alloc(cdSize);
        await fh.read(cd, 0, cdSize, cdOffset);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count && p + 46 <= cd.length; i++) {
            if (cd.readUInt32LE(p) !== CEN_SIG) break;
            const flags = cd.readUInt16LE(p + 8);
            const method = cd.readUInt16LE(p + 10);
            const crc = cd.readUInt32LE(p + 16);
            let compSize = cd.readUInt32LE(p + 20);
            let uncompSize = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            let localOffset = cd.readUInt32LE(p + 42);
            const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
            const nameLenUtf8 = (flags & 0x800) !== 0;
            const name = nameBuf.toString(nameLenUtf8 ? 'utf8' : 'utf8'); // 绝大多数为 UTF-8/CP437 兼容
            const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
            // ZIP64 extra field 0x0001
            let ep = 0;
            while (ep + 4 <= extra.length) {
                const tag = extra.readUInt16LE(ep);
                const len = extra.readUInt16LE(ep + 2);
                if (tag === 0x0001) {
                    let q = ep + 4;
                    if (uncompSize === 0xffffffff && q + 8 <= ep + 4 + len) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8; }
                    if (compSize === 0xffffffff && q + 8 <= ep + 4 + len) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
                    if (localOffset === 0xffffffff && q + 8 <= ep + 4 + len) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
                }
                ep += 4 + len;
            }
            entries.push({ name, method, crc, compSize, uncompSize, localOffset, flags });
            p += 46 + nameLen + extraLen + commentLen;
        }
        return { entries, fh, size };
    } finally {
        // fh 由调用方关闭
    }
}

async function extractEntry(ctx, entry) {
    const { fh } = ctx;
    const header = Buffer.alloc(30);
    await fh.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOC_SIG) throw new Error('ZIP 本地文件头损坏: ' + entry.name);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    if (entry.compSize === 0) return Buffer.alloc(0);
    const data = Buffer.alloc(entry.compSize);
    await fh.read(data, 0, entry.compSize, dataStart);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error('不支持的压缩方式 ' + entry.method + ': ' + entry.name);
}

async function listZip(file) {
    const ctx = await readCentralDirectory(file);
    try {
        return ctx.entries.map((e) => ({
            name: e.name.replace(/\\/g, '/'),
            size: e.uncompSize,
            isDir: e.name.endsWith('/'),
            method: e.method,
        }));
    } finally {
        await ctx.fh.close();
    }
}

/**
 * 解压 ZIP 到目录。
 * @param {object} opts { filter(name): boolean, prefix: 去掉的前缀, flatten: bool, onProgress }
 */
async function extractZip(file, destDir, opts = {}) {
    const ctx = await readCentralDirectory(file);
    const results = [];
    try {
        let done = 0;
        for (const entry of ctx.entries) {
            const rawName = entry.name.replace(/\\/g, '/');
            if (!rawName || rawName.endsWith('/')) continue;
            // filter 针对解压前的原始路径判断
            if (opts.filter && !opts.filter(rawName)) continue;
            let name = rawName;
            if (opts.prefix && name.startsWith(opts.prefix)) name = name.slice(opts.prefix.length);
            if (!name) continue;
            const target = path.join(destDir, name);
            // 防目录穿越
            const rel = path.relative(destDir, target);
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
            await ensureDirAsync(path.dirname(target));
            const data = await extractEntry(ctx, entry);
            await fsp.writeFile(target, data);
            results.push(target);
            done++;
            if (opts.onProgress) opts.onProgress(done, ctx.entries.length, name);
        }
    } finally {
        await ctx.fh.close();
    }
    return results;
}

/** 读取 ZIP 中的单个文件（文本） */
async function readZipFile(file, entryName) {
    const ctx = await readCentralDirectory(file);
    try {
        const entry = ctx.entries.find((e) => e.name.replace(/\\/g, '/') === entryName);
        if (!entry) return null;
        return await extractEntry(ctx, entry);
    } finally {
        await ctx.fh.close();
    }
}

/** 读取 ZIP 中的 JSON 文件 */
async function readZipJson(file, entryName) {
    const buf = await readZipFile(file, entryName);
    if (!buf) return null;
    try { return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

module.exports = { listZip, extractZip, readZipFile, readZipJson };
