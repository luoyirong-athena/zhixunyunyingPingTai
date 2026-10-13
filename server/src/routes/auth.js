const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { getDatabase } = require('../config/database');
const { authRequired, JWT_SECRET, JWT_EXPIRES_IN, createToken } = require('../middleware/auth');

const router = express.Router();
const SMS_CODE_EXPIRES_MS = 5 * 60 * 1000;
const SMS_RESEND_INTERVAL_MS = 60 * 1000;
const SMS_MAX_ATTEMPTS = 5;
const verificationCodes = new Map();

// 敏感操作限流：登录、注册、密码提示
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请15分钟后再试' },
});
const hintLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '申请操作过于频繁，请15分钟后再试' },
});

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    phone: user.phone,
    phone_masked: maskPhone(user.phone),
    avatar_url: user.avatar_url || null,
    password_hint: user.password_hint || '',
    status: user.status || 'active',
    password_reset_required: Boolean(user.password_reset_required),
  };
}

function maskPhone(phone) {
  if (!phone) return null;
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '已绑定手机号';
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '');
}

function normalizeAvatarDataUrl(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    const error = new Error('头像数据格式不正确');
    error.status = 400;
    throw error;
  }

  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error('头像仅支持 JPG、PNG 或 WebP 图片');
    error.status = 400;
    throw error;
  }
  if (Buffer.byteLength(match[2], 'base64') > 1024 * 1024) {
    const error = new Error('处理后的头像不能超过 1MB');
    error.status = 400;
    throw error;
  }
  return value;
}

function findUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  const phone = normalizePhone(value);
  const db = getDatabase();
  return db.prepare("SELECT * FROM users WHERE (username = ? OR phone = ?) AND COALESCE(status, 'active') = 'active'").get(value, phone);
}

function isValidPurpose(purpose) {
  return purpose === 'login' || purpose === 'password';
}

function isDebugSmsEnabled() {
  return process.env.SMS_CODE_DEBUG === 'true';
}

function sendSmsCode(phone, code, purpose) {
  // 项目目前没有绑定具体短信供应商，生产环境可在这里接入阿里云/腾讯云等服务。
  if (process.env.NODE_ENV === 'production') {
    console.log(`[SMS] ${purpose} verification code sent to ${maskPhone(phone)}`);
  } else {
    console.log(`[SMS] ${purpose} verification code for ${maskPhone(phone)}: ${code}`);
  }
}

function issueVerificationCode(user, purpose) {
  const key = `${user.id}:${purpose}`;
  const previous = verificationCodes.get(key);
  if (previous && previous.sentAt + SMS_RESEND_INTERVAL_MS > Date.now()) {
    const retryAfter = Math.ceil((previous.sentAt + SMS_RESEND_INTERVAL_MS - Date.now()) / 1000);
    const error = new Error(`验证码发送过于频繁，请${retryAfter}秒后再试`);
    error.status = 429;
    error.retryAfter = retryAfter;
    throw error;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  verificationCodes.set(key, {
    code,
    purpose,
    userId: user.id,
    sentAt: Date.now(),
    expiresAt: Date.now() + SMS_CODE_EXPIRES_MS,
    attempts: 0,
  });
  sendSmsCode(user.phone, code, purpose);
  return { key, code };
}

function verifyVerificationCode(userId, purpose, code) {
  const key = `${userId}:${purpose}`;
  const record = verificationCodes.get(key);
  if (!record || record.expiresAt < Date.now()) {
    verificationCodes.delete(key);
    return { ok: false, error: '验证码已失效，请重新获取' };
  }

  record.attempts += 1;
  if (record.attempts > SMS_MAX_ATTEMPTS) {
    verificationCodes.delete(key);
    return { ok: false, error: '验证码错误次数过多，请重新获取' };
  }

  if (String(code || '').trim() !== record.code) {
    return { ok: false, error: '验证码错误' };
  }

  verificationCodes.delete(key);
  return { ok: true };
}

function requirePhone(user) {
  if (!user.phone) {
    const error = new Error('当前账号未绑定手机号，请联系管理员配置手机号');
    error.status = 400;
    throw error;
  }
}

// POST /api/auth/send-code
// 登录验证码无需登录；修改密码验证码必须在登录后发送。
router.post('/send-code', (req, res) => {
  const purpose = req.body.purpose || 'login';
  if (!isValidPurpose(purpose)) {
    return res.status(400).json({ error: '验证码用途不正确' });
  }

  let user;
  if (purpose === 'password') {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: '请先登录后再修改密码' });
    }
    try {
      const token = req.headers.authorization.replace(/^Bearer\s+/i, '');
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: '登录状态已失效，请重新登录' });
    }
    user = getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  } else {
    user = findUserByIdentifier(req.body.identifier || req.body.username || req.body.phone);
  }

  // 不泄露账号是否存在，但登录页需要能够提示用户绑定手机号问题。
  if (!user) return res.status(400).json({ error: '账号或手机号不存在' });
  try {
    requirePhone(user);
    const { code } = issueVerificationCode(user, purpose);
    const response = {
      message: `验证码已发送至 ${maskPhone(user.phone)}`,
      phone_masked: maskPhone(user.phone),
      expires_in: SMS_CODE_EXPIRES_MS / 1000,
    };
    if (isDebugSmsEnabled()) response.debug_code = code;
    return res.json(response);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message, retry_after: error.retryAfter });
  }
});

