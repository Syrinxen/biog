const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const tls = require('tls');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'blog.sqlite');
const smtpConfigPath = path.join(dataDir, 'smtp.json');
const articlesPath = path.join(publicDir, 'articles.json');
const sessionCookieName = 'haooah_session';
const sessionDays = 30;
const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || '');
let articleIndexCache = { mtimeMs: 0, ids: new Set() };
const captchaChallenges = new Map();
const captchaTtlMs = 5 * 60 * 1000;

const limits = new Map();
const rateWindows = {
    auth: { windowMs: 15 * 60 * 1000, max: 20 },
    captcha: { windowMs: 15 * 60 * 1000, max: 60 },
    emailCode: { windowMs: 15 * 60 * 1000, max: 8 },
    write: { windowMs: 60 * 1000, max: 30 },
    admin: { windowMs: 60 * 1000, max: 120 }
};

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
});

app.use(express.json({ limit: '32kb', type: 'application/json' }));

function sqlString(value) {
    if (value === null || value === undefined) return 'NULL';
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function sqlite(sql, json = false) {
    const args = ['-cmd', '.timeout 5000', dbPath, sql];
    const { stdout } = await execFileAsync('sqlite3', args, { maxBuffer: 1024 * 1024 });
    if (!json) return [];
    const trimmed = stdout.trim();
    return trimmed ? trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line)) : [];
}

