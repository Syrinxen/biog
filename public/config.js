// 公共配置文件
const config = {
    // API路径
    api: {
        articles: 'articles.json',
        me: '/api/auth/me',
        captcha: '/api/auth/captcha',
        sendCode: '/api/auth/send-code',
        sendResetCode: '/api/auth/send-reset-code',
        resetPassword: '/api/auth/reset-password',
        login: '/api/auth/login',
        register: '/api/auth/register',
        logout: '/api/auth/logout',
        comments: '/api/comments',
        adminSummary: '/api/admin/summary',
        adminUsers: '/api/admin/users',
        adminComments: '/api/admin/comments'
    },
    // 通用函数
    utils: {
        // 转义HTML特殊字符
        escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },
        // 格式化日期
        formatDate(dateString) {
            const date = new Date(dateString);
            return date.toISOString().split('T')[0];
        },
        // 防抖函数
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }
    }
};

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
} else if (typeof window !== 'undefined') {
    window.config = config;
}
