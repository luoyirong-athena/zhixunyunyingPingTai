// 志询CRM - 抖音客户采集 Chrome Extension v2
(function () {
  'use strict';

  var CRM_URL = 'http://localhost:3317';
  var CRM_TOKEN = '';

  // 同步读取 storage（用默认值兜底）
  chrome.storage.local.get(['zx_crm_url', 'zx_crm_token'], function (r) {
    if (r.zx_crm_url) CRM_URL = r.zx_crm_url;
    if (r.zx_crm_token) CRM_TOKEN = r.zx_crm_token;
    console.log('[ZX] CRM URL:', CRM_URL);
  });

  // ====== 提取用户信息 ======
  function extractInfo() {
    var u = { douyin_nickname: '', douyin_id: '', douyin_followers: '0', name: '', phone: '', org_name: '' };

    var m = location.pathname.match(/\/user\/([^/?#]+)/);
    if (m) u.douyin_id = m[1];

    var allText = document.body ? document.body.textContent : '';
    var title = (document.title || '').replace(/[ 的抖音主页\-—–·\s]/g, '').trim();
    if (title && title.length < 50) u.douyin_nickname = title;

    // 从 DOM 找昵称（尝试多种选择器）
    var selectors = ['h1', 'h2', '[class*="name"]', '[class*="nickname"]', '[class*="title"]', '[data-e2e]'];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim();
        if (t.length >= 2 && t.length < 40 && t.indexOf('粉丝') < 0 && t.indexOf('获赞') < 0 && t !== u.douyin_id) {
          u.douyin_nickname = t;
          break;
        }
      }
      if (u.douyin_nickname) break;
    }

    // 粉丝数
    var fm = allText.match(/([\d.]+[亿万]?)\s*粉丝/);
    if (fm) u.douyin_followers = fm[1];

    // 手机号
    var pm = allText.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
    if (!pm) {
      var hp = allText.match(/1[3-9]\d[\s\-]?\d{4}[\s\-]?\d{4}/);
      if (hp) { var d = hp[0].replace(/[\s\-]/g, ''); u.phone = d; }
    } else { u.phone = pm[0]; }

    // 姓名：X老师
    var nm = (u.douyin_nickname || '').match(/(.{1,4})(老师|规划师|导师|教授|校长|主任|讲师|专家|顾问)/);
    if (nm) u.name = nm[0];
    else {
      var nm2 = (u.douyin_nickname || '').match(/[\-\—–·](.{1,4})(老师|规划师|导师|教授|专家)/);
      if (nm2) u.name = nm2[1] + nm2[2];
      else u.name = (u.douyin_nickname || '').replace(/[^一-龥a-zA-Z]/g, '').substring(0, 12);
    }

    // 机构
    var om = allText.match(/(.{3,20}(教育|培训|咨询|规划|升学|志愿|学院|学校|中心|机构|工作室|公司|课堂|学堂|私塾|网校))/);
    if (om) u.org_name = om[0];

    console.log('[ZX] 提取结果:', u);
    return u;
  }

  // ====== 发送到 CRM ======
  function sendToCRM(info, cb) {
    console.log('[ZX] 发送到:', CRM_URL + '/api/scraper/import');
    fetch(CRM_URL + '/api/scraper/import', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CRM_TOKEN ? { Authorization: 'Bearer ' + CRM_TOKEN } : {}),
      body: JSON.stringify({
        keyword: info.douyin_nickname || '抖音用户',
        users: [info],
        sessionId: 'chrome-extension'
      })
    }).then(function (r) {
      console.log('[ZX] 响应状态:', r.status);
      return r.json();
    }).then(function (d) {
      console.log('[ZX] 响应数据:', d);
      cb(d);
    }).catch(function (e) {
      console.error('[ZX] 发送失败:', e);
      cb({ success: false, error: e.message });
    });
  }

  // ====== 浮动按钮 ======
  function createButton() {
    if (document.getElementById('zxCaptureBtn')) return;

    var btn = document.createElement('div');
    btn.id = 'zxCaptureBtn';
    btn.textContent = '📋 采集到CRM';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;padding:10px 18px;background:linear-gradient(135deg,#315efb,#5b7cff);color:#fff;font-size:14px;font-weight:600;border-radius:24px;cursor:pointer;box-shadow:0 4px 20px rgba(49,94,251,.4);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;user-select:none;transition:transform .2s';
    document.body.appendChild(btn);
    console.log('[ZX] 按钮已创建');

    btn.addEventListener('click', function () {
      if (btn.dataset.loading === '1') return;
      btn.dataset.loading = '1';
      btn.textContent = '⏳ 采集中...';

      var info = extractInfo();
      sendToCRM(info, function (resp) {
        btn.dataset.loading = '0';
        if (resp && resp.success) {
          btn.textContent = '✅ 已采集！';
          btn.style.background = '#16a34a';
        } else {
          btn.textContent = '❌ 失败';
          btn.style.background = '#dc2626';
          alert('采集失败: ' + ((resp && resp.error) || '请确认CRM已启动'));
        }
        setTimeout(function () {
          btn.textContent = '📋 采集到CRM';
          btn.style.background = '';
        }, 2500);
      });
    });
  }

  // ====== 启动 ======
  console.log('[ZX] Content script loaded, URL:', location.href);
  setTimeout(createButton, 2000);
})();