// POST /api/auth/login
router.post('/login', sensitiveLimiter, (req, res) => {
  const { username, password, verification_code, login_type = 'password' } = req.body;
  const identifier = username || req.body.phone;
  const user = findUserByIdentifier(identifier);
  const disabledUser = !user && identifier ? getDatabase().prepare("SELECT * FROM users WHERE (username = ? OR phone = ?) AND COALESCE(status, 'active') <> 'active'").get(String(identifier).trim(), normalizePhone(identifier)) : null;

  if (login_type === 'code' || verification_code) {
    if (!identifier || !verification_code) {
      return res.status(400).json({ error: '请输入账号和手机验证码' });
    }
    if (disabledUser) return res.status(403).json({ error: '账号已停用，请联系系统管理员' });
    if (!user) return res.status(401).json({ error: '账号或验证码错误' });
    try {
      requirePhone(user);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
    const result = verifyVerificationCode(user.id, 'login', verification_code);
    if (!result.ok) return res.status(401).json({ error: result.error });
  } else {
    if (!identifier || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (disabledUser) return res.status(403).json({ error: '账号已停用，请联系系统管理员' });
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
  }

  res.json({
    token: createToken(user),
    user: serializeUser(user),
    must_change_password: Boolean(user.password_reset_required),
  });
});

// POST /api/auth/register — 用户名注册
router.post('/register', sensitiveLimiter, (req, res) => {
  const { username, password, confirm_password, display_name, password_hint } = req.body;

  // 1. 校验用户名
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ error: '用户名至少需要2个字符' });
  }
  const trimmedUsername = username.trim();

  // 2. 校验密码强度
  if (!password || password.length < 8) {
    return res.status(400).json({ error: '密码长度至少为8位' });
  }
  const passwordCategories = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (passwordCategories < 2) {
    return res.status(400).json({ error: '密码需包含大写字母、小写字母、数字、特殊字符中至少两类' });
  }

  // 3. 校验确认密码
  if (password !== confirm_password) {
    return res.status(400).json({ error: '两次输入的密码不一致' });
  }

  const normalizedHint = String(password_hint || '').trim();
  if (normalizedHint.length > 80) {
    return res.status(400).json({ error: '密码提示不能超过80个字符' });
  }

  const db = getDatabase();

  // 4. 检查用户名是否已存在
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUsername);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  // 5. 创建用户
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role, password_hint) VALUES (?, ?, ?, ?, ?)'
  ).run(trimmedUsername, hash, display_name || trimmedUsername, 'user', normalizedHint || null);

  const user = db.prepare(
    "SELECT id, username, display_name, phone, role, password_hint, status, password_reset_required FROM users WHERE id = ? AND COALESCE(status, 'active') = 'active'"
  ).get(result.lastInsertRowid);

  // 6. 注册成功，自动登录（返回 token）
  res.status(201).json({ token: createToken(user), user: serializeUser(user) });
});

// GET /api/auth/password-hint — 登录前按用户名获取用户自定义提示
router.get('/password-hint', hintLimiter, (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username || username.length > 50) return res.json({ hint: '' });

  const db = getDatabase();
  const user = db.prepare("SELECT password_hint FROM users WHERE username = ? AND COALESCE(status, 'active') = 'active'").get(username);
  // 用户不存在与未设置提示返回相同结果，避免额外暴露账号信息。
  res.json({ hint: user && user.password_hint ? user.password_hint : '' });
});