async function initDatabase() {
    fs.mkdirSync(dataDir, { recursive: true });
    await sqlite(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS email_verification_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            expires_at TEXT NOT NULL,
            used_at TEXT,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_comments_article_created ON comments(article_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_verification_codes(email, expires_at);
    `);
    await addColumnIfMissing('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing('users', 'disabled_at', 'TEXT');
    await addColumnIfMissing('users', 'nickname', 'TEXT');
    await addColumnIfMissing('users', 'nickname_key', 'TEXT');
    await addColumnIfMissing('sessions', 'csrf_token', 'TEXT');
    await addColumnIfMissing('comments', 'deleted_at', 'TEXT');
    await addColumnIfMissing('email_verification_codes', 'purpose', "TEXT NOT NULL DEFAULT 'register'");
    await sqlite(`
        UPDATE users
        SET nickname = '用户' || id
        WHERE nickname IS NULL OR TRIM(nickname) = '';
        UPDATE users
        SET nickname_key = lower(nickname)
        WHERE nickname_key IS NULL OR TRIM(nickname_key) = '';
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_key ON users(nickname_key);
        CREATE INDEX IF NOT EXISTS idx_comments_deleted ON comments(deleted_at);
    `);
    if (adminEmail) {
        await sqlite(`UPDATE users SET is_admin = 1 WHERE email = ${sqlString(adminEmail)};`);
    }
}

async function addColumnIfMissing(table, column, definition) {
    const rows = await sqlite(`SELECT json_object('name', name) FROM pragma_table_info(${sqlString(table)});`, true).catch(() => []);
    if (rows.some((row) => row.name === column)) return;
    await sqlite(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function parseCookies(cookieHeader) {
    return String(cookieHeader || '').split(';').reduce((cookies, item) => {
        const index = item.indexOf('=');
        if (index === -1) return cookies;
        const key = item.slice(0, index).trim();
        const value = item.slice(index + 1).trim();
        if (!key) return cookies;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (_error) {
            cookies[key] = value;
        }
        return cookies;
    }, {});
}

function createToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return `pbkdf2_sha256$310000$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
    const [algorithm, iterations, salt, expected] = String(storedHash || '').split('$');
    if (algorithm !== 'pbkdf2_sha256' || !iterations || !salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function hashVerificationCode(email, code, purpose = 'register') {
    return crypto.createHash('sha256').update(`${purpose}:${normalizeEmail(email)}:${String(code)}`).digest('hex');
}

function loadSmtpConfig() {
    const fallback = {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM || process.env.SMTP_USER
    };
    if (fs.existsSync(smtpConfigPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(smtpConfigPath, 'utf8'));
        return {
            host: fileConfig.host || fallback.host,
            port: Number(fileConfig.port || fallback.port || 465),
            user: fileConfig.user || fallback.user,
            pass: fileConfig.pass || fallback.pass,
            from: fileConfig.from || fileConfig.user || fallback.from
        };
    }
    return fallback;
}

function encodeMailHeader(value) {
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function createSmtpClient(config) {
    const socket = tls.connect({
        host: config.host,
        port: config.port,
        servername: config.host,
        rejectUnauthorized: true
    });
    socket.setEncoding('utf8');

    let buffer = '';
    const waitFor = (expectedCodes) => new Promise((resolve, reject) => {
        const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('SMTP 连接超时'));
        }, 15000);

        function cleanup() {
            clearTimeout(timeout);
            socket.off('data', onData);
            socket.off('error', onError);
        }

        function onError(error) {
            cleanup();
            reject(error);
        }

        function onData(chunk) {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/).filter(Boolean);
            const lastLine = lines[lines.length - 1] || '';
            const match = lastLine.match(/^(\d{3})([ -])/);
            if (!match || match[2] !== ' ') return;
            const code = Number(match[1]);
            if (!codes.includes(code)) {
                cleanup();
                reject(new Error(`SMTP 返回异常: ${lastLine}`));
                return;
            }
            buffer = '';
            cleanup();
            resolve(lastLine);
        }

        socket.on('data', onData);
        socket.on('error', onError);
    });

    const command = async (line, expectedCodes) => {
        socket.write(`${line}\r\n`);
        return waitFor(expectedCodes);
    };

    return { socket, waitFor, command };
}

async function sendVerificationEmail(email, code, purpose = 'register') {
    const config = loadSmtpConfig();
    if (!config.host || !config.user || !config.pass || !config.from) {
        throw new Error('SMTP 未配置');
    }

    const client = createSmtpClient(config);
    try {
        await client.waitFor(220);
        await client.command(`EHLO ${config.host}`, 250);
        await client.command('AUTH LOGIN', 334);
        await client.command(Buffer.from(config.user).toString('base64'), 334);
        await client.command(Buffer.from(config.pass).toString('base64'), 235);
        await client.command(`MAIL FROM:<${config.from}>`, 250);
        await client.command(`RCPT TO:<${email}>`, [250, 251]);
        await client.command('DATA', 354);

        const isReset = purpose === 'reset';
        const subject = encodeMailHeader(isReset ? 'HaooaH Code 重置密码验证码' : 'HaooaH Code 注册验证码');
        const body = [
            `您的${isReset ? '重置密码' : '注册'}验证码是：${code}`,
            '',
            '验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。'
        ].join('\r\n');
        const message = [
            `From: ${encodeMailHeader('HaooaH Code')} <${config.from}>`,
            `To: <${email}>`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            body.replace(/^\./gm, '..'),
            '.'
        ].join('\r\n');

        client.socket.write(`${message}\r\n`);
        await client.waitFor(250);
        await client.command('QUIT', 221).catch(() => {});
    } finally {
        client.socket.end();
    }
}

function setSessionCookie(req, res, token) {
    const maxAge = sessionDays * 24 * 60 * 60;
    const forwardedProto = req.get('x-forwarded-proto') || req.get('x-scheme');
    const secure = req.secure || forwardedProto === 'https';
    res.cookie(sessionCookieName, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/',
        maxAge: maxAge * 1000
    });
}

