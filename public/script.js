document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const articleList = document.getElementById('article-list');
    const tagCloud = document.getElementById('tag-cloud');
    const categoryList = document.querySelector('.categories');
    const searchInput = document.getElementById('search-input');

    let allArticles = [];
    let currentModule = '全部';
    let currentTag = null;

    async function loadArticles() {
        try {
            const response = await fetch(config.api.articles);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            allArticles = Array.isArray(data) ? data : [];
            renderCategories();
            renderArticles();
            renderTags();
        } catch (error) {
            console.error('加载文章失败:', error);
            renderState('文章加载失败', '请稍后刷新页面重试');
        }
    }

    function renderState(title, detail = '') {
        articleList.innerHTML = '';

        const state = document.createElement('div');
        state.className = 'loading';

        const strong = document.createElement('strong');
        strong.textContent = title;
        state.appendChild(strong);

        if (detail) {
            const paragraph = document.createElement('p');
            paragraph.textContent = detail;
            state.appendChild(paragraph);
        }

        articleList.appendChild(state);
    }

    function getModules() {
        return [...new Set(allArticles.flatMap((article) => article.modules || []))];
    }

    function getFilteredArticles() {
        const searchQuery = (searchInput?.value || '').trim().toLowerCase();

        return allArticles
            .filter((article) => {
                const modules = article.modules || [];
                const title = article.title || '';
                const excerpt = article.excerpt || '';
                const matchesSearch = title.toLowerCase().includes(searchQuery) ||
                    excerpt.toLowerCase().includes(searchQuery);
                const matchesModule = currentModule === '全部' || modules.includes(currentModule);
                const matchesTag = !currentTag || modules.includes(currentTag);
                return matchesSearch && matchesModule && matchesTag;
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    function createTagElement(tagName, isActive = false) {
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = `tag${isActive ? ' active' : ''}`;
        tag.dataset.tag = tagName;
        tag.textContent = tagName;
        tag.addEventListener('click', (event) => {
            event.stopPropagation();
            currentTag = currentTag === tagName ? null : tagName;
            renderArticles();
            renderTags();
        });
        return tag;
    }

    function renderArticles() {
        const filteredArticles = getFilteredArticles();
        articleList.innerHTML = '';

        if (filteredArticles.length === 0) {
            renderState('没有匹配的文章', '换个关键词或分类试试');
            return;
        }

        filteredArticles.forEach((article) => {
            const item = document.createElement('article');
            item.className = 'article-item';
            item.tabIndex = 0;
            item.dataset.id = article.id;

            const title = document.createElement('h3');
            title.className = 'article-title';
            title.textContent = article.title || '未命名文章';

            const meta = document.createElement('div');
            meta.className = 'article-meta';

            (article.modules || []).forEach((moduleName) => {
                meta.appendChild(createTagElement(moduleName, currentTag === moduleName));
            });

            const date = document.createElement('time');
            date.dateTime = article.date || '';
            date.textContent = article.date || '';
            meta.appendChild(date);

            const excerpt = document.createElement('p');
            excerpt.className = 'article-excerpt';
            excerpt.textContent = article.excerpt || '暂无摘要';

            const link = document.createElement('div');
            link.className = 'article-link';
            link.textContent = '阅读全文 →';

            item.append(title, meta, excerpt, link);
            item.addEventListener('click', () => {
                window.location.href = `article.html?id=${encodeURIComponent(article.id)}`;
            });
            item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    window.location.href = `article.html?id=${encodeURIComponent(article.id)}`;
                }
            });

            articleList.appendChild(item);
        });
    }

    function renderCategories() {
        if (!categoryList) return;

        categoryList.innerHTML = '';
        getModules().forEach((moduleName) => {
            const category = document.createElement('button');
            category.type = 'button';
            category.className = `category${currentModule === moduleName ? ' active' : ''}`;
            category.textContent = moduleName;
            category.addEventListener('click', () => {
                currentModule = moduleName;
                currentTag = null;
                syncNav();
                renderCategories();
                renderArticles();
                renderTags();
            });
            categoryList.appendChild(category);
        });
    }

    function renderTags() {
        if (!tagCloud) return;

        tagCloud.innerHTML = '';
        getModules().forEach((tagName) => {
            tagCloud.appendChild(createTagElement(tagName, currentTag === tagName));
        });
    }

    function syncNav() {
        navItems.forEach((nav) => {
            nav.classList.toggle('active', nav.getAttribute('data-module') === currentModule);
        });
    }

    navItems.forEach((item) => {
        item.addEventListener('click', () => {
            currentModule = item.getAttribute('data-module');
            currentTag = null;
            syncNav();
            renderCategories();
            renderArticles();
            renderTags();
        });
    });

    const handleSearch = config.utils.debounce(() => {
        renderArticles();
    }, 300);
    searchInput?.addEventListener('input', handleSearch);

    loadArticles();
});
