/* 启动引导：窗口控制、初始化数据、游戏事件 */
(function () {
    const App = window.App;
    const api = window.pcln;
    const I = window.Icons;
    const esc = App.esc;

    /* ---------------------------- 窗口控制 ---------------------------- */
    document.getElementById('btn-min').onclick = () => api.windowMinimize();
    document.getElementById('btn-max').onclick = async () => {
        const max = await api.windowMaximize();
        document.getElementById('btn-max').innerHTML = max
            ? '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.1" rx="1"/></svg>'
            : '<svg viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.1" rx="1"/></svg>';
    };
    document.getElementById('btn-close').onclick = () => api.windowClose();
    if (api.onWindowState) {
        api.onWindowState(({ maximized }) => {
            document.getElementById('btn-max').innerHTML = maximized
                ? '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.1" rx="1"/></svg>'
                : '<svg viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.1" rx="1"/></svg>';
        });
    }
    // 兜底：双击标题栏最大化
    document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
        if (e.target.closest('.win-btn')) return;
        api.windowMaximize();
    });

    /* ---------------------------- 背景图片 ---------------------------- */
    App.applyBackground = () => {
        const cfg = App.state.config || {};
        const bg = cfg.ui?.background;
        const opacity = cfg.ui?.backgroundOpacity ?? 0.9;
        const main = document.querySelector('.main');
        if (bg) {
            const url = 'file:///' + String(bg).replace(/\\/g, '/').replace(/ /g, '%20');
            document.body.style.backgroundImage = `url("${url}")`;
            document.body.style.backgroundSize = 'cover';
            document.body.style.backgroundPosition = 'center';
            document.body.style.backgroundRepeat = 'no-repeat';
            if (main) main.style.background = `rgba(241,243,247,${1 - opacity})`;
        } else {
            document.body.style.backgroundImage = '';
            if (main) main.style.background = '';
        }
    };

    /* ---------------------------- 启动流程 ---------------------------- */
    async function boot() {
        try {
            App.state.info = await api.info();
            await App.refreshConfig();
        } catch (e) {
            console.error(e);
        }
        App.applyBackground();
        App.renderNav();
        try {
            await App.refreshVersions();
        } catch (e) { App.toast('读取版本列表失败: ' + e.message, 'error'); }
        App.state.running = App.state.info?.running || null;
        App.state.download.targetVersion = App.state.selectedVersion;
        App.setPage(App.state.config?.lastPage || 'home');
        App.renderSide();
        if (App.refreshAuth) await App.refreshAuth();
        App.renderPage();
        App.refreshTasks();
        // 预热版本列表（供下载页项目筛选）
        api.gameVersions().then((list) => {
            App.state.download.gameVersions = list;
        }).catch(() => {
            api.manifest().then((m) => {
                App.state.download.gameVersions = m.versions.filter((v) => v.type === 'release');
            }).catch(() => {});
        });
        // 日志缓存
        api.logs(200).then((lines) => { App.state.logs = lines; }).catch(() => {});
        if (!App.state.versions.length) {
            App.setStatus('未检测到游戏版本，去「下载」页安装一个吧');
        } else {
            App.setStatus(`已加载 ${App.state.versions.length} 个版本`);
        }
    }

    /* ---------------------------- 游戏事件 ---------------------------- */
    let logLineCount = 0;
    if (api.onLaunchStarted) {
        api.onLaunchStarted((e) => {
            App.state.running = { id: e.versionId, pid: e.pid };
            App.toast(`游戏已启动（PID ${e.pid}）`, 'success');
            App.setStatus(`游戏运行中：${e.versionId}`);
            App.renderSide();
            App.renderPage();
        });
    }

    if (api.onLaunchLog) {
        api.onLaunchLog(({ line }) => {
            logLineCount++;
            if (App.state.page === 'help') {
                App.state.help.log = (App.state.help.log || '') + line + '\n';
                const box = document.getElementById('help-log');
                if (box) { box.textContent = App.state.help.log; box.scrollTop = box.scrollHeight; }
            }
        });
    }

    if (api.onLaunchExit) {
        api.onLaunchExit((e) => {
            const wasRunning = App.state.running;
            App.state.running = null;
            App.renderSide();
            App.renderPage();
            if (e.error) {
                App.toast('启动失败：' + e.error, 'error', 6000);
                App.setStatus('启动失败');
                return;
            }
            const analysis = e.analysis;
            const causes = analysis?.causes || [];
            if (e.crashed) {
                App.setStatus('游戏异常退出');
                showCrashModal(e, causes, analysis);
            } else {
                App.setStatus('游戏已退出');
                App.toast('游戏已退出' + (e.code ? `（代码 ${e.code}）` : ''), 'info');
                if (causes.length) showCrashModal(e, causes, analysis);
            }
        });
    }

    function showCrashModal(e, causes, analysis) {
        const m = App.modal({
            title: '游戏异常退出',
            wide: true,
            iconName: 'alert',
            body: `
                <div class="row wrap" style="gap:6px;margin-bottom:8px">
                    <span class="badge badge-red">退出码 ${esc(e.code)}</span>
                    ${e.duration ? `<span class="badge badge-gray">运行 ${Math.round(e.duration / 1000)} 秒</span>` : ''}
                    ${analysis?.javaVersion ? `<span class="badge badge-blue">Java ${esc(analysis.javaVersion)}</span>` : ''}
                    ${analysis?.memory ? `<span class="badge badge-gray">内存 ${analysis.memory} MB</span>` : ''}
                </div>
                <div class="analyze-result">
                    ${causes.length ? causes.map((c) => `
                        <div class="cause-item ${c.level || 'error'}">
                            <div class="cause-title">${I.alert}<span>${esc(c.title)}</span></div>
                            <div class="cause-desc">${esc(c.solution)}</div>
                            ${c.evidence ? `<div class="cause-evidence">${esc(c.evidence)}</div>` : ''}
                        </div>`).join('')
                        : `<div class="cause-item"><div class="cause-title">${I.info}<span>没有识别出明确的错误</span></div>
                           <div class="cause-desc">可以到「帮助」页分析完整日志，或查看启动器日志定位问题。</div></div>`}
                </div>
                ${e.logFile ? `<div class="muted" style="margin-top:8px;word-break:break-all">日志：${esc(e.logFile)}</div>` : ''}`,
            footer: `<button class="btn" data-help>${I.help}去帮助页分析</button>
                     <span class="grow"></span>
                     <button class="btn" data-close>关闭</button>`,
        });
        m.footer.querySelector('[data-close]').onclick = () => m.close();
        m.footer.querySelector('[data-help]').onclick = () => {
            m.close();
            App.state.help.result = analysis || null;
            App.setPage('help');
        };
    }

    /* ---------------------------- 任务结果 ---------------------------- */
    if (api.onTaskUpdate) {
        api.onTaskUpdate((list) => {
            const running = list.filter((t) => t.status === 'running');
            if (running.length) {
                const t = running[0];
                App.setStatus(`${t.title} · ${t.phaseText} · ${Math.round(t.percent || 0)}%`);
            } else {
                App.setStatus(App.state.running ? `游戏运行中：${App.state.running.id}` : '就绪');
            }
        });
    }

    /* ------------------------------ 快捷键 ------------------------------ */
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === '1') { App.setPage('home'); e.preventDefault(); }
        if (e.ctrlKey && e.key === '2') { App.setPage('download'); e.preventDefault(); }
        if (e.ctrlKey && e.key === '3') { App.setPage('settings'); e.preventDefault(); }
        if (e.ctrlKey && e.key === '4') { App.setPage('help'); e.preventDefault(); }
        if (e.key === 'F5') { App.refreshVersions().then(() => App.renderPage()); e.preventDefault(); }
    });

    boot().catch((e) => {
        console.error(e);
        App.toast('启动器初始化失败: ' + e.message, 'error', 8000);
    });
})();
