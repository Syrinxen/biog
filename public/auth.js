(function () {
    const state = {
        user: null,
        csrfToken: null,
        ready: null,
        listeners: []
    };

    function api(path, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (state.csrfToken && options.method && options.method !== 'GET') {
            headers['X-CSRF-Token'] = state.csrfToken;
        }
        return fetch(path, {
            credentials: 'same-origin',
            headers,
            ...options
        }).then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || '请求失败');
            }
            return data;
        });
    }

    function notify() {
        state.listeners.forEach((listener) => listener(state.user));
    }

    function openModal(mode = 'login') {
        const existing = document.querySelector('.auth-modal');
        if (existing) existing.remove();

        const isRegister = mode === 'register';
        const isReset = mode === 'reset';
        let captchaToken = '';
        let captchaChoice = '';
        const modal = document.createElement('div');
        modal.className = 'auth-modal';
        modal.innerHTML = `
            <div class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
                <button class="auth-close" type="button" aria-label="关闭">×</button>
                <h2 id="auth-title">${isRegister ? '邮箱注册' : (isReset ? '重置密码' : '邮箱登录')}</h2>
                <form class="auth-form">
                    ${isRegister ? `
                    <label>
                        <span>昵称</span>
                        <input type="text" name="nickname" autocomplete="nickname" minlength="2" maxlength="20" required>
                    </label>
                    ` : ''}
                    <label>
                        <span>邮箱</span>
                        <input type="email" name="email" autocomplete="email" required>
                    </label>
                    <label>
                        <span>${isReset ? '新密码' : '密码'}</span>
                        <input type="password" name="password" autocomplete="${isRegister || isReset ? 'new-password' : 'current-password'}" minlength="10" required>
                    </label>
                    ${isRegister || isReset ? `
                    <label>
                        <span>邮箱验证码</span>
                        <div class="auth-code-row">
                            <input type="text" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" required>
                            <button class="auth-code-btn" type="button">发送验证码</button>
                        </div>
                    </label>
                    ` : ''}
                    ${isRegister ? `
                    <div class="auth-captcha">
                        <div class="auth-captcha-head">
                            <span class="auth-captcha-prompt">正在生成图片验证</span>
                            <button class="auth-captcha-refresh" type="button">换一组</button>
                        </div>
                        <div class="auth-captcha-grid" aria-label="图片点击验证"></div>
                    </div>
                    ` : ''}
                    <p class="auth-error" role="alert"></p>
                    <button class="auth-submit" type="submit">${isRegister ? '注册并登录' : (isReset ? '重置密码' : '登录')}</button>
                </form>
                <div class="auth-switch-row">
                    <button class="auth-switch" type="button">${isRegister || isReset ? '返回登录' : '没有账号，去注册'}</button>
                    ${!isRegister && !isReset ? '<button class="auth-forgot" type="button">忘记密码</button>' : ''}
                </div>
            </div>
        `;

        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.classList.contains('auth-close')) modal.remove();
        });

        modal.querySelector('.auth-switch').addEventListener('click', () => {
            modal.remove();
            openModal(isRegister || isReset ? 'login' : 'register');
        });
        modal.querySelector('.auth-forgot')?.addEventListener('click', () => {
            modal.remove();
            openModal('reset');
        });

        async function loadCaptcha() {
            if (!isRegister) return;
            const prompt = modal.querySelector('.auth-captcha-prompt');
            const grid = modal.querySelector('.auth-captcha-grid');
            captchaToken = '';
            captchaChoice = '';
            prompt.textContent = '正在生成图片验证';
            grid.innerHTML = '';
            try {
                const data = await api(config.api.captcha);
                captchaToken = data.token || '';
                prompt.textContent = data.prompt || '请选择指定图片';
                (data.choices || []).forEach((choice) => {
                    const button = document.createElement('button');
                    button.className = 'auth-captcha-choice';
                    button.type = 'button';
                    button.dataset.choice = choice.id;
                    button.setAttribute('aria-label', choice.label || '验证图片');

                    const image = document.createElement('img');
                    image.src = choice.image;
                    image.alt = choice.label || '验证图片';
                    button.appendChild(image);
                    button.addEventListener('click', () => {
                        captchaChoice = choice.id;
                        grid.querySelectorAll('.auth-captcha-choice').forEach((item) => {
                            item.classList.toggle('selected', item === button);
                        });
                    });
                    grid.appendChild(button);
                });
            } catch (requestError) {
                prompt.textContent = requestError.message || '图片验证加载失败';
            }
        }

        modal.querySelector('.auth-captcha-refresh')?.addEventListener('click', loadCaptcha);
        loadCaptcha();

        const codeButton = modal.querySelector('.auth-code-btn');
        codeButton?.addEventListener('click', async () => {
            const form = modal.querySelector('.auth-form');
            const error = form.querySelector('.auth-error');
            const email = form.email.value.trim();
            error.textContent = '';
            codeButton.disabled = true;
            try {
                await api(isReset ? config.api.sendResetCode : config.api.sendCode, {
                    method: 'POST',
                    body: JSON.stringify({ email })
                });
                let seconds = 60;
                codeButton.textContent = `${seconds}s`;
                const timer = window.setInterval(() => {
                    seconds -= 1;
                    codeButton.textContent = seconds > 0 ? `${seconds}s` : '发送验证码';
                    if (seconds <= 0) {
                        window.clearInterval(timer);
                        codeButton.disabled = false;
                    }
                }, 1000);
            } catch (requestError) {
                error.textContent = requestError.message;
                codeButton.disabled = false;
            }
        });

        modal.querySelector('.auth-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const submit = form.querySelector('.auth-submit');
            const error = form.querySelector('.auth-error');
            const payload = {
                email: form.email.value,
                password: form.password.value
            };
            if (isRegister || isReset) payload.code = form.code.value;
            if (isRegister) {
                payload.nickname = form.nickname.value;
                payload.captchaToken = captchaToken;
                payload.captchaChoice = captchaChoice;
            }

            submit.disabled = true;
            error.textContent = '';
            try {
                const endpoint = isRegister ? config.api.register : (isReset ? config.api.resetPassword : config.api.login);
                const data = await api(endpoint, {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                if (isReset) {
                    modal.remove();
                    openModal('login');
                    return;
                }
                state.user = data.user;
                state.csrfToken = data.csrfToken || null;
                notify();
                modal.remove();
            } catch (requestError) {
                error.textContent = requestError.message;
                if (isRegister) loadCaptcha();
            } finally {
                submit.disabled = false;
            }
        });

        document.body.appendChild(modal);
        modal.querySelector('input[name="email"]').focus();
    }

    async function loadUser() {
        const data = await api(config.api.me);
        state.user = data.user;
        state.csrfToken = data.csrfToken || null;
        notify();
        return state.user;
    }

    function renderMount(mount) {
        mount.innerHTML = '';
        if (state.user) {
            const email = document.createElement('span');
            email.className = 'auth-email';
            email.textContent = state.user.nickname || state.user.email;
            email.title = state.user.email;

            if (state.user.isAdmin) {
                const admin = document.createElement('a');
                admin.className = 'nav-item auth-action active';
                admin.href = 'admin.html';
                admin.textContent = '后台';
                mount.appendChild(admin);
            }

            const logout = document.createElement('button');
            logout.className = 'nav-item auth-action';
            logout.type = 'button';
            logout.textContent = '退出';
            logout.addEventListener('click', async () => {
                try {
                    await api(config.api.logout, { method: 'POST', body: '{}' });
                } finally {
                    state.user = null;
                    state.csrfToken = null;
                    notify();
                }
            });
            mount.append(email, logout);
            return;
        }

        const login = document.createElement('button');
        login.className = 'nav-item auth-action';
        login.type = 'button';
        login.textContent = '登录';
        login.addEventListener('click', () => openModal('login'));

        const register = document.createElement('button');
        register.className = 'nav-item auth-action active';
        register.type = 'button';
        register.textContent = '注册';
        register.addEventListener('click', () => openModal('register'));
        mount.append(login, register);
    }

    function mountHeaderAuth() {
        const mount = document.getElementById('auth-area');
        if (!mount) return;
        state.listeners.push(() => renderMount(mount));
        renderMount(mount);
    }

    state.ready = loadUser().catch(() => {
        state.user = null;
        state.csrfToken = null;
        notify();
        return null;
    });

    document.addEventListener('DOMContentLoaded', mountHeaderAuth);

    window.AuthUI = {
        get user() {
            return state.user;
        },
        get csrfToken() {
            return state.csrfToken;
        },
        api,
        ready: state.ready,
        onChange(listener) {
            state.listeners.push(listener);
            listener(state.user);
        },
        open: openModal
    };
})();
