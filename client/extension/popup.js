const CRM_KEY = 'zx_crm_url';
const TOKEN_KEY = 'zx_crm_token';
const urlInput = document.getElementById('crmUrl');
const tokenInput = document.getElementById('crmToken');
const btnSave = document.getElementById('btnSave');
const statusEl = document.getElementById('status');

chrome.storage.local.get([CRM_KEY, TOKEN_KEY], function (result) {
  urlInput.value = result[CRM_KEY] || 'http://localhost:3317';
  tokenInput.value = result[TOKEN_KEY] || '';
});

btnSave.addEventListener('click', function () {
  const url = urlInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  const kv = {};
  kv[CRM_KEY] = url;
  kv[TOKEN_KEY] = token;
  chrome.storage.local.set(kv, function () {
    statusEl.textContent = '✅ 已保存: ' + url;
    statusEl.className = 'status ok';
  });
  fetch(url + '/api/health')
    .then(function (r) { return r.json(); })
    .then(function () {
      statusEl.textContent = '✅ 已保存并连接成功: ' + url;
      statusEl.className = 'status ok';
    })
    .catch(function () {
      statusEl.textContent = '⚠️ 已保存但无法连接: ' + url + ' (请确认CRM已启动)';
      statusEl.className = 'status err';
    });
});
