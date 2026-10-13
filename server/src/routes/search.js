// Express 路由：替代 Netlify search.js 函数
// 前端传 keyword → 用 DuckDuckGo HTML 搜索 → 返回解析后的结果列表
// 解决浏览器直接搜第三方网站的 CORS 限制

const express = require('express');
const { authRequired } = require('../middleware/auth');
const { safeError } = require('../utils/errorHandler');
const router = express.Router();

router.use(authRequired);

// POST 处理（兼容 Netlify Functions 调用方式）
router.post('/', async (req, res) => {
  await handleRequest(req, res);
});

router.post('/search', async (req, res) => {
  await handleRequest(req, res);
});

async function handleRequest(req, res) {
  const body = req.body || {};
  const keyword = (body.keyword || '').trim();
  const page = body.page || 1;

  if (!keyword) {
    return res.status(400).json({ error: '缺少 keyword' });
  }

  // DuckDuckGo HTML 搜索（无需 API Key）
  const params = new URLSearchParams({ q: keyword });
  if (page > 1) {
    params.set('s', String((page - 1) * 25));
  }

  try {
    const url = 'https://html.duckduckgo.com/html/?' + params.toString();
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    if (!resp.ok) {
      return res.status(502).json({ error: `搜索服务返回 ${resp.status}` });
    }

    const html = await resp.text();
    const results = [];

    // 匹配每个结果块: <a class="result__a" href="...">title</a> + <a class="result__snippet">snippet</a>
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [...html.matchAll(linkRe)];
    const snippets = [...html.matchAll(snippetRe)];

    for (let i = 0; i < links.length; i++) {
      const href = links[i][1];
      const title = (links[i][2] || '').replace(/<[^>]*>/g, '').trim();
      const snippet = snippets[i] ? (snippets[i][1] || '').replace(/<[^>]*>/g, '').trim() : '';
      if (title && href) {
        results.push({ title, href, snippet });
      }
    }

    // 也尝试解析 <h2 class="result__title"> 格式的链接
    if (results.length === 0) {
      const altLinkRe = /<h2[^>]*class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      const altLinks = [...html.matchAll(altLinkRe)];
      for (const m of altLinks) {
        results.push({
          href: m[1],
          title: (m[2] || '').replace(/<[^>]*>/g, '').trim(),
          snippet: '',
        });
      }
    }

    return res.json({ keyword, page, results, total: results.length });
  } catch (e) {
    return safeError(e, res);
  }
}

module.exports = router;
