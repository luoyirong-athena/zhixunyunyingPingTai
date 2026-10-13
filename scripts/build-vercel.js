const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientDir = path.join(root, 'client');
const apiBase = String(process.env.RAILWAY_API_URL || '').trim().replace(/\/+$/, '');

fs.writeFileSync(
  path.join(clientDir, 'runtime-config.js'),
  `window.__ZHIXUN_RUNTIME_CONFIG__ = ${JSON.stringify({ apiBase })};\n`,
  'utf8'
);

if (!apiBase) {
  console.warn('[vercel-build] RAILWAY_API_URL is not set; /api requests will use the current origin.');
} else {
  console.log(`[vercel-build] Frontend API base: ${apiBase}`);
}
