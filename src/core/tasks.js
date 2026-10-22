'use strict';
/** 任务中心：安装 / 下载 / 启动 等长时间任务的进度与取消管理 */
const { EventEmitter } = require('events');
const { createLogger } = require('./log');

const log = createLogger('task');
const bus = new EventEmitter();
bus.setMaxListeners(100);

let seq = 0;

const PHASE_TEXT = {
    prepare: '准备中',
    meta: '获取版本信息',
    client: '下载客户端',
    libraries: '下载依赖库',
    assets: '下载资源文件',
    loader: '安装加载器',
    modpack: '安装整合包',
    files: '下载整合包文件',
    overrides: '解压覆盖文件',
    verify: '校验文件',
    finished: '完成',
    launching: '启动中',
};

class Task {
    constructor(opts = {}) {
        this.id = opts.id || 'task-' + (++seq);
        this.kind = opts.kind || 'install';
        this.title = opts.title || '任务';
        this.detail = '';
        this.phase = 'prepare';
        this.current = 0;
        this.total = 0;
        this.bytesDone = 0;
        this.bytesTotal = 0;
        this.speed = 0;
        this.status = 'running'; // running | done | failed | cancelled
        this.error = null;
        this.startedAt = Date.now();
        this.finishedAt = 0;
        this.children = opts.children || [];
        this.cancellable = opts.cancellable !== false;
        this.controller = new AbortController();
        this.meta = opts.meta || {};
        this._lastEmit = 0;
        this._speedSample = { t: Date.now(), bytes: 0 };
        this._lastBytes = 0;
    }
    patch(p) {
        Object.assign(this, p);
        if (p.bytesDone !== undefined) this._sampleSpeed();
        this.touch();
    }
    _sampleSpeed() {
        const now = Date.now();
        const dt = now - this._speedSample.t;
        if (dt > 500) {
            const db = this.bytesDone - this._lastBytes;
            this.speed = dt > 0 ? Math.max(0, Math.round(db / (dt / 1000))) : 0;
            this._lastBytes = this.bytesDone;
            this._speedSample = { t: now, bytes: this.bytesDone };
        }
    }
    touch(force = false) {
        tasks.scheduleEmit(force);
    }
    toJSON() {
        return {
            id: this.id, kind: this.kind, title: this.title, detail: this.detail, phase: this.phase,
            phaseText: PHASE_TEXT[this.phase] || this.phase,
            current: this.current, total: this.total,
            percent: this.total > 0 ? Math.min(100, (this.current / this.total) * 100) : (this.status === 'running' ? 0 : 100),
            bytesDone: this.bytesDone, bytesTotal: this.bytesTotal, speed: this.speed,
            status: this.status, error: this.error, startedAt: this.startedAt, finishedAt: this.finishedAt,
            cancellable: this.cancellable && this.status === 'running', meta: this.meta,
        };
    }
}

class TaskManager {
    constructor() {
        this.tasks = new Map();
        this._emitTimer = null;
    }
    scheduleEmit(force) {
        if (this._emitTimer && !force) return;
        if (force) {
            clearTimeout(this._emitTimer);
            this._emitTimer = null;
            this.emit();
            return;
        }
        this._emitTimer = setTimeout(() => { this._emitTimer = null; this.emit(); }, 120);
    }
    emit() {
        bus.emit('update', this.list());
    }
    create(opts) {
        const t = new Task(opts);
        this.tasks.set(t.id, t);
        log.info(`创建任务 ${t.id}: ${t.title}`);
        this.emit();
        return t;
    }
    get(id) {
        return this.tasks.get(id);
    }
    list() {
        return [...this.tasks.values()].map((t) => t.toJSON()).sort((a, b) => b.startedAt - a.startedAt);
    }
    finish(task, status = 'done', error = null) {
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return;
        task.status = status;
        task.error = error ? (error.message || String(error)) : null;
        task.finishedAt = Date.now();
        if (status === 'done') {
            task.phase = 'finished';
            task.current = task.total || task.current;
            task.bytesDone = task.bytesTotal || task.bytesDone;
        }
        if (status === 'failed') log.error(`任务失败 ${task.id}: ${task.title}`, task.error);
        else log.info(`任务结束 ${task.id}: ${status}`);
        task.touch(true);
        // 5 分钟后清理已结束任务，避免内存膨胀
        const self = this;
        setTimeout(() => { if (self.tasks.has(task.id) && task.status !== 'running') { self.tasks.delete(task.id); self.emit(); } }, 5 * 60 * 1000).unref?.();
    }
    cancel(id) {
        const t = this.tasks.get(id);
        if (!t || t.status !== 'running') return false;
        t.controller.abort(new Error('用户取消'));
        t.status = 'cancelled';
        t.error = '已取消';
        t.finishedAt = Date.now();
        t.touch(true);
        log.info('任务取消 ' + id);
        return true;
    }
    clearFinished() {
        for (const [id, t] of this.tasks) if (t.status !== 'running') this.tasks.delete(id);
        this.emit();
    }
}

const tasks = new TaskManager();

module.exports = { tasks, bus, PHASE_TEXT, Task };
