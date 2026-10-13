/**
 * 志询CRM - 客户端认证工具
 * Token 管理 & API 请求拦截
 */
(function () {
  const TOKEN_KEY = 'zhixun_token';
  const USER_KEY = 'zhixun_user';
  const runtimeConfig = window.__ZHIXUN_RUNTIME_CONFIG__ || {};
  const apiBase = String(runtimeConfig.apiBase || window.ZHIXUN_API_BASE || '').trim().replace(/\/+$/, '');
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  function resolveApiUrl(input) {
    const raw = input instanceof Request ? input.url : String(input);
    if (!apiBase || !/^\/api(?:\/|$)/.test(raw)) return input;
    const target = `${apiBase}${raw}`;
    return input instanceof Request ? new Request(target, input) : target;
  }

  // Preserve relative API calls while allowing Vercel to call the Railway API.
  if (nativeFetch) window.fetch = (input, options) => nativeFetch(resolveApiUrl(input), options);
  window.ZhiXunApi = { baseUrl: apiBase, resolveUrl: resolveApiUrl };
  // Some isolated runtimes (for example backup verification) provide only a
  // partial Location object. Treat absent fields as an ordinary web entry.
  const locationPath = String(window.location?.pathname || '');
  const locationSearch = String(window.location?.search || '');
  const mobileEntry = locationPath.indexOf('/mobile/') === 0 || new URLSearchParams(locationSearch).get('from') === 'mobile';
  const loginPath = mobileEntry ? '/mobile/login.html' : '/login.html';

  window.ZhiXunAuth = {
    resolveUrl: resolveApiUrl,
    // 获取存储的 token
    getToken() {
      return localStorage.getItem(TOKEN_KEY);
    },

    // 获取存储的用户信息
    getUser() {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY));
      } catch {
        return null;
      }
    },

    // 保存登录信息
    setSession(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },

    // 清除登录信息
    clearSession() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },

    // 是否已登录
    isAuthenticated() {
      const token = this.getToken();
      if (!token) return false;
      // 检查 token 是否过期
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp * 1000 > Date.now();
      } catch {
        return false;
      }
    },

    // 退出登录
    logout() {
      this.clearSession();
      window.location.href = loginPath;
    },

    // 带认证的 fetch 封装
    async fetch(url, options = {}) {
      const token = this.getToken();
      const headers = { ...options.headers };
      const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type');
      const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
      if (!hasContentType && !isFormData) headers['Content-Type'] = 'application/json';
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const resp = await fetch(url, { ...options, headers });
      // 401 时自动跳转登录
      if (resp.status === 401) {
        this.clearSession();
        window.location.href = loginPath;
        throw new Error('未授权，请重新登录');
      }
      if (resp.status === 403 && !String(url).startsWith('/api/auth/password')) {
        const data = await resp.clone().json().catch(() => ({}));
        if (data.code === 'PASSWORD_RESET_REQUIRED') {
          window.location.href = mobileEntry ? '/password.html?force=1&from=mobile' : '/password.html?force=1';
          throw new Error('首次登录必须修改密码');
        }
      }
      return resp;
    },

    // GET 请求
    async get(url) {
      return this.fetch(url);
    },

    // POST 请求
    async post(url, data) {
      return this.fetch(url, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
  };
})();
