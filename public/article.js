document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('article-container');
    const urlParams = new URLSearchParams(window.location.search);
    const articleId = urlParams.get('id');

    function renderMessage(title, detail = '') {
        container.innerHTML = `
            <div class="loading">
                <strong>${config.utils.escapeHtml(title)}</strong>
                ${detail ? `<p>${config.utils.escapeHtml(detail)}</p>` : ''}
            </div>
        `;
    }

    function addCopyButtons() {
        const blocks = container.querySelectorAll('pre');
        blocks.forEach((block) => {
            const code = block.querySelector('code');
            if (!code) return;

            const button = document.createElement('button');
            button.className = 'copy-btn';
            button.type = 'button';
            button.textContent = '复制';
            button.setAttribute('aria-label', '复制代码');
            button.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(code.textContent || '');
                    button.textContent = '已复制';
                    window.setTimeout(() => {
                        button.textContent = '复制';
                    }, 1600);
                } catch (_) {
                    button.textContent = '失败';
                    window.setTimeout(() => {
                        button.textContent = '复制';
                    }, 1600);
                }
            });

            block.appendChild(button);
        });
    }

    function createRenderer() {
        const renderer = new marked.Renderer();
        renderer.image = ({ href, title, text }) => {
            let src = href || '';
            if (src && !src.startsWith('http') && !src.startsWith('/')) {
                src = `posts/${src}`;
            }

            const safeText = config.utils.escapeHtml(text || '');
            const caption = text ? `<figcaption>${safeText}</figcaption>` : '';
            return `
                <figure>
                    <img src="${config.utils.escapeHtml(src)}" alt="${safeText}" title="${config.utils.escapeHtml(title || '')}" loading="lazy" decoding="async">
                    ${caption}
                </figure>
            `;
        };
        return renderer;
    }

    function generateTOC() {
        const headers = container.querySelectorAll('h2, h3');
        const toc = document.getElementById('toc-container');
        if (!toc) return;

        if (headers.length === 0) {
            toc.style.display = 'none';
            return;
        }

        toc.style.display = 'block';
        toc.innerHTML = '<h4>目录</h4>';
        headers.forEach((header, index) => {
            const id = `header-${index}`;
            header.id = id;

            const link = document.createElement('a');
            link.href = `#${id}`;
            link.textContent = header.textContent;
            link.className = `toc-link toc-${header.tagName.toLowerCase()}`;
            toc.appendChild(link);
        });
    }

    function renderArticleInfo(markdown) {
        const wordCount = markdown.replace(/\s/g, '').length;
        const readingTime = Math.max(1, Math.ceil(wordCount / 400));
        return `<span class="reading-time">约 ${wordCount} 字 | 预计阅读 ${readingTime} 分钟</span>`;
    }

    function formatCommentDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function renderComments(comments = []) {
        const list = document.getElementById('comment-list');
        if (!list) return;
        list.innerHTML = '';

        if (comments.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'comment-empty';
            empty.textContent = '还没有评论。';
            list.appendChild(empty);
            return;
        }

        comments.forEach((comment) => {
            const item = document.createElement('article');
            item.className = 'comment-item';

            const meta = document.createElement('div');
            meta.className = 'comment-meta';

            const author = document.createElement('strong');
            author.textContent = comment.authorNickname || comment.authorEmail || '匿名用户';
            if (comment.authorEmail) author.title = comment.authorEmail;

            const time = document.createElement('time');
            time.dateTime = comment.createdAt || '';
            time.textContent = formatCommentDate(comment.createdAt);

            const body = document.createElement('p');
            body.className = 'comment-body';
            body.textContent = comment.body || '';

            meta.append(author, time);
            item.append(meta, body);
            list.appendChild(item);
        });
    }

    function updateCommentFormForUser(user) {
        const form = document.getElementById('comment-form');
        const guest = document.getElementById('comment-guest');
        if (!form || !guest) return;
        form.hidden = !user;
        guest.hidden = Boolean(user);
    }

    async function loadComments() {
        const list = document.getElementById('comment-list');
        if (!list) return;
        list.innerHTML = '<div class="comment-empty">正在加载评论</div>';
        try {
            const response = await fetch(`${config.api.comments}?articleId=${encodeURIComponent(articleId)}`, {
                credentials: 'same-origin'
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '评论加载失败');
            renderComments(data.comments || []);
        } catch (error) {
            list.innerHTML = `<div class="comment-empty">${config.utils.escapeHtml(error.message)}</div>`;
        }
    }

    function initComments() {
        const form = document.getElementById('comment-form');
        const textarea = document.getElementById('comment-body');
        const status = document.getElementById('comment-status');
        const loginButton = document.getElementById('comment-login');
        const registerButton = document.getElementById('comment-register');

        AuthUI?.onChange(updateCommentFormForUser);
        loginButton?.addEventListener('click', () => AuthUI?.open('login'));
        registerButton?.addEventListener('click', () => AuthUI?.open('register'));

        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            const body = (textarea.value || '').trim();
            if (!body) return;

            status.textContent = '';
            form.querySelector('button[type="submit"]').disabled = true;
            try {
                const response = await fetch(config.api.comments, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': AuthUI?.csrfToken || ''
                    },
                    body: JSON.stringify({ articleId, body })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || '评论发布失败');
                textarea.value = '';
                await loadComments();
            } catch (error) {
                status.textContent = error.message;
            } finally {
                form.querySelector('button[type="submit"]').disabled = false;
            }
        });

        AuthUI?.ready?.then(updateCommentFormForUser);
        loadComments();
    }

    async function loadArticle() {
        if (!articleId) {
            renderMessage('缺少文章 ID');
            return;
        }

        try {
            const listResponse = await fetch(config.api.articles);
            if (!listResponse.ok) {
                throw new Error(`HTTP ${listResponse.status}`);
            }

            const articles = await listResponse.json();
            const article = articles.find((item) => String(item.id) === articleId);

            if (!article || !article.path) {
                renderMessage('没有找到对应文章');
                return;
            }

            const contentResponse = await fetch(article.path);
            if (!contentResponse.ok) {
                throw new Error(`正文加载失败: HTTP ${contentResponse.status}`);
            }

            const markdown = await contentResponse.text();
            const renderer = createRenderer();
            const rawHtml = marked.parse(markdown, {
                renderer,
                breaks: true,
                gfm: true
            });
            const html = DOMPurify.sanitize(rawHtml);
            const tags = (article.modules || [])
                .map((tag) => `<span class="tag">${config.utils.escapeHtml(tag)}</span>`)
                .join('');
            const articleInfo = renderArticleInfo(markdown);

            document.title = `${article.title} - HaooaH Code`;
            const metaDescription = document.querySelector('meta[name="description"]');
            if (metaDescription) {
                metaDescription.setAttribute('content', article.excerpt || `${article.title} - HaooaH Code`);
            }

            container.innerHTML = `
                <div class="article-header">
                    <a class="back-btn" href="index.html">返回文章列表</a>
                    <h1 class="article-title">${config.utils.escapeHtml(article.title)}</h1>
                    <div class="article-meta">
                        ${tags}
                        <time class="date" datetime="${config.utils.escapeHtml(article.date)}">${config.utils.escapeHtml(article.date)}</time>
                    </div>
                    <div class="article-info">
                        ${articleInfo}
                    </div>
                </div>
                <div class="markdown-body">
                    ${html}
                </div>
                <section class="comments-section" aria-labelledby="comments-title">
                    <h2 id="comments-title">评论</h2>
                    <div id="comment-guest" class="comment-gate">
                        <span>登录后可评论</span>
                        <button id="comment-login" class="comment-link" type="button">登录</button>
                        <button id="comment-register" class="comment-link" type="button">注册</button>
                    </div>
                    <form id="comment-form" class="comment-form" hidden>
                        <textarea id="comment-body" name="body" maxlength="2000" rows="5" placeholder="写下你的想法" required></textarea>
                        <div class="comment-form-footer">
                            <p id="comment-status" class="comment-status" role="alert"></p>
                            <button type="submit">发布评论</button>
                        </div>
                    </form>
                    <div id="comment-list" class="comment-list"></div>
                </section>
            `;

            requestAnimationFrame(() => {
                container.querySelectorAll('pre code').forEach((block) => {
                    hljs.highlightElement(block);
                });
                addCopyButtons();
                generateTOC();

                if (window.MathJax?.typesetPromise) {
                    window.MathJax.typesetPromise();
                } else if (window.MathJax?.typeset) {
                    window.MathJax.typeset();
                }
            });

            initComments();
            document.querySelector('.article-detail').classList.add('loaded');
        } catch (error) {
            renderMessage('文章加载失败', error.message);
        }
    }

    const backToTopBtn = document.getElementById('back-to-top');

    window.addEventListener('scroll', () => {
        backToTopBtn.classList.toggle('show', window.pageYOffset > 300);
    });

    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    loadArticle();
});
