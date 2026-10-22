'use strict';
/**
 * 崩溃 / 错误分析：根据 crash-report 与游戏日志给出简略帮助。
 */
const fs = require('fs');
const path = require('path');
const { isFile, listDir, readJsonSync } = require('./fsutil');

const RULES = [
    {
        id: 'oom',
        re: /java\.lang\.OutOfMemoryError(?::\s*(Java heap space|Metaspace|GC overhead limit exceeded|Compressed class space))?/,
        title: '游戏内存不足',
        solution: '在「版本设置 - 内存」中调大最大内存（建议 4096~8192 MB，且不要超过电脑物理内存的一半），关闭高占用模组或降低渲染距离；若为 Metaspace，可改用较新的 Java 并适度增加内存。',
        level: 'error',
    },
    {
        id: 'oom-native',
        re: /There is insufficient memory for the Java Runtime Environment|Cannot allocate memory|paging file is too small/i,
        title: '系统内存 / 虚拟内存不足',
        solution: '关闭其他占用内存的程序，或调大 Windows 虚拟内存（页面文件），并把游戏内存调整为合理值。',
        level: 'error',
    },
    {
        id: 'jvm-heap',
        re: /Invalid maximum heap size|Initial heap size set to a larger value than the maximum heap size|Could not reserve enough space for object heap/,
        title: '内存参数不合法',
        solution: '「版本设置 - 内存」中的数值设置错误（过大的 -Xmx 或 -Xms 大于 -Xmx）。请改为合理的内存值，并确认使用的是 64 位 Java。',
        level: 'error',
    },
    {
        id: 'java-version',
        re: /UnsupportedClassVersionError|class file version (\d+)|has been compiled by a more recent version of the Java Runtime/,
        title: 'Java 版本不匹配',
        solution: '这个版本（或其中的模组）需要更高版本的 Java。打开「设置 - Java」安装与游戏版本匹配的 Java（1.16 及以下用 Java 8，1.17~1.20.4 用 Java 17，1.20.5+ 用 Java 21）。',
        level: 'error',
    },
    {
        id: 'java-too-new',
        re: /has been compiled by a more recent version|Unsupported Java|Java 8 is not supported|requires Java (\d+)|Detected Java version .* but .* requires/i,
        title: 'Java 版本过新或过旧',
        solution: '在版本设置里手动指定合适的 Java 版本。老版本（1.12.2 及更早）请使用 Java 8，1.17~1.20.4 使用 Java 17，1.20.5 之后使用 Java 21。',
        level: 'error',
    },
    {
        id: 'missing-main',
        re: /Could not find or load main class|Error: Main method not found|no main manifest attribute|Unable to access jarfile/,
        title: '游戏核心文件损坏或缺失',
        solution: '在版本卡片中选择「校验并修复」，或重新安装该版本。也可能是 Java 版本不正确导致无法加载主类。',
        level: 'error',
    },
    {
        id: 'classnotfound',
        re: /ClassNotFoundException|NoClassDefFoundError/,
        title: '缺少运行所需的类（模组不完整或游戏文件缺失）',
        solution: '通常是缺少前置模组或文件下载不完整。请检查日志中缺失的类名，安装对应前置模组，或对版本执行「校验并修复」。',
        level: 'error',
    },
    {
        id: 'mod-deps',
        re: /ModResolutionException|Incompatible mod set|Missing or unsupported mandatory dependencies|requires .* which is not installed|Missing dependency|Unsatisfied dependency/i,
        title: '模组缺少前置或版本不兼容',
        solution: '按日志提示安装缺少的前置模组，或把版本不匹配的模组换成当前游戏版本 / 加载器对应的文件。启动器下载模组时会自动安装依赖。',
        level: 'error',
    },
    {
        id: 'mixin',
        re: /Mixin apply failed|MixinException|InvalidMixinException|Critical injection failure|MixinApplyError|The mixin .* could not be applied/i,
        title: '模组注入失败（Mixin 冲突）',
        solution: '某个模组与当前游戏 / 其他模组冲突。优先移除最近添加的模组；日志中通常会写出具体 Mixin 名称，可据此定位模组。也可尝试更新 Fabric Loader / Forge。',
        level: 'error',
    },
    {
        id: 'nosuchmethod',
        re: /NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError/,
        title: '模组与游戏版本不匹配',
        solution: '某个模组是为其他 Minecraft / 加载器版本编译的。请下载与当前版本对应的模组文件，或移除报错信息中提到的模组。',
        level: 'error',
    },
    {
        id: 'glfw',
        re: /GLFW error 65542|The driver does not appear to support OpenGL|Failed to create GLFW window|Pixel format not accelerated|OpenGL 3\.2|GLFW 65543/i,
        title: '显卡驱动 / OpenGL 不支持',
        solution: '当前环境缺少可用的 OpenGL 3.2+ 支持。请先更新显卡驱动（NVIDIA / AMD / Intel 官网）；若在虚拟机、远程桌面或云电脑中运行，通常需要为虚拟机开启 GPU 直通，或安装 Mesa3D 软件渲染（把 opengl32.dll 放到 Java 的 bin 目录）再启动。也可以换用配置了显卡的实体机。',
        level: 'error',
    },
    {
        id: 'vm-no-gpu',
        re: /vmware|virtualbox|hyper-v|qemu|kvm|parallels|virtual machine|Microsoft Basic Display|软件渲染/i,
        title: '检测到虚拟机环境',
        solution: '虚拟机默认没有 3D 加速，Minecraft 需要 OpenGL 3.2 才能创建窗口。请在虚拟机设置中开启 3D 加速 / GPU 直通，或改用 Mesa3D 软件渲染；否则游戏只能运行在纯服务端/命令行场景。',
        level: 'warn',
    },
    {
        id: 'lwjgl',
        re: /LWJGLException|Failed to create window|Could not initialize GLFW/,
        title: '无法创建游戏窗口',
        solution: '更新显卡驱动、关闭屏幕录制 / 覆盖层软件（如某些游戏助手），确认没有其他程序独占显卡。显卡过旧时请降低游戏版本或使用优化模组。',
        level: 'error',
    },
    {
        id: 'duplicate-mod',
        re: /DuplicateModsFoundException|Duplicate mods found|Found duplicate mod|duplicate modid/i,
        title: '存在重复的模组',
        solution: 'mods 文件夹中有两个相同 ID 的模组（例如同时放了两个版本）。日志会列出冲突的文件名，删除较旧的那个即可。',
        level: 'error',
    },
    {
        id: 'invalid-mixin',
        re: /InvalidMixinConfigException|Invalid access|Mixin config .* is invalid/i,
        title: '模组的 Mixin 配置无效',
        solution: '该模组文件损坏或与加载器版本不匹配，建议重新下载该模组，或更新 Fabric Loader。',
        level: 'error',
    },
    {
        id: 'network',
        re: /UnknownHostException|Connection (timed out|refused|reset)|Failed to download|SocketTimeoutException|SSLHandshakeException|Unable to connect to/i,
        title: '网络连接失败',
        solution: '在「设置 - 下载」中切换下载源（镜像 / 官方），检查网络与防火墙；启动游戏时的网络错误一般不影响单机，若为联机请检查服务器地址。',
        level: 'warn',
    },
    {
        id: 'access-denied',
        re: /AccessDeniedException|Permission denied|Access is denied|拒绝访问/,
        title: '文件访问被拒绝',
        solution: '游戏目录可能位于受保护位置（如 Program Files），或被杀毒软件拦截。把游戏目录移到普通文件夹（如 D:\\Minecraft），并把启动器加入杀毒软件白名单。',
        level: 'error',
    },
    {
        id: 'verify',
        re: /java\.lang\.VerifyError|ClassFormatError|Library file .* is corrupted|ZipException|invalid LOC header/i,
        title: '文件损坏',
        solution: '某个 jar 文件下载不完整或已损坏。请对版本执行「校验并修复」，或重新下载对应的模组 / 资源文件。',
        level: 'error',
    },
    {
        id: 'init-error',
        re: /ExceptionInInitializerError|Exception initializing level|Failed to initialize/i,
        title: '初始化失败',
        solution: '通常是模组在初始化阶段出错。查看完整堆栈中最靠前的模组类名，移除或更新该模组。',
        level: 'error',
    },
    {
        id: 'bootstrap',
        re: /Failed to start the game|BootstrapMethods|java\.lang\.RuntimeException: Unable to launch/i,
        title: '游戏启动流程失败',
        solution: '尝试校验并修复版本；若安装了模组，先清空 mods 文件夹确认是否为模组问题，再逐个添加排查。',
        level: 'error',
    },
    {
        id: 'exit-code',
        re: /Exit Code:\s*(-?\d+|0x[0-9A-Fa-f]+)/,
        title: '游戏异常退出',
        solution: '退出码能帮助定位问题：-1073741819(0xC0000005) 多为显卡驱动或模组访问冲突；-1073740791(0xC0000409) 多为驱动 / 系统组件问题；-1 常见于强制关闭。请更新显卡驱动并减少模组。',
        level: 'error',
    },
    {
        id: 'unsatisfied-link',
        re: /UnsatisfiedLinkError|java\.lang\.UnsatisfiedLinkError|no .* in java\.library\.path/i,
        title: '本机库加载失败',
        solution: '多为 Java 位数（32/64 位）或系统架构不匹配，或 natives 文件缺失。请使用 64 位 Java，并校验修复版本文件。',
        level: 'error',
    },
    {
        id: 'add-opens',
        re: /InaccessibleObjectException|module .* does not "opens|IllegalAccessError.*java\.base/i,
        title: 'Java 模块访问受限',
        solution: '部分老模组需要额外的 JVM 参数。可在版本设置的「自定义 JVM 参数」中添加 --add-opens java.base/java.lang=ALL-UNNAMED，或换用该模组支持的 Java 版本。',
        level: 'warn',
    },
    {
        id: 'fabric-api',
        re: /Fabric API is required|fabric-api.*not installed|requires fabric-api/i,
        title: '缺少 Fabric API',
        solution: '安装 Fabric API（在「下载 - 模组」中搜索 Fabric API），并确保其版本与游戏版本一致。',
        level: 'error',
    },
    {
        id: 'mod-loading',
        re: /LoadingFailedException|Failed to load mods|Mod loading has failed|net\.minecraftforge\.fml\.loading/i,
        title: '模组加载失败',
        solution: '查看日志中 "Failed to load mods" 之后列出的模组，逐个移除排查；同时确认 Forge / NeoForge 与游戏版本匹配。',
        level: 'error',
    },
    {
        id: 'outdated-loader',
        re: /fabric-loader.*(outdated|too old)|loader version .* is not supported|requires a newer version of (Fabric|Forge|NeoForge)/i,
        title: '模组加载器版本过旧',
        solution: '重新安装最新版的 Fabric / Quilt / Forge / NeoForge，或在「下载 - 加载器」中选择更新的版本。',
        level: 'warn',
    },
    {
        id: 'auth',
        re: /Authentication servers are down|Invalid session|Failed to login|Invalid credentials/i,
        title: '登录 / 验证失败',
        solution: '本启动器默认使用离线登录，无法进入正版服务器。若要联机正版服务器，请使用正版账号登录其他启动器，或在服务器配置中开启离线模式。',
        level: 'warn',
    },
    {
        id: 'java-missing',
        re: /java(\.exe)?: (command not found|不是内部或外部命令)|系统找不到指定的文件.*java/i,
        title: '找不到 Java',
        solution: '在「设置 - Java」中扫描或下载 Java，或在版本设置中手动指定 java.exe 路径。',
        level: 'error',
    },
    {
        id: 'mixin-remap',
        re: /MixinTransformerError|remap.*failed|no refMap loaded/i,
        title: '模组重映射失败',
        solution: '该模组与当前加载器 / 游戏版本不兼容。请确认模组适用于该版本，或更新 Fabric Loader。',
        level: 'error',
    },
    {
        id: 'timeout-server',
        re: /Timed out|Read timed out|Connection reset by peer/i,
        title: '连接超时',
        solution: '检查网络连接；若在下载资源时出现，请在设置中切换下载源或稍后重试。',
        level: 'warn',
    },
];

