/* The dedicated Platform Operations console.
 *
 * No token is stored in JavaScript. The API sets an HttpOnly session cookie;
 * this file reads only the readable CSRF cookie and echoes it in a header. The
 * console talks directly to the configured API origin with credentials.
 */
/* global document, window */
(function () {
  'use strict';

  var config = window.__PLATFORM_CONSOLE__ || {};
  var API = String(config.apiOrigin || '').replace(/\/+$/, '');
  var CSRF_COOKIE = 'platform_csrf';
  var state = {
    csrf: '',
    admin: null,
    mfaToken: '',
    methods: [],
    enrollmentToken: '',
    view: 'overview',
    auditNextBefore: null,
    loadToken: 0
  };

  function byId(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function text(node, value) { node.textContent = value == null ? '' : String(value); }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }

  function readCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var index = parts[i].indexOf('=');
      if (index < 0) continue;
      if (parts[i].slice(0, index).trim() !== name) continue;
      try { return decodeURIComponent(parts[i].slice(index + 1).trim()); } catch { return ''; }
    }
    return '';
  }

  function csrfToken() {
    return state.csrf || readCookie(CSRF_COOKIE);
  }

  function showError(id, message) {
    var node = byId(id);
    text(node, message);
    if (message) show(node); else hide(node);
  }

  function busy(button, isBusy, busyText) {
    if (!button) return;
    if (isBusy) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = busyText || 'Working…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  function formatNumber(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat().format(number);
  }

  function formatPercent(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return (Number(value) * 100).toFixed(1) + '%';
  }

  function formatCost(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return '$' + Number(value).toFixed(2);
  }

  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function showOnly(id) {
    ['login-view', 'mfa-view', 'enroll-view', 'dashboard-view'].forEach(function (viewId) {
      var node = byId(viewId);
      if (viewId === id) show(node); else hide(node);
    });
    if (id === 'login-view' || id === 'mfa-view' || id === 'enroll-view') hide(byId('topbar-session'));
  }

  function resetToLogin() {
    state.csrf = '';
    state.admin = null;
    state.mfaToken = '';
    state.methods = [];
    state.enrollmentToken = '';
    hide(byId('topbar-session'));
    showOnly('login-view');
    byId('password').value = '';
    showError('login-error', '');
    showError('mfa-error', '');
    showError('enroll-error', '');
    busy(byId('login-submit'), false);
    busy(byId('mfa-submit'), false);
    busy(byId('enroll-submit'), false);
    byId('email').focus();
  }

  function expiredSession() {
    resetToLogin();
    showError('login-error', 'Your platform session ended. Sign in again.');
  }

  async function request(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json', 'X-Platform-Console': '1' };
    var init = { method: opts.method || 'GET', credentials: 'include', headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.auth !== false) {
      var csrf = csrfToken();
      if (csrf) headers['X-Platform-CSRF'] = csrf;
    }
    var response = await fetch(API + path, init);
    var data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      var error = new Error(data.error || ('Request failed (' + response.status + ')'));
      error.code = data.code || '';
      error.status = response.status;
      if (response.status === 401 && opts.auth !== false && path !== '/auth/me') {
        expiredSession();
      }
      throw error;
    }
    return data;
  }

  function errorMessage(error) {
    if (!error) return 'Something went wrong. Try again.';
    if (error.code) return error.message + ' (' + error.code + ')';
    return error.message || 'Something went wrong. Try again.';
  }

  function setSession(data) {
    state.csrf = data.csrfToken || '';
    state.admin = data.admin || null;
    if (!state.admin) {
      throw new Error('The session response did not include a platform principal.');
    }
    hide(byId('topbar-session'));
    showOnly('dashboard-view');
    showDashboard();
  }

  function showDashboard() {
    var admin = state.admin || {};
    show(byId('topbar-session'));
    text(byId('session-name'), admin.email || '');
    text(byId('session-role'), admin.role || 'PLATFORM');
    var canAudit = Array.isArray(admin.capabilities) && admin.capabilities.indexOf('platform.audit.read') >= 0;
    byId('nav-audit').hidden = !canAudit;
    renderSecurity();
    switchView(state.view || 'overview');
  }

  function setViewChrome(view) {
    var titles = {
      overview: {
        eyebrow: 'Platform-wide',
        title: 'Overview',
        subtitle: 'Aggregate reliability and usage across every tenant.'
      },
      audit: {
        eyebrow: 'Security',
        title: 'Audit trail',
        subtitle: 'Sign-ins, refusals, report reads and MFA changes. Append-only.'
      },
      security: {
        eyebrow: 'Your identity',
        title: 'Security',
        subtitle: 'The platform realm, your second factor and registered keys.'
      }
    };
    var chrome = titles[view] || titles.overview;
    text(byId('view-eyebrow'), chrome.eyebrow);
    text(byId('view-title'), chrome.title);
    text(byId('view-subtitle'), chrome.subtitle);
    byId('days').closest('.select-label').hidden = view !== 'overview';
    byId('refresh-button').hidden = view !== 'overview';
  }

  function switchView(view) {
    state.view = view;
    ['overview', 'audit', 'security'].forEach(function (name) {
      var section = byId('view-' + name);
      if (name === view) show(section); else hide(section);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
      if (button.dataset.view === view) button.classList.add('active');
      else button.classList.remove('active');
    });
    setViewChrome(view);
    showError('dashboard-error', '');
    if (view === 'overview') loadOverview();
    if (view === 'audit') loadAudit();
    if (view === 'security') renderSecurity();
  }

  function card(label, value, detail, tone) {
    var node = document.createElement('article');
    node.className = 'metric';
    var labelNode = document.createElement('div');
    labelNode.className = 'metric-label';
    text(labelNode, label);
    var valueNode = document.createElement('div');
    valueNode.className = 'metric-value' + (tone ? ' ' + tone : '');
    text(valueNode, value);
    var detailNode = document.createElement('div');
    detailNode.className = 'metric-detail';
    text(detailNode, detail || '');
    node.appendChild(labelNode);
    node.appendChild(valueNode);
    node.appendChild(detailNode);
    return node;
  }

  function renderService(service) {
    var host = byId('overview-service');
    clear(host);
    var parts = [
      ['Service', (service && service.status === 'ok' ? 'OK' : 'Unknown'), service && service.database !== 'connected'],
      ['Database', (service && service.database) || 'unknown', service && service.database !== 'connected'],
      ['Environment', (service && service.environment) || 'unknown', false],
      ['Commit', (service && service.commit) || 'local', false],
      ['Uptime', service && Number.isFinite(Number(service.uptimeSeconds)) ? Math.floor(service.uptimeSeconds / 60) + ' min' : '—', false],
      ['5xx since boot', formatNumber(service && service.counters && service.counters.serverErrorsSinceBoot), false]
    ];
    parts.forEach(function (part) {
      var item = document.createElement('span');
      var dot = document.createElement('span');
      dot.className = 'dot' + (part[2] ? ' bad' : '');
      var strong = document.createElement('strong');
      text(strong, part[1]);
      item.appendChild(dot);
      item.appendChild(document.createTextNode(part[0] + ' '));
      item.appendChild(strong);
      host.appendChild(item);
    });
  }

  function renderOverview(data) {
    renderService(data.service);
    var cards = byId('overview-cards');
    clear(cards);
    var businesses = data.platform && data.platform.businesses ? data.platform.businesses : {};
    var accounts = data.platform && data.platform.accounts ? data.platform.accounts : {};
    var ai = data.ai || {};
    var issues = data.issues || {};
    var feedback = data.feedback || {};
    var usage = data.usage || {};
    cards.appendChild(card('Businesses', formatNumber(businesses.total), formatNumber(businesses.active) + ' active'));
    cards.appendChild(card('Accounts', formatNumber(accounts.total), formatNumber(accounts.active) + ' active'));
    cards.appendChild(card('AI turns', formatNumber(ai.turns), formatPercent(ai.successRate) + ' succeeded'));
    cards.appendChild(card('Issues', formatNumber(issues.count), formatNumber(issues.affectedTenants) + ' tenants affected', issues.count > 0 ? 'warn' : 'good'));
    cards.appendChild(card('Feedback', formatNumber(feedback.total), formatNumber(feedback.open) + ' open'));
    cards.appendChild(card('Active members', formatNumber(usage.activeMembers && usage.activeMembers.inWindow), 'in the window'));
    cards.appendChild(card('Products', formatNumber(usage.products && usage.products.active), formatNumber(usage.products && usage.products.archived) + ' archived'));
    cards.appendChild(card('Stock movements', formatNumber(usage.stockMovements), formatCost(ai.cost && ai.cost.totalUsd) + ' AI cost'));

    renderTable(byId('ai-daily'), [
      { label: 'Day', value: function (row) { return row.date; }, className: 'mono nowrap' },
      { label: 'Turns', value: function (row) { return formatNumber(row.turns); }, className: 'num' },
      { label: 'Failed', value: function (row) { return formatNumber(row.failedTurns); }, className: 'num' },
      { label: 'p95', value: function (row) { return Number.isFinite(Number(row.p95Ms)) ? Math.round(row.p95Ms) + ' ms' : '—'; }, className: 'num' }
    ], ai.daily || [], 'No AI turns in this window.');

    renderTable(byId('recent-issues'), [
      { label: 'When', value: function (row) { return formatTime(row.occurredAt); }, className: 'nowrap' },
      { label: 'Status', value: function (row) { return row.status; }, className: 'num' },
      { label: 'Route', value: function (row) { return (row.method || '') + ' ' + (row.route || ''); }, className: 'mono' },
      { label: 'Code', value: function (row) { return row.code || '—'; }, className: 'mono' }
    ], issues.recent || [], 'No recent server errors.');

    renderTable(byId('feature-usage'), [
      { label: 'Feature', value: function (row) { return row.feature; }, className: 'mono' },
      { label: 'Members', value: function (row) { return formatNumber(row.members); }, className: 'num' }
    ], usage.features || [], 'No feature presence in this window.');
  }

  async function loadOverview() {
    if (!state.admin) return;
    var requestId = ++state.loadToken;
    var status = byId('dashboard-status');
    text(status, 'Loading platform report…');
    status.className = 'status-line';
    showError('dashboard-error', '');
    busy(byId('refresh-button'), true, 'Refreshing…');
    try {
      var days = byId('days').value || '7';
      var data = await request('/operations?days=' + encodeURIComponent(days));
      if (requestId !== state.loadToken) return;
      renderOverview(data);
      text(status, 'Report produced ' + formatTime(data.asOf) + ' · ' + (data.range ? data.range.days : days) + '-day window · UTC');
      status.className = 'status-line good';
    } catch (error) {
      if (requestId !== state.loadToken) return;
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    } finally {
      busy(byId('refresh-button'), false);
    }
  }

  function renderTable(host, columns, rows, emptyMessage) {
    clear(host);
    if (!rows || rows.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      text(empty, emptyMessage || 'No rows.');
      host.appendChild(empty);
      return;
    }
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    columns.forEach(function (column) {
      var th = document.createElement('th');
      if (column.className) th.className = column.className;
      text(th, column.label);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (column) {
        var td = document.createElement('td');
        if (column.className) td.className = column.className;
        var value = column.value(row);
        if (value && typeof value === 'object' && value.nodeType) td.appendChild(value);
        else text(td, value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  function outcomeBadge(outcome) {
    var badge = document.createElement('span');
    badge.className = 'badge ' + String(outcome || '');
    text(badge, outcome || '—');
    return badge;
  }

  async function loadAudit() {
    if (!state.admin) return;
    if (!Array.isArray(state.admin.capabilities) || state.admin.capabilities.indexOf('platform.audit.read') < 0) {
      switchView('overview');
      return;
    }
    var host = byId('audit-table');
    clear(host);
    var note = byId('audit-note');
    text(note, 'Loading…');
    busy(byId('audit-refresh'), true, 'Loading…');
    showError('dashboard-error', '');
    try {
      var outcome = byId('audit-outcome').value;
      var path = '/audit?limit=50' + (outcome ? '&outcome=' + encodeURIComponent(outcome) : '');
      var data = await request(path);
      state.auditNextBefore = data.nextBefore;
      renderTable(host, [
        { label: 'When', value: function (row) { return formatTime(row.createdAt); }, className: 'nowrap' },
        { label: 'Outcome', value: function (row) { return outcomeBadge(row.outcome); }, className: 'nowrap' },
        { label: 'Action', value: function (row) { return row.action; }, className: 'mono' },
        {
          label: 'Actor',
          value: function (row) {
            if (!row.actorEmail && !row.actorAdminId) return '—';
            return (row.actorEmail || row.actorAdminId) + (row.actorRole ? ' · ' + row.actorRole : '');
          }
        },
        { label: 'Route', value: function (row) { return row.route || '—'; }, className: 'mono' },
        { label: 'Reason', value: function (row) { return row.reason || '—'; }, className: 'mono' },
        { label: 'Request', value: function (row) { return row.requestId || '—'; }, className: 'mono' }
      ], data.events || [], 'No audit events match.');
      text(note, data.hasMore ? 'Showing the newest 50 events. Load again after new events arrive.' : 'End of the trail.');
    } catch (error) {
      text(note, '');
      showError('dashboard-error', errorMessage(error));
    } finally {
      busy(byId('audit-refresh'), false);
    }
  }

  function renderSecurity() {
    var admin = state.admin;
    if (!admin) return;
    text(byId('security-role'), admin.role || '—');
    text(byId('security-mfa'), admin.mfaEnabled ? 'TOTP enrolled' : 'Not enrolled');
    text(byId('security-keys'), formatNumber(admin.webauthnCredentialCount) + ' registered');
    var host = byId('capability-list');
    clear(host);
    (admin.capabilities || []).forEach(function (capability) {
      var chip = document.createElement('span');
      chip.className = 'pill';
      text(chip, capability);
      host.appendChild(chip);
    });
    var supported = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
    byId('webauthn-register-button').disabled = !supported;
    if (!supported) {
      showError('webauthn-error', 'This browser does not expose WebAuthn.');
    }
  }

  function base64urlToBuffer(value) {
    if (value == null) return null;
    var normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToBase64url(value) {
    var bytes = new Uint8Array(value);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function creationOptions(options) {
    return {
      challenge: base64urlToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: base64urlToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: (options.excludeCredentials || []).map(function (item) {
        return { id: base64urlToBuffer(item.id), type: item.type, transports: item.transports };
      })
    };
  }

  function requestOptions(options) {
    return {
      challenge: base64urlToBuffer(options.challenge),
      timeout: options.timeout,
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials || []).map(function (item) {
        return { id: base64urlToBuffer(item.id), type: item.type, transports: item.transports };
      }),
      userVerification: options.userVerification
    };
  }

  function registrationResponse(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : []
      },
      clientExtensionResults: credential.getClientExtensionResults()
    };
  }

  function assertionResponse(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: bufferToBase64url(credential.response.authenticatorData),
        signature: bufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : null
      },
      clientExtensionResults: credential.getClientExtensionResults()
    };
  }

  async function login(event) {
    event.preventDefault();
    showError('login-error', '');
    var submit = byId('login-submit');
    busy(submit, true, 'Checking…');
    try {
      var data = await request('/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          email: byId('email').value.trim(),
          password: byId('password').value,
          deviceLabel: 'Platform console'
        }
      });
      byId('password').value = '';
      if (data.mfaEnrollmentRequired) {
        state.enrollmentToken = data.enrollmentToken;
        text(byId('enroll-account'), data.admin ? data.admin.email : '');
        showOnly('enroll-view');
        await startEnrollment();
      } else if (data.mfaRequired) {
        state.mfaToken = data.mfaToken;
        state.methods = data.methods || [];
        text(byId('mfa-account'), data.admin ? data.admin.email : '');
        byId('webauthn-login-button').hidden = !(
          state.methods.indexOf('webauthn') >= 0 &&
          window.PublicKeyCredential &&
          navigator.credentials &&
          navigator.credentials.get
        );
        showOnly('mfa-view');
        byId('mfa-code').focus();
      } else {
        throw new Error('The server did not request a second factor.');
      }
    } catch (error) {
      showError('login-error', errorMessage(error));
    } finally {
      busy(submit, false);
    }
  }

  async function startEnrollment() {
    showError('enroll-error', '');
    var submit = byId('enroll-submit');
    busy(submit, true, 'Preparing…');
    try {
      var data = await request('/auth/mfa/enroll/start', {
        method: 'POST',
        auth: false,
        body: { enrollmentToken: state.enrollmentToken }
      });
      state.enrollmentToken = data.enrollmentToken;
      text(byId('enroll-secret'), data.secret);
      text(byId('enroll-issuer'), data.issuer);
      text(byId('enroll-account-name'), data.accountName);
      text(byId('enroll-copy-status'), '');
      byId('enroll-code').value = '';
      byId('enroll-code').focus();
    } catch (error) {
      showError('enroll-error', errorMessage(error));
    } finally {
      busy(submit, false);
    }
  }

  async function confirmEnrollment(event) {
    event.preventDefault();
    showError('enroll-error', '');
    var submit = byId('enroll-submit');
    busy(submit, true, 'Confirming…');
    try {
      var data = await request('/auth/mfa/enroll/confirm', {
        method: 'POST',
        auth: false,
        body: {
          enrollmentToken: state.enrollmentToken,
          code: byId('enroll-code').value.trim(),
          deviceLabel: 'Platform console'
        }
      });
      setSession(data);
    } catch (error) {
      showError('enroll-error', errorMessage(error));
    } finally {
      busy(submit, false);
    }
  }

  async function verifyMfa(event) {
    event.preventDefault();
    showError('mfa-error', '');
    var submit = byId('mfa-submit');
    busy(submit, true, 'Verifying…');
    try {
      var data = await request('/auth/mfa/verify', {
        method: 'POST',
        auth: false,
        body: {
          mfaToken: state.mfaToken,
          code: byId('mfa-code').value.trim(),
          deviceLabel: 'Platform console'
        }
      });
      byId('mfa-code').value = '';
      setSession(data);
    } catch (error) {
      showError('mfa-error', errorMessage(error));
    } finally {
      busy(submit, false);
    }
  }

  async function webAuthnLogin() {
    showError('mfa-error', '');
    var button = byId('webauthn-login-button');
    busy(button, true, 'Waiting for key…');
    try {
      var optionsData = await request('/auth/mfa/webauthn/options', {
        method: 'POST',
        auth: false,
        body: { mfaToken: state.mfaToken }
      });
      var credential = await navigator.credentials.get({
        publicKey: requestOptions(optionsData.options)
      });
      if (!credential) throw new Error('No security key was used.');
      var data = await request('/auth/mfa/webauthn/verify', {
        method: 'POST',
        auth: false,
        body: {
          authenticationToken: optionsData.authenticationToken,
          response: assertionResponse(credential),
          deviceLabel: 'Platform console'
        }
      });
      setSession(data);
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        showError('mfa-error', 'Security key verification was cancelled.');
      } else {
        showError('mfa-error', errorMessage(error));
      }
    } finally {
      busy(button, false);
    }
  }

  async function registerWebAuthn() {
    showError('webauthn-error', '');
    var status = byId('webauthn-status');
    text(status, '');
    status.className = 'status-line';
    var button = byId('webauthn-register-button');
    busy(button, true, 'Waiting for key…');
    try {
      var optionsData = await request('/auth/webauthn/register/options', {
        method: 'POST',
        body: {}
      });
      var credential = await navigator.credentials.create({
        publicKey: creationOptions(optionsData.options)
      });
      if (!credential) throw new Error('No security key was registered.');
      var data = await request('/auth/webauthn/register/verify', {
        method: 'POST',
        body: {
          registrationToken: optionsData.registrationToken,
          response: registrationResponse(credential),
          label: byId('key-label').value.trim() || 'Security key'
        }
      });
      state.admin.webauthnCredentialCount = (state.admin.webauthnCredentialCount || 0) + 1;
      renderSecurity();
      text(status, 'Registered ' + data.label + '. It can now be used at sign-in.');
      status.className = 'status-line good';
      byId('key-label').value = '';
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        showError('webauthn-error', 'Security key registration was cancelled.');
      } else {
        showError('webauthn-error', errorMessage(error));
      }
    } finally {
      busy(button, false);
    }
  }

  async function logout() {
    try { await request('/auth/logout', { method: 'POST', body: {} }); } catch { /* session is ending anyway */ }
    resetToLogin();
  }

  async function renewSession() {
    if (!state.admin) return;
    try {
      var data = await request('/auth/renew', { method: 'POST', body: {} });
      if (data.csrfToken) state.csrf = data.csrfToken;
    } catch {
      /* A failed renewal is not a sign-out; the next API call decides. */
    }
  }

  async function copySecret() {
    var status = byId('enroll-copy-status');
    try {
      await navigator.clipboard.writeText(byId('enroll-secret').textContent || '');
      text(status, 'Copied to the clipboard.');
    } catch {
      text(status, 'Select the key and copy it manually.');
    }
  }

  async function bootstrap() {
    state.csrf = readCookie(CSRF_COOKIE);
    try {
      if (!state.csrf) {
        // The console may be a different origin from the API, so its JS cannot
        // read the API host's CSRF cookie. This GET requires the existing
        // HttpOnly session and the exact console Origin, and only issues a new
        // CSRF value; every other request still needs the header.
        var bootstrapData = await request('/auth/csrf', { auth: false });
        state.csrf = bootstrapData.csrfToken;
      }
      var data = await request('/auth/me');
      state.admin = data.admin;
      setSession({ csrfToken: state.csrf, admin: data.admin });
    } catch (error) {
      if (error.status === 403 && error.code === 'PLATFORM_CSRF_INVALID') {
        state.csrf = readCookie(CSRF_COOKIE);
      }
      showOnly('login-view');
    }
  }

  function wire() {
    byId('login-form').addEventListener('submit', login);
    byId('mfa-form').addEventListener('submit', verifyMfa);
    byId('enroll-form').addEventListener('submit', confirmEnrollment);
    byId('enroll-back').addEventListener('click', resetToLogin);
    byId('mfa-back').addEventListener('click', resetToLogin);
    byId('copy-secret').addEventListener('click', copySecret);
    byId('webauthn-login-button').addEventListener('click', webAuthnLogin);
    byId('webauthn-register-button').addEventListener('click', registerWebAuthn);
    byId('logout-button').addEventListener('click', logout);
    byId('refresh-button').addEventListener('click', loadOverview);
    byId('audit-refresh').addEventListener('click', loadAudit);
    byId('days').addEventListener('change', loadOverview);
    byId('audit-outcome').addEventListener('change', loadAudit);
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
      button.addEventListener('click', function () { switchView(button.dataset.view); });
    });
    setInterval(renewSession, 10 * 60 * 1000);
    bootstrap();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
