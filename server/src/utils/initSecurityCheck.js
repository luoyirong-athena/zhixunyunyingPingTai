'use strict';

/**
 * 启动时安全配置自检 —— 非阻塞，仅输出警告。
 * 生产环境的最佳实践检查项：
 *   1. JWT_SECRET 不得为空或默认值
 *   2. ADMIN_DEFAULT_PASSWORD 不得使用公开演示密码（demo123）
 *   3. NODE_ENV 应为 production
 *   4. CORS_ORIGIN 应明确设置
 *   5. SMS_CODE_DEBUG 不得在生产环境启用
 */

const DEFAULT_JWT_SECRET = 'change-me-to-random-string-please';
const WEAK_ADMIN_PASSWORD = 'demo123';

function initSecurityCheck() {
  const warnings = [];

  // --- JWT_SECRET ---
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET) {
    warnings.push('JWT_SECRET 未设置或仍为默认值，请生成强随机字符串替换');
  }

  // --- ADMIN_DEFAULT_PASSWORD ---
  if (process.env.ADMIN_DEFAULT_PASSWORD === WEAK_ADMIN_PASSWORD) {
    warnings.push('ADMIN_DEFAULT_PASSWORD 使用公开演示密码 "demo123"，生产环境请修改或留空自动生成随机密码');
  }

  // --- NODE_ENV ---
  if (process.env.NODE_ENV !== 'production') {
    warnings.push('NODE_ENV 未设为 "production"，部分安全策略（错误脱敏、日志去敏）将不生效');
  }

  // --- CORS_ORIGIN ---
  if (!process.env.CORS_ORIGIN) {
    warnings.push('CORS_ORIGIN 未设置，将默认允许 localhost（部署到公网时请指定真实域名）');
  }

  // --- SMS_CODE_DEBUG ---
  if (process.env.SMS_CODE_DEBUG === 'true') {
    warnings.push('SMS_CODE_DEBUG 已开启，验证码将在 API 响应中返回——仅用于开发调试');
  }

  if (warnings.length) {
    console.warn('\n[SECURITY] ======== 安全配置检查（非阻塞） ========');
    warnings.forEach((w) => console.warn(`[SECURITY] ⚠️  ${w}`));
    console.warn('[SECURITY] ==========================================\n');
  } else {
    console.log('[SECURITY] ✅ 关键安全配置已通过检查');
  }
}

module.exports = { initSecurityCheck };
