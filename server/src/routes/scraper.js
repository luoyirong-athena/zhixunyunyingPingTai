const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const { getDatabase } = require('../config/database');
const { authRequired } = require('../middleware/auth');
const { resolveTeamContext, enforceTeamWriteByMethod } = require('../middleware/team');
const { safeError } = require('../utils/errorHandler');
const { createSyncEvent, publish } = require('../services/syncHub');
const router = express.Router();
const MAX_DOUYIN_RESPONSE_BYTES = 5 * 1024 * 1024;
const DOUYIN_REQUEST_TIMEOUT_MS = 10 * 1000;
const ALLOWED_DOUYIN_HOSTS = new Set(['douyin.com', 'iesdouyin.com']);

function isAllowedDouyinHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return [...ALLOWED_DOUYIN_HOSTS].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0));
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

async function validateDouyinUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { throw new Error('抖音链接格式不正确'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !isAllowedDouyinHost(parsed.hostname)) {
    throw new Error('仅支持安全的抖音链接');
  }
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('抖音链接地址不可访问');
  return parsed;
}

async function fetchDouyinHtml(inputUrl) {
  let current = await validateDouyinUrl(inputUrl);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(current, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      redirect: 'manual',
      signal: AbortSignal.timeout(DOUYIN_REQUEST_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('抖音链接重定向无效');
      current = await validateDouyinUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`抖音页面请求失败（${response.status}）`);
    if (Number(response.headers.get('content-length') || 0) > MAX_DOUYIN_RESPONSE_BYTES) throw new Error('抖音页面响应过大');
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOUYIN_RESPONSE_BYTES) { await reader.cancel(); throw new Error('抖音页面响应过大'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('抖音链接重定向次数过多');
}

// 以下所有路由需要登录
router.use(authRequired, resolveTeamContext, enforceTeamWriteByMethod);

// POST /api/scraper/import — 采集数据导入（需登录）
router.post('/import', (req, res) => {
  const { keyword, users, sessionId } = req.body || {};
  if (!users || !Array.isArray(users) || !users.length) {
    return res.status(400).json({ error: '请提供用户数据' });
  }
  const city = keyword ? keyword.split(' ')[0] : '';
  const results = users.map(u => ({
    douyin_nickname: u.douyin_nickname || u.nickname || '',
    douyin_id: u.douyin_id || u.uid || '',
    douyin_followers: u.douyin_followers || '0',
    city: u.city || city,
    remark: u.remark || `抖音搜索 "${keyword || ''}" 采集`,
  }));
  const sid = String(sessionId || 'default').slice(0, 120);
  const db = getDatabase();
  const pending = db.prepare(`
    INSERT INTO scraper_pending_imports (team_id, created_by_user_id, session_id, payload_json)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    pending.run(req.team.id, req.user.id, sid, JSON.stringify(results));
  })();
  const event = createSyncEvent(db, {
    teamId: req.team.id,
    entityType: 'customer_capture',
    entityId: sid,
    action: 'customer.capture_created',
    operatorUserId: req.user.id,
    requestId: req.get('X-Request-Id') || null,
    payload: { source: 'scraper', sessionId: sid, count: results.length }
  });
  publish(req.team.id, event);
  const total = db.prepare('SELECT COALESCE(SUM(json_array_length(payload_json)), 0) count FROM scraper_pending_imports WHERE team_id = ? AND session_id IN (?, ?)')
    .get(req.team.id, sid, 'default').count;
  res.json({ success: true, count: results.length, total: Number(total || 0) });
});

// GET /api/scraper/pending-imports — 获取待导入数据（需登录）
router.get('/pending-imports', (req, res) => {
  const hasSession = req.query.sessionId !== undefined;
  const sid = String(req.query.sessionId || 'default').slice(0, 120);
  const db = getDatabase();
  const items = db.transaction(() => {
    const rows = hasSession
      ? db.prepare('SELECT id, payload_json FROM scraper_pending_imports WHERE team_id = ? AND session_id IN (?, ?) ORDER BY id').all(req.team.id, sid, 'default')
      : db.prepare('SELECT id, payload_json FROM scraper_pending_imports WHERE team_id = ? ORDER BY id').all(req.team.id);
    if (rows.length) db.prepare(`DELETE FROM scraper_pending_imports WHERE team_id = ? AND id IN (${rows.map(() => '?').join(',')})`)
      .run(req.team.id, ...rows.map(row => row.id));
    return rows.flatMap(row => {
      try {
        const parsed = JSON.parse(row.payload_json);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    });
  })();
  res.json({ results: items, count: items.length });
});

// POST /api/scraper/parse-url — 解析抖音链接，提取用户信息
router.post('/parse-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '请提供抖音链接' });

  try {
    const html = await fetchDouyinHtml(url);

    const user = {};

    // === 提取抖音号 (从URL路径) ===
    const uidMatch = url.match(/\/user\/([^/?"]+)/) || html.match(/\/user\/([^/?"]+)/);
    user.douyin_id = uidMatch ? uidMatch[1] : '';

    // === 提取昵称 ===
    // 优先从 JSON 数据提取
    const nickFromJson = html.match(/"nickname"\s*:\s*"([^"]+)"/);
    if (nickFromJson) {
      user.douyin_nickname = nickFromJson[1];
    }
    // 从 title 标签提取
    if (!user.douyin_nickname) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
      if (titleMatch) {
        user.douyin_nickname = titleMatch[1].replace(/[ 的抖音主页抖音\-—–\s]/g, '').trim();
      }
    }
    // 从 og:title 提取
    if (!user.douyin_nickname) {
      const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
      if (ogMatch) user.douyin_nickname = ogMatch[1].replace(/[ 的抖音主页抖音]/g, '').trim();
    }

    // === 提取粉丝数（不混淆获赞） ===
    const fcMatch = html.match(/"follower_count"\s*:\s*(\d+)/);
    if (fcMatch) {
      const n = parseInt(fcMatch[1]);
      user.douyin_followers = n >= 10000 ? (n/10000).toFixed(1)+'万' : String(n);
    } else {
      // 从页面文本提取，严格匹配"粉丝"（不是"获赞"）
      const fm = html.match(/([\d.]+[亿万]?)\s*粉丝/);
      if (fm && !html.substring(Math.max(0, fm.index-10), fm.index).includes('获赞')) {
        user.douyin_followers = fm[1];
      }
    }

    // === 提取签名/简介 ===
    const sigMatch = html.match(/"signature"\s*:\s*"([^"]*)"/);
    if (sigMatch) {
      user.signature = sigMatch[1].replace(/\\n/g, ' ').replace(/\\t/g, ' ');
    }

    // === 提取手机号（支持隐晦格式） ===
    const allText = (user.signature || '') + ' ' + html;
    // 标准手机号
    let phoneMatch = allText.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
    if (phoneMatch) {
      user.phone = phoneMatch[0];
    } else {
      // 带分隔符的手机号: 1366-9688-458, 1366 9688 458 等
      const hiddenPhone = allText.match(/1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/);
      if (hiddenPhone) {
        user.phone = hiddenPhone[0].replace(/[-\s]/g, '');
      }
    }

    // === 提取微信号 ===
    const wxMatch = allText.match(/(?:[Vv]|微信|wx|WX|❤|💛|👉|☝|✌)[:：]?\s*([a-zA-Z][a-zA-Z0-9_-]{4,19})/);
    if (wxMatch) user.wechat_id = wxMatch[1];

    // === 提取姓名（从昵称中识别"X老师"） ===
    if (user.douyin_nickname) {
      // 模式1: "X老师" 在昵称中
      const nm = user.douyin_nickname.match(/([^\s\-—–·【\(（]{1,4})(老师|规划师|导师|教授|校长|主任|讲师|专家|顾问|学长|学姐|师兄|师姐)/);
      if (nm) {
        user.name = nm[0];
      }
      // 模式2: "-X老师" 破折号后面
      if (!user.name) {
        const nm2 = user.douyin_nickname.match(/[-—–·]([^\s\-—–·]{1,4})(老师|规划师|导师|教授|专家)/);
        if (nm2) user.name = nm2[1] + nm2[2];
      }
      // 模式3: 没找到"老师"关键词，直接用昵称
      if (!user.name) {
        // 取昵称前几个字（去除非中文字符）
        const clean = user.douyin_nickname.replace(/[^一-龥a-zA-Z]/g, '');
        user.name = clean.substring(0, 12) || user.douyin_nickname;
      }
    }

    // === 提取机构名称 ===
    const orgMatch = allText.match(/([一-龥]{3,20}(?:教育|培训|咨询|规划|升学|志愿|学院|学校|中心|机构|工作室|公司|课堂|学堂|私塾|网校))/);
    if (orgMatch) user.org_name = orgMatch[0];

    // === 备注 ===
    user.remark = '链接解析导入';

    res.json({ success: true, user });
  } catch (err) {
    const clientErrors = new Set([
      '抖音链接格式不正确', '仅支持安全的抖音链接', '抖音链接地址不可访问',
      '抖音链接重定向无效', '抖音页面响应过大', '抖音链接重定向次数过多'
    ]);
    if (clientErrors.has(err.message) || err.name === 'TimeoutError') {
      return res.status(400).json({ error: err.name === 'TimeoutError' ? '抖音页面请求超时' : err.message });
    }
    return safeError(err, res);
  }
});

module.exports = router;