// POST /api/auth/password-reset-requests — 登录前提交密码重置申请
router.post('/password-reset-requests', passwordResetRequestLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!username || username.length > 50) return res.status(400).json({ error: '请输入用户名' });

  const db = getDatabase();
  const user = db.prepare("SELECT id, username FROM users WHERE username = ? AND COALESCE(status, 'active') = 'active'").get(username);
  // 不泄露账号是否存在；演示管理员必须通过受控方式恢复。
  if (!user || user.username === (process.env.DEMO_ADMIN_USERNAME || 'demo')) {
    return res.json({ message: '如账号存在，申请已提交，请联系系统管理员处理' });
  }

  const pending = db.prepare("SELECT id FROM password_reset_requests WHERE target_user_id = ? AND status = 'pending'").get(user.id);
  if (pending) return res.json({ message: '如账号存在，申请已提交，请联系系统管理员处理' });

  try {
    db.prepare(`INSERT INTO password_reset_requests
      (target_user_id, requested_by_user_id, status, requested_ip)
      VALUES (?, ?, 'pending', ?)`).run(user.id, user.id, req.ip || '');
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.json({ message: '如账号存在，申请已提交，请联系系统管理员处理' });
    }
    throw error;
  }
  res.json({ message: '如账号存在，申请已提交，请联系系统管理员处理' });
});

// GET /api/auth/me
router.get('/me', authRequired, (req, res) => {
  const db = getDatabase();
  const user = db.prepare(
    "SELECT id, username, display_name, role, phone, avatar_url, password_hint, status, password_reset_required FROM users WHERE id = ? AND COALESCE(status, 'active') = 'active'"
  ).get(req.user.id);

  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: serializeUser(user) });
});

// PUT /api/auth/profile — 更新个人信息（无需验证码）
router.put('/profile', authRequired, (req, res) => {
  const { display_name, phone, avatar_url, password_hint } = req.body;

  // 至少需要一个字段
  if (display_name === undefined && phone === undefined && avatar_url === undefined && password_hint === undefined) {
    return res.status(400).json({ error: '请提供需要修改的信息' });
  }

  // 验证手机号格式
  if (phone !== undefined) {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: '请输入有效的手机号' });
    }
  }

  let normalizedAvatar;
  if (avatar_url !== undefined) {
    try {
      normalizedAvatar = normalizeAvatarDataUrl(avatar_url);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  }

  let normalizedHint;
  if (password_hint !== undefined) {
    normalizedHint = String(password_hint || '').trim();
    if (normalizedHint.length > 80) {
      return res.status(400).json({ error: '密码提示不能超过80个字符' });
    }
  }

  const db = getDatabase();

  // 检查手机号是否被其他用户占用
  if (phone !== undefined) {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id);
    if (existing) {
      return res.status(409).json({ error: '该手机号已被其他用户使用' });
    }
  }

  // 构建动态更新 SQL
  const fields = [];
  const values = [];

  if (display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(display_name);
  }
  if (phone !== undefined) {
    fields.push('phone = ?');
    values.push(phone);
  }
  if (avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(normalizedAvatar);
  }
  if (password_hint !== undefined) {
    fields.push('password_hint = ?');
    values.push(normalizedHint || null);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.user.id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // 返回更新后的用户信息
  const user = db.prepare(
    "SELECT id, username, display_name, role, phone, avatar_url, password_hint, status, password_reset_required FROM users WHERE id = ? AND COALESCE(status, 'active') = 'active'"
  ).get(req.user.id);

  res.json({ user: serializeUser(user) });
});

// PUT /api/auth/password
// 个人中心仅校验旧密码和新密码；页面未提供短信验证码输入，不应额外要求验证码。
router.put('/password', authRequired, (req, res) => {
  const { old_password, new_password, force_reset } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: '请填写旧密码和新密码' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: '新密码长度至少为8位' });
  }
  const newCategories = [
    /[A-Z]/.test(new_password),
    /[a-z]/.test(new_password),
    /[0-9]/.test(new_password),
    /[^A-Za-z0-9]/.test(new_password),
  ].filter(Boolean).length;
  if (newCategories < 2) {
    return res.status(400).json({ error: '新密码需包含大写字母、小写字母、数字、特殊字符中至少两类' });
  }
  if (old_password === new_password) {
    return res.status(400).json({ error: '新密码不能与旧密码相同' });
  }

  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(400).json({ error: '旧密码不正确' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  if (force_reset && !user.password_reset_required) {
    return res.status(400).json({ error: '当前账号没有待完成的强制改密任务' });
  }
  db.prepare('UPDATE users SET password_hash = ?, password_reset_required = 0, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
  res.json({ message: '密码修改成功，请使用新密码登录' });
});

module.exports = router;
