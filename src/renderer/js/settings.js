/* 设置页：启动、下载、Java、界面、关于 */
(function () {
    const App = window.App;
    const I = window.Icons;
    const api = window.pcln;
    const esc = App.esc;

    App.state.settings = { tab: 'launch', java: null, javaLoading: false };

    const TABS = [
        { id: 'launch', name: '启动设置', icon: 'rocket' },
        { id: 'download', name: '下载设置', icon: 'download' },
        { id: 'java', name: 'Java', icon: 'java' },
        { id: 'ui', name: '界面', icon: 'image' },
        { id: 'about', name: '关于', icon: 'info' },
    ];

    function cfg() { return App.state.config; }

    function render() {
        const page = document.getElementById('page-settings');
        const st = App.state.settings;
        const c = cfg();
        if (!c) return;
        page.innerHTML = `
            <div class="page-head">
                <div>
                    <div class="h1">设置</div>
                    <div class="sub">启动器与游戏的全局配置</div>
                </div>
                <span class="grow"></span>
                <button class="btn" data-act="open-data">${I.folder}数据目录</button>
            </div>
            <div class="settings-wrap">
                <nav class="settings-nav">
                    ${TABS.map((t) => `<button class="nav-item ${st.tab === t.id ? 'active' : ''}" data-act="set-tab" data-tab="${t.id}">${I[t.icon]}${t.name}</button>`).join('')}
                </nav>
                <div class="settings-body">${renderTab()}</div>
            </div>`;
        if (st.tab === 'java' && !st.java && !st.javaLoading) loadJava();
    }

    function field(label, inner, hint) {
        return `<div class="field"><label>${label}</label><div class="field-body">${inner}${hint ? `<span class="field-hint">${hint}</span>` : ''}</div></div>`;
    }

    function renderTab() {
        const st = App.state.settings;
        const c = cfg();
        if (st.tab === 'launch') {
            const acct = App.state.auth?.active;
            return `
            <div class="card setting-card">
                <div class="sc-title">${I.rocket}启动</div>
                ${field('当前账号', `
                    <button class="btn" data-act="accounts-manage">
                        ${I.info}<span>${acct ? esc(acct.name) + ' · ' + (acct.type === 'microsoft' ? '微软正版' : '离线') : '未登录账号'}</span>
                    </button>
                    <label class="row" style="gap:6px;font-size:12px;color:var(--text-2)">
                        <span class="switch"><input type="checkbox" ${App.state.auth?.autoLogin ? 'checked' : ''} data-act-change="auto-login"><i></i></span>启动时自动登录
                    </label>`, '自动续期正版令牌，无需每次登录')}
                ${field('默认离线名', `<input class="input" style="width:200px" value="${esc(c.launch.username)}" data-cfg="launch.username">`, '仅在没有任何账号时使用')}
                ${field('最大内存', `
                    <div class="range-row">
                        <input type="range" min="1024" max="32768" step="512" value="${c.java.maxMemory}" data-cfg-range="java.maxMemory">
                        <span class="mem-value" data-mem>${(c.java.maxMemory / 1024).toFixed(1)} GB</span>
                    </div>`, '建议 4096 ~ 8192 MB，不要超过物理内存的一半')}
                ${field('最小内存', `
                    <div class="range-row">
                        <input type="range" min="256" max="8192" step="256" value="${c.java.minMemory}" data-cfg-range="java.minMemory">
                        <span class="mem-value" data-mem-min>${c.java.minMemory} MB</span>
                    </div>`)}
                ${field('垃圾回收器', `
                    <select class="select" style="width:200px" data-cfg="java.gc">
                        ${[['auto', '自动（推荐）'], ['g1', 'G1GC'], ['zgc', 'ZGC（大内存低停顿）'], ['serial', 'SerialGC（低内存）']]
                            .map(([k, n]) => `<option value="${k}" ${c.java.gc === k ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>`)}
                ${field('窗口大小', `
                    <input class="input" style="width:88px" type="number" value="${c.launch.width}" data-cfg-number="launch.width">
                    <span class="muted">×</span>
                    <input class="input" style="width:88px" type="number" value="${c.launch.height}" data-cfg-number="launch.height">
                    <label class="row" style="gap:6px;font-size:12px;color:var(--text-2)">
                        <span class="switch"><input type="checkbox" ${c.launch.fullscreen ? 'checked' : ''} data-cfg-check="launch.fullscreen"><i></i></span>全屏启动
                    </label>`)}
                ${field('启动后', `
                    <select class="select" style="width:200px" data-cfg="ui.closeAfterLaunch">
                        <option value="keep" ${c.ui.closeAfterLaunch === 'keep' ? 'selected' : ''}>保持启动器打开</option>
                        <option value="minimize" ${c.ui.closeAfterLaunch === 'minimize' ? 'selected' : ''}>最小化启动器</option>
                        <option value="close" ${c.ui.closeAfterLaunch === 'close' ? 'selected' : ''}>关闭启动器</option>
                    </select>`)}
            </div>
            <div class="card setting-card">
                <div class="sc-title">${I.terminal}自定义参数</div>
                ${field('JVM 参数', `<textarea class="textarea" style="width:100%;min-height:56px" data-cfg="java.extraArgs" placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8">${esc(c.java.extraArgs)}</textarea>`, '追加到所有版本')}
                ${field('游戏参数', `<textarea class="textarea" style="width:100%;min-height:56px" data-cfg="launch.extraArgs" placeholder="--fullscreen">${esc(c.launch.extraArgs)}</textarea>`, '追加到所有版本')}
            </div>`;
        }
        if (st.tab === 'download') {
            return `
            <div class="card setting-card">
                <div class="sc-title">${I.download}下载</div>
                ${field('下载源', `
                    <select class="select" style="width:240px" data-cfg="download.source">
                        <option value="auto" ${c.download.source === 'auto' ? 'selected' : ''}>自动（官方优先，失败时回退镜像）</option>
                        <option value="mirror" ${c.download.source === 'mirror' ? 'selected' : ''}>镜像优先（BMCLAPI，国内更快）</option>
                        <option value="official" ${c.download.source === 'official' ? 'selected' : ''}>仅官方源</option>
                    </select>`, '镜像源可加速国内下载，文件会校验 SHA1')}
                ${field('下载并发', `
                    <div class="range-row" style="max-width:320px">
                        <input type="range" min="1" max="32" step="1" value="${c.download.concurrency}" data-cfg-range="download.concurrency">
                        <span class="mem-value" data-conc>${c.download.concurrency}</span>
                    </div>`, '过高可能被限速')}
                ${field('游戏目录', `
                    <input class="input" style="flex:1;min-width:260px;font-size:11.5px" value="${esc(c.gameDir)}" data-cfg="gameDir">
                    <button class="btn btn-sm" data-act="pick-game-dir">浏览</button>
                    <button class="btn btn-sm" data-act="open-data">打开</button>`, '包含 versions / libraries / assets')}
                ${field('CurseForge 整合包', `
                    <span class="badge badge-green">免 Key</span>
                    <span class="muted" style="font-size:11.5px">模组通过 CurseForge 官网公开接口下载，无需申请任何 API Key</span>
                    <button class="btn btn-sm" data-act="cf-help">${I.help}说明</button>`)}
            </div>
            <div class="card setting-card">
                <div class="sc-title">${I.refresh}缓存</div>
                ${field('缓存目录', `<span class="muted" style="font-size:11px;word-break:break-all">${esc(App.state.info?.dataDir || '')}\\cache</span><button class="btn btn-sm" data-act="open-cache">打开</button>`)}
                ${field('重新扫描版本', `<button class="btn btn-sm" data-act="rescan">${I.refresh}立即扫描</button>`)}
            </div>`;
        }
        if (st.tab === 'java') {
            const list = st.java || [];
            return `
            <div class="card setting-card">
                <div class="sc-title">${I.java}Java 运行时</div>
                ${field('全局 Java', `
                    <select class="select" style="width:340px" data-cfg="java.path">
                        <option value="auto" ${c.java.path === 'auto' ? 'selected' : ''}>自动选择（按版本需求匹配）</option>
                        ${list.map((j) => `<option value="${esc(j.path)}" ${c.java.path === j.path ? 'selected' : ''}>Java ${j.major} ${j.is64 ? '64位' : '32位'} · ${esc(j.vendor || '')} · ${esc(j.path)}</option>`).join('')}
                    </select>
                    <button class="btn btn-sm" data-act="java-rescan">${I.refresh}重新扫描</button>`)}
                <div class="spacer"></div>
                ${st.javaLoading ? `<div class="empty"><span class="spinner"></span> 正在扫描…</div>`
                    : list.length ? list.map((j) => `
                        <div class="java-row">
                            <span class="java-ver">Java ${j.major}</span>
                            <span class="badge ${j.is64 ? 'badge-green' : 'badge-red'}">${j.is64 ? '64 位' : '32 位'}</span>
                            <span class="java-path" title="${esc(j.path)}">${esc(j.path)}</span>
                            <span class="badge badge-gray">${esc(j.vendor || '未知')}</span>
                        </div>`).join('')
                    : '<div class="empty" style="padding:16px"><b>未检测到 Java</b>请下载下面的 Java 后再试</div>'}
            </div>
            <div class="card setting-card">
                <div class="sc-title">${I.download}下载 Java</div>
                <div class="sub" style="margin-bottom:8px">来自 Adoptium Temurin，自动解压到启动器目录，不污染系统环境。各版本所需 Java：1.16 及以下 → 8；1.17~1.20.4 → 17；1.20.5+ → 21。</div>
                <div class="row wrap">
                    ${[8, 17, 21].map((m) => `<button class="btn" data-act="java-install" data-major="${m}">${I.download}下载 Java ${m}</button>`).join('')}
                    <button class="btn" data-act="java-pick">${I.folder}手动指定 java.exe</button>
                </div>
            </div>`;
        }
        if (st.tab === 'ui') {
            return `
            <div class="card setting-card">
                <div class="sc-title">${I.image}外观</div>
                ${field('背景图片', `<input class="input" style="flex:1;min-width:240px;font-size:11.5px" value="${esc(c.ui.background)}" data-cfg="ui.background" placeholder="留空使用纯色背景"><button class="btn btn-sm" data-act="pick-bg">选择图片</button><button class="btn btn-sm" data-act="clear-bg">清除</button>`, '支持 png / jpg')}
                ${field('背景不透明度', `<div class="range-row" style="max-width:320px"><input type="range" min="0" max="100" step="5" value="${Math.round((c.ui.backgroundOpacity ?? 0.9) * 100)}" data-cfg-range="ui.backgroundOpacity"><span class="mem-value" data-opacity>${Math.round((c.ui.backgroundOpacity ?? 0.9) * 100)}%</span></div>`)}
                ${field('主题', `<select class="select" style="width:200px" data-cfg="ui.theme"><option value="light" ${c.ui.theme === 'light' ? 'selected' : ''}>浅色（PCL 风格）</option></select>`, '深色主题开发中')}
            </div>
            <div class="card setting-card">
                <div class="sc-title">${I.grid}窗口</div>
                ${field('记住窗口大小', '<span class="muted">启动器会自动记住上次的窗口尺寸与位置</span>')}
                ${field('重置窗口', `<button class="btn btn-sm" data-act="reset-window">恢复默认大小</button>`)}
            </div>`;
        }
        // about
        const info = App.state.info || {};
        return `
            <div class="card setting-card">
                <div class="sc-title">${I.info}关于 Plain Craft Launcher N</div>
                <div class="detail-desc">
                    <p>一个使用 Electron + Node.js 编写的 Minecraft 启动器，界面与交互参考 <b>PCL2 CE</b>，实现了版本安装、加载器安装、模组 / 整合包 / 资源包 / 光影 / 数据包下载、离线启动与崩溃分析等功能。</p>
                    <p class="muted">本启动器仅供学习交流使用，与 PCL2 官方无关。</p>
                </div>
                <div class="spacer"></div>
                ${field('启动器版本', `<b>v${esc(info.version || '1.0.0')}</b><span class="muted">Electron ${esc(info.electron || '')} · Node ${esc(info.node || '')}</span>`)}
                ${field('游戏目录', `<span class="muted" style="font-size:11px;word-break:break-all">${esc(info.gameDir || '')}</span>`)}
                ${field('数据目录', `<span class="muted" style="font-size:11px;word-break:break-all">${esc(info.dataDir || '')}</span><button class="btn btn-sm" data-act="open-data">打开</button>`)}
                ${field('日志文件', `<button class="btn btn-sm" data-act="open-log">${I.external}打开启动器日志</button>`)}
            </div>
            <div class="card setting-card">
                <div class="sc-title">${I.help}帮助与反馈</div>
                <div class="row wrap">
                    <button class="btn" data-act="go-help">${I.help}崩溃与错误分析</button>
                    <button class="btn" data-act="open-log">${I.terminal}查看日志</button>
                </div>
            </div>`;
    }

    /* ------------------------------ Java ------------------------------ */
    async function loadJava() {
        App.state.settings.javaLoading = true;
        App.renderPage();
        try {
            App.state.settings.java = await api.listJava(true);
        } catch (e) { App.state.settings.java = []; }
        App.state.settings.javaLoading = false;
        App.renderPage();
    }

    /* ------------------------------ 动作 ------------------------------ */
    App.on('set-tab', (el) => {
        App.state.settings.tab = el.dataset.tab;
        if (el.dataset.tab === 'java') App.state.settings.java = null;
        App.renderPage();
    });

    function setPath(target, value) {
        const keys = target.split('.');
        const patch = {};
        let cur = patch;
        for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = {}; cur = cur[keys[i]]; }
        cur[keys[keys.length - 1]] = value;
        return api.configSet(patch).then((c) => { App.state.config = c; return c; });
    }

    App.on('cfg-save', async (el) => {
        const target = el.dataset.cfg;
        if (!target) return;
        await setPath(target, el.value);
    });

    document.addEventListener('change', async (e) => {
        const t = e.target;
        if (!t.dataset) return;
        if (t.dataset.cfg && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) {
            await App.call(() => setPath(t.dataset.cfg, t.value));
        } else if (t.dataset.cfgNumber) {
            await App.call(() => setPath(t.dataset.cfgNumber, Number(t.value)));
        } else if (t.dataset.cfgCheck) {
            await App.call(() => setPath(t.dataset.cfgCheck, !!t.checked));
        } else if (t.dataset.cfgRange) {
            const v = Number(t.value);
            await App.call(() => setPath(t.dataset.cfgRange, v));
        }
        if (t.dataset.cfg || t.dataset.cfgNumber || t.dataset.cfgCheck) App.renderPage();
    });

    document.addEventListener('input', (e) => {
        const t = e.target;
        if (!t.dataset) return;
        if (t.dataset.cfgRange === 'java.maxMemory') {
            const label = document.querySelector('[data-mem]');
            if (label) label.textContent = (Number(t.value) / 1024).toFixed(1) + ' GB';
        }
        if (t.dataset.cfgRange === 'java.minMemory') {
            const label = document.querySelector('[data-mem-min]');
            if (label) label.textContent = t.value + ' MB';
        }
        if (t.dataset.cfgRange === 'download.concurrency') {
            const label = document.querySelector('[data-conc]');
            if (label) label.textContent = t.value;
        }
        if (t.dataset.cfgRange === 'ui.backgroundOpacity') {
            const label = document.querySelector('[data-opacity]');
            if (label) label.textContent = t.value + '%';
        }
    });

    App.on('pick-game-dir', async () => {
        const dir = await api.chooseDir({ title: '选择游戏目录（.minecraft）', defaultPath: cfg().gameDir });
        if (!dir) return;
        const c = await api.configSet({ gameDir: dir });
        App.state.config = c;
        await App.refreshVersions();
        App.toast('游戏目录已切换', 'success');
        App.renderPage();
    });

    App.on('pick-bg', async () => {
        const file = await api.chooseFile({ title: '选择背景图片', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        if (!file) return;
        const c = await api.configSet({ ui: { background: file } });
        App.state.config = c;
        App.applyBackground();
        App.renderPage();
    });

    App.on('clear-bg', async () => {
        const c = await api.configSet({ ui: { background: '' } });
        App.state.config = c;
        App.applyBackground();
        App.renderPage();
    });

    App.on('reset-window', () => {
        api.windowState();
        App.toast('可通过拖动窗口边缘调整大小，启动器会自动记住', 'info');
    });

    App.on('open-data', () => api.openPath(App.state.info?.dataDir));
    App.on('open-cache', () => api.openPath((App.state.info?.dataDir || '') + '/cache'));
    App.on('open-log', () => api.openLog());
    App.on('go-help', () => App.setPage('help'));

    App.on('auto-login', async (el) => {
        try {
            await api.authAutoLogin(!!el.checked);
            await App.refreshAuth();
            App.toast(el.checked ? '已开启自动登录' : '已关闭自动登录', 'success');
        } catch (e) { App.toast(e.message, 'error'); }
    });

    App.on('cf-help', () => {
        const m = App.modal({
            title: '关于 CurseForge 整合包',
            iconName: 'help',
            body: `
                <div class="account-note" style="margin-top:0">
                    ${I.check}
                    <span><b>不需要任何 API Key。</b>启动器直接调用 CurseForge 官网公开的接口，
                    按整合包清单里的 <code>projectID / fileID</code> 查询文件名、大小并下载文件，
                    和你用浏览器打开 CurseForge 下载是同一个来源。</span>
                </div>
                <div class="spacer"></div>
                <div class="h2" style="margin-bottom:6px">${I.info}可能遇到的情况</div>
                <ul style="margin:0;padding-left:20px;line-height:1.85;font-size:12.5px">
                    <li>少数作者在 CurseForge 上关闭了「第三方下载」，这类文件会自动跳过，
                        需要你打开 CurseForge 网页手动下载后放进 <code>mods</code> 文件夹（安装结束后会提示数量）。</li>
                    <li>也可以直接在 CurseForge 网页下载整合包 zip，用主页的「导入整合包」安装，效果相同。</li>
                    <li>Modrinth 的整合包、模组走 Modrinth 官方接口，同样不需要任何账号或 Key。</li>
                </ul>`,
            footer: `<button class="btn" data-close>知道了</button>`,
        });
        m.footer.querySelector('[data-close]').onclick = () => m.close();
    });
    App.on('rescan', async () => { await App.refreshVersions(); App.toast('已重新扫描版本', 'success'); });
    App.on('java-rescan', async () => { App.state.settings.java = null; await loadJava(); App.toast('已重新扫描 Java', 'success'); });
    App.on('java-install', async (el) => {
        const major = Number(el.dataset.major);
        await api.installJava(major);
        App.toast(`已开始下载 Java ${major}，完成后会自动出现在列表中`, 'success');
        setTimeout(() => { App.state.settings.java = null; loadJava(); }, 4000);
    });
    App.on('java-pick', async () => {
        const file = await api.chooseFile({ title: '选择 java.exe', filters: [{ name: 'Java', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }] });
        if (!file) return;
        const c = await api.configSet({ java: { path: file } });
        App.state.config = c;
        App.state.settings.java = null;
        App.renderPage();
        App.toast('已指定 Java 路径', 'success');
    });

    window.SettingsPage = { render };
})();
