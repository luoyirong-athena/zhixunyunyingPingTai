const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDatabase } = require('../config/database');

function initAdminUser() {
  const db = getDatabase();
  const demoUsername = process.env.DEMO_ADMIN_USERNAME || 'demo';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(demoUsername);

  const defaultPhone = process.env.ADMIN_DEFAULT_PHONE || '';

  if (!existing) {
    let defaultPassword;
    if (process.env.ADMIN_DEFAULT_PASSWORD) {
      defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD;
    } else {
      defaultPassword = process.env.NODE_ENV === 'production'
        ? crypto.randomBytes(12).toString('hex')
        : 'demo123';
      console.log(`[INIT] 未设置 ADMIN_DEFAULT_PASSWORD，使用${process.env.NODE_ENV === 'production' ? '随机' : '演示'}密码`);
    }
    const hash = bcrypt.hashSync(defaultPassword, 10);
    db.prepare(
      "INSERT INTO users (username, password_hash, display_name, role, phone, status) VALUES (?, ?, ?, ?, ?, 'active')"
    ).run(demoUsername, hash, '演示管理员', 'admin', defaultPhone);
    if (process.env.NODE_ENV === 'production') {
      console.log('[INIT] 默认管理员已创建，请通过环境变量 ADMIN_DEFAULT_PASSWORD 查看密码');
    } else {
      console.log(`[INIT] 演示管理员已创建 → 账号: ${demoUsername}  密码: ${defaultPassword}`);
    }
    console.log('[INIT] ⚠️  请登录后立即修改密码！');
  } else {
    const admin = db.prepare('SELECT phone FROM users WHERE id = ?').get(existing.id);
    if (defaultPhone && !admin.phone) {
      try {
        db.prepare('UPDATE users SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(defaultPhone, existing.id);
        console.log(`[INIT] 已为管理员绑定手机号: ${defaultPhone}`);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          console.log(`[INIT] 管理员手机号 ${defaultPhone} 已被占用，跳过绑定（可在个人中心手动设置）`);
        } else {
          throw err;
        }
      }
    }
    console.log('[INIT] 管理员账号已存在，跳过初始化');
  }
}

module.exports = { initAdminUser };
