/* 渲染层核心：状态、事件总线、通用组件 */
(function () {
    const I = window.Icons;
    const api = window.pcln;

    const App = {
        state: {
            info: null,
            config: null,
            versions: [],
            selectedVersion: '',
            page: 'home',
            tasks: [],
            running: null,
            download: {
                tab: 'game',
                gameVersion: '',
                loader: '',
                manifest: null,
                page: 0,
                pageSize: 30,
                query: '',
                typeFilter: 'release',
                projects: {},
                projectList: [],
                total: 0,
                loading: false,
            },
            help: { result: null, analyzing: false },
            logs: [],
        },
        actions: {},
        on(name, fn) { this.actions[name] = fn; },
        el(id) { return document.getElementById(id); },
        svg(name) { return I[name] || ''; },
    };
    window.App = App;

    /* ---------------------------- 工具函数 ---------------------------- */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    App.esc = esc;

    function fmtBytes(n) {
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
    }
    function fmtSpeed(n) {
        if (!n) return '';
        return fmtBytes(n) + '/s';
    }
    function fmtCount(n) {
        if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿';
        if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
        return String(n || 0);
    }
    function timeAgo(iso) {
        if (!iso) return '';
        const t = typeof iso === 'number' ? iso : Date.parse(iso);
        if (!t) return '';
        const d = Date.now() - t;
        if (d < 60000) return '刚刚';
        if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
        if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
        if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
        return new Date(t).toLocaleDateString('zh-CN');
    }
    function fmtDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    Object.assign(App, { fmtBytes, fmtSpeed, fmtCount, timeAgo, fmtDate });

    /* ------------------------------ Toast ----------------------------- */
    function toast(msg, type = 'info', ms = 2600) {
        const host = document.getElementById('toast-host');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.innerHTML = (type === 'success' ? I.check : type === 'error' ? I.alert : I.info) + `<span>${esc(msg)}</span>`;
        el.style.display = 'flex';
        el.querySelector('svg').style.width = '14px';
        el.querySelector('svg').style.height = '14px';
        host.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity .2s, transform .2s';
            el.style.opacity = '0';
            el.style.transform = 'translateY(-6px)';
            setTimeout(() => el.remove(), 220);
        }, ms);
    }
    App.toast = toast;

    /* ------------------------------ 弹窗 ------------------------------ */
    function modal({ title, body, footer, wide, narrow, onClose, iconName }) {
        const host = document.getElementById('modal-host');
        const mask = document.createElement('div');
        mask.className = 'modal-mask';
        mask.innerHTML = `
            <div class="modal ${wide ? 'wide' : ''} ${narrow ? 'narrow' : ''}">
                <div class="modal-head">
                    ${iconName ? `<span style="display:inline-flex;width:16px;height:16px;color:var(--accent)">${I[iconName] || ''}</span>` : ''}
                    <span class="grow">${esc(title || '')}</span>
                    <button class="modal-close" data-close>${I.close}</button>
                </div>
                <div class="modal-body"></div>
                <div class="modal-foot ${footer ? '' : 'hidden'}"></div>
            </div>`;
        const bodyEl = mask.querySelector('.modal-body');
        const footEl = mask.querySelector('.modal-foot');
        if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
        if (typeof footer === 'string') footEl.innerHTML = footer; else if (footer) footEl.appendChild(footer);
        document.getElementById('modal-host').appendChild(mask);
        mask.querySelector('.modal-close').onclick = () => close();
        mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        let closed = false;
        function close() {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey);
            mask.remove();
            if (onClose) onClose();
        }
        mask.querySelector('.modal-close').innerHTML = I.close;
        mask.querySelector('.modal-close').style.width = '26px';
        mask.querySelector('.modal-close').style.height = '26px';
        mask.querySelector('.modal-close').querySelector('svg').style.width = '13px';
        return { mask, body: bodyEl, footer: footEl, close };
    }
    App.modal = modal;

    function confirmDialog({ title = '确认操作', text = '', okText = '确定', danger = false }) {
        return new Promise((resolve) => {
            let result = false;
            const m = modal({
                title,
                narrow: true,
                body: `<div style="line-height:1.75;white-space:pre-wrap">${esc(text)}</div>`,
                footer: `<button class="btn" data-close>取消</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
                onClose: () => resolve(result),
            });
            m.footer.querySelector('[data-close]').onclick = () => m.close();
            m.footer.querySelector('[data-ok]').onclick = () => { result = true; m.close(); };
        });
    }
    App.confirm = confirmDialog;

    function promptDialog({ title = '请输入', value = '', placeholder = '', hint = '', multiline = false }) {
        return new Promise((resolve) => {
            let result = null;
            const m = modal({
                title,
                narrow: true,
                body: `
                    <div class="field-hint" style="margin-bottom:8px">${esc(hint)}</div>
                    ${multiline
                        ? `<textarea class="textarea" style="width:100%;height:110px" data-input placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
                        : `<input class="input" style="width:100%" data-input value="${esc(value)}" placeholder="${esc(placeholder)}">`}`,
                footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>确定</button>`,
                onClose: () => resolve(result),
            });
            const input = m.body.querySelector('[data-input]');
            setTimeout(() => { input.focus(); input.select && input.select(); }, 30);
            const ok = () => { result = input.value.trim(); m.close(); };
            m.footer.querySelector('[data-close]').onclick = () => m.close();
            m.footer.querySelector('[data-ok]').onclick = ok;
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) ok(); });
        });
    }
    App.prompt = promptDialog;

    /* --------------------------- 数据加载 / 刷新 --------------------------- */
    async function call(fn, ...args) {
        try {
            return await fn(...args);
        } catch (e) {
            toast(e?.message || String(e), 'error', 4200);
            throw e;
        }
    }
    App.call = call;

    async function refreshConfig() {
        App.state.config = await api.configGet();
        return App.state.config;
    }
    async function refreshVersions() {
        App.state.versions = await api.versions();
        const ids = new Set(App.state.versions.map((v) => v.id));
        if (!ids.has(App.state.selectedVersion)) {
            const last = App.state.config?.lastVersion;
            App.state.selectedVersion = ids.has(last) ? last : (App.state.versions[0]?.id || '');
        }
        renderSide();
        return App.state.versions;
    }
    Object.assign(App, { refreshConfig, refreshVersions });

    function loaderName(loader) {
        return { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', optifine: 'OptiFine' }[loader] || loader || '原版';
    }
    App.loaderName = loaderName;

    function renderSide() {
        const v = App.state.versions.find((x) => x.id === App.state.selectedVersion);
        const box = document.getElementById('side-version');
        if (box) {
            box.innerHTML = v
                ? `<b title="${esc(v.id)}">${esc(v.id)}</b>${esc(loaderName(v.loader))} · ${esc(v.mcVersion || '')}`
                : '<b>未选择版本</b>请先安装一个版本';
        }
        const user = document.getElementById('side-user');
        if (user && App.renderSideUser) App.renderSideUser();
        const mid = document.getElementById('status-mid');
        if (mid && App.state.config) mid.textContent = '游戏目录：' + App.state.config.gameDir;
        const right = document.getElementById('status-right');
        if (right && App.state.info) right.textContent = 'PCL-N v' + App.state.info.version;
    }
    App.renderSide = renderSide;

    function selectVersion(id) {
        App.state.selectedVersion = id;
        App.state.download.targetVersion = id;
        App.state.config.lastVersion = id;
        api.configSet({ lastVersion: id }).catch(() => {});
        renderSide();
        App.renderPage();
    }
    App.selectVersion = selectVersion;

    /* ------------------------------ 导航 ------------------------------ */
    const NAV = [
        { id: 'home', name: '主页', icon: 'home' },
        { id: 'download', name: '下载', icon: 'download' },
        { id: 'settings', name: '设置', icon: 'settings' },
        { id: 'help', name: '帮助', icon: 'help' },
    ];
    function renderNav() {
        const nav = document.getElementById('nav');
        nav.innerHTML = NAV.map((n) => `
            <button class="nav-item ${App.state.page === n.id ? 'active' : ''}" data-act="go" data-page="${n.id}">
                ${I[n.icon]}<span class="nav-label">${n.name}</span>
            </button>`).join('');
    }
    App.renderNav = renderNav;
    App.NAV = NAV;

    function setPage(page) {
        if (!NAV.some((n) => n.id === page)) page = 'home';
        const changed = App.state.page !== page;
        App.state.page = page;
        document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
        renderNav();
        document.getElementById('page-' + page).scrollTop = 0;
        App.renderPage();
        api.configSet({ lastPage: page }).catch(() => {});
        return changed;
    }
    App.setPage = setPage;

    function renderPage() {
        const renderers = {
            home: () => window.HomePage?.render(),
            download: () => window.DownloadPage?.render(),
            settings: () => window.SettingsPage?.render(),
            help: () => window.HelpPage?.render(),
        };
        try {
            renderers[App.state.page]?.();
        } catch (e) {
            console.error(e);
            toast('页面渲染失败: ' + e.message, 'error');
        }
    }
    App.renderPage = renderPage;

    /* ------------------------------ 任务栏 ------------------------------ */
    function renderTasks(list) {
        App.state.tasks = list || [];
        const bar = document.getElementById('taskbar');
        const active = App.state.tasks.filter((t) => t.status === 'running');
        const recent = App.state.tasks.filter((t) => t.status !== 'running').slice(0, 2);
        const show = [...active, ...recent];
        if (!show.length) {
            bar.classList.remove('show');
            bar.innerHTML = '';
            return;
        }
        bar.classList.add('show');
        bar.innerHTML = `<div class="taskbar-inner">` + show.map((t) => {
            const pct = t.status === 'done' ? 100 : Math.min(100, t.percent || 0);
            const info = t.status === 'failed' ? `<span style="color:var(--red)">失败</span>`
                : t.status === 'cancelled' ? '已取消'
                    : t.status === 'done' ? '完成'
                        : `${pct.toFixed(0)}% ${t.speed ? '· ' + fmtSpeed(t.speed) : ''} ${t.bytesTotal ? '· ' + fmtBytes(t.bytesDone) + '/' + fmtBytes(t.bytesTotal) : ''}`;
            return `<div class="task-item ${t.status}" title="${esc(t.error || '')}">
                <span class="task-name"><b>${esc(t.title)}</b>${t.detail ? ' · ' + esc(String(t.detail).slice(0, 40)) : ''}</span>
                <span class="task-bar"><i style="width:${pct}%"></i></span>
                <span class="task-info">${info}</span>
                ${t.cancellable ? `<button class="task-x" data-act="cancel-task" data-id="${esc(t.id)}" title="取消">${I.close}</button>` : '<span style="width:18px"></span>'}
            </div>`;
        }).join('') + '</div>';
    }
    App.renderTasks = renderTasks;

    /* 取消后台任务 */
    App.on('cancel-task', async (el) => {
        const id = el.dataset.id;
        if (!id) return;
        await api.taskCancel(id);
        App.state.tasks = await api.taskList();
        renderTasks(App.state.tasks);
        toast('已取消任务', 'info');
    });

    function setStatus(text) {
        const el = document.getElementById('status-left');
        if (el) el.textContent = text;
    }
    App.setStatus = setStatus;

    /* ------------------------------ 启动游戏 ------------------------------ */
    async function launchVersion(id) {
        const versionId = id || App.state.selectedVersion;
        if (!versionId) { toast('请先安装并选择一个版本', 'warn'); return; }
        if (App.state.running) { toast('游戏已在运行中', 'warn'); return; }
        setStatus('正在启动 ' + versionId + '…');
        try {
            const res = await api.launch(versionId);
            toast(`正在启动 ${versionId}（Java ${res.javaVersion}）`, 'success');
            App.state.running = { id: versionId };
            renderSide();
            setTimeout(() => { App.renderPage(); }, 300);
        } catch (e) {
            setStatus('启动失败');
            // JAVA_NOT_FOUND 时给出引导
            if (/Java/i.test(e.message)) {
                const go = await confirmDialog({
                    title: '缺少 Java 运行时',
                    text: e.message + '\n\n是否前往「设置 - Java」安装？',
                    okText: '去安装',
                });
                if (go) { setPage('settings'); }
            }
            throw e;
        }
    }
    App.launchVersion = launchVersion;

    /* --------------------------- 版本安装等动作 --------------------------- */
    async function installVanilla(id, label) {
        const t = await api.installVanilla(id);
        toast(`已开始安装 ${label || id}，可在下方查看进度`, 'success');
        App.state.tasks = await api.taskList();
        renderTasks(App.state.tasks);
        return t;
    }
    App.installVanilla = installVanilla;

    async function refreshTasks() {
        App.state.tasks = await api.taskList();
        renderTasks(App.state.tasks);
    }
    App.refreshTasks = refreshTasks;

    /* --------------------------- 版本图标辅助 --------------------------- */
    function versionIconHtml(v, size) {
        const cls = v.loader || 'vanilla';
        const letter = ({
            fabric: 'Fa', forge: 'Fo', neoforge: 'Ne', quilt: 'Qu', vanilla: 'MC', optifine: 'OF',
        }[cls] || 'MC');
        const style = size ? `style="width:${size}px;height:${size}px"` : '';
        return `<div class="version-icon ${cls}" ${style} data-icon-for="${esc(v.id)}" title="${esc(v.id)}">${esc(letter)}</div>`;
    }
    App.versionIconHtml = versionIconHtml;

    async function loadVersionIcons(root = document) {
        const nodes = root.querySelectorAll('[data-icon-for]');
        for (const node of nodes) {
            const id = node.getAttribute('data-icon-for');
            try {
                const url = await api.versionIcon(id);
                if (url) {
                    node.innerHTML = `<img src="${url}" alt="">`;
                    node.style.background = '#fff';
                }
            } catch { /* 无图标 */ }
        }
    }
    App.loadVersionIcons = loadVersionIcons;

    /* --------------------------- 全局事件委托 --------------------------- */
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const fn = App.actions[el.dataset.act];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        try { fn(el, e); } catch (err) { console.error(err); toast(err.message, 'error'); }
    });
    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-act-change]');
        if (!el) return;
        const fn = App.actions[el.dataset.actChange];
        if (fn) fn(el, e);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('[data-act-enter]')) {
            const fn = App.actions[e.target.dataset.actEnter];
            if (fn) fn(e.target, e);
        }
    });

    // 双击版本卡片直接启动
    document.addEventListener('dblclick', (e) => {
        const card = e.target.closest('.version-card');
        if (!card) return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        const fn = App.actions['launch'];
        if (fn) fn({ dataset: { id: card.dataset.id } }, e);
    });

    /* 后台任务结果提示 */
    if (api.onTaskUpdate) {
        api.onTaskUpdate((list) => {
            const prev = new Map(App.state.tasks.map((t) => [t.id, t.status]));
            renderTasks(list);
            for (const t of list) {
                if (prev.get(t.id) === 'running' && t.status === 'failed') toast(`${t.title} 失败：${t.error || ''}`, 'error', 5000);
                if (prev.get(t.id) === 'running' && t.status === 'done' && ['install', 'modpack', 'download'].includes(t.kind)) {
                    toast(`${t.title} 完成`, 'success');
                    refreshVersions().then(() => App.renderPage());
                }
            }
        });
    }

    /* 任务完成后的跳转 / 选中新版本 */
    if (api.onTaskResult) {
        api.onTaskResult(({ ok, kind, result, error }) => {
            if (!ok) {
                if (kind === 'modpack' || kind === 'install') toast('任务失败：' + (error || ''), 'error', 5000);
                return;
            }
            if (result && result.id && (kind === 'install' || kind === 'modpack')) {
                refreshVersions().then(() => {
                    const exists = App.state.versions.some((v) => v.id === result.id);
                    if (exists) {
                        selectVersion(result.id);
                        toast(`已切换到新版本 ${result.id}`, 'success');
                    } else {
                        App.renderPage();
                    }
                });
            }
        });
    }
})();
