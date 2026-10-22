/* 主页：版本卡片、启动、版本设置、模组管理 */
(function () {
    const App = window.App;
    const I = window.Icons;
    const api = window.pcln;
    const esc = App.esc;

    App.state.home = { query: '', sort: 'recent' };

    function filteredVersions() {
        const h = App.state.home;
        let list = App.state.versions.slice();
        if (h.query) {
            const q = h.query.toLowerCase();
            list = list.filter((v) => v.id.toLowerCase().includes(q) || (v.mcVersion || '').includes(q) || (v.loader || '').includes(q));
        }
        if (h.sort === 'name') list.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));
        else if (h.sort === 'version') list.sort((a, b) => String(b.mcVersion).localeCompare(String(a.mcVersion), 'zh-CN', { numeric: true }));
        return list;
    }

    function typeBadge(v) {
        if (v.type === 'snapshot') return '<span class="badge badge-orange">快照</span>';
        if (v.type === 'old_beta' || v.type === 'old_alpha') return '<span class="badge badge-gray">远古</span>';
        return '';
    }

    function versionCard(v) {
        const running = App.state.running && App.state.running.id === v.id;
        const active = v.id === App.state.selectedVersion;
        return `
        <div class="version-card ${active ? 'active' : ''}" data-act="select-version" data-id="${esc(v.id)}">
            ${App.versionIconHtml(v)}
            <div class="version-main">
                <div class="version-name" title="${esc(v.id)}">${esc(v.id)}</div>
                <div class="version-meta">
                    <span>${esc(v.mcVersion || '')}</span>
                    ${v.loader && v.loader !== 'vanilla' ? `<span>·</span><span>${esc(App.loaderName(v.loader))}${v.loaderVersion ? ' ' + esc(v.loaderVersion) : ''}</span>` : ''}
                </div>
                <div class="version-tags">
                    ${typeBadge(v)}
                    ${v.modCount ? `<span class="badge badge-blue">${v.modCount} 模组</span>` : ''}
                    ${v.isolation === 'version' ? '<span class="badge">隔离</span>' : ''}
                    ${running ? '<span class="badge badge-green">运行中</span>' : ''}
                </div>
                <button class="version-play" data-act="launch" data-id="${esc(v.id)}">${I.play}<span>${running ? '运行中' : '启动'}</span></button>
            </div>
            <button class="version-more" data-act="version-more" data-id="${esc(v.id)}" title="更多操作">${I.more}</button>
        </div>`;
    }

    function heroSection() {
        const cfg = App.state.config;
        const v = App.state.versions.find((x) => x.id === App.state.selectedVersion);
        const running = App.state.running;
        if (!v) {
            return `<div class="hero">
                <div class="hero-account">${App.accountChipHtml ? App.accountChipHtml() : ''}</div>
                <h2>欢迎使用 PCL-N</h2>
                <div class="hero-sub">还没有安装任何游戏版本，去下载页安装一个吧</div>
                <div class="hero-row">
                    <button class="btn-launch" data-act="go" data-page="download">${I.download}<span>下载游戏版本</span></button>
                    <button class="hero-chip" data-act="import-modpack">${I.package}<span>导入整合包</span></button>
                </div>
            </div>`;
        }
        return `<div class="hero">
            <div class="hero-account">${App.accountChipHtml ? App.accountChipHtml() : ''}</div>
            <h2>${esc(v.id)}</h2>
            <div class="hero-sub">
                Minecraft ${esc(v.mcVersion || '')} · ${esc(App.loaderName(v.loader))}
                ${v.modCount ? ` · ${v.modCount} 个模组` : ''}
                ${v.javaVersion ? ` · Java ${v.javaVersion}` : ''}
                · 内存 ${Math.round((cfg.java.maxMemory || 4096) / 1024 * 10) / 10} GB
            </div>
            <div class="hero-row">
                <button class="btn-launch" data-act="launch" data-id="${esc(v.id)}" ${running ? 'disabled' : ''}>
                    ${running ? '<span class="spinner"></span>' : I.play}<span>${running ? '游戏运行中' : '启动游戏'}</span>
                </button>
                <button class="hero-chip" data-act="version-settings" data-id="${esc(v.id)}">${I.settings}<span>版本设置</span></button>
                <button class="hero-chip" data-act="open-folder" data-path="${esc(v.gameDir)}">${I.folder}<span>游戏目录</span></button>
                <button class="hero-chip" data-act="mods-manage" data-id="${esc(v.id)}">${I.package}<span>模组管理</span></button>
            </div>
        </div>`;
    }

    function sidePanel() {
        const versions = App.state.versions;
        const running = App.state.running;
        return `<div class="side-panel">
            <div class="card mini-card">
                <div class="mini-title">快速安装</div>
                <div class="mini-list">
                    <div class="mini-item"><span class="dot"></span><b>最新正式版</b><button class="mini-btn" data-act="install-latest" data-type="release">安装</button></div>
                    <div class="mini-item"><span class="dot" style="background:var(--orange)"></span><b>最新快照</b><button class="mini-btn" data-act="install-latest" data-type="snapshot">安装</button></div>
                    <div class="mini-item"><span class="dot" style="background:var(--purple)"></span><b>模组加载器</b><button class="mini-btn" data-act="go" data-page="download" data-tab="loader">前往</button></div>
                </div>
            </div>
            <div class="card mini-card">
                <div class="mini-title">本机状态</div>
                <div class="mini-list">
                    <div class="mini-item"><b>${versions.length}</b> 个已安装版本</div>
                    <div class="mini-item"><b>${versions.reduce((s, v) => s + (v.modCount || 0), 0)}</b> 个模组文件</div>
                    <div class="mini-item"><b>${esc(App.loaderName(versions[0]?.loader || 'vanilla'))}</b> 最近使用加载器</div>
                    <div class="mini-item">${running ? `<span class="badge badge-green">游戏运行中</span>` : '<span class="badge badge-gray">游戏未启动</span>'}</div>
                </div>
            </div>
            <div class="card mini-card">
                <div class="mini-title">小提示</div>
                <div class="sub" style="line-height:1.65;font-size:11.5px">
                    下载模组时会自动安装前置依赖；整合包会创建独立的隔离版本，不会污染其他存档。
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-block" data-act="go" data-page="help">查看错误百科</button>
            </div>
        </div>`;
    }

    function render() {
        const page = document.getElementById('page-home');
        const list = filteredVersions();
        page.innerHTML = `
            <div class="home-layout">
                <div class="home-main">
                    ${heroSection()}
                    <div class="section" style="margin-top:14px">
                        <div class="section-head" style="margin-bottom:8px">
                            <div class="h1">游戏版本</div>
                            <span class="muted">${App.state.versions.length} 个版本</span>
                            <span class="grow"></span>
                            <button class="btn" data-act="go" data-page="download">${I.plus}安装新版本</button>
                            <button class="btn" data-act="import-modpack">${I.package}导入整合包</button>
                            <button class="btn btn-icon" data-act="refresh-versions" title="刷新版本列表">${I.refresh}</button>
                        </div>
                        <div class="dl-toolbar" style="margin-bottom:10px">
                            <div class="search-box">${I.search}<input class="input" placeholder="搜索版本…" value="${esc(App.state.home.query)}" data-act-change="home-search"></div>
                            <select class="select" data-act-change="home-sort" style="width:118px">
                                <option value="recent" ${App.state.home.sort === 'recent' ? 'selected' : ''}>最近游玩</option>
                                <option value="name" ${App.state.home.sort === 'name' ? 'selected' : ''}>按名称</option>
                                <option value="version" ${App.state.home.sort === 'version' ? 'selected' : ''}>按游戏版本</option>
                            </select>
                            <span class="grow"></span>
                            <span class="muted">${App.state.versions.length ? '单击卡片切换版本，双击直接启动' : ''}</span>
                        </div>
                        ${list.length ? `<div class="version-grid">${list.map(versionCard).join('')}</div>`
                            : `<div class="empty"><b>${App.state.versions.length ? '没有匹配的版本' : '还没有安装任何版本'}</b>${App.state.versions.length ? '换个关键词试试' : '点击右上角「安装新版本」开始'}</div>`}
                    </div>
                </div>
                ${sidePanel()}
            </div>`;
        App.loadVersionIcons(page);
    }

    /* ----------------------------- 交互动作 ----------------------------- */
    App.on('go', (el) => {
        if (el.dataset.tab) App.state.download.tab = el.dataset.tab;
        App.setPage(el.dataset.page);
    });

    App.on('select-version', (el) => {
        App.selectVersion(el.dataset.id);
    });

    // 双击版本卡片直接启动
    App.on('launch', async (el) => {
        const id = el.dataset.id || App.state.selectedVersion;
        try { await App.launchVersion(id); } catch { /* 已提示 */ }
    });

    App.on('refresh-versions', async () => {
        await App.refreshVersions();
        App.renderPage();
        App.toast('版本列表已刷新', 'success');
    });

    App.on('home-search', (el) => {
        App.state.home.query = el.value.trim();
        App.renderPage();
        // 保持焦点
        const input = document.querySelector('[data-act-change="home-search"]');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    App.on('home-sort', (el) => { App.state.home.sort = el.value; App.renderPage(); });

    App.on('install-latest', async (el) => {
        const type = el.dataset.type || 'release';
        const m = await App.call(api.manifest);
        const id = type === 'snapshot' ? m.latest.snapshot : m.latest.release;
        await App.installVanilla(id, id);
        App.renderPage();
    });

    App.on('open-folder', (el) => { api.openPath(el.dataset.path); });

    App.on('version-more', (el) => {
        const v = App.state.versions.find((x) => x.id === el.dataset.id);
        if (!v) return;
        const m = App.modal({
            title: v.id,
            narrow: true,
            body: `<div class="mini-list" style="gap:2px">
                ${menuRow('play', '启动游戏', 'menu-launch', v.id)}
                ${menuRow('settings', '版本设置', 'version-settings', v.id)}
                ${menuRow('package', '模组管理', 'mods-manage', v.id)}
                ${menuRow('folder', '打开游戏目录', 'open-folder', v.id, v.gameDir)}
                ${menuRow('refresh', '校验并修复', 'verify-version', v.id)}
                ${menuRow('copy', '重命名版本', 'rename-version', v.id)}
                ${menuRow('trash', '删除版本', 'delete-version', v.id, null, 'color:var(--red)')}
            </div>`,
        });
        m.body.querySelectorAll('[data-menu]').forEach((row) => {
            row.onclick = () => {
                m.close();
                const action = App.actions[row.dataset.menu];
                if (action) action(row, null);
            };
        });
    });

    function menuRow(iconName, text, action, id, path, style) {
        return `<button class="btn btn-ghost" style="justify-content:flex-start;height:32px;width:100%;${style || ''}"
            data-menu="${esc(action)}" data-id="${esc(id || '')}" data-path="${esc(path || '')}">
            ${I[iconName] || ''}<span>${esc(text)}</span></button>`;
    }

    App.on('menu-launch', (el) => App.launchVersion(el.dataset.id).catch(() => {}));

    App.on('verify-version', async (el) => {
        const id = el.dataset.id;
        const ok = await App.confirm({ title: '校验并修复', text: `将检查「${id}」的所有游戏文件，缺失或损坏的文件会重新下载。`, okText: '开始校验' });
        if (!ok) return;
        await api.verifyVersion(id);
        App.toast('已开始校验，可在下方查看进度', 'success');
    });

    App.on('rename-version', async (el) => {
        const id = el.dataset.id;
        const name = await App.prompt({ title: '重命名版本', hint: '版本目录名也会一起修改，请勿在游戏运行时操作。', value: id });
        if (!name || name === id) return;
        try {
            await api.versionRename(id, name);
            await App.refreshVersions();
            App.selectVersion(name);
            App.toast('已重命名', 'success');
        } catch (e) { /* 已提示 */ }
    });

    App.on('delete-version', async (el) => {
        const id = el.dataset.id;
        const ok = await App.confirm({
            title: '删除版本',
            text: `确定要删除「${id}」吗？\n版本目录与其中的模组、存档都会被删除，且无法恢复。`,
            okText: '删除', danger: true,
        });
        if (!ok) return;
        await api.versionDelete(id, false);
        await App.refreshVersions();
        App.renderPage();
        App.toast('版本已删除', 'success');
    });

    /* ---------------------------- 版本设置弹窗 ---------------------------- */
    App.on('version-settings', async (el) => {
        const id = el.dataset.id;
        if (!id) { App.toast('请先选择一个版本', 'warn'); return; }
        let detail, settings, javaList;
        try {
            [detail, settings, javaList] = await Promise.all([
                api.versionDetail(id), api.versionSettingsGet(id), api.listJava(false),
            ]);
        } catch (e) { return; }
        const g = App.state.config;
        const autoJava = g.java.path === 'auto';
        const javaOptions = [{ path: 'auto', label: '自动选择（推荐）' }, ...javaList.map((j) => ({ path: j.path, label: `Java ${j.major} · ${j.vendor || ''} ${j.is64 ? '64位' : '32位'}` }))];
        const body = `
            <div class="tabs" style="margin-bottom:12px" data-vs-tabs>
                <button class="tab active" data-tab="basic">${I.settings}基本</button>
                <button class="tab" data-tab="java">${I.java}Java 与内存</button>
                <button class="tab" data-tab="args">${I.terminal}高级参数</button>
            </div>
            <div data-vs-pane="basic">
                <div class="field"><label>版本名称</label><div class="field-body"><b>${esc(id)}</b><span class="badge badge-blue">${esc(App.loaderName(detail.loader))}</span><span class="muted">${esc(detail.minecraftVersion || '')}</span></div></div>
                <div class="field"><label>游戏目录</label><div class="field-body"><span class="muted" style="word-break:break-all;font-size:11px">${esc(detail.gameDir)}</span><button class="btn btn-sm" data-act="open-folder" data-path="${esc(detail.gameDir)}">打开</button></div></div>
                <div class="field"><label>版本隔离</label><div class="field-body">
                    <select class="select" data-f="isolation" style="width:220px">
                        <option value="global" ${(settings.isolation || 'global') === 'global' ? 'selected' : ''}>关闭（共用 .minecraft）</option>
                        <option value="version" ${settings.isolation === 'version' ? 'selected' : ''}>开启（使用版本独立目录）</option>
                    </select>
                    <span class="field-hint">隔离后模组、存档、配置互不影响</span>
                </div></div>
                <div class="field"><label>窗口大小</label><div class="field-body">
                    <input class="input" style="width:90px" data-f="width" type="number" value="${settings.width ?? g.launch.width}">
                    <span class="muted">×</span>
                    <input class="input" style="width:90px" data-f="height" type="number" value="${settings.height ?? g.launch.height}">
                    <span class="field-hint">仅对支持的版本生效</span>
                </div></div>
                <div class="field"><label>离线用户名</label><div class="field-body">
                    <input class="input" style="width:200px" data-f="username" value="${esc(settings.username || g.launch.username)}" placeholder="默认使用全局用户名">
                </div></div>
                <div class="field"><label>启动日志</label><div class="field-body">
                    <span class="muted" style="font-size:11px">${esc(detail.logFile || '')}</span>
                    <button class="btn btn-sm" data-act="version-log" data-id="${esc(id)}">查看日志</button>
                </div></div>
            </div>
            <div data-vs-pane="java" class="hidden">
                <div class="field"><label>Java 运行时</label><div class="field-body">
                    <select class="select" data-f="javaPath" style="flex:1;min-width:240px">
                        ${javaOptions.map((o) => `<option value="${esc(o.path)}" ${(settings.javaPath || g.java.path) === o.path ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>
                </div></div>
                <div class="field"><label>最大内存</label><div class="field-body">
                    <div class="range-row">
                        <input type="range" min="1024" max="32768" step="256" value="${settings.maxMemory ?? g.java.maxMemory}" data-f="maxMemory" data-range>
                        <span class="mem-value" data-mem-label>${settings.maxMemory ?? g.java.maxMemory} MB</span>
                    </div>
                </div></div>
                <div class="field"><label>垃圾回收器</label><div class="field-body">
                    <select class="select" data-f="gc" style="width:220px">
                        <option value="auto" ${(settings.gc || g.java.gc) === 'auto' ? 'selected' : ''}>自动</option>
                        <option value="g1" ${settings.gc === 'g1' ? 'selected' : ''}>G1GC（推荐）</option>
                        <option value="zgc" ${settings.gc === 'zgc' ? 'selected' : ''}>ZGC（大内存）</option>
                        <option value="serial" ${settings.gc === 'serial' ? 'selected' : ''}>SerialGC（低内存）</option>
                    </select>
                </div></div>
                <div class="field"><label>版本要求</label><div class="field-body"><span class="muted">该版本建议 Java ${detail.javaVersion}，当前全局设置为 ${autoJava ? '自动选择' : esc(g.java.path)}</span></div></div>
            </div>
            <div data-vs-pane="args" class="hidden">
                <div class="field" style="align-items:flex-start"><label>自定义 JVM 参数</label><div class="field-body" style="flex-direction:column;align-items:stretch">
                    <textarea class="textarea" data-f="jvmArgs" placeholder="-XX:+UseG1GC -Dsome.option=true">${esc(settings.jvmArgs || '')}</textarea>
                    <span class="field-hint">追加到 JVM 启动参数中，留空则使用全局设置</span>
                </div></div>
                <div class="field" style="align-items:flex-start"><label>自定义游戏参数</label><div class="field-body" style="flex-direction:column;align-items:stretch">
                    <textarea class="textarea" data-f="gameArgs" placeholder="--fullscreen">${esc(settings.gameArgs || '')}</textarea>
                    <span class="field-hint">追加到游戏启动参数中</span>
                </div></div>
            </div>`;
        const m = App.modal({
            title: '版本设置 · ' + id,
            body,
            wide: true,
            footer: `<button class="btn btn-danger" data-del>${I.trash}删除版本</button>
                     <button class="btn" data-verify>${I.refresh}校验修复</button>
                     <span class="grow"></span>
                     <button class="btn" data-cancel>取消</button>
                     <button class="btn btn-primary" data-save>保存设置</button>`,
            iconName: 'settings',
        });
        m.body.querySelectorAll('[data-vs-tabs] .tab').forEach((tab) => {
            tab.onclick = () => {
                m.body.querySelectorAll('[data-vs-tabs] .tab').forEach((t) => t.classList.toggle('active', t === tab));
                m.body.querySelectorAll('[data-vs-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.vsPane !== tab.dataset.tab));
            };
        });
        m.body.querySelectorAll('[data-range]').forEach((r) => {
            r.oninput = () => {
                const label = m.body.querySelector('[data-mem-label]');
                if (label) label.textContent = r.value + ' MB';
            };
        });
        m.body.querySelector('[data-del]').onclick = async () => {
            m.close();
            App.actions['delete-version']({ dataset: { id } });
        };
        m.body.querySelector('[data-verify]').onclick = () => {
            m.close();
            App.actions['verify-version']({ dataset: { id } });
        };
        m.footer.querySelector('[data-cancel]').onclick = () => m.close();
        m.footer.querySelector('[data-save]').onclick = async () => {
            const patch = {};
            m.body.querySelectorAll('[data-f]').forEach((input) => {
                if (input.type === 'range' || input.type === 'number') patch[input.dataset.f] = Number(input.value);
                else patch[input.dataset.f] = input.value;
            });
            await api.versionSettingsSet(id, patch);
            m.close();
            App.toast('版本设置已保存', 'success');
            App.renderPage();
        };
    });

    App.on('version-log', async (el) => {
        const lines = await api.logs(300);
        const text = lines.map((l) => l.line).join('\n');
        App.modal({
            title: '启动器日志',
            wide: true,
            body: `<div class="log-box" style="height:360px">${esc(text || '暂无日志')}</div>`,
            footer: `<button class="btn" data-open-log>${I.external}打开日志文件</button><span class="grow"></span><button class="btn btn-primary" data-close>关闭</button>`,
        });
        const host = document.getElementById('modal-host');
        const foot = host.querySelector('.modal-foot');
        if (foot) {
            foot.querySelector('[data-open-log]').onclick = () => api.openLog();
            foot.querySelector('[data-close]').onclick = () => host.querySelector('.modal-mask').remove();
        }
    });

    /* --------------------------- 模组管理弹窗 --------------------------- */
    App.on('mods-manage', async (el) => {
        const id = el.dataset.id || App.state.selectedVersion;
        if (!id) { App.toast('请先选择版本', 'warn'); return; }
        const m = App.modal({
            title: '内容管理 · ' + id,
            wide: true,
            body: `<div class="tabs" style="margin-bottom:10px">
                    <button class="tab active" data-mt="mods">${I.package}模组</button>
                    <button class="tab" data-mt="resourcepacks">${I.image}资源包</button>
                    <button class="tab" data-mt="shaderpacks">${I.sparkle}光影</button>
                    <button class="tab" data-mt="datapacks">${I.database}数据包</button>
                    <button class="tab" data-mt="saves">${I.save}存档</button>
                   </div>
                   <div data-mpane></div>`,
            footer: `<button class="btn" data-open>${I.folder}打开文件夹</button>
                     <button class="btn" data-install>${I.download}去下载</button>
                     <span class="grow"></span>
                     <button class="btn btn-primary" data-done>完成</button>`,
            iconName: 'package',
        });
        const pane = m.body.querySelector('[data-mpane]');
        let current = 'mods';
        const gameDir = (await api.versionDetail(id)).gameDir;

        async function loadPane(tab) {
            current = tab;
            pane.innerHTML = `<div class="empty"><span class="spinner"></span> 正在读取…</div>`;
            try {
                if (tab === 'mods') await renderMods();
                else if (tab === 'resourcepacks') await renderSimple(await api.resourcePacks(id), 't', '资源包', 'resourcepacks');
                else if (tab === 'shaderpacks') await renderSimple(await api.shaderPacks(id), 't', '光影包', 'shaderpacks');
                else if (tab === 'datapacks') await renderDatapacks();
                else if (tab === 'saves') await renderSaves(await api.saves(id));
            } catch (e) {
                pane.innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
            }
        }

        async function renderMods() {
            const list = await api.mods(id);
            if (!list.length) {
                pane.innerHTML = `<div class="empty"><b>还没有安装模组</b>点击下方「去下载」，或把 .jar 文件放进 mods 文件夹</div>`;
                return;
            }
            pane.innerHTML = `<div class="list">` + list.map((mod) => `
                <div class="list-item">
                    <div class="li-main">
                        <div class="li-title">${esc(mod.name)} ${mod.version ? `<span class="badge badge-gray">${esc(mod.version)}</span>` : ''}
                            ${mod.loader ? `<span class="badge ${mod.loader === 'fabric' ? 'badge-orange' : 'badge-blue'}">${esc(mod.loader)}</span>` : ''}
                        </div>
                        <div class="li-sub">${esc(mod.description || mod.file)}</div>
                    </div>
                    <div class="li-actions">
                        <label class="switch" title="${mod.enabled ? '已启用' : '已禁用'}">
                            <input type="checkbox" ${mod.enabled ? 'checked' : ''} data-toggle="${esc(mod.path)}">
                            <i></i>
                        </label>
                        <button class="btn btn-sm btn-danger" data-delmod="${esc(mod.path)}">${I.trash}</button>
                    </div>
                </div>`).join('') + `</div>
                <div class="muted" style="margin-top:8px">共 ${list.length} 个文件，关闭开关会重命名为 .disabled（游戏不再加载）</div>`;
            pane.querySelectorAll('[data-toggle]').forEach((input) => {
                input.onchange = async () => {
                    try {
                        await api.modToggle(input.dataset.toggle);
                        await renderMods();
                        App.toast(input.checked ? '已启用' : '已禁用', 'success');
                    } catch (e) { App.toast(e.message, 'error'); }
                };
            });
            pane.querySelectorAll('[data-delmod]').forEach((btn) => {
                btn.onclick = async () => {
                    const ok = await App.confirm({ title: '删除模组', text: '删除后无法恢复，确定继续？', danger: true, okText: '删除' });
                    if (!ok) return;
                    await api.modDelete(btn.dataset.delmod);
                    await renderMods();
                };
            });
        }

        async function renderSimple(list, unused, label, folder) {
            if (!list.length) {
                pane.innerHTML = `<div class="empty"><b>暂无${label}</b>可前往下载页安装</div>`;
                return;
            }
            pane.innerHTML = `<div class="list">` + list.map((p) => `
                <div class="list-item">
                    <div class="li-main">
                        <div class="li-title">${esc(p.description || p.file)} ${p.format ? `<span class="badge badge-gray">格式 ${p.format}</span>` : ''}</div>
                        <div class="li-sub">${esc(p.file)}${p.size ? ' · ' + App.fmtBytes(p.size) : ''}</div>
                    </div>
                    <div class="li-actions">
                        <button class="btn btn-sm" data-open-item="${esc(p.path)}">${I.folder}</button>
                        <button class="btn btn-sm btn-danger" data-del-item="${esc(p.path)}">${I.trash}</button>
                    </div>
                </div>`).join('') + `</div>`;
            bindItemActions();
        }

        async function renderDatapacks() {
            const list = await api.datapacks(id);
            if (!list.length) {
                pane.innerHTML = `<div class="empty"><b>暂无数据包</b>数据包也可以放到存档的 datapacks 文件夹中</div>`;
                return;
            }
            pane.innerHTML = `<div class="list">` + list.map((p) => `
                <div class="list-item">
                    <div class="li-main"><div class="li-title">${esc(p.file)}</div><div class="li-sub">${p.isDir ? '文件夹' : App.fmtBytes(p.size)}</div></div>
                    <div class="li-actions">
                        <button class="btn btn-sm" data-open-item="${esc(p.path)}">${I.folder}</button>
                        <button class="btn btn-sm btn-danger" data-del-item="${esc(p.path)}">${I.trash}</button>
                    </div>
                </div>`).join('') + `</div>`;
            bindItemActions();
        }

        async function renderSaves(list) {
            if (!list.length) {
                pane.innerHTML = `<div class="empty"><b>暂无存档</b>进入游戏创建一个世界后会显示在这里</div>`;
                return;
            }
            pane.innerHTML = `<div class="list">` + list.map((s) => `
                <div class="list-item">
                    <div class="li-main"><div class="li-title">${esc(s.name)}</div><div class="li-sub">${App.timeAgo(s.mtime)}</div></div>
                    <div class="li-actions"><button class="btn btn-sm" data-open-item="${esc(s.path)}">${I.folder}</button></div>
                </div>`).join('') + `</div>`;
            bindItemActions();
        }

        function bindItemActions() {
            pane.querySelectorAll('[data-open-item]').forEach((b) => { b.onclick = () => api.openPath(b.dataset.openItem); });
            pane.querySelectorAll('[data-del-item]').forEach((b) => {
                b.onclick = async () => {
                    const ok = await App.confirm({ title: '删除', text: '确定删除该文件？', danger: true, okText: '删除' });
                    if (!ok) return;
                    // 无专用接口时用 shell 删除：通过 mods:delete 通用接口
                    await api.modDelete(b.dataset.delItem).catch((e) => App.toast(e.message, 'error'));
                    await loadPane(current);
                };
            });
        }

        m.body.querySelectorAll('[data-mt]').forEach((tab) => {
            tab.onclick = async () => {
                m.body.querySelectorAll('[data-mt]').forEach((t) => t.classList.toggle('active', t === tab));
                await loadPane(tab.dataset.mt);
            };
        });
        m.footer.querySelector('[data-open]').onclick = () => api.openPath(gameDir);
        m.footer.querySelector('[data-done]').onclick = () => m.close();
        m.footer.querySelector('[data-install]').onclick = () => {
            m.close();
            App.state.download.targetVersion = id;
            App.setPage('download');
        };
        await loadPane('mods');
    });

    /* --------------------------- 导入整合包 --------------------------- */
    App.on('import-modpack', async () => {
        const file = await api.chooseFile({ title: '选择整合包文件', filters: [{ name: '整合包', extensions: ['zip', 'mrpack'] }] });
        if (!file) return;
        let info;
        try {
            info = await api.detectModpack(file);
        } catch (e) {
            App.toast('无法读取整合包：' + e.message, 'error');
            return;
        }
        const kindText = { mrpack: 'Modrinth 整合包', curseforge: 'CurseForge 整合包', generic: '通用压缩包' }[info.kind] || '整合包';
        let baseVersion = info.mcVersion || '';
        const needBase = info.kind === 'generic' && !baseVersion;
        if (needBase && !App.state.versions.length) {
            App.toast('请先安装一个原版游戏版本，再导入该整合包', 'warn', 4000);
            return;
        }
        const options = App.state.versions.map((v) => `<option value="${esc(v.id)}" ${v.id === App.state.selectedVersion ? 'selected' : ''}>${esc(v.id)}（Minecraft ${esc(v.mcVersion || '?')}）</option>`).join('');
        const ok = await new Promise((resolve) => {
            let confirmed = false;
            const m = App.modal({
                title: '安装整合包',
                narrow: true,
                iconName: 'package',
                body: `
                    <div style="line-height:1.9">
                        <div><b>${esc(info.name)}</b> <span class="badge badge-blue">${kindText}</span></div>
                        <div class="muted">Minecraft ${esc(info.mcVersion || '未知')}${info.loader && info.loader !== 'vanilla' ? ' · ' + esc(App.loaderName(info.loader)) + (info.loaderVersion ? ' ' + esc(info.loaderVersion) : '') : ''} · ${info.files || 0} 个文件</div>
                        ${info.summary ? `<div class="muted" style="margin-top:4px">${esc(info.summary)}</div>` : ''}
                    </div>
                    ${needBase ? `<div class="field" style="margin-top:8px"><label>基础版本</label><div class="field-body">
                        <select class="select" style="flex:1" data-base>${options}</select>
                    </div></div><div class="field-hint">压缩包未声明游戏版本，请选择它基于的已安装版本</div>` : ''}
                    <div class="field-hint" style="margin-top:8px">安装后会创建一个独立的隔离版本，不会影响现有存档与模组。</div>`,
                footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" data-ok>${I.download}开始安装</button>`,
                onClose: () => resolve(confirmed ? baseVersion : null),
            });
            const sel = m.body.querySelector('[data-base]');
            m.footer.querySelector('[data-close]').onclick = () => m.close();
            m.footer.querySelector('[data-ok]').onclick = () => {
                if (sel) baseVersion = sel.value;
                confirmed = true;
                m.close();
            };
        });
        if (!ok) return;
        const res = await api.installModpackFile({ file, name: info.name, baseVersion: baseVersion || undefined });
        App.toast(`已开始安装「${info.name}」，可在下方查看进度`, 'success');
        if (res?.info?.kind === 'curseforge') {
            setTimeout(() => App.toast('CurseForge 整合包的模组需要 API Key 才能自动下载，可在设置中填写', 'warn', 6000), 800);
        }
    });

    window.HomePage = { render };
})();
