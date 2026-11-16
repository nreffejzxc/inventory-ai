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
  // The config value is the API origin only (the console server refuses a path).
  // Every platform endpoint lives under the API's `/api/platform` mount.
  var API = String(config.apiOrigin || '').replace(/\/+$/, '') + '/api/platform';
  var CSRF_COOKIE = 'platform_csrf';
  var state = {
    csrf: '',
    admin: null,
    mfaToken: '',
    methods: [],
    enrollmentToken: '',
    view: 'overview',
    auditNextBefore: null,
    operations: null,
    operationsAt: 0,
    assignees: [],
    selectedTicket: null,
    loadToken: 0,
    sessionEpoch: 0
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

  function hasCapability(capability) {
    return !!(state.admin && Array.isArray(state.admin.capabilities) && state.admin.capabilities.indexOf(capability) >= 0);
  }

  function formatBytes(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    if (number < 1024) return number + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var size = number / 1024;
    var index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[index];
  }

  function formatDuration(seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 60) return Math.round(value) + ' s';
    if (value < 3600) return Math.floor(value / 60) + ' min';
    if (value < 86400) return (value / 3600).toFixed(1) + ' h';
    return (value / 86400).toFixed(1) + ' d';
  }

  function renderCards(host, items) {
    clear(host);
    items.forEach(function (item) {
      host.appendChild(card(item.label, item.value, item.detail, item.tone));
    });
  }

  function renderChecks(host, checks) {
    clear(host);
    if (!checks || checks.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      text(empty, 'No checks are reported.');
      host.appendChild(empty);
      return;
    }
    checks.forEach(function (check) {
      var row = document.createElement('div');
      row.className = 'check-item';
      var dot = document.createElement('span');
      dot.className = 'check-dot ' + String(check.status || '').toLowerCase();
      var body = document.createElement('div');
      var title = document.createElement('strong');
      text(title, check.label || check.key || 'Check');
      var detail = document.createElement('p');
      text(detail, check.detail || '');
      body.appendChild(title);
      body.appendChild(detail);
      row.appendChild(dot);
      row.appendChild(body);
      host.appendChild(row);
    });
  }

  function renderNotes(host, notes) {
    clear(host);
    (notes || []).forEach(function (note) {
      var row = document.createElement('p');
      text(row, note);
      host.appendChild(row);
    });
    if (!host.firstChild) {
      var empty = document.createElement('p');
      text(empty, 'No limitations reported by this source.');
      host.appendChild(empty);
    }
  }

  function showOnly(id) {
    ['login-view', 'mfa-view', 'enroll-view', 'dashboard-view'].forEach(function (viewId) {
      var node = byId(viewId);
      if (viewId === id) show(node); else hide(node);
    });
    if (id === 'login-view' || id === 'mfa-view' || id === 'enroll-view') hide(byId('topbar-session'));
  }

  function resetToLogin() {
    state.sessionEpoch += 1;
    state.csrf = '';
    state.admin = null;
    state.mfaToken = '';
    state.methods = [];
    state.enrollmentToken = '';
    hide(byId('topbar-session'));
    showOnly('login-view');
    byId('password').value = '';
    byId('recovery-code').value = '';
    hide(byId('recovery-login-panel'));
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
    var epoch = state.sessionEpoch;
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
      if (response.status === 401 && opts.auth !== false && path !== '/auth/me' && epoch === state.sessionEpoch) {
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
    state.sessionEpoch += 1;
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
    var caps = Array.isArray(admin.capabilities) ? admin.capabilities : [];
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
      var required = button.getAttribute('data-capability');
      if (required && caps.indexOf(required) < 0) button.hidden = true;
    });
    byId('nav-audit').hidden = caps.indexOf('platform.audit.read') < 0;
    if (caps.indexOf('platform.metrics.read') < 0 && state.view === 'overview') state.view = 'live';
    renderSecurity();
    switchView(state.view || 'overview');
  }

  function setViewChrome(view) {
    var titles = {
      overview: {
        eyebrow: 'Platform-wide',
        title: 'Operations overview',
        subtitle: 'One place to judge platform health, AI usage and open operational concerns.'
      },
      live: {
        eyebrow: 'Right now',
        title: 'Live system status',
        subtitle: 'Readiness, process health and configuration observed from the running API.'
      },
      infrastructure: {
        eyebrow: 'Monitoring',
        title: 'Infrastructure & API',
        subtitle: 'Process, database and integration facts that are actually observable.'
      },
      ai: {
        eyebrow: 'Monitoring',
        title: 'AI operations',
        subtitle: 'Free-first routing, fallback, latency, failures and provider-reported cost.'
      },
      database: {
        eyebrow: 'Monitoring',
        title: 'Database & storage',
        subtitle: 'Connection readiness and aggregate MongoDB storage facts.'
      },
      mobile: {
        eyebrow: 'Monitoring',
        title: 'Mobile app health',
        subtitle: 'What the Android app actually reports — currently no telemetry.'
      },
      jobs: {
        eyebrow: 'Monitoring',
        title: 'Background jobs',
        subtitle: 'External delivery configuration and the job history this deployment does not keep.'
      },
      businesses: {
        eyebrow: 'Operations',
        title: 'Businesses & tenants',
        subtitle: 'Aggregate tenant and activity counts with deliberately no tenant detail.'
      },
      inventory: {
        eyebrow: 'Operations',
        title: 'Inventory analytics',
        subtitle: 'Platform-wide operational counts from inventory and its movement ledger.'
      },
      support: {
        eyebrow: 'Operations',
        title: 'Support center',
        subtitle: 'Internal tickets and investigation notes. No tenant data is linked.'
      },
      errors: {
        eyebrow: 'Operations',
        title: 'Errors & incidents',
        subtitle: 'Durable 5xx events and bounded groups. No request bodies or messages.'
      },
      team: {
        eyebrow: 'Security & team',
        title: 'Team management',
        subtitle: 'Platform administrators, roles and capabilities.'
      },
      audit: {
        eyebrow: 'Security',
        title: 'Audit trail',
        subtitle: 'Sign-ins, refusals, report reads and MFA changes. Append-only.'
      },
      security: {
        eyebrow: 'Your identity',
        title: 'Security & access',
        subtitle: 'The platform realm, your second factor and registered keys.'
      },
      deployments: {
        eyebrow: 'Releases',
        title: 'Deployments & releases',
        subtitle: 'The build answering requests and the boot observations recorded since enablement.'
      },
      checks: {
        eyebrow: 'Releases',
        title: 'System checks & reports',
        subtitle: 'Real configuration predicates and the monitoring sources that are unavailable.'
      }
    };
    var chrome = titles[view] || titles.overview;
    text(byId('view-eyebrow'), chrome.eyebrow);
    text(byId('view-title'), chrome.title);
    text(byId('view-subtitle'), chrome.subtitle);
    var operational = ['overview', 'live', 'infrastructure', 'ai', 'database', 'businesses', 'inventory', 'errors', 'checks'];
    byId('days').closest('.select-label').hidden = operational.indexOf(view) < 0;
    byId('refresh-button').hidden = operational.indexOf(view) < 0 && ['support', 'team', 'deployments', 'audit'].indexOf(view) < 0;
  }

  function switchView(view) {
    state.view = view;
    ['overview', 'live', 'infrastructure', 'ai', 'database', 'mobile', 'jobs', 'businesses', 'inventory', 'support', 'errors', 'team', 'deployments', 'checks', 'audit', 'security'].forEach(function (name) {
      var section = byId('view-' + name);
      if (name === view) show(section); else hide(section);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
      if (button.dataset.view === view) button.classList.add('active');
      else button.classList.remove('active');
    });
    setViewChrome(view);
    showError('dashboard-error', '');
    if (view === 'live' || view === 'checks') loadStatus();
    else if (['overview', 'infrastructure', 'ai', 'database', 'businesses', 'inventory', 'errors'].indexOf(view) >= 0) loadOperations();
    if (view === 'support') loadSupport();
    if (view === 'team') loadTeam();
    if (view === 'deployments') loadDeployments();
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
    var businesses = data.platform && data.platform.businesses ? data.platform.businesses : {};
    var accounts = data.platform && data.platform.accounts ? data.platform.accounts : {};
    var ai = data.ai || {};
    var issues = data.issues || {};
    var usage = data.usage || {};
    var support = data.support || {};
    renderCards(byId('overview-cards'), [
      { label: 'Businesses', value: formatNumber(businesses.total), detail: formatNumber(businesses.active) + ' active · ' + formatNumber(businesses.newInWindow) + ' new' },
      { label: 'Active members', value: formatNumber(usage.activeMembers && usage.activeMembers.inWindow), detail: formatNumber(accounts.active) + ' active accounts' },
      { label: 'AI turns', value: formatNumber(ai.turns), detail: formatPercent(ai.successRate) + ' succeeded', tone: ai.failedTurns > 0 ? 'warn' : 'good' },
      { label: 'Free-model share', value: formatPercent(ai.freeRate), detail: formatNumber(ai.freeTurns) + ' of ' + formatNumber(ai.turns) + ' turns' },
      { label: 'Paid fallback', value: formatNumber(ai.paidTurns), detail: formatPercent(ai.failoverRate) + ' of turns failover' },
      { label: 'Open tickets', value: formatNumber(support.unresolved), detail: formatNumber(support.total) + ' total tickets', tone: support.unresolved > 0 ? 'warn' : 'good' },
      { label: '5xx errors', value: formatNumber(issues.count), detail: formatNumber(issues.affectedTenants) + ' tenants affected', tone: issues.count > 0 ? 'bad' : 'good' },
      { label: 'AI cost', value: formatCost(ai.cost && ai.cost.providerReportedUsd), detail: ai.cost && ai.cost.unknownCostTurns ? formatNumber(ai.cost.unknownCostTurns) + ' turns unknown' : 'provider-reported only' }
    ]);

    renderTable(byId('ai-daily'), [
      { label: 'Day', value: function (row) { return row.date; }, className: 'mono nowrap' },
      { label: 'Turns', value: function (row) { return formatNumber(row.turns); }, className: 'num' },
      { label: 'Free', value: function (row) { return formatNumber(row.freeTurns); }, className: 'num' },
      { label: 'Paid', value: function (row) { return formatNumber(row.paidTurns); }, className: 'num' },
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
    text(byId('dashboard-status'), 'Report produced ' + formatTime(data.asOf) + ' · ' + (data.range ? data.range.days : '—') + '-day window · UTC');
    byId('dashboard-status').className = 'status-line good';
  }

  async function loadOperations() {
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
      state.operations = data;
      state.operationsAt = Date.now();
      renderCurrentOperations();
    } catch (error) {
      if (requestId !== state.loadToken) return;
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    } finally {
      busy(byId('refresh-button'), false);
    }
  }

  async function loadStatus() {
    if (!state.admin) return;
    var requestId = ++state.loadToken;
    var status = byId('dashboard-status');
    text(status, 'Loading live status…');
    status.className = 'status-line';
    showError('dashboard-error', '');
    busy(byId('refresh-button'), true, 'Refreshing…');
    try {
      var data = await request('/status');
      if (requestId !== state.loadToken) return;
      state.operations = data;
      state.operationsAt = Date.now();
      if (state.view === 'live') renderLive(data);
      if (state.view === 'checks') renderChecksView(data);
      text(status, 'Live status produced ' + formatTime(new Date().toISOString()) + ' · this process');
      status.className = 'status-line good';
    } catch (error) {
      if (requestId !== state.loadToken) return;
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    } finally {
      busy(byId('refresh-button'), false);
    }
  }

  function renderCurrentOperations() {
    var data = state.operations;
    if (!data) return;
    if (state.view === 'overview') renderOverview(data);
    if (state.view === 'live') renderLive(data);
    if (state.view === 'infrastructure') renderInfrastructure(data);
    if (state.view === 'ai') renderAi(data);
    if (state.view === 'database') renderDatabase(data);
    if (state.view === 'businesses') renderBusinesses(data);
    if (state.view === 'inventory') renderInventory(data);
    if (state.view === 'errors') renderErrors(data);
    if (state.view === 'checks') renderChecksView(data);
    if (state.view === 'security') renderSecurity();
  }

  function renderLive(data) {
    renderService(data.service);
    var usage = data.usage || {};
    var support = data.support || {};
    var security = data.security || {};
    var infra = data.infrastructure || {};
    var liveCards = [
      { label: 'API', value: data.service && data.service.status === 'ok' ? 'Healthy' : 'Unknown', detail: 'This response came from the API process', tone: 'good' },
      { label: 'Database', value: (data.service && data.service.database) || 'unknown', detail: 'Driver connection state', tone: data.service && data.service.database === 'connected' ? 'good' : 'bad' },
      { label: 'Process uptime', value: formatDuration(data.service && data.service.uptimeSeconds), detail: 'Reset by a restart', tone: '' },
      { label: '5xx since boot', value: formatNumber(data.service && data.service.counters && data.service.counters.serverErrorsSinceBoot), detail: data.service && data.service.counters && data.service.counters.lastServerErrorAt ? 'Last ' + formatTime(data.service.counters.lastServerErrorAt) : 'None observed', tone: data.service && data.service.counters && data.service.counters.serverErrorsSinceBoot > 0 ? 'bad' : 'good' },
      { label: 'Commit', value: (data.service && data.service.commit) || 'unknown', detail: 'Deployed build answering', tone: '' }
    ];
    if (data.metricsAvailable !== false) {
      liveCards.splice(4, 0,
        { label: 'Open tickets', value: formatNumber(support.unresolved), detail: formatNumber(support.total) + ' total' },
        { label: 'Platform denials', value: formatNumber(security.deniedCapabilityChecks), detail: 'In the selected window', tone: security.deniedCapabilityChecks > 0 ? 'warn' : 'good' },
        { label: 'Active members', value: formatNumber(usage.activeMembers && usage.activeMembers.inWindow), detail: 'Distinct members in window' }
      );
    }
    renderCards(byId('live-cards'), liveCards);
    renderChecks(byId('live-checks'), (infra.checks || []).filter(function (check) { return check.key !== 'database_stats'; }));
    renderNotes(byId('live-unavailable'), infra.unavailable || []);
  }

  function renderInfrastructure(data) {
    var infra = data.infrastructure || {};
    var processInfo = infra.process || {};
    var db = infra.database || {};
    var integrations = infra.integrations || {};
    renderCards(byId('infra-cards'), [
      { label: 'Uptime', value: formatDuration(processInfo.uptimeSeconds), detail: 'Process since boot' },
      { label: 'RSS memory', value: formatBytes(processInfo.memory && processInfo.memory.rssBytes), detail: 'Node process, not host' },
      { label: 'CPU average', value: Number.isFinite(Number(processInfo.cpuPercent)) ? processInfo.cpuPercent + '%' : '—', detail: 'Process CPU since boot' },
      { label: 'DB latency', value: db.pingMs == null ? '—' : db.pingMs + ' ms', detail: 'dbStats round trip', tone: db.available ? 'good' : 'warn' },
      { label: 'Data size', value: formatBytes(db.dataSizeBytes), detail: 'Logical dataSize' },
      { label: 'Storage size', value: formatBytes(db.storageSizeBytes), detail: 'Allocated storage' },
      { label: 'Collections', value: formatNumber(db.collections), detail: formatNumber(db.objects) + ' objects' },
      { label: 'Integrations', value: integrations.aiConfigured ? 'AI on' : 'AI off', detail: integrations.mailConfigured ? 'Mail on' : 'Mail off' }
    ]);
    renderTable(byId('infra-process'), [
      { label: 'Metric', value: function (row) { return row.label; } },
      { label: 'Value', value: function (row) { return row.value; }, className: 'mono' }
    ], [
      { label: 'Node runtime', value: processInfo.nodeVersion || '—' },
      { label: 'Heap used', value: formatBytes(processInfo.memory && processInfo.memory.heapUsedBytes) },
      { label: 'Heap total', value: formatBytes(processInfo.memory && processInfo.memory.heapTotalBytes) },
      { label: 'External memory', value: formatBytes(processInfo.memory && processInfo.memory.externalBytes) },
      { label: 'Database state', value: db.state || 'unknown' },
      { label: 'Database name', value: db.name || 'unknown' },
      { label: 'Database ready', value: db.ready ? 'yes' : 'no' },
      { label: 'Commit', value: (infra.build && infra.build.commit) || 'unknown' }
    ], 'No process data.');
    renderChecks(byId('infra-integrations'), [
      { label: 'AI provider', status: integrations.aiConfigured ? 'ok' : 'warn', detail: integrations.aiProvider || 'Not configured' },
      { label: 'Transactional mail', status: integrations.mailConfigured ? 'ok' : 'warn', detail: integrations.mailProvider || 'Not configured' },
      { label: 'Firebase Admin', status: integrations.firebaseConfigured ? 'ok' : 'warn', detail: integrations.firebaseConfigured ? 'Credentials configured' : 'Not configured' },
      { label: 'Email verification', status: integrations.emailVerificationConfigured ? 'ok' : 'warn', detail: integrations.emailVerificationConfigured ? 'Flow configured' : 'Unavailable' },
      { label: 'Platform auth', status: integrations.platformAuthConfigured ? 'ok' : 'critical', detail: integrations.platformAuthConfigured ? 'Configured' : 'Missing secret' },
      { label: 'Platform MFA', status: integrations.platformMfaConfigured ? 'ok' : 'critical', detail: integrations.platformMfaConfigured ? 'Configured' : 'Missing key' }
    ]);
    renderChecks(byId('infra-checks'), infra.checks || []);
    renderNotes(byId('infra-unavailable'), infra.unavailable || []);
  }

  function renderAi(data) {
    var ai = data.ai || {};
    var feedback = data.feedback || {};
    var cost = ai.cost || {};
    renderCards(byId('ai-cards'), [
      { label: 'AI turns', value: formatNumber(ai.turns), detail: formatNumber(ai.okTurns) + ' ok · ' + formatNumber(ai.failedTurns) + ' failed' },
      { label: 'Free turns', value: formatNumber(ai.freeTurns), detail: formatPercent(ai.freeRate) + ' of turns', tone: 'good' },
      { label: 'Paid turns', value: formatNumber(ai.paidTurns), detail: formatPercent(ai.paidRate) + ' of turns' },
      { label: 'Failover rate', value: formatPercent(ai.failoverRate), detail: formatNumber(ai.failoverTurns) + ' turns with failover', tone: ai.failoverRate > 0.2 ? 'warn' : '' },
      { label: 'p95 latency', value: Number.isFinite(Number(ai.p95Ms)) ? Math.round(ai.p95Ms) + ' ms' : '—', detail: 'Approximate percentile' },
      { label: 'Empty responses', value: formatNumber(ai.emptyResponses), detail: formatNumber(ai.retries) + ' retries · ' + formatNumber(ai.reasks) + ' re-asks' },
      { label: 'Tokens', value: formatNumber(ai.tokens && ai.tokens.total), detail: formatNumber(ai.tokens && ai.tokens.input) + ' in · ' + formatNumber(ai.tokens && ai.tokens.output) + ' out' },
      { label: 'Provider cost', value: formatCost(cost.providerReportedUsd), detail: formatNumber(cost.unknownCostTurns) + ' unknown-cost turns', tone: cost.unknownCostTurns > 0 ? 'warn' : '' }
    ]);
    renderTable(byId('ai-models'), [
      { label: 'Model', value: function (row) { return row.model; }, className: 'mono' },
      { label: 'Tier', value: function (row) { return row.tier; }, className: 'mono' },
      { label: 'Turns', value: function (row) { return formatNumber(row.turns); }, className: 'num' },
      { label: 'Failed', value: function (row) { return formatNumber(row.failedTurns); }, className: 'num' },
      { label: 'Failovers', value: function (row) { return formatNumber(row.failovers); }, className: 'num' },
      { label: 'p95', value: function (row) { return Number.isFinite(Number(row.p95Ms)) ? Math.round(row.p95Ms) + ' ms' : '—'; }, className: 'num' },
      { label: 'Cost', value: function (row) { return formatCost(row.cost && row.cost.providerReportedUsd); }, className: 'num' }
    ], ai.models || [], 'No model-level turns in this window.');
    renderTable(byId('ai-outcomes'), [
      { label: 'Outcome', value: function (row) { return row.outcome; }, className: 'mono' },
      { label: 'Turns', value: function (row) { return formatNumber(row.count); }, className: 'num' }
    ], ai.outcomes || [], 'No turn outcomes in this window.');
    renderTable(byId('ai-daily-full'), [
      { label: 'Day', value: function (row) { return row.date; }, className: 'mono nowrap' },
      { label: 'Turns', value: function (row) { return formatNumber(row.turns); }, className: 'num' },
      { label: 'Free', value: function (row) { return formatNumber(row.freeTurns); }, className: 'num' },
      { label: 'Paid', value: function (row) { return formatNumber(row.paidTurns); }, className: 'num' },
      { label: 'Failovers', value: function (row) { return formatNumber(row.failovers); }, className: 'num' },
      { label: 'p95', value: function (row) { return Number.isFinite(Number(row.p95Ms)) ? Math.round(row.p95Ms) + ' ms' : '—'; }, className: 'num' }
    ], ai.daily || [], 'No AI turns in this window.');
    renderTable(byId('ai-feedback'), [
      { label: 'Signal', value: function (row) { return row.label; } },
      { label: 'Count', value: function (row) { return formatNumber(row.value); }, className: 'num' }
    ], [
      { label: 'Total feedback', value: feedback.total },
      { label: 'Open review', value: feedback.open },
      { label: 'Up ratings', value: feedback.up },
      { label: 'Down ratings', value: feedback.down },
      { label: 'Down in window', value: feedback.window && feedback.window.down }
    ], 'No feedback.');
  }

  function renderDatabase(data) {
    var infra = data.infrastructure || {};
    var db = infra.database || {};
    renderCards(byId('db-cards'), [
      { label: 'Connection', value: db.ready ? 'Ready' : 'Not ready', detail: db.state || 'unknown', tone: db.ready ? 'good' : 'bad' },
      { label: 'dbStats latency', value: db.pingMs == null ? '—' : db.pingMs + ' ms', detail: 'Cached 30 seconds' },
      { label: 'Data size', value: formatBytes(db.dataSizeBytes), detail: 'Logical bytes' },
      { label: 'Storage size', value: formatBytes(db.storageSizeBytes), detail: 'Allocated bytes' },
      { label: 'Index size', value: formatBytes(db.indexSizeBytes), detail: formatNumber(db.indexes) + ' indexes' },
      { label: 'Objects', value: formatNumber(db.objects), detail: formatNumber(db.collections) + ' collections' },
      { label: 'Average object', value: formatBytes(db.avgObjectSizeBytes), detail: 'dbStats average' },
      { label: 'Database', value: db.name || 'unknown', detail: 'Not a credential' }
    ]);
    renderTable(byId('db-storage'), [
      { label: 'Metric', value: function (row) { return row.label; } },
      { label: 'Value', value: function (row) { return row.value; }, className: 'mono' }
    ], [
      { label: 'Available', value: db.available ? 'yes' : 'no' },
      { label: 'Collections', value: formatNumber(db.collections) },
      { label: 'Documents / objects', value: formatNumber(db.objects) },
      { label: 'Data size', value: formatBytes(db.dataSizeBytes) },
      { label: 'Storage size', value: formatBytes(db.storageSizeBytes) },
      { label: 'Indexes', value: formatNumber(db.indexes) },
      { label: 'Index size', value: formatBytes(db.indexSizeBytes) },
      { label: 'Note', value: db.note || '—' }
    ], 'No database statistics.');
    renderNotes(byId('db-unavailable'), [
      'Slow-query profiling, connection-pool saturation and index health require Atlas/driver metrics not exposed here.',
      'Backup status and restore verification are not available on the current database tier/API. No backup result is claimed.',
      'Collection-level document counts are not enumerated; those scans would add production load without answering an operational question the dbStats aggregate does not.'
    ]);
  }

  function renderBusinesses(data) {
    var businesses = data.platform && data.platform.businesses ? data.platform.businesses : {};
    var accounts = data.platform && data.platform.accounts ? data.platform.accounts : {};
    var usage = data.usage || {};
    var support = data.support || {};
    renderCards(byId('business-cards'), [
      { label: 'Businesses', value: formatNumber(businesses.total), detail: formatNumber(businesses.active) + ' active' },
      { label: 'Suspended', value: formatNumber(businesses.suspended), detail: 'No destructive action offered', tone: businesses.suspended > 0 ? 'warn' : '' },
      { label: 'Archived', value: formatNumber(businesses.archived), detail: 'Retained, not deleted' },
      { label: 'New in window', value: formatNumber(businesses.newInWindow), detail: 'UTC window' },
      { label: 'Accounts', value: formatNumber(accounts.total), detail: formatNumber(accounts.active) + ' active' },
      { label: 'Active members', value: formatNumber(usage.activeMembers && usage.activeMembers.inWindow), detail: 'Distinct in window' },
      { label: 'Tenants active', value: formatNumber(data.platform && data.platform.tenantsActiveInWindow), detail: 'Feature presence in window' },
      { label: 'Open tickets', value: formatNumber(support.unresolved), detail: 'Internal, tenant-free records' }
    ]);
    renderTable(byId('business-window'), [
      { label: 'Status', value: function (row) { return row.label; } },
      { label: 'Count', value: function (row) { return formatNumber(row.value); }, className: 'num' }
    ], [
      { label: 'Active', value: businesses.active },
      { label: 'Suspended', value: businesses.suspended },
      { label: 'Archived', value: businesses.archived },
      { label: 'New in window', value: businesses.newInWindow }
    ], 'No business counts.');
    renderTable(byId('business-note'), [
      { label: 'Signal', value: function (row) { return row.label; } },
      { label: 'Value', value: function (row) { return row.value; }, className: 'mono' }
    ], [
      { label: 'Products active', value: formatNumber(usage.products && usage.products.active) },
      { label: 'Products archived', value: formatNumber(usage.products && usage.products.archived) },
      { label: 'Active locations', value: formatNumber(usage.locations) },
      { label: 'Active suppliers', value: formatNumber(usage.suppliers) },
      { label: 'Open purchase orders', value: formatNumber(usage.openPurchaseOrders) },
      { label: 'Stock movements', value: formatNumber(usage.stockMovements) }
    ], 'No business activity.');
  }

  function renderInventory(data) {
    var inventory = data.inventory || {};
    var usage = data.usage || {};
    var movements = inventory.movements || {};
    renderCards(byId('inventory-cards'), [
      { label: 'Inventory records', value: formatNumber(inventory.records), detail: 'Product × location rows' },
      { label: 'Zero-quantity rows', value: formatNumber(inventory.zeroQuantityRecords), detail: 'Not the same as out-of-stock products', tone: inventory.zeroQuantityRecords > 0 ? 'warn' : '' },
      { label: 'Total quantity', value: formatNumber(inventory.totalQuantity), detail: 'Across every tenant' },
      { label: 'Reserved quantity', value: formatNumber(inventory.reservedQuantity), detail: 'V1 keeps reservations at zero' },
      { label: 'Products active', value: formatNumber(usage.products && usage.products.active), detail: formatNumber(usage.products && usage.products.archived) + ' archived' },
      { label: 'Movements in window', value: formatNumber(usage.stockMovements), detail: 'Ledger rows' },
      { label: 'Locations active', value: formatNumber(usage.locations), detail: 'Current status' },
      { label: 'Purchase orders', value: formatNumber(usage.openPurchaseOrders), detail: 'Open' }
    ]);
    renderTable(byId('inventory-movements'), [
      { label: 'Type', value: function (row) { return row.type; }, className: 'mono' },
      { label: 'Movements', value: function (row) { return formatNumber(row.count); }, className: 'num' },
      { label: 'Quantity', value: function (row) { return formatNumber(row.quantity); }, className: 'num' }
    ], Object.keys(movements).map(function (key) { return { type: key, count: movements[key].count, quantity: movements[key].quantity }; }), 'No movements in this window.');
    renderNotes(byId('inventory-unavailable'), [
      inventory.lowStock && inventory.lowStock.note,
      'New-product creation counts, stock-adjustment event classifications and supplier activity are available only as the aggregate product/movement counts above; they are not separately stored.',
      'No tenant product name, SKU, quantity row or location is exposed by this view.'
    ].filter(Boolean));
  }

  function renderErrors(data) {
    var issues = data.issues || {};
    var security = data.security || {};
    renderCards(byId('error-cards'), [
      { label: '5xx events', value: formatNumber(issues.count), detail: 'In the selected window', tone: issues.count > 0 ? 'bad' : 'good' },
      { label: 'Affected tenants', value: formatNumber(issues.affectedTenants), detail: 'Distinct authenticated tenants' },
      { label: 'Latest event', value: formatTime(issues.latestAt), detail: 'UTC' },
      { label: 'Platform denials', value: formatNumber(security.deniedCapabilityChecks), detail: 'Platform audit denials' },
      { label: 'Failed admin logins', value: formatNumber(security.failedAdminLogins), detail: 'Platform realm' },
      { label: 'MFA failures', value: formatNumber(security.mfaFailures), detail: 'Platform realm' },
      { label: 'Tracked routes', value: formatNumber((issues.byRoute || []).length), detail: 'Bounded groups' },
      { label: 'Tracked codes', value: formatNumber((issues.byCode || []).length), detail: 'Bounded groups' }
    ]);
    renderTable(byId('error-by-route'), [
      { label: 'Route', value: function (row) { return (row.method || '') + ' ' + (row.route || ''); }, className: 'mono' },
      { label: 'Events', value: function (row) { return formatNumber(row.count); }, className: 'num' },
      { label: 'Tenants', value: function (row) { return formatNumber(row.affectedTenants); }, className: 'num' }
    ], issues.byRoute || [], 'No 5xx routes in this window.');
    renderTable(byId('error-by-code'), [
      { label: 'Status', value: function (row) { return row.status; }, className: 'num' },
      { label: 'Code', value: function (row) { return row.code || '—'; }, className: 'mono' },
      { label: 'Events', value: function (row) { return formatNumber(row.count); }, className: 'num' }
    ], issues.byCode || [], 'No 5xx codes in this window.');
    renderTable(byId('error-recent'), [
      { label: 'When', value: function (row) { return formatTime(row.occurredAt); }, className: 'nowrap' },
      { label: 'Status', value: function (row) { return row.status; }, className: 'num' },
      { label: 'Route', value: function (row) { return (row.method || '') + ' ' + (row.route || ''); }, className: 'mono' },
      { label: 'Code', value: function (row) { return row.code || '—'; }, className: 'mono' }
    ], issues.recent || [], 'No recent 5xx events.');
  }

  function renderChecksView(data) {
    var infra = data.infrastructure || {};
    renderChecks(byId('checks-list'), infra.checks || []);
    renderNotes(byId('checks-unavailable'), infra.unavailable || []);
  }

  function ticketBadge(value) {
    var badge = document.createElement('span');
    badge.className = 'badge ' + String(value || '');
    text(badge, value || '—');
    return badge;
  }

  function populateAssignees(select, selected) {
    if (!select) return;
    var current = selected || select.value || '';
    clear(select);
    var unassigned = document.createElement('option');
    unassigned.value = '';
    text(unassigned, 'Unassigned');
    select.appendChild(unassigned);
    (state.assignees || []).forEach(function (admin) {
      var option = document.createElement('option');
      option.value = admin.id;
      text(option, admin.name + ' · ' + admin.role);
      select.appendChild(option);
    });
    select.value = current;
  }

  function loadSupport() {
    if (!hasCapability('platform.support.manage')) return;
    var status = byId('ticket-list-status');
    text(status, 'Loading ticket queue…');
    status.className = 'status-line';
    showError('dashboard-error', '');
    var filter = byId('ticket-status-filter').value;
    var ticketRequest = request('/tickets?limit=50' + (filter ? '&status=' + encodeURIComponent(filter) : ''));
    var assigneeRequest = state.assignees.length ? Promise.resolve(null) : request('/tickets/assignees');
    Promise.all([ticketRequest, assigneeRequest]).then(function (results) {
      var data = results[0];
      if (results[1]) state.assignees = results[1].assignees || [];
      var summary = data.summary || {};
      var unresolved = Number(summary.total || 0) - Number(summary.RESOLVED || 0) - Number(summary.CLOSED || 0);
      renderCards(byId('support-summary'), [
        { label: 'Total tickets', value: formatNumber(summary.total), detail: 'Internal records' },
        { label: 'Unresolved', value: formatNumber(unresolved), detail: 'New through fix in progress', tone: unresolved > 0 ? 'warn' : 'good' },
        { label: 'New', value: formatNumber(summary.NEW || 0), detail: 'Awaiting investigation' },
        { label: 'Escalated', value: formatNumber(summary.ESCALATED || 0), detail: 'Needs developer attention', tone: summary.ESCALATED > 0 ? 'warn' : '' },
        { label: 'Fix in progress', value: formatNumber(summary.FIX_IN_PROGRESS || 0), detail: 'Being worked' },
        { label: 'Resolved', value: formatNumber(summary.RESOLVED || 0), detail: 'Awaiting close' },
        { label: 'Critical', value: formatNumber((data.tickets || []).filter(function (ticket) { return ticket.severity === 'CRITICAL'; }).length), detail: 'In this page' },
        { label: 'Closed', value: formatNumber(summary.CLOSED || 0), detail: 'Retained history' }
      ]);
      populateAssignees(byId('ticket-assignee'));
      populateAssignees(byId('ticket-detail-assignee'));
      renderTable(byId('ticket-list'), [
        { label: 'Ticket', value: function (row) { return row.reference; }, className: 'mono nowrap' },
        { label: 'Title', value: function (row) { return row.title; } },
        { label: 'Priority', value: function (row) { return ticketBadge(row.priority); }, className: 'nowrap' },
        { label: 'Status', value: function (row) { return ticketBadge(row.status); }, className: 'nowrap' },
        { label: 'Assignee', value: function (row) { return row.assignedEmail || '—'; }, className: 'mono' },
        { label: 'Created', value: function (row) { return formatTime(row.createdAt); }, className: 'nowrap' },
        { label: '', value: function (row) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'link-button';
          text(button, 'Open');
          button.addEventListener('click', function () { openTicket(row.id); });
          return button;
        }, className: 'nowrap' }
      ], data.tickets || [], 'No tickets match this filter.');
      text(status, 'Queue loaded ' + formatTime(new Date().toISOString()) + (data.hasMore ? ' · showing newest 50' : ''));
      status.className = 'status-line good';
    }).catch(function (error) {
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    });
  }

  function openTicket(id) {
    showError('dashboard-error', '');
    request('/tickets/' + encodeURIComponent(id)).then(function (data) {
      var ticket = data.ticket;
      state.selectedTicket = ticket;
      text(byId('ticket-detail-title'), ticket.title);
      text(byId('ticket-detail-ref'), ticket.reference);
      var detail = byId('ticket-detail');
      clear(detail);
      var list = document.createElement('dl');
      list.className = 'ticket-detail-list';
      [
        ['Category', ticket.category],
        ['Priority', ticket.priority],
        ['Severity', ticket.severity],
        ['Status', ticket.status],
        ['Created by', ticket.createdByEmail],
        ['Created', formatTime(ticket.createdAt)],
        ['Description', ticket.description]
      ].forEach(function (pair) {
        var dt = document.createElement('dt');
        text(dt, pair[0]);
        var dd = document.createElement('dd');
        text(dd, pair[1] == null ? '—' : pair[1]);
        list.appendChild(dt);
        list.appendChild(dd);
      });
      detail.appendChild(list);
      if ((ticket.notes || []).length) {
        var noteHead = document.createElement('h3');
        text(noteHead, 'Internal notes');
        detail.appendChild(noteHead);
        ticket.notes.forEach(function (note) {
          var row = document.createElement('div');
          row.className = 'ticket-note';
          var body = document.createElement('p');
          text(body, note.body);
          var meta = document.createElement('p');
          meta.className = 'muted';
          text(meta, (note.authorEmail || '—') + ' · ' + formatTime(note.createdAt));
          row.appendChild(body);
          row.appendChild(meta);
          detail.appendChild(row);
        });
      }
      byId('ticket-detail-status').value = ticket.status;
      byId('ticket-detail-priority').value = ticket.priority;
      populateAssignees(byId('ticket-detail-assignee'), ticket.assignedAdminId || '');
      byId('ticket-note').value = '';
      showError('ticket-detail-error', '');
      text(byId('ticket-detail-status-line'), '');
      show(byId('ticket-detail-panel'));
      byId('ticket-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (error) {
      showError('dashboard-error', errorMessage(error));
    });
  }

  function createTicket(event) {
    event.preventDefault();
    showError('ticket-form-error', '');
    var button = byId('ticket-create-button');
    busy(button, true, 'Creating…');
    request('/tickets', {
      method: 'POST',
      body: {
        title: byId('ticket-title').value.trim(),
        description: byId('ticket-description').value.trim(),
        category: byId('ticket-category').value,
        priority: byId('ticket-priority').value,
        severity: byId('ticket-severity').value,
        assignedAdminId: byId('ticket-assignee').value || null
      }
    }).then(function (data) {
      byId('ticket-form').reset();
      text(byId('ticket-form-status'), 'Created ' + data.ticket.reference + '.');
      byId('ticket-form-status').className = 'status-line good';
      loadSupport();
      openTicket(data.ticket.id);
    }).catch(function (error) {
      showError('ticket-form-error', errorMessage(error));
    }).finally(function () {
      busy(button, false);
    });
  }

  function updateTicket() {
    if (!state.selectedTicket) return;
    var button = byId('ticket-update-button');
    showError('ticket-detail-error', '');
    busy(button, true, 'Saving…');
    request('/tickets/' + encodeURIComponent(state.selectedTicket.id), {
      method: 'PATCH',
      body: {
        status: byId('ticket-detail-status').value,
        priority: byId('ticket-detail-priority').value,
        assignedAdminId: byId('ticket-detail-assignee').value || null
      }
    }).then(function (data) {
      state.selectedTicket = data.ticket;
      text(byId('ticket-detail-status-line'), 'Updated ' + data.ticket.reference + '.');
      byId('ticket-detail-status-line').className = 'status-line good';
      openTicket(data.ticket.id);
      loadSupport();
    }).catch(function (error) {
      showError('ticket-detail-error', errorMessage(error));
    }).finally(function () {
      busy(button, false);
    });
  }

  function addTicketNote() {
    if (!state.selectedTicket) return;
    var button = byId('ticket-note-button');
    var body = byId('ticket-note').value.trim();
    if (!body) {
      showError('ticket-detail-error', 'Enter a note first.');
      return;
    }
    showError('ticket-detail-error', '');
    busy(button, true, 'Adding…');
    request('/tickets/' + encodeURIComponent(state.selectedTicket.id) + '/notes', {
      method: 'POST',
      body: { body: body }
    }).then(function (data) {
      state.selectedTicket = data.ticket;
      byId('ticket-note').value = '';
      text(byId('ticket-detail-status-line'), 'Note added.');
      byId('ticket-detail-status-line').className = 'status-line good';
      openTicket(data.ticket.id);
    }).catch(function (error) {
      showError('ticket-detail-error', errorMessage(error));
    }).finally(function () {
      busy(button, false);
    });
  }

  async function loadTeam() {
    var host = byId('team-list');
    clear(host);
    text(byId('team-note'), 'Loading platform team…');
    try {
      var rows;
      if (hasCapability('platform.admin.manage')) {
        var data = await request('/admins');
        rows = (data.admins || []).map(function (admin) {
          return { name: admin.name || admin.email, email: admin.email, role: admin.role, status: admin.status, mfa: admin.mfaEnabled ? 'enrolled' : 'not enrolled', keys: admin.webauthnCredentialCount, recovery: admin.recoveryCodesRemaining };
        });
      } else {
        var assignees = await request('/tickets/assignees');
        rows = (assignees.assignees || []).map(function (admin) {
          return { name: admin.name, email: admin.email, role: admin.role, status: 'ACTIVE', mfa: '—', keys: '—', recovery: '—' };
        });
      }
      renderTable(host, [
        { label: 'Name', value: function (row) { return row.name; } },
        { label: 'Email', value: function (row) { return row.email; }, className: 'mono' },
        { label: 'Role', value: function (row) { return row.role; }, className: 'mono' },
        { label: 'Status', value: function (row) { return row.status; } },
        { label: 'MFA', value: function (row) { return row.mfa; } },
        { label: 'Keys', value: function (row) { return row.keys; }, className: 'num' },
        { label: 'Recovery', value: function (row) { return row.recovery; }, className: 'num' }
      ], rows, 'No platform team members returned.');
      text(byId('team-note'), 'Role and capability assignments are enforced by the backend. This view does not change permissions.');
    } catch (error) {
      text(byId('team-note'), '');
      showError('dashboard-error', errorMessage(error));
    }
  }

  async function loadDeployments() {
    var status = byId('deploy-note');
    text(status, 'Loading deployment history…');
    showError('dashboard-error', '');
    try {
      var data = await request('/deployments?limit=50');
      var current = data.current || {};
      renderCards(byId('deploy-current'), [
        { label: 'Current commit', value: current.commit || 'unknown', detail: 'Build answering this request' },
        { label: 'Environment', value: current.environment || 'unknown', detail: 'Runtime posture' },
        { label: 'Node runtime', value: current.nodeVersion || '—', detail: 'Process runtime' },
        { label: 'Process uptime', value: formatDuration(current.uptimeSeconds), detail: 'Since boot' }
      ]);
      renderTable(byId('deploy-table'), [
        { label: 'Started', value: function (row) { return formatTime(row.startedAt); }, className: 'nowrap' },
        { label: 'Commit', value: function (row) { return row.commit; }, className: 'mono' },
        { label: 'Environment', value: function (row) { return row.environment; } },
        { label: 'Node', value: function (row) { return row.nodeVersion; }, className: 'mono' },
        { label: 'Observed', value: function (row) { return formatTime(row.recordedAt); }, className: 'nowrap' }
      ], data.deployments || [], 'No boot history recorded yet.');
      text(status, data.note || '');
      status.className = 'muted small';
    } catch (error) {
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    }
  }

  function refreshCurrent() {
    if (state.view === 'live' || state.view === 'checks') loadStatus();
    else if (['overview', 'infrastructure', 'ai', 'database', 'businesses', 'inventory', 'errors'].indexOf(state.view) >= 0) loadOperations();
    else if (state.view === 'support') loadSupport();
    else if (state.view === 'team') loadTeam();
    else if (state.view === 'deployments') loadDeployments();
    else if (state.view === 'audit') loadAudit();
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
    var remaining = Number(admin.recoveryCodesRemaining || 0);
    text(byId('security-recovery'), formatNumber(remaining) + ' unused');
    byId('recovery-warning').hidden = remaining > 0;
    var host = byId('capability-list');
    clear(host);
    (admin.capabilities || []).forEach(function (capability) {
      var chip = document.createElement('span');
      chip.className = 'pill';
      text(chip, capability);
      host.appendChild(chip);
    });
    var canManage = Array.isArray(admin.capabilities) && admin.capabilities.indexOf('platform.admin.manage') >= 0;
    byId('admin-panel').hidden = !canManage;
    if (canManage && state.view === 'security') loadAdmins();
    var supported = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
    byId('webauthn-register-button').disabled = !supported;
    if (!supported) {
      showError('webauthn-error', 'This browser does not expose WebAuthn.');
    }
  }

  function adminActionButton(label, className, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ' + className + ' small';
    text(button, label);
    button.addEventListener('click', onClick);
    return button;
  }

  async function loadAdmins() {
    if (!state.admin) return;
    if (!Array.isArray(state.admin.capabilities) || state.admin.capabilities.indexOf('platform.admin.manage') < 0) return;
    var host = byId('admin-list');
    clear(host);
    text(byId('admin-error'), '');
    byId('admin-error').hidden = true;
    text(byId('admin-status'), 'Loading administrators…');
    try {
      var data = await request('/admins');
      clear(host);
      (data.admins || []).forEach(function (admin) {
        var row = document.createElement('div');
        row.className = 'admin-row';
        var main = document.createElement('div');
        main.className = 'admin-row-main';
        var title = document.createElement('strong');
        text(title, admin.email);
        main.appendChild(title);
        var meta = document.createElement('p');
        meta.className = 'muted small';
        text(meta, (admin.role || '—') + ' · ' + (admin.status || '—') + ' · MFA ' + (admin.mfaEnabled ? 'enrolled' : 'not enrolled') + ' · ' + formatNumber(admin.recoveryCodesRemaining || 0) + ' recovery codes');
        main.appendChild(meta);
        (admin.webauthnKeys || []).forEach(function (key) {
          var keyRow = document.createElement('div');
          keyRow.className = 'key-row';
          var label = document.createElement('span');
          text(label, key.label + ' · added ' + formatTime(key.createdAt));
          keyRow.appendChild(label);
          keyRow.appendChild(adminActionButton('Remove key', 'ghost', function () {
            removeAdminKey(admin.id, admin.email, key.id);
          }));
          main.appendChild(keyRow);
        });
        var actions = document.createElement('div');
        actions.className = 'admin-row-actions';
        if (admin.id !== state.admin.id) {
          if (admin.status === 'ACTIVE') {
            actions.appendChild(adminActionButton('Disable', 'secondary', function () {
              changeAdminStatus(admin.id, admin.email, 'DISABLED');
            }));
          } else {
            actions.appendChild(adminActionButton('Enable', 'secondary', function () {
              changeAdminStatus(admin.id, admin.email, 'ACTIVE');
            }));
          }
          actions.appendChild(adminActionButton('Delete', 'ghost', function () {
            deleteAdmin(admin.id, admin.email);
          }));
        }
        row.appendChild(main);
        row.appendChild(actions);
        host.appendChild(row);
      });
      if (!host.firstChild) text(host, 'No platform administrators found.');
      text(byId('admin-status'), '');
    } catch (error) {
      showError('admin-error', errorMessage(error));
      text(byId('admin-status'), '');
    }
  }

  async function changeAdminStatus(id, email, status) {
    try {
      await request('/admins/' + encodeURIComponent(id) + '/status', {
        method: 'PATCH',
        body: { status: status }
      });
      text(byId('admin-status'), email + ' is now ' + status.toLowerCase() + '.');
      await loadAdmins();
    } catch (error) {
      showError('admin-error', errorMessage(error));
    }
  }

  async function deleteAdmin(id, email) {
    if (!window.confirm('Delete ' + email + '? Their sessions are revoked immediately. This cannot be undone.')) return;
    try {
      await request('/admins/' + encodeURIComponent(id), { method: 'DELETE' });
      text(byId('admin-status'), email + ' was deleted.');
      await loadAdmins();
    } catch (error) {
      showError('admin-error', errorMessage(error));
    }
  }

  async function removeAdminKey(id, email, credentialId) {
    if (!window.confirm('Remove this security key from ' + email + '? Their platform sessions will be revoked.')) return;
    try {
      await request('/admins/' + encodeURIComponent(id) + '/webauthn/' + encodeURIComponent(credentialId), { method: 'DELETE' });
      if (id === state.admin.id) {
        resetToLogin();
        showError('login-error', 'Security key removed. Sign in again with another key or TOTP.');
        return;
      }
      text(byId('admin-status'), 'Security key removed from ' + email + '.');
      await loadAdmins();
    } catch (error) {
      showError('admin-error', errorMessage(error));
    }
  }

  async function generateRecoveryCodes() {
    showError('recovery-error', '');
    var password = byId('recovery-password').value;
    var button = byId('recovery-generate-button');
    if (!password) {
      showError('recovery-error', 'Enter your current password to generate codes.');
      return;
    }
    busy(button, true, 'Generating…');
    try {
      var data = await request('/auth/recovery-codes', {
        method: 'POST',
        body: { password: password }
      });
      byId('recovery-password').value = '';
      var list = byId('recovery-code-list');
      text(list, data.codes.join('\n'));
      list.hidden = false;
      state.admin.recoveryCodesRemaining = data.remaining;
      renderSecurity();
      text(byId('recovery-status'), 'New recovery codes generated. Store them offline now; they will not be shown again.');
      byId('recovery-status').className = 'status-line good';
    } catch (error) {
      showError('recovery-error', errorMessage(error));
    } finally {
      busy(button, false);
    }
  }

  async function changePassword() {
    showError('password-error', '');
    var currentPassword = byId('password-current').value;
    var newPassword = byId('password-new').value;
    var confirmPassword = byId('password-confirm').value;
    var button = byId('password-change-button');
    if (!currentPassword || !newPassword) {
      showError('password-error', 'Enter your current and new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showError('password-error', 'The new passwords do not match.');
      return;
    }
    busy(button, true, 'Changing…');
    try {
      await request('/auth/password', {
        method: 'POST',
        body: { currentPassword: currentPassword, newPassword: newPassword }
      });
      resetToLogin();
      showError('login-error', 'Password changed. Every platform session was signed out.');
    } catch (error) {
      showError('password-error', errorMessage(error));
    } finally {
      busy(button, false);
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
        byId('recovery-login-panel').hidden = state.methods.indexOf('recovery') < 0;
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

  async function recoveryLogin() {
    showError('mfa-error', '');
    var button = byId('recovery-login-button');
    var code = byId('recovery-code').value.trim();
    if (!code) {
      showError('mfa-error', 'Enter a recovery code.');
      return;
    }
    busy(button, true, 'Checking…');
    try {
      var data = await request('/auth/mfa/recovery', {
        method: 'POST',
        auth: false,
        body: {
          mfaToken: state.mfaToken,
          recoveryCode: code,
          deviceLabel: 'Platform console'
        }
      });
      setSession(data);
      text(byId('dashboard-status'), 'Recovery code accepted. ' + formatNumber(data.mfa && data.mfa.remaining) + ' unused codes remain.');
    } catch (error) {
      showError('mfa-error', errorMessage(error));
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
    byId('recovery-login-button').addEventListener('click', recoveryLogin);
    byId('recovery-generate-button').addEventListener('click', generateRecoveryCodes);
    byId('password-change-button').addEventListener('click', changePassword);
    byId('admin-refresh').addEventListener('click', loadAdmins);
    byId('logout-button').addEventListener('click', logout);
    byId('refresh-button').addEventListener('click', refreshCurrent);
    byId('audit-refresh').addEventListener('click', loadAudit);
    byId('days').addEventListener('change', loadOperations);
    byId('audit-outcome').addEventListener('change', loadAudit);
    byId('ticket-form').addEventListener('submit', createTicket);
    byId('ticket-refresh').addEventListener('click', loadSupport);
    byId('ticket-status-filter').addEventListener('change', loadSupport);
    byId('ticket-update-button').addEventListener('click', updateTicket);
    byId('ticket-note-button').addEventListener('click', addTicketNote);
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (button) {
      button.addEventListener('click', function () { switchView(button.dataset.view); });
    });
    setInterval(renewSession, 10 * 60 * 1000);
    bootstrap();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
