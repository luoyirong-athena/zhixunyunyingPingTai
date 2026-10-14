(function () {
  'use strict';

  if (!window.ZhiXunAuth?.isAuthenticated?.()) {
    // Keep the H5 entry self-contained even when opened without a trailing slash.
    window.location.replace('/mobile/login.html');
    return;
  }

  var root = document.getElementById('root');
  /* H5-only guard: shared redraw code can briefly hand an invalid target to
   * MutationObserver while a modal/list node is being replaced. Ignore that
   * transient observer request instead of letting it abort the mobile shell. */
  if (window.MutationObserver && !window.__zxMobileSafeMutationObserver) {
    var nativeMutationObserverObserve = window.MutationObserver.prototype.observe;
    window.MutationObserver.prototype.observe = function (target, options) {
      if (!target || typeof target.nodeType !== 'number') return;
      try {
        return nativeMutationObserverObserve.call(this, target, options);
      } catch (error) {
        return;
      }
    };
    window.__zxMobileSafeMutationObserver = true;
  }
  root.classList.add('zx-mobile-root');
  document.documentElement.classList.add('zx-mobile-layout');
  document.body.classList.add('zx-mobile-layout');

  /* A desktop browser does not have the same CSS viewport as a phone, so a
   * merely narrowed browser window can still take different responsive paths.
   * Show the exact H5 in a phone-width frame while testing on desktop; phones
   * themselves continue to render the application directly. */
  var mobilePreview = new URLSearchParams(window.location.search).get('preview') === '1';
  if (!mobilePreview && window.innerWidth > 480) {
    var previewUrl = window.location.pathname + '?preview=1' + window.location.hash;
    document.body.classList.add('zx-mobile-preview-host');
    root.innerHTML = '<iframe class="zx-mobile-preview-frame" title="H5 手机预览" src="' + previewUrl + '"></iframe>';
    root.classList.add('zx-mobile-ready');
    return;
  }

  function load(src, type) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      if (type) script.type = type;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /* The shared application requests its map next to the desktop entry point.
   * Resolve that one static asset from the H5 directory without changing the
   * shared customer-map behavior used by the web version. */
  function routeMobileMapAsset() {
    if (typeof window.fetch !== 'function' || window.__zxMobileMapAssetRouted) return;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var requested = typeof input === 'string' ? input : input && input.url;
      if (requested === './china.json') return nativeFetch('../china.json', init);
      return nativeFetch(input, init);
    };
    window.__zxMobileMapAssetRouted = true;
  }

  routeMobileMapAsset();

  function installMobileNavigation() {
    document.documentElement.classList.add('zx-mobile-layout');
    document.body.classList.add('zx-mobile-layout');

    /* The desktop shell owns this action.  Intercept only the H5 profile
     * entry so the return link can bring a mobile user back to the H5 shell. */
    root.addEventListener('click', function (event) {
      var profile = event.target.closest('[data-action="profile"]');
      if (!profile) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.href = '../profile.html?from=mobile';
    }, true);

    function ensureBottomNavigation() {
      var nav = document.querySelector('#sidebar') || document.querySelector('.zx-topbar .zx-nav');
      if (!nav) return;
      document.querySelectorAll('.zx-mobile-bottom-nav').forEach(function (oldNav) {
        if (oldNav !== nav) oldNav.remove();
      });
      nav.classList.add('zx-mobile-bottom-nav');
      if (nav.parentElement !== document.body) document.body.appendChild(nav);
    }

    function fixMobileBrandLogo() {
      var logo = document.querySelector('.zx-topbar .zx-brand-lockup');
      if (logo && !logo.dataset.mobileLogoFixed) {
        logo.src = '../assets/zx-stacked-logo.svg';
        logo.dataset.mobileLogoFixed = 'true';
      }
    }

    var mobileManagedWechatDrawerState = {
      host: null,
      source: null,
      body: null,
      handle: null,
      raf: 0,
      open: false,
      listenersBound: false,
      modalObserver: null
    };
    var mobileRootObserver = null;
    var mobileRootObserverTarget = null;
    var mobileProvinceDropdownState = { listenersBound: false };

    function isMobileMutationTarget(target) {
      return Boolean(target && (target.nodeType === 1 || target.nodeType === 9 || target.nodeType === 11));
    }

    function syncMobileManagedWechatDrawerVisibility() {
      var state = mobileManagedWechatDrawerState;
      if (!state.host || !state.source || !state.body || !state.host.isConnected || !state.source.isConnected) return;
      /* These filters are a side tool on H5, rather than a block above the
       * customer results. Keep the entry available from the first frame. */
      state.host.classList.add('can-open');
    }

    function scheduleMobileManagedWechatDrawerVisibility() {
      var state = mobileManagedWechatDrawerState;
      if (state.raf) return;
      state.raf = window.requestAnimationFrame(function () {
        state.raf = 0;
        syncMobileManagedWechatDrawerVisibility();
      });
    }

    function syncMobileManagedWechatDrawer() {
      if (routeName() !== 'customers') return;
      var overview = document.querySelector('#zxModal .zx-managed-wechat-overview');
      var host = overview && overview.querySelector(':scope > .zx-mobile-managed-wechat-drawer-host');
      var source = host
        ? host.querySelector(':scope > .zx-managed-wechat-filters')
        : overview && overview.querySelector(':scope > .zx-managed-wechat-filters');
      if (!source) {
        /* A modal close is the only stable "no source" state. Clear the
         * expanded flag here so a later modal starts collapsed, while a
         * same-modal re-render can retain it through the next sync pass. */
        mobileManagedWechatDrawerState.host = null;
        mobileManagedWechatDrawerState.source = null;
        mobileManagedWechatDrawerState.body = null;
        mobileManagedWechatDrawerState.handle = null;
        mobileManagedWechatDrawerState.open = false;
        return;
      }
      var state = mobileManagedWechatDrawerState;
      if (!host) {
        host = document.createElement('div');
        host.className = 'zx-mobile-managed-wechat-drawer-host';
        source.parentElement.insertBefore(host, source);
        host.appendChild(source);
      }
      var handle = host.querySelector(':scope > .zx-mobile-managed-wechat-drawer-handle');
      if (!handle) {
        handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'zx-mobile-managed-wechat-drawer-handle';
        handle.setAttribute('aria-label', '打开工具栏');
        handle.setAttribute('aria-expanded', 'false');
        handle.innerHTML = '<span>工具栏</span><b>‹</b>';
        host.appendChild(handle);
        handle.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          state.open = !state.open;
          host.classList.toggle('is-open', state.open);
          handle.setAttribute('aria-expanded', String(state.open));
          handle.querySelector('b').textContent = state.open ? '›' : '‹';
        });
      }
      state.host = host;
      state.source = source;
      state.body = source.closest('.zx-modal-body');
      state.handle = handle;
      /* Filtering replaces the modal body. Re-apply the previous open state
       * after the new source and handle have been mounted. */
      host.classList.toggle('is-open', state.open);
      handle.setAttribute('aria-expanded', String(state.open));
      handle.querySelector('b').textContent = state.open ? '›' : '‹';
      if (!state.listenersBound) {
        state.listenersBound = true;
        window.addEventListener('scroll', scheduleMobileManagedWechatDrawerVisibility, { passive: true });
        window.addEventListener('resize', scheduleMobileManagedWechatDrawerVisibility);
        document.addEventListener('scroll', scheduleMobileManagedWechatDrawerVisibility, { passive: true, capture: true });
      }
      scheduleMobileManagedWechatDrawerVisibility();
    }

    function installMobileManagedWechatDrawer() {
      var state = mobileManagedWechatDrawerState;
      if (state.modalObserver || !document.body) return;
      /* The shared modal host is mounted beside #root. Watch that host so a
       * newly opened managed-WeChat dialog is converted immediately. */
      var observer = new MutationObserver(function () {
        if (document.querySelector('#zxModal .zx-managed-wechat-filters')) {
          syncMobileManagedWechatDrawer();
        }
      });
      if (!isMobileMutationTarget(document.body)) {
        window.setTimeout(installMobileManagedWechatDrawer, 100);
        return;
      }
      try {
        observer.observe(document.body, { childList: true, subtree: true });
        state.modalObserver = observer;
      } catch (error) {
        observer.disconnect();
        window.setTimeout(installMobileManagedWechatDrawer, 100);
        return;
      }
      /* The shared customer handler can replace a modal body synchronously
       * during its own click listener. Run once after that listener completes
       * as well, so both managed-WeChat modal variants are transformed even
       * when their host is reused instead of inserted as a new DOM node. */
      document.addEventListener('click', function () {
        if (routeName() !== 'customers') return;
        window.setTimeout(syncMobileManagedWechatDrawer, 0);
      });
    }

    function syncMobileCustomSettingsFilter() {
      if (routeName() !== 'customers') return;
      var settingsRoot = document.querySelector('#zxModal .zx-custom-settings');
      if (!settingsRoot) return;
      var sections = Array.prototype.slice.call(settingsRoot.querySelectorAll(':scope > .zx-custom-settings-section'));
      if (!sections.length) return;
      var filter = settingsRoot.querySelector(':scope > .zx-mobile-custom-settings-filter');
      if (!filter) {
        filter = document.createElement('label');
        filter.className = 'zx-mobile-custom-settings-filter';
        filter.innerHTML = '<span>显示板块</span><select class="zx-select" aria-label="选择自定义板块"><option value="all">全部板块</option></select>';
        settingsRoot.insertBefore(filter, settingsRoot.firstChild);
        filter.querySelector('select').addEventListener('change', function () {
          var value = this.value;
          sections.forEach(function (section, index) {
            section.hidden = value !== 'all' && value !== String(index);
          });
        });
      }
      var select = filter.querySelector('select');
      var previous = select.value || 'all';
      var optionMarkup = '<option value="all">全部板块</option>' + sections.map(function (section, index) {
        var title = section.querySelector('h3');
        return '<option value="' + index + '">' + (title ? title.textContent.trim() : ('板块 ' + (index + 1))) + '</option>';
      }).join('');
      if (select.dataset.mobileOptionsMarkup !== optionMarkup) {
        select.innerHTML = optionMarkup;
        select.dataset.mobileOptionsMarkup = optionMarkup;
      }
      select.value = sections.some(function (_, index) { return String(index) === previous; }) || previous === 'all' ? previous : 'all';
      sections.forEach(function (section, index) {
        section.hidden = select.value !== 'all' && select.value !== String(index);
      });
    }

    function closeMobileProvinceMenus(except) {
      document.querySelectorAll('.zx-mobile-province-select.is-open').forEach(function (host) {
        if (host !== except) host.classList.remove('is-open');
      });
    }

    function syncMobileProvinceDropdowns() {
      if (routeName() !== 'customers') return;
      document.querySelectorAll('#customerProvince, #captureListProvince').forEach(function (select) {
        if (!select || !select.options.length) return;
        var host = select.parentElement;
        if (!host.classList.contains('zx-mobile-province-select')) {
          host.classList.add('zx-mobile-province-select');
          var trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'zx-mobile-province-trigger';
          trigger.setAttribute('aria-haspopup', 'listbox');
          trigger.setAttribute('aria-expanded', 'false');
          var menu = document.createElement('div');
          menu.className = 'zx-mobile-province-menu';
          menu.setAttribute('role', 'listbox');
          host.insertBefore(trigger, select);
          host.appendChild(menu);
          select.hidden = true;
          select.setAttribute('aria-hidden', 'true');
          trigger.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var open = !host.classList.contains('is-open');
            closeMobileProvinceMenus(host);
            host.classList.toggle('is-open', open);
            trigger.setAttribute('aria-expanded', String(open));
          });
        }
        var trigger = host.querySelector('.zx-mobile-province-trigger');
        var menu = host.querySelector('.zx-mobile-province-menu');
        var current = select.options[select.selectedIndex];
        var triggerText = current ? current.textContent : '全部省份';
        if (trigger.textContent !== triggerText) trigger.textContent = triggerText;
        var optionMarkup = Array.prototype.map.call(select.options, function (option) {
          return '<button type="button" role="option" class="zx-mobile-province-option" data-value="' + String(option.value).replace(/"/g, '&quot;') + '" aria-selected="' + (option.selected ? 'true' : 'false') + '">' + option.textContent + '</button>';
        }).join('');
        if (menu.dataset.mobileOptionsMarkup !== optionMarkup) {
          menu.innerHTML = optionMarkup;
          menu.dataset.mobileOptionsMarkup = optionMarkup;
          menu.querySelectorAll('.zx-mobile-province-option').forEach(function (optionButton) {
            optionButton.addEventListener('click', function (event) {
              event.preventDefault();
              event.stopPropagation();
              select.value = optionButton.dataset.value || '';
              select.dispatchEvent(new Event('change', { bubbles: true }));
              host.classList.remove('is-open');
              trigger.setAttribute('aria-expanded', 'false');
            });
          });
        }
        var currentChip = host.querySelector('.zx-province-current');
        if (currentChip) currentChip.hidden = true;
      });
      if (!mobileProvinceDropdownState.listenersBound) {
        mobileProvinceDropdownState.listenersBound = true;
        document.addEventListener('click', function (event) {
          if (!event.target.closest('.zx-mobile-province-select')) closeMobileProvinceMenus();
        });
      }
    }

    function ensureMobileGlobalSearch() {
      var form = document.getElementById('globalSearch');
      if (!form || form.dataset.mobileSearchReady) return;
      form.dataset.mobileSearchReady = 'true';
      form.style.pointerEvents = 'auto';
      form.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });
    }

    function ensureCaptureSidebarControl() {
      if (routeName() !== 'customers') return;
      var layout = document.querySelector('.zx-capture-layout');
      var sidebar = layout && layout.querySelector(':scope > .zx-capture-sidebar');
      if (!layout || !sidebar) return;
      /* A fresh H5 capture view always opens with the existing form visible.
       * The user can still collapse it afterwards using the same control. */
      if (!layout.dataset.mobileCaptureReady) {
        layout.classList.remove('zx-mobile-capture-collapsed');
        layout.dataset.mobileCaptureReady = 'true';
      }
      if (sidebar.querySelector('.zx-mobile-capture-collapse')) return;
      var control = document.createElement('button');
      control.type = 'button';
      control.className = 'zx-mobile-capture-collapse';
      control.setAttribute('aria-expanded', 'true');
      control.innerHTML = '<span>收起筛选</span><b>‹</b>';
      control.addEventListener('click', function () {
        var collapsed = layout.classList.toggle('zx-mobile-capture-collapsed');
        control.setAttribute('aria-expanded', String(!collapsed));
        control.querySelector('span').textContent = collapsed ? '展开筛选' : '收起筛选';
        control.querySelector('b').textContent = collapsed ? '›' : '‹';
      });
      sidebar.insertBefore(control, sidebar.firstChild);
    }

    /* The pending-customer filters remain in their original location so the
     * shared application keeps its existing event bindings and page layout.
     * H5 adds a lightweight proxy drawer only after both filter blocks have
     * scrolled out of view. Proxy controls forward to the real controls. */
    var customerFilterDrawerState = {
      shell: null,
      panel: null,
      handle: null,
      backdrop: null,
      body: null,
      toolbar: null,
      statusLine: null,
      toolbarSource: null,
      statusSource: null,
      targetKind: '',
      observer: null,
      raf: 0,
      scrollBound: false,
      visibilityTimer: null,
      active: false,
      open: false,
      toolbarVisible: true,
      statusVisible: true
    };

    function customerFilterDrawerTargets() {
      if (routeName() !== 'customers') return null;
      var isRenderable = function (element) {
        if (!element || !element.isConnected) return false;
        var style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      /* Both the pending view and the capture view can remain mounted while
       * the customer tab switches. Prefer the active capture layout when it
       * is renderable so the drawer rebinds to the correct controls. */
      var layout = document.querySelector('.zx-capture-layout');
      var captureMain = layout && layout.querySelector(':scope > .zx-capture-main');
      /* arrangeMobileCaptureView moves the sidebar into the main column on H5.
       * Resolve it from the main column so the drawer still tracks the live
       * source after that layout-only reparenting. */
      var captureSidebar = captureMain && captureMain.querySelector(':scope > .zx-capture-sidebar');
      var captureToolbar = captureMain && captureMain.querySelector(':scope > .zx-capture-filter-bar');
      if (isRenderable(layout) && isRenderable(captureToolbar) && isRenderable(captureSidebar)) {
        return { toolbar: captureToolbar, statusLine: captureSidebar, kind: 'capture' };
      }
      var customerOverviews = Array.prototype.slice.call(document.querySelectorAll('.zx-customer-overview.zx-customer-overview-pending, .zx-customer-overview:not(.zx-customer-overview-pending)'));
      for (var overviewIndex = 0; overviewIndex < customerOverviews.length; overviewIndex += 1) {
        var overview = customerOverviews[overviewIndex];
        var card = overview.querySelector('.zx-customer-info-card');
        if (card) {
          var isPending = overview.classList.contains('zx-customer-overview-pending');
          var customerToolbar = card.querySelector(isPending ? '.zx-toolbar' : '.zx-customer-official-toolbar');
          var customerStatusLine = card.querySelector('.zx-filter-line');
          if (isRenderable(overview) && isRenderable(customerToolbar) && isRenderable(customerStatusLine)) {
            return { toolbar: customerToolbar, statusLine: customerStatusLine, kind: isPending ? 'pending' : 'library' };
          }
        }
      }
      return null;
    }

    function customerFilterInteractiveNodes(node) {
      return Array.prototype.slice.call(node.querySelectorAll('input, select, textarea, button'));
    }

    function forwardCustomerFilterProxy(proxy, original) {
      if (!proxy || !original) return;
      var tagName = String(proxy.tagName || '').toLowerCase();
      if (tagName === 'input' || tagName === 'textarea') {
        if (tagName === 'input' && (proxy.type === 'checkbox' || proxy.type === 'radio')) proxy.checked = original.checked;
        else proxy.value = original.value;
        var composing = false;
        proxy.addEventListener('compositionstart', function (event) {
          event.stopPropagation();
          composing = true;
          original.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        }, true);
        proxy.addEventListener('compositionend', function (event) {
          event.stopPropagation();
          if (!original.isConnected) return;
          composing = false;
          original.value = proxy.value;
          original.dispatchEvent(new Event('compositionend', { bubbles: true }));
        }, true);
        proxy.addEventListener('input', function (event) {
          event.stopPropagation();
          if (!original.isConnected) return;
          if (tagName === 'input' && (proxy.type === 'checkbox' || proxy.type === 'radio')) original.checked = proxy.checked;
          else original.value = proxy.value;
          original.dispatchEvent(new Event('input', { bubbles: true }));
        }, true);
        return;
      }
      if (tagName === 'select') {
        proxy.value = original.value;
        proxy.addEventListener('change', function (event) {
          event.stopPropagation();
          if (!original.isConnected) return;
          original.value = proxy.value;
          original.dispatchEvent(new Event('change', { bubbles: true }));
        }, true);
        return;
      }
      if (tagName === 'button') {
        proxy.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (!original.isConnected) return;
          original.click();
        }, true);
      }
    }

    function makeCustomerFilterProxy(source, kind) {
      var clone = source.cloneNode(true);
      clone.classList.add('zx-mobile-customer-filter-proxy', 'zx-mobile-customer-filter-proxy-' + kind);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(function (element) { element.removeAttribute('id'); });
      var originals = customerFilterInteractiveNodes(source);
      var proxies = customerFilterInteractiveNodes(clone);
      proxies.forEach(function (proxy, index) {
        var original = originals[index];
        if (!original) return;
        proxy.removeAttribute('id');
        forwardCustomerFilterProxy(proxy, original);
      });
      return clone;
    }

    function ensureCustomerFilterDrawerShell() {
      if (customerFilterDrawerState.shell && document.body.contains(customerFilterDrawerState.shell)) return;
      var existingShell = document.querySelector('.zx-mobile-customer-filter-drawer-shell');
      if (existingShell) {
        customerFilterDrawerState.shell = existingShell;
        customerFilterDrawerState.panel = existingShell.querySelector('.zx-mobile-customer-filter-drawer');
        customerFilterDrawerState.handle = existingShell.querySelector('.zx-mobile-customer-filter-handle');
        customerFilterDrawerState.backdrop = existingShell.querySelector('.zx-mobile-customer-filter-backdrop');
        customerFilterDrawerState.body = existingShell.querySelector('.zx-mobile-customer-filter-drawer-body');
        return;
      }
      var shell = document.createElement('div');
      shell.className = 'zx-mobile-customer-filter-drawer-shell';
      shell.innerHTML = '<button type="button" class="zx-mobile-customer-filter-handle" aria-label="打开工具栏" aria-expanded="false"><span>工具栏</span><b>‹</b></button>' +
        '<div class="zx-mobile-customer-filter-backdrop" aria-hidden="true"></div>' +
        '<aside class="zx-mobile-customer-filter-drawer" aria-hidden="true" aria-label="工具栏抽屉">' +
        '<div class="zx-mobile-customer-filter-drawer-head"><strong>工具栏</strong><button type="button" class="zx-mobile-customer-filter-close" aria-label="关闭工具栏">×</button></div>' +
        '<div class="zx-mobile-customer-filter-drawer-body"></div>' +
        '</aside>';
      document.body.appendChild(shell);
      customerFilterDrawerState.shell = shell;
      customerFilterDrawerState.panel = shell.querySelector('.zx-mobile-customer-filter-drawer');
      customerFilterDrawerState.handle = shell.querySelector('.zx-mobile-customer-filter-handle');
      customerFilterDrawerState.backdrop = shell.querySelector('.zx-mobile-customer-filter-backdrop');
      customerFilterDrawerState.body = shell.querySelector('.zx-mobile-customer-filter-drawer-body');
      customerFilterDrawerState.handle.addEventListener('click', function () {
        if (!customerFilterDrawerState.active) return;
        setCustomerFilterDrawerOpen(!customerFilterDrawerState.open);
      });
      shell.querySelector('.zx-mobile-customer-filter-close').addEventListener('click', function () {
        setCustomerFilterDrawerOpen(false);
      });
      customerFilterDrawerState.backdrop.addEventListener('click', function () {
        setCustomerFilterDrawerOpen(false);
      });
    }

    function setCustomerFilterDrawerOpen(open) {
      var state = customerFilterDrawerState;
      if (!state.panel || !state.handle) return;
      state.open = Boolean(open && state.active);
      state.shell.classList.toggle('is-open', state.open);
      state.panel.classList.toggle('is-open', state.open);
      state.backdrop.classList.toggle('is-open', state.open);
      state.panel.setAttribute('aria-hidden', String(!state.open));
      state.handle.setAttribute('aria-expanded', String(state.open));
      state.handle.querySelector('b').textContent = state.open ? '›' : '‹';
    }

    function scheduleCustomerFilterDrawerVisibility() {
      var state = customerFilterDrawerState;
      if (state.raf) return;
      state.raf = requestAnimationFrame(function () {
        state.raf = 0;
        updateCustomerFilterDrawerVisibility();
      });
    }

    function updateCustomerFilterDrawerVisibility() {
      var state = customerFilterDrawerState;
      ensureCustomerFilterDrawerShell();
      var targets = customerFilterDrawerTargets();
      if (!targets) {
        state.active = false;
        if (state.handle) state.handle.hidden = true;
        if (state.shell) state.shell.classList.remove('can-open');
        setCustomerFilterDrawerOpen(false);
        return;
      }
      if (state.toolbarSource !== targets.toolbar || state.statusSource !== targets.statusLine || state.targetKind !== targets.kind || !state.body.childElementCount) {
        syncCustomerFilterDrawer();
        return;
      }
      state.active = true;
      if (!state.toolbarSource.isConnected || !state.statusSource.isConnected) {
        syncCustomerFilterDrawer();
        return;
      }
      var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      var visible = function (element) {
        var rect = element.getBoundingClientRect();
        return rect.bottom > 8 && rect.top < viewportHeight - 8;
      };
      state.toolbarVisible = visible(state.toolbarSource);
      state.statusVisible = visible(state.statusSource);
      /* Keep the H5 entry reachable at all scroll positions. The source
       * controls remain in place, while the drawer provides the missing
       * mobile-side toolbar without depending on IntersectionObserver timing. */
      state.shell.classList.toggle('can-open', state.active);
      state.handle.classList.remove('is-hidden');
      state.handle.hidden = !state.active;
    }

    function observeCustomerFilterDrawerTargets() {
      var state = customerFilterDrawerState;
      if (state.observer) state.observer.disconnect();
      if ('IntersectionObserver' in window &&
          isMobileMutationTarget(state.toolbarSource) &&
          isMobileMutationTarget(state.statusSource) &&
          state.toolbarSource.isConnected &&
          state.statusSource.isConnected) {
        state.observer = new IntersectionObserver(function () {
          scheduleCustomerFilterDrawerVisibility();
        }, { root: null, threshold: [0, 0.01] });
        try {
          state.observer.observe(state.toolbarSource);
          state.observer.observe(state.statusSource);
        } catch (error) {
          state.observer.disconnect();
          state.observer = null;
        }
      }
      scheduleCustomerFilterDrawerVisibility();
    }

    function syncCustomerFilterDrawer() {
      ensureCustomerFilterDrawerShell();
      var state = customerFilterDrawerState;
      if (!state.scrollBound) {
        state.scrollBound = true;
        window.addEventListener('scroll', scheduleCustomerFilterDrawerVisibility, { passive: true });
        document.addEventListener('scroll', scheduleCustomerFilterDrawerVisibility, { passive: true, capture: true });
        window.addEventListener('resize', scheduleCustomerFilterDrawerVisibility);
      }
      var targets = customerFilterDrawerTargets();
      if (!targets) {
        state.active = false;
        state.toolbarSource = null;
        state.statusSource = null;
        state.targetKind = '';
        state.handle.hidden = true;
        setCustomerFilterDrawerOpen(false);
        state.shell.classList.remove('can-open');
        if (state.observer) state.observer.disconnect();
        if (state.visibilityTimer) {
          window.clearInterval(state.visibilityTimer);
          state.visibilityTimer = null;
        }
        return;
      }
      state.active = true;
      if (!state.visibilityTimer) {
        state.visibilityTimer = window.setInterval(function () {
          if (state.active) updateCustomerFilterDrawerVisibility();
        }, 300);
      }
      if (state.toolbarSource === targets.toolbar && state.statusSource === targets.statusLine && state.targetKind === targets.kind && state.body.childElementCount) {
        updateCustomerFilterDrawerVisibility();
        scheduleCustomerFilterDrawerVisibility();
        return;
      }
      state.toolbarSource = targets.toolbar;
      state.statusSource = targets.statusLine;
      state.targetKind = targets.kind;
      state.body.innerHTML = '';
      var toolbarSection = document.createElement('section');
      toolbarSection.className = 'zx-mobile-customer-filter-drawer-section';
      toolbarSection.innerHTML = '<div class="zx-mobile-customer-filter-drawer-label">'+(targets.kind === 'capture' ? '工具栏' : '工具库')+'</div>';
      toolbarSection.appendChild(makeCustomerFilterProxy(targets.toolbar, 'toolbar'));
      var statusSection = document.createElement('section');
      statusSection.className = 'zx-mobile-customer-filter-drawer-section';
      statusSection.innerHTML = '<div class="zx-mobile-customer-filter-drawer-label">'+(targets.kind === 'capture' ? '采集设置' : '客户状态')+'</div>';
      statusSection.appendChild(makeCustomerFilterProxy(targets.statusLine, targets.kind === 'capture' ? 'capture-sidebar' : 'status'));
      state.body.appendChild(toolbarSection);
      state.body.appendChild(statusSection);
      observeCustomerFilterDrawerTargets();
      updateCustomerFilterDrawerVisibility();
    }

    function installCustomerFilterDrawer() {
      if (!window.__zxMobileCustomerFilterDrawerInstalled) {
        window.__zxMobileCustomerFilterDrawerInstalled = true;
        window.addEventListener('keydown', function (event) {
          if (event.key === 'Escape' && customerFilterDrawerState.open) {
            event.preventDefault();
            setCustomerFilterDrawerOpen(false);
          }
        });
      }
      syncCustomerFilterDrawer();
    }

    /* The capture view is a two-column desktop layout.  On H5, place the
     * existing capture information panel in the right content area, including
     * its city picker.  Nodes and events are reused exactly as rendered by
     * the shared application. */
    function arrangeMobileCaptureView() {
      if (routeName() !== 'customers') return;
      var layout = document.querySelector('.zx-capture-layout');
      var sidebar = layout && layout.querySelector(':scope > .zx-capture-sidebar');
      var main = layout && layout.querySelector(':scope > .zx-capture-main');
      var filterBar = main && main.querySelector(':scope > .zx-capture-filter-bar');
      if (!layout || !sidebar || !main || !filterBar) return;

      /* Remove the temporary H5-only quick form from earlier versions. */
      main.querySelectorAll('.zx-capture-quick').forEach(function (form) { form.remove(); });

      var cityField = layout.querySelector('.zx-capture-city-grid')?.closest('.zx-field');
      if (cityField && cityField.parentElement !== sidebar) sidebar.appendChild(cityField);
      if (sidebar.parentElement !== main || sidebar.previousElementSibling !== filterBar) {
        main.insertBefore(sidebar, filterBar.nextSibling);
      }
      layout.classList.add('zx-mobile-capture-arranged');
    }

    /* H5 customer-library cards keep the shared table markup and handlers.
     * Mark only visually empty fields so CSS can omit those rows on phones. */
    function hideEmptyCustomerCardFields() {
      if (routeName() !== 'customers') return;
      document.querySelectorAll('.zx-official-customer-table tbody tr.clickable > td').forEach(function (cell) {
        if (cell.classList.contains('zx-pending-select-cell') || cell.querySelector('.zx-row-actions')) {
          cell.classList.remove('zx-mobile-empty-field');
          return;
        }
        var value = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        var empty = !value || /^(?:-|--|未设置|未填写手机号)$/.test(value);
        cell.classList.toggle('zx-mobile-empty-field', empty);
        /* Set this directly as well as through the H5 stylesheet: the shared
         * table stylesheet can reapply a table-cell display during redraws. */
        if (empty) cell.style.setProperty('display', 'none', 'important');
        else cell.style.removeProperty('display');
      });
      /* Pending cards keep the shared desktop data model, but the H5 card
       * intentionally omits 微信昵称 and 公众号. Remove those two cells
       * after each virtual-list remount so the remaining rows stay indexed
       * as: 选择、客户、销售状态、省市、管理微信账户、抖音昵称、机构名称、备注、更新时间、操作. */
      document.querySelectorAll('.zx-pending-customer-table tbody tr.clickable').forEach(function (row) {
        if (row.children.length < 12) return;
        row.children[7].remove();
        row.children[6].remove();
      });
    }

    var tabSets = {
      dashboard: [],
      customers: [['客户库', '[data-customer-tab="all"]'], ['待确认客户', '[data-customer-tab="pending"]'], ['客户采集', '[data-customer-tab="capture"]']],
      tasks: [],
      knowledge: [['常用话术', '[data-knowledge-tab="scripts"]'], ['经验总结', '[data-knowledge-tab="experiences"]'], ['资料库', '[data-knowledge-tab="materials"]']],
      settings: []
    };

    function routeName() { return (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard').split('/')[0]; }

    function syncMobileTabs() {
      var main = document.querySelector('.zx-main');
      if (!main) return;
      var route = routeName();
      var old = main.querySelector('.zx-mobile-tabs');

      /* The customer page already has the complete five-way business tab set.
       * Move that real control into the mobile tab slot instead of showing a
       * second, reduced three-item navigation. */
      if (route === 'customers') {
        var customerTabs = main.querySelector('.zx-tabs');
        if (!customerTabs) return;
        if (old && old !== customerTabs) old.remove();
        customerTabs.classList.add('zx-mobile-tabs', 'zx-mobile-customer-tabs');
        customerTabs.setAttribute('aria-label', '客户分类');
        var customerActions = main.querySelector(':scope > .zx-actions');
        if (customerActions && main.firstElementChild !== customerActions) main.insertBefore(customerActions, main.firstChild);
        if (customerTabs.previousElementSibling !== customerActions) main.insertBefore(customerTabs, customerActions ? customerActions.nextSibling : main.firstChild);
        return;
      }

      /* Knowledge has its own complete three-way control with item counts.
       * Put that real control in the same top slot and avoid a duplicate. */
      if (route === 'knowledge') {
        var knowledgeTabs = main.querySelector('.zx-tabs');
        if (!knowledgeTabs) return;
        if (old && old !== knowledgeTabs) old.remove();
        knowledgeTabs.classList.add('zx-mobile-tabs', 'zx-mobile-knowledge-tabs');
        knowledgeTabs.setAttribute('aria-label', '知识分类');
        if (main.firstElementChild !== knowledgeTabs) main.insertBefore(knowledgeTabs, main.firstChild);
        return;
      }

      /* Settings uses its real five-way navigation.  Move it into the same
       * top category slot, rather than keeping a second, unrelated tab row. */
      if (route === 'settings') {
        var settingTabs = main.querySelector('.zx-setting-nav');
        if (!settingTabs) return;
        if (old && old !== settingTabs) old.remove();
        settingTabs.classList.add('zx-mobile-tabs', 'zx-mobile-setting-tabs');
        settingTabs.setAttribute('aria-label', '设置分类');
        if (main.firstElementChild !== settingTabs) main.insertBefore(settingTabs, main.firstChild);
        return;
      }

      var tabs = tabSets[route] || [];
      if (old && old.dataset.route === route && old.dataset.labels === tabs.map(function (item) { return item[0]; }).join('|')) return;
      if (old) old.remove();
      if (!tabs.length) return;
      var nav = document.createElement('nav');
      nav.className = 'zx-mobile-tabs';
      nav.dataset.route = route;
      nav.dataset.labels = tabs.map(function (item) { return item[0]; }).join('|');
      nav.setAttribute('aria-label', '当前页面分类');
      tabs.forEach(function (item, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'zx-mobile-tab' + (index === 0 ? ' active' : '');
        var sourceTab = route === 'knowledge' && item[1] ? document.querySelector(item[1]) : null;
        button.textContent = sourceTab ? sourceTab.textContent.trim() : item[0];
        button.dataset.mobileSelector = item[1];
        nav.appendChild(button);
      });
      if (route === 'knowledge') nav.classList.add('zx-mobile-knowledge-tabs', 'zx-mobile-generated-knowledge-tabs');
      main.insertBefore(nav, main.firstChild);
      nav.addEventListener('click', function (event) {
        var button = event.target.closest('.zx-mobile-tab');
        if (!button) return;
        nav.querySelectorAll('.zx-mobile-tab').forEach(function (tab) { tab.classList.remove('active'); });
        button.classList.add('active');
        var target = button.dataset.mobileSelector && document.querySelector(button.dataset.mobileSelector);
        if (target) {
          target.click();
          setTimeout(function () {
            var activeTarget = tabs.map(function (item) { return item[1]; }).findIndex(function (selector) {
              return selector && document.querySelector(selector + '.active');
            });
            if (activeTarget >= 0) nav.querySelectorAll('.zx-mobile-tab').forEach(function (tab, tabIndex) {
              tab.classList.toggle('active', tabIndex === activeTarget);
            });
          }, 0);
          return;
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    function observeMobileRootChanges() {
      var target = document.getElementById('root');
      if (!isMobileMutationTarget(target)) {
        window.setTimeout(observeMobileRootChanges, 100);
        return;
      }
      if (mobileRootObserver && mobileRootObserverTarget === target) return;
      if (mobileRootObserver) mobileRootObserver.disconnect();
      var observer = new MutationObserver(function () {
        ensureBottomNavigation();
        fixMobileBrandLogo();
        syncMobileTabs();
        arrangeMobileCaptureView();
        ensureCaptureSidebarControl();
        hideEmptyCustomerCardFields();
        syncCustomerFilterDrawer();
        syncMobileManagedWechatDrawer();
        syncMobileCustomSettingsFilter();
        syncMobileProvinceDropdowns();
        ensureMobileGlobalSearch();
      });
      try {
        observer.observe(target, { childList: true, subtree: true });
        mobileRootObserver = observer;
        mobileRootObserverTarget = target;
      } catch (error) {
        observer.disconnect();
        window.setTimeout(observeMobileRootChanges, 100);
      }
    }
    observeMobileRootChanges();
    installMobileManagedWechatDrawer();
    installCustomerFilterDrawer();
    /* Apply the initial H5 placement before revealing the shared shell. */
    ensureBottomNavigation();
    fixMobileBrandLogo();
    syncMobileTabs();
    arrangeMobileCaptureView();
    ensureCaptureSidebarControl();
    hideEmptyCustomerCardFields();
    syncMobileManagedWechatDrawer();
    syncMobileCustomSettingsFilter();
    syncMobileProvinceDropdowns();
    ensureMobileGlobalSearch();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        root.classList.add('zx-mobile-ready');
      });
    });
    window.addEventListener('hashchange', function () {
      setTimeout(function () {
        syncMobileTabs();
        syncCustomerFilterDrawer();
      }, 0);
    });
    setTimeout(function () {
      ensureBottomNavigation();
      fixMobileBrandLogo();
      syncMobileTabs();
      arrangeMobileCaptureView();
      ensureCaptureSidebarControl();
      hideEmptyCustomerCardFields();
      syncCustomerFilterDrawer();
      syncMobileManagedWechatDrawer();
      syncMobileCustomSettingsFilter();
      syncMobileProvinceDropdowns();
      ensureMobileGlobalSearch();
    }, 0);
    /* Some knowledge data is hydrated immediately after the shell is drawn.
     * Repeat after that pass so the real tab control is always available. */
    setTimeout(function () { syncMobileTabs(); arrangeMobileCaptureView(); ensureCaptureSidebarControl(); hideEmptyCustomerCardFields(); syncCustomerFilterDrawer(); syncMobileManagedWechatDrawer(); syncMobileCustomSettingsFilter(); syncMobileProvinceDropdowns(); ensureMobileGlobalSearch(); }, 120);
    setTimeout(function () { syncMobileTabs(); arrangeMobileCaptureView(); ensureCaptureSidebarControl(); hideEmptyCustomerCardFields(); syncCustomerFilterDrawer(); syncMobileManagedWechatDrawer(); syncMobileCustomSettingsFilter(); syncMobileProvinceDropdowns(); ensureMobileGlobalSearch(); }, 600);
    /* Customer data can redraw after the shared shell's initial hydration.
     * Reapply the H5-only empty-field treatment through those final draws. */
    [1000, 1800, 3000].forEach(function (delay) {
      setTimeout(function () {
        hideEmptyCustomerCardFields();
      }, delay);
    });
  }

  load('../vendor/exceljs.min.js').catch(function () {})
    .then(function () { return load('../vendor/xlsx.full.min.js?v=0.18.5').catch(function () {}); })
    .then(function () { return load('../vendor/jszip.min.js?v=3.10.1').catch(function () {}); })
    .then(function () { return load('../one-stop.js?v=20261010-006'); })
    /* The desktop pet is optional on H5. Its observer must never block the
     * mobile navigation and customer-filter drawer from being installed. */
    .then(function () { return load('../zx-pet.js?v=20261010-003', 'module').catch(function () {}); })
    .then(function () { installMobileNavigation(); })
    .catch(function (error) {
      root.innerHTML = '<div class="zx-mobile-load-error"><strong>移动工作台加载失败</strong><span>' +
        String(error && error.message || '请刷新重试') + '</span></div>';
      root.classList.add('zx-mobile-ready');
    });
}());