function parseMemory(text) {
    const m = text.match(/--?Xmx\s*(\d+)([mMgG])?/);
    const m2 = text.match(/JVM Flags:.*?-Xmx(\d+)([mMgG])/);
    const src = m || m2;
    if (!src) return null;
    let n = parseInt(src[1], 10);
    if (src[2] && src[2].toLowerCase() === 'g') n *= 1024;
    return n;
}

function parseJavaVersion(text) {
    const m = text.match(/Java Version:\s*([^\n,]+)/i) || text.match(/java\.version\s*=\s*([^\s,]+)/i) || text.match(/using Java (\d+)/i);
    return m ? m[1].trim() : null;
}

function extractMods(text) {
    const mods = new Set();
    // 常见格式: "mod_name 1.2.3" / "Mod: xxx" / " - modid@version"
    const patterns = [
        /\b([a-z0-9_-]+)\s+v?(\d+\.\d+(?:\.\d+)?[^\s,)]*)\s+(?:from|requires|is not installed)/gi,
        /Mod File:\s*([^\n]+\.jar)/gi,
        /at\s+([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,})/gi,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text))) {
            const v = m[1].trim();
            if (v.length < 3) continue;
            if (/^(java|javax|sun|jdk|net\.minecraft|com\.mojang|org\.lwjgl|org\.apache|io\.netty|net\.fabricmc|org\.spongepowered|cpw\.mods|com\.electron|org\.slf4j|org\.objectweb|net\.neoforged|net\.minecraftforge)/i.test(v)) continue;
            mods.add(v.slice(0, 80));
            if (mods.size > 12) break;
        }
    }
    return [...mods];
}

