'use strict';
/** 统一日志：写入文件 + 内存环形缓冲 + 事件广播 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { paths } = require('./paths');

const bus = new EventEmitter();
bus.setMaxListeners(200);

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const state = {
    level: LEVELS[process.env.PCLN_LOG_LEVEL] || LEVELS.debug,
    buffer: [],
    maxBuffer: 4000,
    stream: null,
    currentFile: null,
    listeners: 0,
};

function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openStream() {
    if (state.stream) return state.stream;
    try {
        fs.mkdirSync(paths.logsDir, { recursive: true });
        state.currentFile = path.join(paths.logsDir, `launcher-${today()}.log`);
        state.stream = fs.createWriteStream(state.currentFile, { flags: 'a' });
        state.stream.on('error', () => { state.stream = null; });
    } catch {
        state.stream = null;
    }
    return state.stream;
}

function log(level, scope, message, extra) {
    const lv = LEVELS[level] || LEVELS.info;
    if (lv < state.level) return;
    const time = new Date();
    const ts = time.toTimeString().slice(0, 8) + '.' + String(time.getMilliseconds()).padStart(3, '0');
    let text = message;
    if (extra instanceof Error) text += ' ' + (extra.stack || extra.message);
    else if (extra !== undefined) {
        try { text += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); } catch { /* ignore */ }
    }
    const line = `[${ts}][${level.toUpperCase().padEnd(5)}][${scope}] ${text}`;
    const entry = { time: time.toISOString(), level, scope, text, line };
    state.buffer.push(entry);
    if (state.buffer.length > state.maxBuffer) state.buffer.splice(0, state.buffer.length - state.maxBuffer);
    const s = openStream();
    if (s) s.write(line + '\n');
    if (state.listeners > 0) bus.emit('log', entry);
    if (lv >= LEVELS.warn && process.env.PCLN_LOG_CONSOLE !== '0') {
        // 控制台回显，便于开发调试
        (lv >= LEVELS.error ? console.error : console.warn)(line);
    }
}

function createLogger(scope) {
    return {
        trace: (m, e) => log('trace', scope, m, e),
        debug: (m, e) => log('debug', scope, m, e),
        info: (m, e) => log('info', scope, m, e),
        warn: (m, e) => log('warn', scope, m, e),
        error: (m, e) => log('error', scope, m, e),
        child: (sub) => createLogger(scope + ':' + sub),
    };
}

function getLogs(limit = 500) {
    return state.buffer.slice(-limit);
}

function getLogFile() {
    openStream();
    return state.currentFile;
}

bus.on('newListener', (ev) => { if (ev === 'log') state.listeners++; });
bus.on('removeListener', (ev) => { if (ev === 'log') state.listeners = Math.max(0, state.listeners - 1); });

module.exports = { createLogger, getLogs, getLogFile, bus, log, LEVELS };
