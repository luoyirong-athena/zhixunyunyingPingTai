'use strict';

/**
 * 安全错误响应 —— 生产环境不暴露内部错误细节。
 * @param {Error|string} err   原始错误
 * @param {Response}   res    Express response
 * @param {string}     [fallbackMsg='服务器内部错误']
 */
function safeError(err, res, fallbackMsg) {
  const msg = fallbackMsg || '服务器内部错误';
  console.error('[ERROR]', err);
  const message = process.env.NODE_ENV === 'production' ? msg : String(err);
  return res.status(500).json({ error: message });
}

module.exports = { safeError };