function analyzeText(text, meta = {}) {
    const normalized = String(text || '');
    const matched = [];
    for (const rule of RULES) {
        const m = normalized.match(rule.re);
        if (m) {
            matched.push({
                id: rule.id,
                level: rule.level,
                title: rule.title,
                solution: rule.solution,
                evidence: m[0].slice(0, 200),
            });
        }
    }
    // 去重（同一 id 只保留一次）
    const seen = new Set();
    const causes = matched.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    const mods = extractMods(normalized);
    const memory = parseMemory(normalized);
    const javaVersion = parseJavaVersion(normalized);
    const exitCode = (normalized.match(/Exit Code:\s*(-?\d+|0x[0-9A-Fa-f]+)/i) || [])[1] || null;

    let summary;
    if (causes.length === 0) {
        summary = '没有识别出明确的错误模式。可以把日志发到交流群，或用下方的「查看原始日志」自行排查。';
    } else {
        summary = causes[0].title;
    }

    return {
        ok: causes.length === 0,
        summary,
        causes,
        mods,
        memory,
        javaVersion,
        exitCode,
        analyzedAt: new Date().toISOString(),
        meta,
    };
}

async function analyzeFile(filePath) {
    if (!isFile(filePath)) throw new Error('文件不存在: ' + filePath);
    const stat = fs.statSync(filePath);
    const maxBytes = 4 * 1024 * 1024;
    let text;
    if (stat.size > maxBytes) {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
        fs.closeSync(fd);
        text = buf.toString('utf8');
    } else {
        text = fs.readFileSync(filePath, 'utf8');
    }
    return analyzeText(text, { file: filePath, size: stat.size });
}

/** 分析游戏目录下最新的日志 / 崩溃报告 */
async function analyzeGameDir(gameDir) {
    const candidates = [];
    const crashDir = path.join(gameDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
        for (const e of await listDir(crashDir)) {
            if (e.isFile() && /\.txt$/i.test(e.name)) {
                const p = path.join(crashDir, e.name);
                candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs, kind: 'crash' });
            }
        }
    }
    const logsDir = path.join(gameDir, 'logs');
    if (fs.existsSync(logsDir)) {
        for (const name of ['latest.log', 'debug.log']) {
            const p = path.join(logsDir, name);
            if (isFile(p)) candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs, kind: 'log' });
        }
        for (const e of await listDir(logsDir)) {
            if (e.isFile() && /^pcln-.*\.log$/i.test(e.name)) {
                const p = path.join(logsDir, e.name);
                candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs, kind: 'launcher-log' });
            }
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (!candidates.length) return null;
    const best = candidates[0];
    const result = await analyzeFile(best.path);
    result.meta.kind = best.kind;
    result.meta.mtime = best.mtime;
    return result;
}

module.exports = { analyzeText, analyzeFile, analyzeGameDir, RULES, extractMods };
