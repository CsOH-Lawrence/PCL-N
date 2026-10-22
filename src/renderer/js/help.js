/* 帮助页：崩溃分析、错误百科、启动器日志 */
(function () {
    const App = window.App;
    const I = window.Icons;
    const api = window.pcln;
    const esc = App.esc;

    App.state.help = { result: null, analyzing: false, kb: null, kbQuery: '', log: '' };

    function render() {
        const page = document.getElementById('page-help');
        const st = App.state.help;
        page.innerHTML = `
            <div class="page-head">
                <div>
                    <div class="h1">帮助</div>
                    <div class="sub">游戏报错分析、常见问题与启动器日志</div>
                </div>
                <span class="grow"></span>
                <button class="btn" data-act="help-analyze">${I.alert}分析最近一次游戏日志</button>
                <button class="btn" data-act="help-pick">${I.folder}选择崩溃报告</button>
            </div>
            <div class="help-grid">
                <div style="display:flex;flex-direction:column;gap:12px;min-width:0">
                    <div class="card analyze-card">
                        <div class="analyze-head">
                            <span style="width:18px;height:18px;color:var(--accent);display:inline-flex">${I.alert}</span>
                            <b>崩溃 / 错误分析</b>
                            <span class="grow"></span>
                            ${st.result ? `<button class="btn btn-sm" data-act="help-copy">${I.copy}复制结论</button>` : ''}
                        </div>
                        <div id="help-result">${renderResult()}</div>
                    </div>
                    <div class="card analyze-card">
                        <div class="analyze-head">
                            <span style="width:18px;height:18px;color:var(--text-2);display:inline-flex">${I.terminal}</span>
                            <b>启动器日志</b>
                            <span class="grow"></span>
                            <button class="btn btn-sm" data-act="help-refresh-log">${I.refresh}刷新</button>
                            <button class="btn btn-sm" data-act="help-open-log">${I.external}打开文件</button>
                        </div>
                        <div class="log-box" id="help-log">${esc(st.log || '点击「刷新」加载最近日志…')}</div>
                    </div>
                </div>
                <div class="card analyze-card">
                    <div class="analyze-head">
                        <span style="width:18px;height:18px;color:var(--text-2);display:inline-flex">${I.book}</span>
                        <b>错误百科</b>
                        <span class="grow"></span>
                        <span class="muted">${(st.kb || []).length} 条</span>
                    </div>
                    <div class="search-box" style="width:100%;margin-bottom:8px">
                        ${I.search}<input class="input" style="width:100%" placeholder="搜索错误关键词…" value="${esc(st.kbQuery)}" data-act-change="kb-search">
                    </div>
                    <div id="kb-list">${renderKb()}</div>
                </div>
            </div>`;
        if (!st.kb) loadKb();
        bindKb();
        App.setStatus(st.result ? '已完成日志分析' : '就绪');
    }

    function renderResult() {
        const st = App.state.help;
        if (st.analyzing) return `<div class="empty"><span class="spinner"></span> 正在分析日志…</div>`;
        const r = st.result;
        if (!r) {
            return `<div class="empty" style="padding:22px">
                <b>还没有分析结果</b>
                点击右上角「分析最近一次游戏日志」，或选择一个 crash-report 文件。分析会识别内存不足、Java 版本不匹配、模组冲突等常见问题。
            </div>`;
        }
        const causes = r.causes || [];
        return `
            <div class="row" style="gap:8px;margin-bottom:8px">
                <span class="badge ${causes.length ? 'badge-red' : 'badge-green'}">${causes.length ? '发现问题' : '未发现明显问题'}</span>
                <b style="font-size:13px">${esc(r.summary || '')}</b>
            </div>
            <div class="row wrap" style="gap:5px;margin-bottom:6px">
                ${r.javaVersion ? `<span class="badge badge-blue">Java ${esc(r.javaVersion)}</span>` : ''}
                ${r.memory ? `<span class="badge badge-gray">内存 ${r.memory} MB</span>` : ''}
                ${r.exitCode ? `<span class="badge badge-orange">退出码 ${esc(r.exitCode)}</span>` : ''}
                ${r.meta?.file ? `<span class="badge badge-gray" title="${esc(r.meta.file)}">${esc(String(r.meta.file).split(/[\\/]/).pop())}</span>` : ''}
            </div>
            <div class="analyze-result">
                ${causes.map((c) => `
                    <div class="cause-item ${c.level || 'error'}">
                        <div class="cause-title">${I.alert}<span>${esc(c.title)}</span></div>
                        <div class="cause-desc">${esc(c.solution)}</div>
                        ${c.evidence ? `<div class="cause-evidence">${esc(c.evidence)}</div>` : ''}
                    </div>`).join('')}
            </div>
            ${r.mods?.length ? `<div class="spacer"></div><div class="muted">日志中提到的可疑模组 / 类：${r.mods.slice(0, 8).map((m) => `<span class="badge badge-gray">${esc(m)}</span>`).join(' ')}</div>` : ''}`;
    }

    function renderKb() {
        const st = App.state.help;
        const q = (st.kbQuery || '').toLowerCase();
        const list = (st.kb || []).filter((k) => !q || k.title.toLowerCase().includes(q) || k.solution.toLowerCase().includes(q));
        if (!st.kb) return `<div class="empty"><span class="spinner"></span> 加载中…</div>`;
        if (!list.length) return `<div class="empty">没有匹配的条目</div>`;
        return list.map((k) => `
            <div class="kb-item" data-kb="${esc(k.id)}">
                <div class="kb-title"><span class="badge ${k.level === 'error' ? 'badge-red' : 'badge-orange'}">${k.level === 'error' ? '错误' : '警告'}</span>${esc(k.title)}</div>
                <div class="kb-body">${esc(k.solution)}</div>
            </div>`).join('');
    }

    function bindKb() {
        document.querySelectorAll('.kb-item').forEach((el) => {
            el.onclick = () => el.classList.toggle('open');
        });
    }

    async function loadKb() {
        try {
            App.state.help.kb = await api.helpKb();
            const host = document.getElementById('kb-list');
            if (host) { host.innerHTML = renderKb(); bindKb(); }
        } catch { /* ignore */ }
    }

    /* ------------------------------ 动作 ------------------------------ */
    App.on('help-analyze', async () => {
        const st = App.state.help;
        st.analyzing = true;
        st.result = null;
        App.renderPage();
        try {
            const res = await api.analyze({ versionId: App.state.selectedVersion || undefined });
            st.result = res;
            App.toast(res.causes?.length ? '分析完成：' + res.summary : '分析完成，没有发现明显问题', res.causes?.length ? 'warn' : 'success', 4000);
        } catch (e) {
            App.toast(e.message, 'error');
        } finally {
            st.analyzing = false;
            App.renderPage();
        }
    });

    App.on('help-pick', async () => {
        const file = await api.pickCrash();
        if (!file) return;
        const st = App.state.help;
        st.analyzing = true;
        App.renderPage();
        try {
            st.result = await api.analyze({ file });
        } catch (e) { App.toast(e.message, 'error'); }
        st.analyzing = false;
        App.renderPage();
    });

    App.on('help-copy', async () => {
        const r = App.state.help.result;
        if (!r) return;
        const text = [r.summary, ...(r.causes || []).map((c) => `【${c.title}】${c.solution}`)].join('\n\n');
        try {
            await navigator.clipboard.writeText(text);
            App.toast('已复制到剪贴板', 'success');
        } catch { App.toast('复制失败', 'error'); }
    });

    App.on('help-refresh-log', async () => {
        try {
            const lines = await api.logs(200);
            App.state.help.log = lines.map((l) => l.line).join('\n');
            const box = document.getElementById('help-log');
            if (box) box.textContent = App.state.help.log || '暂无日志';
            box.scrollTop = box.scrollHeight;
        } catch (e) { App.toast(e.message, 'error'); }
    });

    App.on('help-open-log', () => api.openLog());
    App.on('kb-search', (el) => {
        App.state.help.kbQuery = el.value.trim();
        const host = document.getElementById('kb-list');
        if (host) { host.innerHTML = renderKb(); bindKb(); }
        const input = document.querySelector('[data-act-change="kb-search"]');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });

    window.HelpPage = { render };
})();
