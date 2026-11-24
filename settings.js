(function () {
  'use strict';

  var CHANNEL = 'tencent-docs';
  var CONFIRM_WINDOW_MS = 4000;
  var TOKEN_KEY = 'personal_mcp_token';
  var TOKEN_URL = 'https://docs.qq.com/open/auth/mcp.html';
  var SECTIONS = [
    { key: 'tencent_docs_account', id: 'personal' },
    { key: 'tencent_docs_saas_account', id: 'enterprise' }
  ];

  var MESSAGES = {
    'zh-CN': {
      intro: '连接后，Cindy 会按你的要求读写这个账号有权限的腾讯文档。授权范围：读取文档、编辑文档。个人版和企业版可以都连，使用时 Cindy 会先问你要操作哪一个。',
      sections: {
        personal: { title: '个人版', hint: '用 QQ 或微信登录的腾讯文档账号（docs.qq.com）', accountName: '个人版账号' },
        enterprise: { title: '企业版', hint: '企业的腾讯文档账号（saas.docs.qq.com）', accountName: '企业版账号' }
      },
      token: {
        title: '个人 Token（可选）',
        hint: '删除、移动、改分享权限等操作需要腾讯文档的管理权限，一键登录拿不到。填上个人版的个人 Token 后，Cindy 只在这类操作时使用它。请用和上面个人版相同的账号获取。',
        placeholder: '粘贴个人 Token',
        save: '保存',
        clear: '清除',
        confirmClear: '确认清除',
        saved: '已保存',
        savedTail: '已保存，末四位 {tail}',
        notSaved: '未填写',
        get: '去腾讯文档开放平台获取 ↗',
        savedOk: '个人 Token 已保存。',
        clearedOk: '个人 Token 已清除。',
        failed: '保存没有成功，请重试。'
      },
      connectFirst: '连接账号',
      connectMore: '再连接一个账号',
      connectedOn: '{date} 连接',
      connected: '已连接',
      expired: '授权已失效，请重新连接',
      scopeStale: '授权范围有变化，建议重新连接',
      isDefault: '默认',
      reconnect: '重新连接',
      makeDefault: '设为默认',
      disconnect: '断开',
      confirmDisconnect: '确认断开',
      opening: '已打开浏览器，请登录腾讯文档并同意授权…',
      reconnecting: '已打开浏览器，请用原来的账号重新授权…',
      connectedOk: '账号已连接。',
      reconnectedOk: '已重新连接，旧的失效授权已移除。',
      disconnectedOk: '已断开这个账号。',
      defaultOk: '已设为默认账号。',
      loadFailed: '账号状态加载失败，请关闭后重新打开插件详情。',
      actionFailed: '操作没有完成，请重新打开插件详情核对账号状态后再试。',
      unknown: '无法确认连接结果，请重新打开插件详情核对账号状态，再决定是否重试。',
      errors: {
        NO_CLIENT_CONFIG: '插件缺少应用身份配置，请更新插件。',
        INVALID_CONFIG: '插件的授权配置无效，请更新插件。',
        LISTEN_FAILED: '本机授权回调端口被占用，请关闭占用该端口的程序后重试。',
        CALLBACK_INVALID: '授权回调校验失败，请重试。',
        EXCHANGE_FAILED: '腾讯文档没有发放登录凭证，请重试；多次失败请更新插件。',
        NETWORK: '连不上腾讯文档，请检查网络后重试。',
        SERVICE_UNAVAILABLE: '腾讯文档授权服务暂时不可用，请稍后重试。',
        TIMEOUT: '等待授权超时，请重试。',
        CANCELLED: '授权已取消。',
        ACCOUNT_LIMIT: '已达到账号数量上限，请先断开不用的账号。',
        VAULT_WRITE_FAILED: '账号保存失败，请重试。'
      }
    },
    en: {
      intro: 'After you connect, Cindy reads and edits the Tencent Docs this account can access, only when you ask. Access requested: read and edit documents. You can connect both Personal and Enterprise; Cindy asks which one to use each time.',
      sections: {
        personal: { title: 'Personal', hint: 'Tencent Docs account signed in with QQ or Weixin (docs.qq.com)', accountName: 'Personal account' },
        enterprise: { title: 'Enterprise', hint: 'Your organization’s Tencent Docs account (saas.docs.qq.com)', accountName: 'Enterprise account' }
      },
      token: {
        title: 'Personal Token (optional)',
        hint: 'Deleting, moving and changing sharing need Tencent Docs management access, which one-click sign-in cannot get. Add a personal Token for your Personal account and Cindy uses it only for those actions. Get it with the same account as above.',
        placeholder: 'Paste personal Token',
        save: 'Save',
        clear: 'Clear',
        confirmClear: 'Confirm clear',
        saved: 'Saved',
        savedTail: 'Saved, ending in {tail}',
        notSaved: 'Not set',
        get: 'Get it from the Tencent Docs open platform ↗',
        savedOk: 'Personal Token saved.',
        clearedOk: 'Personal Token cleared.',
        failed: 'Could not save. Try again.'
      },
      connectFirst: 'Connect account',
      connectMore: 'Connect another account',
      connectedOn: 'Connected {date}',
      connected: 'Connected',
      expired: 'Authorization expired. Reconnect to continue.',
      scopeStale: 'Requested access has changed. Reconnecting is recommended.',
      isDefault: 'Default',
      reconnect: 'Reconnect',
      makeDefault: 'Make default',
      disconnect: 'Disconnect',
      confirmDisconnect: 'Confirm disconnect',
      opening: 'Your browser is open. Sign in to Tencent Docs and approve access…',
      reconnecting: 'Your browser is open. Approve access again with the same account…',
      connectedOk: 'Account connected.',
      reconnectedOk: 'Reconnected. The expired authorization was removed.',
      disconnectedOk: 'Account disconnected.',
      defaultOk: 'Default account updated.',
      loadFailed: 'Could not load account status. Close and reopen the plugin details.',
      actionFailed: 'The action did not finish. Reopen the plugin details, check the account status, and try again.',
      unknown: 'Connection outcome is unknown. Reopen plugin details and check the account status before deciding whether to retry.',
      errors: {
        NO_CLIENT_CONFIG: 'The plugin is missing its app identity. Update the plugin.',
        INVALID_CONFIG: 'The plugin authorization settings are invalid. Update the plugin.',
        LISTEN_FAILED: 'The local sign-in callback port is in use. Close the program using it and try again.',
        CALLBACK_INVALID: 'The sign-in callback could not be verified. Try again.',
        EXCHANGE_FAILED: 'Tencent Docs did not issue sign-in credentials. Try again, or update the plugin if it keeps failing.',
        NETWORK: 'Cannot reach Tencent Docs. Check your network and try again.',
        SERVICE_UNAVAILABLE: 'The Tencent Docs sign-in service is temporarily unavailable. Try again later.',
        TIMEOUT: 'Timed out waiting for approval. Try again.',
        CANCELLED: 'Sign-in was cancelled.',
        ACCOUNT_LIMIT: 'Account limit reached. Disconnect an account you no longer use first.',
        VAULT_WRITE_FAILED: 'Could not save the account. Try again.'
      }
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var t = MESSAGES.en;
  var locale = 'en';
  var busy = false;
  var accountsByKey = {};
  var pendingDisconnect = null;
  var pendingTimer = null;
  var tokenState = { saved: false, tail: null };
  var tokenClearArmed = false;

  function notifyChanged() {
    try { new BroadcastChannel(CHANNEL).postMessage({ type: 'account-changed' }); } catch (_err) { /* 旧宿主忽略 */ }
  }

  function setStatus(text, isError) {
    var el = $('status');
    el.textContent = text || '';
    el.className = isError ? 'error' : '';
  }

  function formatDate(value) {
    if (value === undefined || value === null || value === '') return '';
    var date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_err) {
      return date.toISOString().slice(0, 10);
    }
  }

  function connectError(result) {
    var code = result && result.error ? String(result.error) : '';
    var message = t.errors[code] || t.unknown;
    var detail = result && result.detail ? String(result.detail).trim() : '';
    return detail ? message + (locale === 'zh-CN' ? '（' + detail + '）' : ' (' + detail + ')') : message;
  }

  async function loadLocale() {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 2000);
    try {
      var response = await fetch('/app-context', { signal: controller.signal });
      if (response.ok) {
        var data = await response.json();
        var requested = data && data.context && data.context.locale;
        if (Object.prototype.hasOwnProperty.call(MESSAGES, requested)) locale = requested;
      }
    } catch (_err) {
      locale = 'en';
    } finally {
      clearTimeout(timer);
    }
    t = MESSAGES[locale];
    document.documentElement.lang = locale;
    $('intro').textContent = t.intro;
  }

  function button(label, className, onClick) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'action' + (className ? ' ' + className : '');
    el.textContent = label;
    el.disabled = busy;
    el.addEventListener('click', onClick);
    return el;
  }

  function renderAccount(section, account, index, multiple) {
    var copy = t.sections[section.id];
    var row = document.createElement('div');
    row.className = 'account';

    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (account.avatarDataUrl) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = account.avatarDataUrl;
      avatar.appendChild(img);
    } else {
      // 腾讯文档不提供账号头像，用插件图标代替（单字头像缩小后容易被看成箭头）。
      var icon = document.createElement('img');
      icon.alt = '';
      icon.src = '/assets/icon.png';
      icon.className = 'avatar-icon';
      avatar.appendChild(icon);
    }
    row.appendChild(avatar);

    var identity = document.createElement('div');
    identity.className = 'identity';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = account.label || (multiple ? copy.accountName + ' ' + (index + 1) : copy.accountName);
    if (multiple && account.isDefault) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = t.isDefault;
      name.appendChild(badge);
    }
    identity.appendChild(name);
    var meta = document.createElement('div');
    var expired = account.status === 'expired';
    meta.className = 'meta' + (expired ? ' expired' : '');
    if (expired) {
      meta.textContent = t.expired;
    } else if (account.scopeStale) {
      meta.textContent = t.scopeStale;
    } else {
      var date = formatDate(account.createdAt);
      meta.textContent = date ? t.connectedOn.replace('{date}', date) : t.connected;
    }
    identity.appendChild(meta);
    row.appendChild(identity);

    var actions = document.createElement('div');
    actions.className = 'actions';
    if (expired || account.scopeStale) {
      actions.appendChild(button(t.reconnect, 'primary', function () { void connect(section, account); }));
    }
    if (multiple && !account.isDefault && !expired) {
      actions.appendChild(button(t.makeDefault, '', function () { void makeDefault(section, account); }));
    }
    var pendingId = section.key + ':' + account.id;
    var confirming = pendingDisconnect === pendingId;
    actions.appendChild(button(confirming ? t.confirmDisconnect : t.disconnect, 'danger', function () {
      if (pendingDisconnect === pendingId) {
        clearPending();
        void disconnect(section, account);
      } else {
        armDisconnect(pendingId);
      }
    }));
    row.appendChild(actions);
    return row;
  }

  function render() {
    var root = $('sections');
    root.textContent = '';
    SECTIONS.forEach(function (section) {
      var copy = t.sections[section.id];
      var accounts = accountsByKey[section.key] || [];
      var wrap = document.createElement('div');
      wrap.className = 'section';
      var title = document.createElement('div');
      title.className = 'title';
      title.textContent = copy.title;
      wrap.appendChild(title);
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = copy.hint;
      wrap.appendChild(hint);

      var list = document.createElement('div');
      list.className = 'account-list';
      var multiple = accounts.length > 1;
      accounts.forEach(function (account, index) {
        list.appendChild(renderAccount(section, account, index, multiple));
      });
      var connectButton = document.createElement('button');
      connectButton.type = 'button';
      connectButton.className = 'account-connect';
      connectButton.disabled = busy;
      var plus = document.createElement('span');
      plus.className = 'plus';
      plus.setAttribute('aria-hidden', 'true');
      plus.textContent = '+';
      var label = document.createElement('span');
      label.textContent = accounts.length ? t.connectMore : t.connectFirst;
      connectButton.appendChild(plus);
      connectButton.appendChild(label);
      connectButton.addEventListener('click', function () { void connect(section, null); });
      list.appendChild(connectButton);
      wrap.appendChild(list);
      root.appendChild(wrap);
    });
    if ($('token').childNodes.length) renderToken();
  }

  function clearPending() {
    pendingDisconnect = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function armDisconnect(id) {
    clearPending();
    pendingDisconnect = id;
    pendingTimer = setTimeout(function () { clearPending(); render(); }, CONFIRM_WINDOW_MS);
    render();
  }

  function renderToken() {
    var copy = t.token;
    var root = $('token');
    root.textContent = '';
    var title = document.createElement('div');
    title.className = 'title';
    title.textContent = copy.title;
    root.appendChild(title);
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = copy.hint;
    root.appendChild(hint);
    var box = document.createElement('div');
    box.className = 'token-box';
    var status = document.createElement('div');
    status.className = 'token-status' + (tokenState.saved ? ' saved' : '');
    status.textContent = tokenState.saved ? (tokenState.tail ? copy.savedTail.replace('{tail}', tokenState.tail) : copy.saved) : copy.notSaved;
    box.appendChild(status);
    var row = document.createElement('div');
    row.className = 'token-row';
    var input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = copy.placeholder;
    input.disabled = busy;
    row.appendChild(input);
    row.appendChild(button(copy.save, 'primary', function () {
      var value = input.value.trim();
      input.value = '';
      if (value) void saveToken(value);
    }));
    if (tokenState.saved) {
      row.appendChild(button(tokenClearArmed ? copy.confirmClear : copy.clear, 'danger', function () {
        if (tokenClearArmed) {
          tokenClearArmed = false;
          void clearToken();
        } else {
          tokenClearArmed = true;
          renderToken();
          setTimeout(function () { tokenClearArmed = false; renderToken(); }, CONFIRM_WINDOW_MS);
        }
      }));
    }
    box.appendChild(row);
    var link = document.createElement('a');
    link.className = 'token-link';
    link.href = TOKEN_URL;
    link.textContent = copy.get;
    box.appendChild(link);
    root.appendChild(box);
  }

  async function loadToken() {
    try {
      var response = await fetch('/secrets');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var list = await response.json();
      var entry = Array.isArray(list) ? list.find(function (item) { return item && item.key === TOKEN_KEY; }) : null;
      tokenState = { saved: Boolean(entry && entry.saved), tail: entry && entry.tail ? String(entry.tail) : null };
    } catch (_err) {
      tokenState = { saved: false, tail: null };
    }
    renderToken();
  }

  function saveToken(value) {
    return withBusy(async function () {
      try {
        // 值直接交给宿主保管，不写进 /kv、日志或任何页面状态。
        var response = await fetch('/secrets/' + TOKEN_KEY, { method: 'PUT', body: JSON.stringify({ value: value }) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        setStatus(t.token.savedOk, false);
      } catch (_err) {
        setStatus(t.token.failed, true);
      }
    });
  }

  function clearToken() {
    return withBusy(async function () {
      try {
        var response = await fetch('/secrets/' + TOKEN_KEY, { method: 'DELETE' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        setStatus(t.token.clearedOk, false);
      } catch (_err) {
        setStatus(t.token.failed, true);
      }
    });
  }

  async function load() {
    try {
      var response = await fetch('/oauth');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var list = await response.json();
      if (!Array.isArray(list)) throw new Error('invalid response');
      accountsByKey = {};
      SECTIONS.forEach(function (section) {
        var entry = list.find(function (item) { return item && item.key === section.key; });
        accountsByKey[section.key] = entry && Array.isArray(entry.accounts) ? entry.accounts : [];
      });
      render();
    } catch (_err) {
      accountsByKey = {};
      render();
      setStatus(t.loadFailed, true);
    }
  }

  async function withBusy(task) {
    if (busy) return;
    busy = true;
    render();
    try {
      await task();
    } finally {
      busy = false;
      await load();
      await loadToken();
    }
  }

  function connect(section, target) {
    return withBusy(async function () {
      setStatus(target ? t.reconnecting : t.opening, false);
      try {
        var response = await fetch('/oauth/' + section.key + '/connect', { method: 'POST' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
        if (!result || !result.ok) {
          setStatus(connectError(result), true);
          return;
        }
        notifyChanged();
        var fresh = result.account;
        if (target && fresh && fresh.id && fresh.id !== target.id) {
          // 腾讯文档不提供账号身份端点，重新授权会生成新账号记录；
          // 用户点的是“重新连接”，移除被替换的那条，并沿用它的默认身份。
          if (target.isDefault) {
            await fetch('/oauth/' + section.key + '/default', { method: 'POST', body: JSON.stringify({ accountId: fresh.id }) });
          }
          await fetch('/oauth/' + section.key + '/accounts/' + encodeURIComponent(target.id), { method: 'DELETE' });
          setStatus(t.reconnectedOk, false);
        } else {
          setStatus(t.connectedOk, false);
        }
      } catch (_err) {
        setStatus(t.unknown, true);
      }
    });
  }

  function disconnect(section, account) {
    return withBusy(async function () {
      try {
        var response = await fetch('/oauth/' + section.key + '/accounts/' + encodeURIComponent(account.id), { method: 'DELETE' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        notifyChanged();
        setStatus(t.disconnectedOk, false);
      } catch (_err) {
        setStatus(t.actionFailed, true);
      }
    });
  }

  function makeDefault(section, account) {
    return withBusy(async function () {
      try {
        var response = await fetch('/oauth/' + section.key + '/default', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        notifyChanged();
        setStatus(t.defaultOk, false);
      } catch (_err) {
        setStatus(t.actionFailed, true);
      }
    });
  }

  void loadLocale().then(load).then(loadToken);
})();
