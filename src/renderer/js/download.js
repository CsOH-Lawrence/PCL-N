/* 下载页：游戏版本、加载器、整合包、模组、资源包、光影、数据包、Java */
(function () {
    const App = window.App;
    const I = window.Icons;
    const api = window.pcln;
    const esc = App.esc;

    const TABS = [
        { id: 'game', name: '游戏版本', icon: 'cube' },
        { id: 'loader', name: '加载器', icon: 'layers' },
        { id: 'modpack', name: '整合包', icon: 'package' },
        { id: 'mod', name: '模组', icon: 'grid' },
        { id: 'resourcepack', name: '资源包', icon: 'image' },
        { id: 'shader', name: '光影', icon: 'sparkle' },
        { id: 'datapack', name: '数据包', icon: 'database' },
        { id: 'java', name: 'Java', icon: 'java' },
    ];

    const PROJECT_TYPE = { modpack: 'modpack', mod: 'mod', resourcepack: 'resourcepack', shader: 'shader', datapack: 'datapack' };
    const LOADER_CHOICES = {
        mod: [['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']],
        modpack: [['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']],
        shader: [['iris', 'Iris'], ['optifine', 'OptiFine'], ['canvas', 'Canvas']],
        resourcepack: [],
        datapack: [],
    };

    function dl() { return App.state.download; }

    function targetVersionInfo() {
        const id = App.state.download.targetVersion || App.state.selectedVersion;
        return App.state.versions.find((v) => v.id === id) || null;
    }

    function mcVersionOfTarget() {
        return targetVersionInfo()?.mcVersion || '';
    }

    async function ensureManifest() {
        const d = dl();
        if (!d.manifest) d.manifest = await App.call(api.manifest);
        return d.manifest;
    }

    /* ------------------------------ 渲染入口 ------------------------------ */
    function render() {
        const page = document.getElementById('page-download');
        const d = dl();
        page.innerHTML = `
            <div class="page-head">
                <div>
                    <div class="h1">下载</div>
                    <div class="sub">游戏本体、加载器、模组、整合包与各类资源</div>
                </div>
                <span class="grow"></span>
                <div class="tabs">${TABS.map((t) => `<button class="tab ${d.tab === t.id ? 'active' : ''}" data-act="dl-tab" data-tab="${t.id}">${I[t.icon]}${t.name}</button>`).join('')}</div>
            </div>
            <div id="dl-content"></div>`;
        renderContent();
    }

    function renderContent() {
        const d = dl();
        const host = document.getElementById('dl-content');
        if (!host) return;
        if (d.tab === 'game') renderGame(host);
        else if (d.tab === 'loader') renderLoader(host);
        else if (d.tab === 'java') renderJava(host);
        else renderProjects(host);
    }

    /* ---------------------------- 游戏版本 ---------------------------- */
    async function renderGame(host) {
        const d = dl();
        host.innerHTML = `<div class="empty"><span class="spinner"></span> 正在获取版本列表…</div>`;
        let manifest;
        try { manifest = await ensureManifest(); } catch (e) { host.innerHTML = `<div class="empty">获取版本列表失败：${esc(e.message)}</div>`; return; }
        const installed = new Set(App.state.versions.map((v) => v.id));
        let list = manifest.versions;
        if (d.typeFilter === 'release') list = list.filter((v) => v.type === 'release');
        else if (d.typeFilter === 'snapshot') list = list.filter((v) => v.type === 'snapshot');
        if (d.query) {
            const q = d.query.toLowerCase();
            list = list.filter((v) => v.id.toLowerCase().includes(q));
        }
        const total = list.length;
        const maxPage = Math.max(1, Math.ceil(total / d.pageSize));
        if (d.page >= maxPage) d.page = 0;
        const pageList = list.slice(d.page * d.pageSize, (d.page + 1) * d.pageSize);

        host.innerHTML = `
            <div class="dl-toolbar">
                <div class="tabs">
                    ${[['release', '正式版'], ['snapshot', '快照'], ['all', '全部']].map(([k, n]) =>
                        `<button class="tab ${d.typeFilter === k ? 'active' : ''}" data-act="dl-type" data-type="${k}">${n}</button>`).join('')}
                </div>
                <div class="search-box">${I.search}<input class="input" placeholder="搜索版本号…" value="${esc(d.query)}" data-act-change="dl-search"></div>
                <span class="grow"></span>
                <span class="muted">共 ${total} 个版本${d.page + 1}/${maxPage} 页</span>
                <button class="btn btn-icon" data-act="dl-refresh-manifest" title="刷新版本列表">${I.refresh}</button>
            </div>
            <div class="list">
                ${pageList.map((v) => {
                    const isInstalled = installed.has(v.id);
                    return `<div class="list-item">
                        <div style="width:38px;height:38px;border-radius:8px;display:grid;place-items:center;background:${v.type === 'release' ? 'var(--green-soft)' : 'var(--orange-soft)'};color:${v.type === 'release' ? 'var(--green)' : 'var(--orange)'};font-weight:700;font-size:11px">
                            ${v.type === 'release' ? 'MC' : 'SNAP'}
                        </div>
                        <div class="li-main">
                            <div class="li-title">${esc(v.id)}
                                <span class="badge ${v.type === 'release' ? 'badge-green' : 'badge-orange'}">${v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type}</span>
                                ${isInstalled ? '<span class="badge badge-blue">已安装</span>' : ''}
                                ${manifest.latest.release === v.id ? '<span class="badge badge-purple">最新正式版</span>' : ''}
                                ${manifest.latest.snapshot === v.id ? '<span class="badge badge-purple">最新快照</span>' : ''}
                            </div>
                            <div class="li-sub">发布于 ${App.fmtDate(v.releaseTime)}</div>
                        </div>
                        <div class="li-actions">
                            ${isInstalled
                                ? `<button class="btn btn-sm" data-act="dl-launch" data-id="${esc(v.id)}">${I.play}启动</button>
                                   <button class="btn btn-sm" data-act="dl-verify" data-id="${esc(v.id)}">修复</button>`
                                : `<button class="btn btn-sm btn-primary" data-act="dl-install-game" data-id="${esc(v.id)}">${I.download}安装</button>`}
                        </div>
                    </div>`;
                }).join('')}
            </div>
            <div class="pager">
                <button class="btn btn-sm" data-act="dl-page" data-dir="-1" ${d.page <= 0 ? 'disabled' : ''}>上一页</button>
                <span class="muted">第 ${d.page + 1} / ${maxPage} 页</span>
                <button class="btn btn-sm" data-act="dl-page" data-dir="1" ${d.page >= maxPage - 1 ? 'disabled' : ''}>下一页</button>
            </div>`;
        App.setStatus(total ? `版本列表已加载，共 ${total} 个` : '没有匹配的版本');
    }

    /* ------------------------------ 加载器 ------------------------------ */
    async function renderLoader(host) {
        const d = dl();
        host.innerHTML = `<div class="empty"><span class="spinner"></span> 正在获取版本列表…</div>`;
        const manifest = await ensureManifest().catch(() => null);
        if (!manifest) { host.innerHTML = `<div class="empty">无法获取版本列表，请检查网络</div>`; return; }
        const releases = manifest.versions.filter((v) => v.type === 'release').slice(0, 80);
        const mc = d.loaderMc || mcVersionOfTarget() || releases[0]?.id || '';
        d.loaderMc = mc;
        const loaders = [
            { id: 'fabric', name: 'Fabric', color: '#d8b26b', desc: '轻量、更新最快的模组加载器，适合绝大多数模组' },
            { id: 'quilt', name: 'Quilt', color: '#d76fa6', desc: 'Fabric 的分支，兼容大部分 Fabric 模组' },
            { id: 'forge', name: 'Forge', color: '#6b7f9e', desc: '老牌模组加载器，模组生态庞大' },
            { id: 'neoforge', name: 'NeoForge', color: '#c08a3e', desc: 'Forge 社区分支，1.20.2 之后的主流选择' },
        ];
        host.innerHTML = `
            <div class="dl-toolbar">
                <span class="muted">选择 Minecraft 版本</span>
                <select class="select" data-act-change="dl-loader-mc" style="width:150px">
                    ${releases.map((v) => `<option value="${esc(v.id)}" ${v.id === mc ? 'selected' : ''}>${esc(v.id)}</option>`).join('')}
                </select>
                <span class="muted">加载器会安装成一个独立版本，可保留原版</span>
            </div>
            <div class="loader-grid">
                ${loaders.map((l) => `
                    <div class="card loader-card">
                        <div class="lc-head">
                            <div class="lc-logo" style="background:${l.color}">${l.name.slice(0, 2)}</div>
                            <div>
                                <div class="lc-name">${l.name}</div>
                                <div class="muted" style="font-size:10.5px">${esc(mc)}</div>
                            </div>
                        </div>
                        <div class="lc-desc">${l.desc}</div>
                        <select class="select" data-loader-ver="${l.id}" style="width:100%">
                            <option value="">正在获取版本…</option>
                        </select>
                        <button class="btn btn-primary btn-sm" data-act="dl-install-loader" data-loader="${l.id}">${I.download}安装 ${l.name}</button>
                    </div>`).join('')}
            </div>
            <div class="spacer"></div>
            <div class="card" style="padding:12px 14px">
                <div class="h2">${I.info}说明</div>
                <div class="sub" style="line-height:1.75">
                    · Fabric / Quilt 直接从官方元数据安装，速度快、体积小。<br>
                    · Forge / NeoForge 需要运行官方安装器，首次安装可能耗时数分钟，且需要合适的 Java（已在设置中检测）。<br>
                    · 安装完成后会在主页出现对应版本卡片，模组请放到该版本的 mods 文件夹（版本隔离开启时互不影响）。
                </div>
            </div>`;
        loadLoaderVersions(mc);
    }

    async function loadLoaderVersions(mc) {
        const sels = [...document.querySelectorAll('[data-loader-ver]')];
        sels.forEach((sel) => { sel.innerHTML = '<option value="">正在获取…</option>'; });
        await Promise.all(sels.map(async (sel) => {
            const loader = sel.dataset.loaderVer;
            try {
                const list = await api.loaderVersions(loader, mc);
                if (!list.length) {
                    sel.innerHTML = `<option value="">该版本不支持 ${esc(loader)}</option>`;
                    return;
                }
                sel.innerHTML = list.slice(0, 300).map((v) => {
                    const ver = typeof v === 'string' ? v : v.version;
                    const stable = typeof v === 'string' ? true : v.stable;
                    return `<option value="${esc(ver)}">${esc(ver)}${stable ? '（稳定）' : ''}</option>`;
                }).join('');
            } catch (e) {
                sel.innerHTML = `<option value="">获取失败</option>`;
            }
        }));
    }

    /* ------------------------------ Java ------------------------------ */
    async function renderJava(host) {
        host.innerHTML = `<div class="empty"><span class="spinner"></span> 正在扫描 Java…</div>`;
        let list = [];
        try { list = await api.listJava(true); } catch (e) { /* ignore */ }
        host.innerHTML = `
            <div class="dl-toolbar">
                <button class="btn" data-act="java-rescan">${I.refresh}重新扫描</button>
                <span class="grow"></span>
                <span class="muted">游戏版本会自动匹配需要的 Java 主版本</span>
            </div>
            <div class="card" style="padding:12px 14px;margin-bottom:12px">
                <div class="h2" style="margin-bottom:6px">已检测到 ${list.length} 个 Java</div>
                ${list.length ? list.map((j) => `
                    <div class="java-row" style="margin-bottom:6px">
                        <span class="java-ver">Java ${j.major}</span>
                        <span class="badge ${j.is64 ? 'badge-green' : 'badge-red'}">${j.is64 ? '64 位' : '32 位'}</span>
                        <span class="java-path" title="${esc(j.path)}">${esc(j.path)}</span>
                        <span class="muted">${esc(j.version)}</span>
                    </div>`).join('') : '<div class="empty" style="padding:16px">没有检测到 Java，可点击下方按钮下载</div>'}
            </div>
            <div class="h2">${I.download}下载 Java（Adoptium Temurin JRE）</div>
            <div class="loader-grid">
                ${[[8, '旧版本（1.12.2 及更早）'], [17, '1.17 ~ 1.20.4'], [21, '1.20.5 及更新版本']].map(([major, note]) => `
                    <div class="card loader-card">
                        <div class="lc-head">
                            <div class="lc-logo" style="background:#2b78d4">J${major}</div>
                            <div><div class="lc-name">Java ${major}</div><div class="muted" style="font-size:10.5px">${note}</div></div>
                        </div>
                        <button class="btn btn-primary btn-sm" data-act="java-install" data-major="${major}">${I.download}下载安装</button>
                    </div>`).join('')}
            </div>`;
    }

    /* ------------------------------ Modrinth ------------------------------ */
    const FOLDER_TEXT = {
        mod: '模组', modpack: '整合包', resourcepack: '资源包', shader: '光影', datapack: '数据包',
    };

    function projectCard(p) {
        return `<div class="proj-card" data-act="proj-open" data-id="${esc(p.id)}">
            <img class="proj-icon" src="${esc(p.icon || '')}" alt="" onerror="this.style.visibility='hidden'">
            <div class="proj-body">
                <div class="proj-title">${esc(p.title)}</div>
                <div class="proj-desc">${esc(p.description || '')}</div>
                <div class="proj-foot">
                    <span class="badge badge-gray">${esc(p.author || '')}</span>
                    <span>${I.download.replace('<svg', '<svg style="width:10px;height:10px"')} ${App.fmtCount(p.downloads)}</span>
                    ${p.categories?.slice(0, 2).map((c) => `<span class="badge badge-blue">${esc(c)}</span>`).join('') || ''}
                </div>
            </div>
        </div>`;
    }

    async function renderProjects(host) {
        const d = dl();
        const type = PROJECT_TYPE[d.tab];
        const mc = mcVersionOfTarget();
        const loaderChoices = LOADER_CHOICES[d.tab] || [];
        const busy = d.loading;
        const gameVersions = [...new Set([mc, ...(d.gameVersions || []).map((v) => v.version || v)].filter(Boolean))];
        host.innerHTML = `
            <div class="dl-toolbar">
                <div class="search-box">${I.search}<input class="input" style="width:220px" placeholder="搜索${FOLDER_TEXT[type]}…" value="${esc(d.query)}" data-act-enter="proj-search" data-act-change="proj-search-change"></div>
                <select class="select" data-act-change="proj-mc" style="width:140px">
                    <option value="">全部游戏版本</option>
                    ${gameVersions.slice(0, 200).map((v) => `<option value="${esc(v)}" ${v === d.gameVersion ? 'selected' : ''}>${esc(v)}</option>`).join('')}
                </select>
                ${loaderChoices.length ? `<select class="select" data-act-change="proj-loader" style="width:130px">
                    <option value="">全部加载器</option>
                    ${loaderChoices.map(([k, n]) => `<option value="${k}" ${k === d.loader ? 'selected' : ''}>${n}</option>`).join('')}
                </select>` : ''}
                <select class="select" data-act-change="proj-sort" style="width:120px">
                    <option value="relevance" ${d.sort === 'relevance' ? 'selected' : ''}>相关度</option>
                    <option value="downloads" ${d.sort === 'downloads' ? 'selected' : ''}>下载量</option>
                    <option value="follows" ${d.sort === 'follows' ? 'selected' : ''}>关注数</option>
                    <option value="newest" ${d.sort === 'newest' ? 'selected' : ''}>最新发布</option>
                </select>
                <span class="grow"></span>
                <span class="muted">安装到：${targetVersionInfo() ? esc(targetVersionInfo().id) : '未选择版本'}</span>
            </div>
            ${d.tab === 'modpack' ? `<div class="dl-toolbar" style="margin-top:-2px">
                <button class="btn btn-sm" data-act="import-modpack">${I.package}从本地文件安装整合包</button>
                <span class="muted">支持 .mrpack / CurseForge zip / 通用压缩包</span>
            </div>` : ''}
            <div id="proj-list">${busy ? `<div class="empty"><span class="spinner"></span> 正在搜索…</div>` : ''}</div>`;
        if (!busy && !d.projectList.length) {
            await searchProjects({ reset: true });
            return;
        }
        drawProjects();
    }

    function drawProjects() {
        const d = dl();
        const box = document.getElementById('proj-list');
        if (!box) return;
        if (d.loading) { box.innerHTML = `<div class="empty"><span class="spinner"></span> 正在搜索…</div>`; return; }
        if (!d.projectList.length) {
            box.innerHTML = `<div class="empty"><b>没有找到结果</b>试试更换游戏版本、加载器或关键词</div>`;
            return;
        }
        box.innerHTML = `
            <div class="proj-grid">${d.projectList.map(projectCard).join('')}</div>
            <div class="pager">
                <button class="btn btn-sm" data-act="proj-page" data-dir="-1" ${d.page <= 0 ? 'disabled' : ''}>上一页</button>
                <span class="muted">第 ${d.page + 1} 页 · 共 ${App.fmtCount(d.total)} 个结果</span>
                <button class="btn btn-sm" data-act="proj-page" data-dir="1" ${(d.page + 1) * 20 >= d.total ? 'disabled' : ''}>下一页</button>
            </div>`;
    }

    async function searchProjects({ reset } = {}) {
        const d = dl();
        const type = PROJECT_TYPE[d.tab];
        if (!type) return;
        if (reset) d.page = 0;
        d.loading = true;
        drawProjects();
        try {
            const res = await api.searchProjects({
                query: d.query,
                projectType: type,
                gameVersion: d.gameVersion || '',
                loader: d.loader || '',
                limit: 20,
                offset: d.page * 20,
                sort: d.sort || 'relevance',
            });
            d.projectList = res.hits;
            d.total = res.total;
        } catch (e) {
            d.projectList = [];
            d.total = 0;
            App.toast(e.message, 'error');
        } finally {
            d.loading = false;
            if (dl().tab === d.tab) drawProjects();
        }
    }

    /* ------------------------------ 项目详情 ------------------------------ */
    async function openProject(id) {
        const d = dl();
        const target = targetVersionInfo();
        const m = App.modal({
            title: '正在加载…',
            wide: true,
            body: `<div class="empty"><span class="spinner"></span> 正在获取项目信息…</div>`,
            footer: `<button class="btn" data-site>${I.external}在浏览器打开</button><span class="grow"></span><button class="btn" data-cls>关闭</button>`,
        });
        let project, versions, selectedVersion;
        try {
            project = await api.projectInfo(id);
            const mc = target?.mcVersion || d.gameVersion || '';
            versions = await api.projectVersions(project.id, {
                gameVersion: mc || undefined,
                loader: d.loader || undefined,
            });
            if (!versions.length) versions = await api.projectVersions(project.id, { gameVersion: mc || undefined });
            if (!versions.length) versions = await api.projectVersions(project.id, {});
        } catch (e) {
            m.body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
            return;
        }
        selectedVersion = versions[0];
        const head = m.mask.querySelector('.modal-head .grow');
        if (head) head.textContent = project.title;
        m.footer.querySelector('[data-cls]').onclick = () => m.close();
        m.footer.querySelector('[data-site]').onclick = () => api.openExternal(`https://modrinth.com/${project.type}/${project.slug}`);

        const installBtn = document.createElement('button');
        installBtn.className = 'btn btn-primary';
        installBtn.innerHTML = I.download + '安装';
        installBtn.onclick = async () => {
            if (!selectedVersion) { App.toast('请选择要安装的版本', 'warn'); return; }
            if (!target && project.type !== 'modpack') { App.toast('请先在主页选择要安装到的游戏版本', 'warn'); return; }
            installBtn.disabled = true;
            try {
                if (project.type === 'modpack') {
                    await api.installModpack({ projectId: project.id, versionId: selectedVersion.id, name: project.title });
                } else {
                    await api.installProject({
                        projectId: project.id,
                        versionId: selectedVersion.id,
                        targetVersion: target.id,
                        projectType: project.type,
                        loader: d.loader || undefined,
                        world: project.type === 'datapack' ? undefined : undefined,
                    });
                }
                App.toast(`已开始安装 ${project.title}`, 'success');
                m.close();
            } catch (e) { App.toast(e.message, 'error'); }
            finally { installBtn.disabled = false; }
        };
        m.footer.insertBefore(installBtn, m.footer.querySelector('[data-site]'));

        const renderDetail = () => {
            m.body.innerHTML = `
                <div class="row" style="align-items:flex-start;gap:12px">
                    <img src="${esc(project.icon || '')}" style="width:64px;height:64px;border-radius:12px;background:#eef1f6" onerror="this.style.visibility='hidden'">
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:700;font-size:14px">${esc(project.title)}</div>
                        <div class="muted" style="margin:3px 0 6px">${esc(project.description || '')}</div>
                        <div class="row wrap" style="gap:5px">
                            <span class="badge badge-blue">${esc(FOLDER_TEXT[project.type] || project.type)}</span>
                            <span class="badge badge-gray">${I.download.replace('<svg', '<svg style="width:10px;height:10px"')} ${App.fmtCount(project.downloads)}</span>
                            ${project.categories?.slice(0, 5).map((c) => `<span class="badge">${esc(c)}</span>`).join('') || ''}
                        </div>
                    </div>
                </div>
                <div class="spacer"></div>
                <div class="h2">${I.layers}选择版本 <span class="muted" style="font-weight:400">（${versions.length} 个可用文件）</span></div>
                <div style="max-height:230px;overflow:auto;padding-right:2px">
                    ${versions.length ? versions.map((v, i) => `
                        <div class="ver-pick" data-ver="${esc(v.id)}" style="cursor:pointer;${i === 0 ? 'border-color:var(--accent);background:var(--accent-soft)' : ''}">
                            <div style="flex:1;min-width:0">
                                <div class="vp-name">${esc(v.name || v.versionNumber)} <span class="badge ${v.type === 'release' ? 'badge-green' : 'badge-orange'}">${v.type}</span></div>
                                <div class="vp-meta">${esc(v.gameVersions.slice(0, 3).join(', '))} · ${esc(v.loaders.join(', '))} · ${App.fmtDate(v.date)}</div>
                            </div>
                            <span class="badge badge-gray">${esc(v.files[0]?.filename || '')}</span>
                        </div>`).join('') : '<div class="empty">没有适用于当前游戏版本的文件</div>'}
                </div>
                ${project.body ? `<div class="spacer"></div><div class="h2">${I.book}介绍</div><div class="detail-desc" style="max-height:220px;overflow:auto">${sanitizeHtml(project.body)}</div>` : ''}`;
            m.body.querySelectorAll('[data-ver]').forEach((row) => {
                row.onclick = () => {
                    selectedVersion = versions.find((v) => v.id === row.dataset.ver) || selectedVersion;
                    m.body.querySelectorAll('[data-ver]').forEach((r) => {
                        r.style.borderColor = ''; r.style.background = '';
                    });
                    row.style.borderColor = 'var(--accent)';
                    row.style.background = 'var(--accent-soft)';
                };
            });
        };
        renderDetail();
    }

    function sanitizeHtml(html) {
        // 极简清洗：仅保留常见排版标签
        return String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/ on\w+="[^"]*"/gi, '')
            .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, '<img src="$1">')
            .replace(/<(?!\/?(p|br|b|i|u|strong|em|ul|ol|li|h1|h2|h3|h4|h5|h6|code|pre|blockquote|a|img|hr|table|thead|tbody|tr|td|th|span|div)\b)[^>]*>/gi, '');
    }

    /* ------------------------------ 交互动作 ------------------------------ */
    App.on('dl-tab', async (el) => {
        const d = dl();
        d.tab = el.dataset.tab;
        d.page = 0;
        d.projectList = [];
        d.total = 0;
        d.query = '';
        d.loader = '';
        // 内容类标签默认筛选当前选中版本对应的游戏版本
        if (['mod', 'modpack', 'resourcepack', 'shader', 'datapack'].includes(d.tab)) {
            d.gameVersion = mcVersionOfTarget() || '';
        } else {
            d.gameVersion = '';
        }
        if (!d.gameVersions) {
            try {
                d.gameVersions = await api.gameVersions();
            } catch {
                try {
                    const m = await api.manifest();
                    d.gameVersions = m.versions.filter((v) => v.type === 'release');
                } catch { d.gameVersions = []; }
            }
        }
        App.renderPage();
    });

    App.on('dl-type', (el) => { dl().typeFilter = el.dataset.type; dl().page = 0; App.renderPage(); });
    App.on('dl-search', (el) => {
        dl().query = el.value.trim();
        dl().page = 0;
        renderContent();
        const input = document.querySelector('[data-act-change="dl-search"]');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    App.on('dl-page', (el) => {
        dl().page = Math.max(0, dl().page + Number(el.dataset.dir));
        App.renderPage();
    });
    App.on('dl-refresh-manifest', async () => {
        dl().manifest = await App.call(api.manifest, true);
        App.toast('版本列表已更新', 'success');
        App.renderPage();
    });
    App.on('dl-install-game', async (el) => {
        await App.installVanilla(el.dataset.id, el.dataset.id);
        App.renderPage();
    });
    App.on('dl-launch', (el) => App.launchVersion(el.dataset.id).catch(() => {}));
    App.on('dl-verify', async (el) => {
        await api.verifyVersion(el.dataset.id);
        App.toast('已开始校验修复', 'success');
    });
    App.on('dl-loader-mc', (el) => { dl().loaderMc = el.value; App.renderPage(); });
    App.on('dl-install-loader', async (el) => {
        const loader = el.dataset.loader;
        const sel = document.querySelector(`[data-loader-ver="${loader}"]`);
        const version = sel?.value || '';
        const mc = dl().loaderMc || mcVersionOfTarget();
        if (!mc) { App.toast('请选择 Minecraft 版本', 'warn'); return; }
        if (!version) { App.toast('请选择加载器版本', 'warn'); return; }
        await api.installLoader({ mc, loader, version });
        App.toast('已开始安装加载器，可在下方查看进度', 'success');
    });
    App.on('java-rescan', () => { App.renderPage(); });
    App.on('java-install', async (el) => {
        const major = Number(el.dataset.major);
        await App.call(api.installJava, major);
        App.toast(`已开始下载 Java ${major}`, 'success');
    });

    App.on('proj-search', () => searchProjects({ reset: true }));
    App.on('proj-search-change', (el) => { dl().query = el.value.trim(); });
    App.on('proj-mc', (el) => { dl().gameVersion = el.value; searchProjects({ reset: true }); });
    App.on('proj-loader', (el) => { dl().loader = el.value; searchProjects({ reset: true }); });
    App.on('proj-sort', (el) => { dl().sort = el.value; searchProjects({ reset: true }); });
    App.on('proj-page', (el) => {
        const d = dl();
        d.page = Math.max(0, d.page + Number(el.dataset.dir));
        searchProjects({});
    });
    App.on('proj-open', (el) => openProject(el.dataset.id));

    window.DownloadPage = { render };
})();
