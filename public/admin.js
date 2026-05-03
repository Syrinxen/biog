document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('admin-status');
    const denied = document.getElementById('admin-denied');
    const panel = document.getElementById('admin-panel');
    const summary = document.getElementById('admin-summary');
    const usersBody = document.getElementById('admin-users');
    const commentsList = document.getElementById('admin-comments');
    const includeDeleted = document.getElementById('include-deleted-comments');
    let csrfToken = AuthUI?.csrfToken || null;
    let currentUser = AuthUI?.user || null;

    async function adminApi(path, options = {}) {
        if (!csrfToken) {
            const authResponse = await fetch(config.api.me, { credentials: 'same-origin' });
            const authData = await authResponse.json().catch(() => ({}));
            csrfToken = authData.csrfToken || AuthUI?.csrfToken || null;
        }

        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (csrfToken && options.method && options.method !== 'GET') {
            headers['X-CSRF-Token'] = csrfToken;
        }

        const response = await fetch(path, {
            credentials: 'same-origin',
            headers,
            ...options
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || '请求失败');
        }
        return data;
    }

    function setStatus(message = '') {
        status.textContent = message;
    }

    function replaceChildrenWithText(parent, className, text) {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text;
        parent.replaceChildren(element);
    }

    function renderTableMessage(message) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = message;
        row.appendChild(cell);
        usersBody.replaceChildren(row);
    }

    async function loadCurrentUser() {
        const response = await fetch(config.api.me, { credentials: 'same-origin' });
        const data = await response.json().catch(() => ({}));
        csrfToken = data.csrfToken || AuthUI?.csrfToken || csrfToken;
        currentUser = data.user || AuthUI?.user || null;
        return currentUser;
    }

    function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function renderSummary(data = {}) {
        const items = [
                ['正常用户', data.users || 0],
            ['已注销用户', data.disabledUsers || 0],
            ['正常评论', data.comments || 0],
            ['已删除评论', data.deletedComments || 0]
        ];
        summary.replaceChildren();
        items.forEach(([label, value]) => {
            const item = document.createElement('div');
            item.className = 'admin-stat';
            const number = document.createElement('strong');
            number.textContent = value;
            const name = document.createElement('span');
            name.textContent = label;
            item.append(number, name);
            summary.appendChild(item);
        });
    }

    async function loadSummary() {
        const data = await adminApi(config.api.adminSummary);
        renderSummary(data.summary);
    }

    async function loadUsers() {
        renderTableMessage('正在加载');
        const data = await adminApi(config.api.adminUsers);
        usersBody.replaceChildren();
        if (!data.users.length) {
            renderTableMessage('暂无用户');
            return;
        }
        data.users.forEach((user) => {
            const row = document.createElement('tr');
            row.className = user.disabledAt ? 'is-muted' : '';
            const emailCell = document.createElement('td');
            emailCell.textContent = `${user.nickname || '未设置'} · ${user.email}`;
            const roleCell = document.createElement('td');
            roleCell.textContent = user.isAdmin ? '管理员' : '用户';
            const commentCell = document.createElement('td');
            commentCell.textContent = user.commentCount || 0;
            const statusCell = document.createElement('td');
            statusCell.textContent = user.disabledAt ? `已注销 ${formatDate(user.disabledAt)}` : '正常';
            const actions = document.createElement('td');
            row.append(emailCell, roleCell, commentCell, statusCell, actions);

            if (!user.disabledAt) {
                const adminButton = document.createElement('button');
                adminButton.className = 'admin-action';
                adminButton.type = 'button';
                adminButton.textContent = user.isAdmin ? '取消管理员' : '设为管理员';
                adminButton.disabled = currentUser?.id === user.id && user.isAdmin;
                adminButton.addEventListener('click', async () => {
                    await adminApi(`${config.api.adminUsers}/${user.id}/admin`, {
                        method: 'PATCH',
                        body: JSON.stringify({ isAdmin: !user.isAdmin })
                    });
                    await refreshAll();
                });

                const deleteButton = document.createElement('button');
                deleteButton.className = 'admin-action danger';
                deleteButton.type = 'button';
                deleteButton.textContent = '注销';
                deleteButton.disabled = currentUser?.id === user.id;
                deleteButton.addEventListener('click', async () => {
                    if (!window.confirm(`注销用户 ${user.email}？`)) return;
                    await adminApi(`${config.api.adminUsers}/${user.id}`, { method: 'DELETE' });
                    await refreshAll();
                });

                actions.append(adminButton, deleteButton);
            }

            usersBody.appendChild(row);
        });
    }

    async function loadComments() {
        replaceChildrenWithText(commentsList, 'comment-empty', '正在加载');
        const query = includeDeleted.checked ? '?includeDeleted=1' : '';
        const data = await adminApi(`${config.api.adminComments}${query}`);
        commentsList.replaceChildren();
        if (!data.comments.length) {
            replaceChildrenWithText(commentsList, 'comment-empty', '暂无评论');
            return;
        }
        data.comments.forEach((comment) => {
            const item = document.createElement('article');
            item.className = `admin-comment${comment.deletedAt ? ' is-muted' : ''}`;

            const meta = document.createElement('div');
            meta.className = 'admin-comment-meta';
            meta.textContent = `${comment.authorNickname || comment.authorEmail} · 文章 ${comment.articleId} · ${formatDate(comment.createdAt)}`;
            if (comment.authorEmail) meta.title = comment.authorEmail;

            const body = document.createElement('p');
            body.textContent = comment.body || '';

            const footer = document.createElement('div');
            footer.className = 'admin-comment-footer';
            if (comment.deletedAt) {
                footer.textContent = `已删除 ${formatDate(comment.deletedAt)}`;
            } else {
                const button = document.createElement('button');
                button.className = 'admin-action danger';
                button.type = 'button';
                button.textContent = '删除评论';
                button.addEventListener('click', async () => {
                    if (!window.confirm('删除这条评论？')) return;
                    await adminApi(`${config.api.adminComments}/${comment.id}`, { method: 'DELETE' });
                    await refreshAll();
                });
                footer.appendChild(button);
            }

            item.append(meta, body, footer);
            commentsList.appendChild(item);
        });
    }

    async function refreshAll() {
        setStatus('');
        try {
            await Promise.all([loadSummary(), loadUsers(), loadComments()]);
        } catch (error) {
            setStatus(error.message);
            if (error.message === '请先登录') {
                denied.hidden = false;
                panel.hidden = true;
            }
        }
    }

    function applyAccess(user) {
        csrfToken = AuthUI?.csrfToken || csrfToken;
        currentUser = user || currentUser;
        const isAdmin = Boolean(currentUser?.isAdmin);
        denied.hidden = isAdmin;
        panel.hidden = !isAdmin;
        setStatus(isAdmin ? '' : (currentUser ? '当前账号没有后台权限' : '请先登录管理员账号'));
        if (isAdmin) refreshAll();
    }

    document.getElementById('admin-login')?.addEventListener('click', () => AuthUI.open('login'));
    document.getElementById('refresh-users')?.addEventListener('click', refreshAll);
    includeDeleted?.addEventListener('change', loadComments);

    document.querySelectorAll('.admin-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach((item) => item.classList.toggle('active', item === tab));
            document.getElementById('admin-users-panel').hidden = tab.dataset.panel !== 'users';
            document.getElementById('admin-comments-panel').hidden = tab.dataset.panel !== 'comments';
        });
    });

    setStatus('正在检查权限');
    if (window.AuthUI?.onChange) {
        AuthUI.onChange(applyAccess);
    }
    loadCurrentUser().then(applyAccess).catch((error) => {
        denied.hidden = false;
        panel.hidden = true;
        setStatus(error.message || '权限检查失败');
    });
});
