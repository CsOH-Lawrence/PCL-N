/* 账号与自动登录：离线账号 / 微软正版，令牌保存在本地并自动续期 */
(function () {
    const App = window.App;
    const I = window.Icons;
    const api = window.pcln;
    const esc = App.esc;

    App.state.auth = { accounts: [], activeId: '', active: null, autoLogin: true };

    function typeText(a) {
        if (!a) return '';
        return a.type === 'microsoft' ? '微软正版' : '离线';
    }

    function expireText(a) {
        if (!a || a.type !== 'microsoft') return '';
        if (!a.expiresAt) return '';
        const left = a.expiresAt - Date.now();
        if (left <= 0) return '令牌已过期';
        const h = Math.floor(left / 3600000);
        const m = Math.floor((left % 3600000) / 60000);
        return h > 0 ? `令牌剩余 ${h} 小时 ${m} 分` : `令牌剩余 ${m} 分钟`;
    }

    function avatarHtml(a, size = 34) {
        const style = `width:${size}px;height:${size}px;border-radius:8px;object-fit:cover;flex:0 0 auto`;
        if (a?.type === 'microsoft' && a.skin) {
            return `<img src="${esc(a.skin)}" style="${style};background:#eef1f6" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'account-avatar',style:'${style}',textContent:'${esc((a.name || '?')[0])}'}))">`;
        }
        const letter = (a?.name || '?').slice(0, 1).toUpperCase();
        return `<div class="account-avatar" style="${style}">${esc(letter)}</div>`;
    }

    function chipHtml() {
        const a = App.state.auth.active;
        if (!a) {
            return `<button class="hero-chip" data-act="accounts-manage">${I.info}<span>未登录账号</span></button>`;
        }
        return `<button class="hero-chip" data-act="accounts-manage" title="账号管理">
            ${a.type === 'microsoft' ? I.check : I.info}
            <span>${esc(a.name)}</span>
            <span class="chip-badge">${typeText(a)}</span>
        </button>`;
    }

    App.accountChipHtml = chipHtml;

    async function refreshAuth(broadcast = false) {
        try {
            App.state.auth = await api.authState();
        } catch { /* 忽略 */ }
        App.renderSide();
        if (broadcast) App.renderPage();
        return App.state.auth;
    }
    App.refreshAuth = refreshAuth;

    function renderSideUser() {
        const el = document.getElementById('side-user');
        if (!el) return;
        const a = App.state.auth.active;
        el.innerHTML = a
            ? `<button class="side-account" data-act="accounts-manage" title="账号管理">
                   <span class="dot ${a.type === 'microsoft' ? 'green' : ''}"></span>
                   <span class="name">${esc(a.name)}</span>
                   <span class="type">${typeText(a)}</span>
               </button>`
            : `<button class="side-account" data-act="accounts-manage" title="账号管理">
                   <span class="dot"></span><span class="name">未登录账号</span><span class="type">点击登录</span>
               </button>`;
    }
    App.renderSideUser = renderSideUser;

    /* ---------------------------- 账号管理弹窗 ---------------------------- */
    function openManager() {
        const auth = App.state.auth;
        const active = auth.active;
        const m = App.modal({
            title: '账号与自动登录',
            wide: false,
            iconName: 'info',
            body: `
                <div class="account-list" data-account-list>${renderList()}</div>
                <div class="account-divider"></div>
                <div class="row wrap" style="gap:8px">
                    <button class="btn" data-add-offline>${I.plus}添加离线账号</button>
                    <button class="btn btn-primary" data-ms-login>${I.globe}微软账号登录</button>
                    <span class="grow"></span>
                    <button class="btn btn-sm" data-refresh-all>${I.refresh}刷新全部</button>
                </div>
                <div class="spacer"></div>
                <div class="field" style="border-bottom:0;padding:4px 0">
                    <label style="width:auto">启动时自动登录</label>
                    <div class="field-body">
                        <label class="switch"><input type="checkbox" ${auth.autoLogin ? 'checked' : ''} data-auto-login><i></i></label>
                        <span class="field-hint">自动使用上次的账号并静默续期正版令牌</span>
                    </div>
                </div>
                <div class="account-note">
                    ${I.info}
                    <span>正版登录通过微软官方页面完成，授权后的令牌只保存在本机
                    （${esc(App.state.info?.dataDir || '')}/accounts.json），用于启动游戏；
                    离线账号的 UUID 按 <code>OfflinePlayer:名字</code> 生成。</span>
                </div>`,
            footer: `<span class="grow"></span><button class="btn btn-primary" data-close>完成</button>`,
            onClose: () => App.renderPage(),
        });

        function renderList() {
            const list = App.state.auth.accounts;
            if (!list.length) {
                return `<div class="empty" style="padding:18px"><b>还没有添加账号</b>可以添加离线账号，或使用微软正版登录</div>`;
            }
            return list.map((a) => {
                const isActive = a.id === App.state.auth.activeId;
                return `<div class="account-row ${isActive ? 'active' : ''}" data-id="${esc(a.id)}">
                    ${avatarHtml(a, 34)}
                    <div class="account-main">
                        <div class="account-title">
                            <b>${esc(a.name)}</b>
                            <span class="badge ${a.type === 'microsoft' ? 'badge-green' : 'badge-gray'}">${typeText(a)}</span>
                            ${isActive ? '<span class="badge badge-blue">使用中</span>' : ''}
                            ${a.expired ? '<span class="badge badge-orange">已过期</span>' : ''}
                        </div>
                        <div class="account-sub">${a.type === 'microsoft' ? esc(a.uuid || '') : '离线 UUID：' + esc((a.uuid || '').slice(0, 8)) + '…'} ${expireText(a) ? ' · ' + expireText(a) : ''}</div>
                    </div>
                    <div class="account-actions">
                        ${!isActive ? `<button class="btn btn-sm" data-use="${esc(a.id)}">切换</button>` : ''}
                        ${a.type === 'microsoft' ? `<button class="btn btn-sm" data-refresh="${esc(a.id)}" title="刷新令牌">${I.refresh}</button>` : ''}
                        <button class="btn btn-sm btn-danger" data-del="${esc(a.id)}" title="移除账号">${I.trash}</button>
                    </div>
                </div>`;
            }).join('');
        }

        function rerender() {
            const box = m.body.querySelector('[data-account-list]');
            if (box) box.innerHTML = renderList();
            bindRows();
        }

        function bindRows() {
            m.body.querySelectorAll('[data-use]').forEach((btn) => {
                btn.onclick = async () => {
                    try {
                        App.state.auth = await api.authSelect(btn.dataset.use);
                        await App.refreshAuth();
                        rerender();
                        App.toast('已切换账号', 'success');
                    } catch (e) { App.toast(e.message, 'error'); }
                };
            });
            m.body.querySelectorAll('[data-refresh]').forEach((btn) => {
                btn.onclick = async () => {
                    btn.disabled = true;
                    btn.innerHTML = '<span class="spinner"></span>';
                    try {
                        await api.authRefresh(btn.dataset.refresh);
                        await App.refreshAuth();
                        rerender();
                        App.toast('登录令牌已刷新', 'success');
                    } catch (e) {
                        App.toast(e.message, 'error', 5000);
                    } finally {
                        btn.disabled = false;
                        btn.innerHTML = I.refresh;
                    }
                };
            });
            m.body.querySelectorAll('[data-del]').forEach((btn) => {
                btn.onclick = async () => {
                    const ok = await App.confirm({ title: '移除账号', text: '移除后需要重新登录才能使用该账号，确定继续？', danger: true, okText: '移除' });
                    if (!ok) return;
                    try {
                        App.state.auth = await api.authRemove(btn.dataset.del);
                        await App.refreshAuth();
                        rerender();
                        App.toast('账号已移除', 'success');
                    } catch (e) { App.toast(e.message, 'error'); }
                };
            });
        }

        m.body.querySelector('[data-add-offline]').onclick = async () => {
            const name = await App.prompt({
                title: '添加离线账号',
                hint: '离线账号用于单机与离线服务器，不能进入正版验证服务器。',
                value: App.state.config?.launch?.username || 'Steve',
                placeholder: '1~16 位，字母/数字/下划线/中文',
            });
            if (!name) return;
            try {
                await api.authAddOffline(name);
                await App.refreshAuth();
                rerender();
                App.toast(`已添加离线账号 ${name}`, 'success');
            } catch (e) { App.toast(e.message, 'error'); }
        };

        m.body.querySelector('[data-ms-login]').onclick = async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 请在弹窗中登录…';
            try {
                const account = await api.authMsLogin();
                await App.refreshAuth();
                rerender();
                App.toast(`登录成功：${account?.name || ''}`, 'success');
            } catch (err) {
                App.toast(err.message || '登录失败', 'error', 5000);
            } finally {
                btn.disabled = false;
                btn.innerHTML = I.globe + '微软账号登录';
            }
        };

        m.body.querySelector('[data-auto-login]').onchange = async (e) => {
            try {
                await api.authAutoLogin(e.target.checked);
                await App.refreshAuth();
            } catch (err) { App.toast(err.message, 'error'); }
        };

        m.body.querySelector('[data-refresh-all]').onclick = async () => {
            const targets = App.state.auth.accounts.filter((a) => a.type === 'microsoft');
            if (!targets.length) { App.toast('没有微软账号需要刷新', 'info'); return; }
            for (const a of targets) {
                try { await api.authRefresh(a.id); } catch (e) { App.toast(`${a.name}: ${e.message}`, 'error', 4000); }
            }
            await App.refreshAuth();
            rerender();
            App.toast('刷新完成', 'success');
        };

        bindRows();
    }

    App.on('accounts-manage', () => openManager());
    App.on('account-chip', () => openManager());

    /* 主进程推送的账号状态 / 自动登录结果 */
    if (api.onAuthState) {
        api.onAuthState((s) => {
            App.state.auth = s;
            App.renderSideUser();
            App.renderPage();
        });
    }
    if (api.onAuthRefresh) {
        api.onAuthRefresh((r) => {
            if (r?.ok && r.account) {
                App.toast('已自动登录：' + r.account.name, 'success');
            } else if (r && r.ok === false) {
                App.toast('自动登录失败：' + (r.error || '未知错误') + (r.needRelogin ? '（请到账号管理重新登录）' : ''), 'error', 6000);
            }
        });
    }

    // 启动即读取账号状态（侧边栏 / 主页立即显示）
    api.authState().then((s) => {
        App.state.auth = s;
        App.renderSideUser();
    }).catch(() => {});

    window.AccountsPage = { refreshAuth, openManager, chipHtml };
})();
