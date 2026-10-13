const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { initDatabase } = require('./config/database');
const { initAdminUser } = require('./utils/initAdmin');
const { initSecurityCheck } = require('./utils/initSecurityCheck');
const { startSyncQueueWorker } = require('./services/syncQueueWorker');
const { startDataMaintenance } = require('./services/dataMaintenance');

// 路由模块
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const taskRoutes = require('./routes/tasks');
const feedbackRoutes = require('./routes/feedback');
const experienceRoutes = require('./routes/experiences');
const tagRoutes = require('./routes/tags');
const productRoutes = require('./routes/products');
const analyticsRoutes = require('./routes/analytics');
const ocrRoutes = require('./routes/ocr');
const searchRoutes = require('./routes/search');
const dataRoutes = require('./routes/data');
const salesStatusRoutes = require('./routes/salesStatuses');
const chatRecordRoutes = require('./routes/chatRecords');
const materialsRoutes = require('./routes/materials');
const scraperRoutes = require('./routes/scraper');
const syncRoutes = require('./routes/sync');
const knowledgeRelationRoutes = require('./routes/knowledgeRelations');
const priorityCustomerRoutes = require('./routes/priorityCustomers');
const customerEvidenceRoutes = require('./routes/customerEvidence');
const dataPermissionRoutes = require('./routes/dataPermissions');
const userManagementRoutes = require('./routes/userManagement');
const operationLogRoutes = require('./routes/operationLogs');
const backupRoutes = require('./routes/backups');

const app = express();
const PORT = process.env.PORT || 3317;
const isProduction = process.env.NODE_ENV === 'production';

// ========== 中间件 ==========
// 安全响应头（CSP 允许内联脚本，后续可改为 nonce/hash 策略）
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      // The desktop H5 preview embeds this same local origin in development.
      // Production remains non-embeddable.
      frameSrc: isProduction ? ["'none'"] : ["'self'"],
      // A phone reaches the local development server over plain HTTP.  Helmet
      // enables this directive by default, which would rewrite every H5 asset
      // URL to HTTPS even though this development server has no TLS endpoint.
      // Keep the upgrade in production, but leave LAN testing on HTTP intact.
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS 限制（生产环境通过 CORS_ORIGIN 环境变量指定真实域名）
const configuredCorsOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:3317')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    const isDouyinOrigin = /^https:\/\/(?:[a-z0-9-]+\.)?douyin\.com$/i.test(String(origin || ''));
    callback(null, !origin || configuredCorsOrigins.includes(origin) || isDouyinOrigin);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

// 全局限流（所有 /api 路由）
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  skip: req => req.method === 'GET' && (
    req.path === '/health'
    || req.path === '/sync/changes'
    || req.path === '/sync/events'
    || req.path === '/sync/jobs'
    || req.path.startsWith('/sync/jobs/')
  ),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api', globalLimiter);