function clearSessionCookie(res) {
    res.clearCookie(sessionCookieName, { httpOnly: true, sameSite: 'lax', path: '/' });
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function normalizeNickname(nickname) {
    return String(nickname || '').trim().replace(/\s+/g, ' ');
}

function nicknameKey(nickname) {
    return normalizeNickname(nickname).toLowerCase();
}

function validateNickname(nickname) {
    const normalized = normalizeNickname(nickname);
    return normalized.length >= 2 &&
        normalized.length <= 20 &&
        /^[\p{L}\p{N}_ -]+$/u.test(normalized);
}

function validateArticleId(articleId) {
    return /^[a-zA-Z0-9_-]{1,120}$/.test(articleId);
}

function loadArticleIds() {
    const stat = fs.statSync(articlesPath);
    if (articleIndexCache.mtimeMs === stat.mtimeMs) return articleIndexCache.ids;

    const articles = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
    const ids = new Set();
    if (Array.isArray(articles)) {
        articles.forEach((article) => {
            if (article && validateArticleId(String(article.id || ''))) {
                ids.add(String(article.id));
            }
        });
    }
    articleIndexCache = { mtimeMs: stat.mtimeMs, ids };
    return ids;
}

function articleExists(articleId) {
    try {
        return loadArticleIds().has(articleId);
    } catch (error) {
        console.error('文章索引读取失败:', error);
        return false;
    }
}

function normalizeOrigin(value) {
    if (!value) return null;
    try {
        const url = new URL(value.includes('://') ? value : `http://${value}`);
        const isDefaultPort = (url.protocol === 'https:' && url.port === '443') ||
            (url.protocol === 'http:' && url.port === '80');
        return `${url.protocol}//${url.hostname}${isDefaultPort || !url.port ? '' : `:${url.port}`}`;
    } catch (_error) {
        return null;
    }
}

function isSameOrigin(req) {
    const origin = normalizeOrigin(req.get('origin'));
    if (!origin) return true;
    const forwardedProto = req.get('x-forwarded-proto') || req.get('x-scheme') || req.protocol;
    const hosts = [
        req.get('host'),
        req.get('x-forwarded-host'),
        req.get('x-host')
    ].filter(Boolean);
    return hosts.some((host) => {
        const current = normalizeOrigin(`${forwardedProto}://${host}`);
        const http = normalizeOrigin(`http://${host}`);
        const https = normalizeOrigin(`https://${host}`);
        return origin === current || origin === http || origin === https;
    });
}

function requireSameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!isSameOrigin(req)) return res.status(403).json({ error: '请求来源无效' });
    return next();
}

function rateLimit(name) {
    const rule = rateWindows[name];
    return (req, res, next) => {
        const key = `${name}:${req.ip}`;
        const now = Date.now();
        const current = limits.get(key);
        if (!current || current.resetAt <= now) {
            limits.set(key, { count: 1, resetAt: now + rule.windowMs });
            return next();
        }
        current.count += 1;
        if (current.count > rule.max) {
            return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
        }
        return next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of limits) {
        if (value.resetAt <= now) limits.delete(key);
    }
    for (const [token, challenge] of captchaChallenges) {
        if (challenge.expiresAt <= now) captchaChallenges.delete(token);
    }
}, 5 * 60 * 1000).unref();

function captchaShapeMarkup(shape, accent) {
    if (shape === 'circle') return `<circle cx="80" cy="54" r="26" fill="${accent}"/>`;
    if (shape === 'triangle') return `<path d="M80 24 L112 82 H48 Z" fill="${accent}"/>`;
    if (shape === 'square') return `<rect x="54" y="28" width="52" height="52" rx="4" fill="${accent}"/>`;
    if (shape === 'star') return `<path d="M80 22 L90 44 L114 47 L96 63 L101 86 L80 74 L59 86 L64 63 L46 47 L70 44 Z" fill="${accent}"/>`;
    if (shape === 'heart') return `<path d="M80 84 C38 54 50 24 72 31 C76 32 79 35 80 38 C81 35 84 32 88 31 C110 24 122 54 80 84 Z" fill="${accent}"/>`;
    return `<path d="M95 26 C73 30 58 48 62 66 C66 84 86 92 105 82 C91 80 80 69 80 54 C80 41 86 31 95 26 Z" fill="${accent}"/>`;
}

