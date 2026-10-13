const jwt = require('jsonwebtoken');
const { getDatabase } = require('../config/database');

const JWT_SECRET = (() => {
  const DEFAULT_SECRET = 'change-me-to-random-string-please';
  const secret = process.env.JWT_SECRET;

  if (!secret || secret === DEFAULT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] 生产环境必须设置 JWT_SECRET 环境变量（不能使用默认值）');
      process.exit(1);
    }
    const fallback = require('crypto').randomBytes(32).toString('hex');
    console.warn('[WARN] 未设置 JWT_SECRET，已自动生成临时密钥（仅开发环境有效，重启后所有 token 失效）');
    return fallback;
  }

  return secret;
})();

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * 签发 JWT token。
 * 携带 token_version (tv)，用于改密码后强制旧 token 失效。
 */
function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未授权：缺少认证令牌' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getDatabase().prepare("SELECT id, username, role, display_name, status, token_version, password_reset_required FROM users WHERE id = ?").get(decoded.id);
    if (!user || (user.status && user.status !== 'active')) {
      return res.status(401).json({ error: '账号已停用，请联系系统管理员' });
    }
    // 密码修改后旧 token 失效
    if (user.token_version !== (decoded.tv || 0)) {
      return res.status(401).json({ error: '密码已修改，请重新登录' });
    }
    req.user = { ...decoded, username: user.username, role: user.role, display_name: user.display_name || '', password_reset_required: Boolean(user.password_reset_required) };
    const requestPath = String(req.originalUrl || '').split('?')[0];
    if (user.password_reset_required && requestPath !== '/api/auth/me' && requestPath !== '/api/auth/password') {
      return res.status(403).json({ error: '首次登录必须修改密码', code: 'PASSWORD_RESET_REQUIRED' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: '未授权：令牌无效或已过期' });
  }
}

function authOptional(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      /* Ignore invalid token; authOptional allows unauthenticated access */
    }
  }
  next();
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足：需要管理员权限' });
  }
  next();
}

module.exports = { authRequired, authOptional, adminRequired, JWT_SECRET, JWT_EXPIRES_IN, createToken };