// Request failures are returned only to the user who initiated the action.
// Durable background jobs publish their own targeted retry/failure events.
// A complete background job may contain several individually capped 1MB
// batches; every other JSON API keeps the original 5MB safety limit.
app.use('/api/sync/jobs', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== API 路由 ==========
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerEvidenceRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/experiences', experienceRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/product-requests', productRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/functions/ocr', ocrRoutes);
app.use('/api/functions/search', searchRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/sales-statuses', salesStatusRoutes);
app.use('/api/chat-records', chatRecordRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/knowledge', knowledgeRelationRoutes);
app.use('/api/dashboard/priority-customers', priorityCustomerRoutes);
app.use('/api/data-permissions', dataPermissionRoutes);
app.use('/api/admin/users', userManagementRoutes);
app.use('/api/operation-logs', operationLogRoutes);
app.use('/api/backups', backupRoutes);
// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
});

// ========== 静态文件服务 ==========
// 本地开发时后端顺带托管 client/；如果只运行 API，则按目录是否存在决定是否挂载静态中间件。
// 路径可用 ZHIXUN_PUBLIC_DIR 覆盖（留空/不设则用仓库内的 client/）。
const publicDir = process.env.ZHIXUN_PUBLIC_DIR
  ? path.resolve(process.env.ZHIXUN_PUBLIC_DIR)
  : path.join(__dirname, '..', '..', 'client');
const servesStatic = fs.existsSync(path.join(publicDir, 'index.html'));

if (servesStatic) {
  app.use(express.static(publicDir, {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      } else if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  // 独立提供 china.json（SPA 根路径引用）
  app.get('/china.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.sendFile(path.join(publicDir, 'china.json'));
  });

  // favicon.svg
  app.get('/favicon.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(path.join(publicDir, 'favicon.svg'));
  });
}

// 兜底路由
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }

  // 纯 API 模式下，非 API 路径本就不该打到这里，
  // 打到了说明反代规则配错了 —— 返回 JSON 404 而不是去 sendFile 一个不存在的
  // index.html（那会抛 ENOENT，在日志里表现成 500，掩盖真正的配置问题）。
  if (!servesStatic) {
    return res.status(404).json({ error: 'Not found' });
  }

  const ext = path.extname(req.path);
  const isPageRequest = !ext || ext === '.html';
  const isVitePath = req.path.startsWith('/@');

  if (isPageRequest && !isVitePath) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(publicDir, 'index.html'));
  } else {
    res.status(404).end();
  }
});

// Keep oversized JSON errors machine-readable so the client can distinguish a
// payload problem from a transient network or database failure.
app.use((error, req, res, next) => {
  const requestId = String(req.get('X-Request-Id') || '').slice(0, 100) || null;
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: '同步请求过大，请使用分批导入或减少单次提交内容', code: 'PAYLOAD_TOO_LARGE', requestId, retryable: false });
  }
  if (error) {
    const code = String(error.code || '').toUpperCase();
    const message = String(error.message || '').toLowerCase();
    const retryable = /^(SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN))/.test(code)
      || /database is locked|database table is locked|sqlite_(busy|locked)|busy snapshot/.test(message);
    if (retryable) res.set('Retry-After', '3');
    console.error('[HTTP] request failed', { requestId, code: error.code, error: error.message });
    return res.status(retryable ? 503 : 500).json({
      error: retryable ? '服务器正在处理其他同步请求，请稍后重试' : '服务器处理请求失败，请稍后重试',
      code: retryable ? 'SYNC_TEMPORARY_FAILURE' : 'SERVER_ERROR',
      requestId,
      retryable
    });
  }
  return next();
});

// ========== 启动 ==========
initDatabase();
initAdminUser();
initSecurityCheck();
startDataMaintenance({
  db: require('./config/database').getDatabase(),
  intervalMs: process.env.ZHIXUN_MAINTENANCE_INTERVAL_MS
});

const HOST = process.env.HOST || '0.0.0.0';

// 读取 SSL 证书（自签名，开发/内网环境使用）
const SSL_KEY = path.join(__dirname, '..', 'data', 'localhost-key.pem');
const SSL_CERT = path.join(__dirname, '..', 'data', 'localhost-cert.pem');
const sslOptions = fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)
  ? { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }
  : null;

startSyncQueueWorker({ port: PORT, secure: Boolean(sslOptions) });

let httpServer;
if (sslOptions) {
  httpServer = https.createServer(sslOptions, app).listen(PORT, HOST, () => {
    console.log(`\n========================================`);
    console.log(`  志询 · 增长运营平台`);
    console.log(`  服务已启动: https://localhost:${PORT}`);
    console.log(`  [Startup] Admin account initialized`);
    console.log(`========================================\n`);
  });
} else {
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`\n========================================`);
    console.log(`  志询 · 增长运营平台`);
    console.log(`  服务已启动: http://${HOST}:${PORT}`);
    console.log(`  [Startup] Admin account initialized`);
    console.log(`========================================\n`);
  });
}

// Large backup uploads stream to disk and may legitimately take longer than
// Node's default request timeout. Authentication and rate limiting still run
// before the backup body is accepted.
httpServer.requestTimeout = Math.max(0, Number(process.env.ZHIXUN_HTTP_REQUEST_TIMEOUT_MS || 0) || 0);

module.exports = app;