function createCaptchaSvg(shape, accent) {
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 108">
            <rect width="160" height="108" rx="10" fill="#f8fafc"/>
            <path d="M0 86 C34 66 52 98 86 78 S128 52 160 70 V108 H0Z" fill="${accent}" opacity="0.18"/>
            <circle cx="32" cy="28" r="13" fill="${accent}" opacity="0.28"/>
            ${captchaShapeMarkup(shape, accent)}
        </svg>
    `.replace(/\s+/g, ' ').trim();
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function createCaptchaChallenge() {
    const items = [
        { id: 'circle', label: '圆形', accent: '#0066ff' },
        { id: 'triangle', label: '三角形', accent: '#00a6b2' },
        { id: 'square', label: '方形', accent: '#44a36f' },
        { id: 'star', label: '星形', accent: '#d99a00' },
        { id: 'heart', label: '心形', accent: '#d94b6a' },
        { id: 'moon', label: '月亮', accent: '#6f65d8' }
    ];
    const target = items[crypto.randomInt(0, items.length)];
    const token = createToken(24);
    let answer = '';
    const shuffled = items
        .map((item) => ({ item, sort: crypto.randomInt(0, 1000000) }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ item }) => {
            const choiceId = createToken(8);
            if (item.id === target.id) answer = choiceId;
            return {
                id: choiceId,
                label: '验证图片',
                image: createCaptchaSvg(item.id, item.accent)
            };
        });
    captchaChallenges.set(token, {
        answer,
        expiresAt: Date.now() + captchaTtlMs
    });
    return {
        token,
        prompt: `请点击“${target.label}”图片`,
        choices: shuffled
    };
}

function verifyCaptcha(token, choice) {
    const challenge = captchaChallenges.get(String(token || ''));
    if (!challenge) return false;
    captchaChallenges.delete(String(token || ''));
    return challenge.expiresAt > Date.now() && challenge.answer === String(choice || '');
}

async function createSession(req, res, userId) {
    const token = createToken(32);
    const csrfToken = createToken(24);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
    await sqlite(`
        INSERT INTO sessions (token_hash, user_id, expires_at, csrf_token)
        VALUES (${sqlString(tokenHash)}, ${Number(userId)}, ${sqlString(expiresAt)}, ${sqlString(csrfToken)});
    `);
    setSessionCookie(req, res, token);
    return csrfToken;
}

async function getCurrentUser(req) {
    const token = parseCookies(req.headers.cookie)[sessionCookieName];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const rows = await sqlite(`
        SELECT json_object(
            'id', users.id,
            'email', users.email,
            'nickname', users.nickname,
            'isAdmin', users.is_admin,
            'disabledAt', users.disabled_at,
            'expires_at', sessions.expires_at,
            'csrfToken', sessions.csrf_token
        )
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ${sqlString(tokenHash)}
        LIMIT 1;
    `, true);
    const user = rows[0];
    if (!user) return null;
    if (new Date(user.expires_at).getTime() <= Date.now() || user.disabledAt) {
        await sqlite(`DELETE FROM sessions WHERE token_hash = ${sqlString(tokenHash)};`);
        return null;
    }
    if (!user.csrfToken) {
        user.csrfToken = createToken(24);
        await sqlite(`UPDATE sessions SET csrf_token = ${sqlString(user.csrfToken)} WHERE token_hash = ${sqlString(tokenHash)};`);
    }
    return {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        isAdmin: Boolean(user.isAdmin),
        csrfToken: user.csrfToken,
        tokenHash
    };
}

async function requireUser(req, res, next) {
    try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: '请先登录' });
        req.user = user;
        return next();
    } catch (error) {
        return next(error);
    }
}

function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sent = req.get('x-csrf-token') || '';
    if (!req.user?.csrfToken || sent !== req.user.csrfToken) {
        return res.status(403).json({ error: '安全校验失败，请刷新页面后重试' });
    }
    return next();
}

function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
    return next();
}

function publicUser(user) {
    if (!user) return null;
    return { id: user.id, email: user.email, nickname: user.nickname || user.email, isAdmin: Boolean(user.isAdmin) };
}

app.use('/api', requireSameOrigin);

app.get('/api/auth/me', async (req, res, next) => {
    try {
        const user = await getCurrentUser(req);
        res.json({ user: publicUser(user), csrfToken: user?.csrfToken || null });
    } catch (error) {
        next(error);
    }
});

app.get('/api/auth/captcha', rateLimit('captcha'), (_req, res) => {
    res.json(createCaptchaChallenge());
});

app.post('/api/auth/send-code', rateLimit('emailCode'), async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body.email);
        if (!validateEmail(email)) return res.status(400).json({ error: '请输入有效邮箱' });

        const existing = await sqlite(`SELECT json_object('id', id) FROM users WHERE email = ${sqlString(email)} LIMIT 1;`, true);
        if (existing.length > 0) return res.status(409).json({ error: '该邮箱已注册' });

        const recent = await sqlite(`
            SELECT json_object('count', COUNT(*))
            FROM email_verification_codes
            WHERE email = ${sqlString(email)}
              AND purpose = 'register'
              AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute');
        `, true);
        if ((recent[0]?.count || 0) > 0) {
            return res.status(429).json({ error: '验证码发送过于频繁，请稍后再试' });
        }

        const code = String(crypto.randomInt(100000, 1000000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await sqlite(`
            INSERT INTO email_verification_codes (email, code_hash, expires_at, purpose)
            VALUES (${sqlString(email)}, ${sqlString(hashVerificationCode(email, code, 'register'))}, ${sqlString(expiresAt)}, 'register');
            DELETE FROM email_verification_codes
            WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
               OR used_at IS NOT NULL;
        `);

        await sendVerificationEmail(email, code, 'register');
        res.json({ ok: true, message: '验证码已发送' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/send-reset-code', rateLimit('emailCode'), async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body.email);
        if (!validateEmail(email)) return res.status(400).json({ error: '请输入有效邮箱' });

        const existing = await sqlite(`
            SELECT json_object('id', id)
            FROM users
            WHERE email = ${sqlString(email)}
              AND disabled_at IS NULL
            LIMIT 1;
        `, true);
        if (existing.length === 0) {
            return res.status(404).json({ error: '该邮箱未注册或账号已注销' });
        }

        const recent = await sqlite(`
            SELECT json_object('count', COUNT(*))
            FROM email_verification_codes
            WHERE email = ${sqlString(email)}
              AND purpose = 'reset'
              AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute');
        `, true);
        if ((recent[0]?.count || 0) > 0) {
            return res.status(429).json({ error: '验证码发送过于频繁，请稍后再试' });
        }

        const code = String(crypto.randomInt(100000, 1000000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await sqlite(`
            INSERT INTO email_verification_codes (email, code_hash, expires_at, purpose)
            VALUES (${sqlString(email)}, ${sqlString(hashVerificationCode(email, code, 'reset'))}, ${sqlString(expiresAt)}, 'reset');
        `);

        await sendVerificationEmail(email, code, 'reset');
        res.json({ ok: true, message: '验证码已发送' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/reset-password', rateLimit('auth'), async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || '');
        const code = String(req.body.code || '').trim();
        if (!validateEmail(email)) return res.status(400).json({ error: '请输入有效邮箱' });
        if (password.length < 10 || password.length > 128) {
            return res.status(400).json({ error: '密码长度需要 10 到 128 位' });
        }
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: '请输入 6 位邮箱验证码' });
        }

        const userRows = await sqlite(`
            SELECT json_object('id', id)
            FROM users
            WHERE email = ${sqlString(email)}
              AND disabled_at IS NULL
            LIMIT 1;
        `, true);
        const user = userRows[0];
        if (!user) return res.status(404).json({ error: '该邮箱未注册或账号已注销' });

        const codeRows = await sqlite(`
            SELECT json_object('id', id, 'codeHash', code_hash, 'attempts', attempts, 'expiresAt', expires_at)
            FROM email_verification_codes
            WHERE email = ${sqlString(email)}
              AND purpose = 'reset'
              AND used_at IS NULL
            ORDER BY id DESC
            LIMIT 1;
        `, true);
        const codeRecord = codeRows[0];
        if (!codeRecord || new Date(codeRecord.expiresAt).getTime() <= Date.now() || codeRecord.attempts >= 5) {
            return res.status(400).json({ error: '验证码无效或已过期' });
        }
        if (codeRecord.codeHash !== hashVerificationCode(email, code, 'reset')) {
            await sqlite(`UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ${Number(codeRecord.id)};`);
            return res.status(400).json({ error: '验证码错误' });
        }

        await sqlite(`
            UPDATE users SET password_hash = ${sqlString(createPasswordHash(password))} WHERE id = ${Number(user.id)};
            UPDATE email_verification_codes
            SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ${Number(codeRecord.id)};
            DELETE FROM sessions WHERE user_id = ${Number(user.id)};
        `);
        clearSessionCookie(res);
        res.json({ ok: true, message: '密码已重置，请重新登录' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/register', rateLimit('auth'), async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body.email);
        const nickname = normalizeNickname(req.body.nickname);
        const password = String(req.body.password || '');
        const code = String(req.body.code || '').trim();
        const captchaToken = String(req.body.captchaToken || '');
        const captchaChoice = String(req.body.captchaChoice || '');
        if (!validateEmail(email)) return res.status(400).json({ error: '请输入有效邮箱' });
        if (!validateNickname(nickname)) {
            return res.status(400).json({ error: '昵称需要 2 到 20 位，可使用中文、字母、数字、空格、下划线或连字符' });
        }
        if (password.length < 10 || password.length > 128) {
            return res.status(400).json({ error: '密码长度需要 10 到 128 位' });
        }
        if (!/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: '请输入 6 位邮箱验证码' });
        }
        if (!verifyCaptcha(captchaToken, captchaChoice)) {
            return res.status(400).json({ error: '图片验证失败，请重试' });
        }

        const nicknameRows = await sqlite(`
            SELECT json_object('id', id)
            FROM users
            WHERE nickname_key = ${sqlString(nicknameKey(nickname))}
            LIMIT 1;
        `, true);
        if (nicknameRows.length > 0) return res.status(409).json({ error: '该昵称已被使用' });

        const codeRows = await sqlite(`
            SELECT json_object('id', id, 'codeHash', code_hash, 'attempts', attempts, 'expiresAt', expires_at)
            FROM email_verification_codes
            WHERE email = ${sqlString(email)}
              AND purpose = 'register'
              AND used_at IS NULL
            ORDER BY id DESC
            LIMIT 1;
        `, true);
        const codeRecord = codeRows[0];
        if (!codeRecord || new Date(codeRecord.expiresAt).getTime() <= Date.now() || codeRecord.attempts >= 5) {
            return res.status(400).json({ error: '验证码无效或已过期' });
        }
        if (codeRecord.codeHash !== hashVerificationCode(email, code, 'register')) {
            await sqlite(`UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ${Number(codeRecord.id)};`);
            return res.status(400).json({ error: '验证码错误' });
        }

        const countRows = await sqlite(`SELECT json_object('count', COUNT(*), 'admins', COALESCE(SUM(is_admin), 0)) FROM users;`, true);
        const shouldAdmin = (countRows[0]?.count === 0) || (countRows[0]?.admins === 0) || (adminEmail && email === adminEmail);
        const passwordHash = createPasswordHash(password);
        await sqlite(`
            INSERT INTO users (email, nickname, nickname_key, password_hash, is_admin)
            VALUES (${sqlString(email)}, ${sqlString(nickname)}, ${sqlString(nicknameKey(nickname))}, ${sqlString(passwordHash)}, ${shouldAdmin ? 1 : 0});
            UPDATE email_verification_codes
            SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ${Number(codeRecord.id)};
        `);
        const rows = await sqlite(`SELECT json_object('id', id, 'email', email, 'nickname', nickname, 'isAdmin', is_admin) FROM users WHERE email = ${sqlString(email)} LIMIT 1;`, true);
        const csrfToken = await createSession(req, res, rows[0].id);
        res.status(201).json({ user: publicUser(rows[0]), csrfToken });
    } catch (error) {
        if (String(error.message || '').includes('UNIQUE constraint failed')) {
            const message = String(error.message || '').includes('nickname') ? '该昵称已被使用' : '该邮箱已注册';
            return res.status(409).json({ error: message });
        }
        next(error);
    }
});

app.post('/api/auth/login', rateLimit('auth'), async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || '');
        if (adminEmail && email === adminEmail) {
            await sqlite(`UPDATE users SET is_admin = 1 WHERE email = ${sqlString(email)};`);
        }
        const rows = await sqlite(`
            SELECT json_object('id', id, 'email', email, 'nickname', nickname, 'password_hash', password_hash, 'isAdmin', is_admin, 'disabledAt', disabled_at)
            FROM users
            WHERE email = ${sqlString(email)}
            LIMIT 1;
        `, true);
        const user = rows[0];
        if (!user || user.disabledAt || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }
        const csrfToken = await createSession(req, res, user.id);
        res.json({ user: publicUser(user), csrfToken });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/logout', async (req, res, next) => {
    try {
        const token = parseCookies(req.headers.cookie)[sessionCookieName];
        if (token) {
            await sqlite(`DELETE FROM sessions WHERE token_hash = ${sqlString(hashToken(token))};`);
        }
        clearSessionCookie(res);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/comments', async (req, res, next) => {
    try {
        const articleId = String(req.query.articleId || '').trim();
        if (!validateArticleId(articleId)) {
            return res.status(400).json({ error: '缺少文章 ID' });
        }
        if (!articleExists(articleId)) return res.status(404).json({ error: '文章不存在' });
        const comments = await sqlite(`
            SELECT json_object(
                'id', comments.id,
                'articleId', comments.article_id,
                'body', comments.body,
                'createdAt', comments.created_at,
                'authorEmail', users.email,
                'authorNickname', users.nickname
            )
            FROM comments
            JOIN users ON users.id = comments.user_id
            WHERE comments.article_id = ${sqlString(articleId)}
              AND comments.deleted_at IS NULL
            ORDER BY comments.created_at DESC, comments.id DESC
            LIMIT 100;
        `, true);
        res.json({ comments });
    } catch (error) {
        next(error);
    }
});

app.post('/api/comments', rateLimit('write'), requireUser, requireCsrf, async (req, res, next) => {
    try {
        const articleId = String(req.body.articleId || '').trim();
        const body = String(req.body.body || '').trim();
        if (!validateArticleId(articleId)) {
            return res.status(400).json({ error: '缺少文章 ID' });
        }
        if (!articleExists(articleId)) return res.status(404).json({ error: '文章不存在' });
        if (!body || body.length > 2000) {
            return res.status(400).json({ error: '评论内容需要 1 到 2000 字' });
        }
        await sqlite(`
            INSERT INTO comments (article_id, user_id, body)
            VALUES (${sqlString(articleId)}, ${Number(req.user.id)}, ${sqlString(body)});
        `);
        const rows = await sqlite(`
            SELECT json_object(
                'id', comments.id,
                'articleId', comments.article_id,
                'body', comments.body,
                'createdAt', comments.created_at,
                'authorEmail', users.email,
                'authorNickname', users.nickname
            )
            FROM comments
            JOIN users ON users.id = comments.user_id
            WHERE comments.article_id = ${sqlString(articleId)}
              AND comments.user_id = ${Number(req.user.id)}
              AND comments.deleted_at IS NULL
            ORDER BY comments.id DESC
            LIMIT 1;
        `, true);
        res.status(201).json({ comment: rows[0] });
    } catch (error) {
        next(error);
    }
});

app.use('/api/admin', rateLimit('admin'), requireUser, requireCsrf, requireAdmin);

app.get('/api/admin/summary', async (_req, res, next) => {
    try {
        const rows = await sqlite(`
            SELECT json_object(
                'users', (SELECT COUNT(*) FROM users WHERE disabled_at IS NULL),
                'disabledUsers', (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL),
                'comments', (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL),
                'deletedComments', (SELECT COUNT(*) FROM comments WHERE deleted_at IS NOT NULL)
            );
        `, true);
        res.json({ summary: rows[0] || {} });
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/users', async (_req, res, next) => {
    try {
        const users = await sqlite(`
            SELECT json_object(
                'id', users.id,
                'email', users.email,
                'nickname', users.nickname,
                'isAdmin', users.is_admin,
                'disabledAt', users.disabled_at,
                'createdAt', users.created_at,
                'commentCount', (SELECT COUNT(*) FROM comments WHERE comments.user_id = users.id AND comments.deleted_at IS NULL)
            )
            FROM users
            ORDER BY users.created_at DESC, users.id DESC
            LIMIT 200;
        `, true);
        res.json({ users });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/admin/users/:id', async (req, res, next) => {
    try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: '用户 ID 无效' });
        if (userId === Number(req.user.id)) return res.status(400).json({ error: '不能注销当前管理员账号' });
        await sqlite(`
            UPDATE users SET disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${userId};
            DELETE FROM sessions WHERE user_id = ${userId};
        `);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.patch('/api/admin/users/:id/admin', async (req, res, next) => {
    try {
        const userId = Number(req.params.id);
        const isAdmin = req.body.isAdmin ? 1 : 0;
        if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: '用户 ID 无效' });
        if (userId === Number(req.user.id) && !isAdmin) return res.status(400).json({ error: '不能取消当前管理员权限' });
        await sqlite(`UPDATE users SET is_admin = ${isAdmin} WHERE id = ${userId} AND disabled_at IS NULL;`);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/comments', async (req, res, next) => {
    try {
        const includeDeleted = req.query.includeDeleted === '1';
        const comments = await sqlite(`
            SELECT json_object(
                'id', comments.id,
                'articleId', comments.article_id,
                'body', comments.body,
                'createdAt', comments.created_at,
                'deletedAt', comments.deleted_at,
                'authorEmail', users.email,
                'authorNickname', users.nickname,
                'userId', users.id
            )
            FROM comments
            JOIN users ON users.id = comments.user_id
            ${includeDeleted ? '' : 'WHERE comments.deleted_at IS NULL'}
            ORDER BY comments.created_at DESC, comments.id DESC
            LIMIT 200;
        `, true);
        res.json({ comments });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/admin/comments/:id', async (req, res, next) => {
    try {
        const commentId = Number(req.params.id);
        if (!Number.isInteger(commentId) || commentId <= 0) return res.status(400).json({ error: '评论 ID 无效' });
        await sqlite(`UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${commentId};`);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.use(express.static(publicDir, {
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('articles.json')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
});

app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: '服务器暂时不可用' });
});

initDatabase()
    .then(() => {
        app.listen(port, '0.0.0.0', () => {
            console.log(`Haooah Code 博客后端已启动，运行端口：${port}`);
        });
    })
    .catch((error) => {
        console.error('数据库初始化失败:', error);
        process.exit(1);
    });
