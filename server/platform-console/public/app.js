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
    backups: null,
    jobs: null,
    integrity: null,
    operationsAt: 0,
    assignees: [],
    selectedTicket: null,
    loadToken: 0,
    sessionEpoch: 0,
    stepUpToken: '',
    stepUpExpiresAt: 0,
    stepUpPromise: null,
    stepUpResolve: null,
    stepUpReject: null
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
    ['login-view', 'mfa-view', 'enroll-view', 'recovery-setup-view', 'dashboard-view'].forEach(function (viewId) {
      var node = byId(viewId);
      if (viewId === id) show(node); else hide(node);
    });
    if (id === 'login-view' || id === 'mfa-view' || id === 'enroll-view' || id === 'recovery-setup-view') hide(byId('topbar-session'));
  }

  function resetToLogin() {
    state.sessionEpoch += 1;
    state.csrf = '';
    state.admin = null;
    clearStepUp(true);
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
    showError('recovery-setup-error', '');
    showError('recovery-setup-continue-error', '');
    byId('recovery-setup-password').value = '';
    byId('recovery-setup-saved').checked = false;
    byId('recovery-setup-form').hidden = false;
    byId('recovery-setup-result').hidden = true;
    byId('recovery-setup-codes').textContent = '';
    busy(byId('login-submit'), false);
    busy(byId('mfa-submit'), false);
    busy(byId('enroll-submit'), false);
    byId('email').focus();
  }

  function expiredSession() {
    // Only an established session can expire. `state.admin` is set by
    // setSession() and cleared by resetToLogin(), so while a password/MFA
    // challenge is in progress there is no session to end. A late 401 from a
    // request owned by the PREVIOUS session must not clear that new challenge;
    // doing so sent the next security-key click with an empty mfaToken.
    if (!state.admin) return;
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
      var stepUp = activeStepUpToken();
      if (stepUp) headers['X-Platform-Step-Up'] = stepUp;
    }
    var response = await fetch(API + path, init);
    var data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      var error = new Error(data.error || ('Request failed (' + response.status + ')'));
      error.code = data.code || '';
      error.status = response.status;
      var stepUpCredentialFailure =
        path === '/auth/step-up' &&
        (data.code === 'PLATFORM_CURRENT_PASSWORD_INVALID' || data.code === 'PLATFORM_MFA_INVALID');
      if (response.status === 401 && opts.auth !== false && path !== '/auth/me' && !stepUpCredentialFailure && epoch === state.sessionEpoch) {
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
    forgetStepUp();
    state.csrf = data.csrfToken || '';
    state.admin = data.admin || null;
    if (!state.admin) {
      throw new Error('The session response did not include a platform principal.');
    }
    if (Number(state.admin.recoveryCodesRemaining || 0) < 1) {
      showRecoverySetup();
      return;
    }
    hide(byId('topbar-session'));
    showOnly('dashboard-view');
    showDashboard();
  }

  function showRecoverySetup() {
    hide(byId('topbar-session'));
    showOnly('recovery-setup-view');
    text(byId('recovery-setup-account'), state.admin ? state.admin.email : '');
    showError('recovery-setup-error', '');
    showError('recovery-setup-continue-error', '');
    byId('recovery-setup-password').value = '';
    byId('recovery-setup-saved').checked = false;
    byId('recovery-setup-form').hidden = false;
    byId('recovery-setup-result').hidden = true;
    byId('recovery-setup-codes').textContent = '';
    byId('recovery-setup-password').focus();
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
    titles.backups = {
      eyebrow: 'Operations',
      title: 'Backups & restore',
      subtitle: 'Encrypted archives on the backup host, the daily schedule and the runs it recorded.'
    };
    titles.jobs = {
      eyebrow: 'Monitoring',
      title: 'Background jobs',
      subtitle: 'The Windows Scheduled Tasks that operate Inventory AI, their last result and their logs.'
    };
    titles.integrity = {
      eyebrow: 'Monitoring',
      title: 'Integrity monitor',
      subtitle: 'The read-only inventory-integrity audit: heartbeat, latest run and its recent history.'
    };
    titles.readiness = {
      eyebrow: 'Operations',
      title: 'Readiness & outbox',
      subtitle: 'The six required indexes behind /ready, and the audit outbox backlog.'
    };
    var chrome = titles[view] || titles.overview;
    text(byId('view-eyebrow'), chrome.eyebrow);
    text(byId('view-title'), chrome.title);
    text(byId('view-subtitle'), chrome.subtitle);
    var operational = ['overview', 'live', 'infrastructure', 'ai', 'database', 'businesses', 'inventory', 'errors', 'checks'];
    byId('days').closest('.select-label').hidden = operational.indexOf(view) < 0;
    byId('refresh-button').hidden = operational.indexOf(view) < 0 && ['support', 'team', 'deployments', 'audit', 'backups', 'jobs', 'integrity', 'readiness'].indexOf(view) < 0;
  }

  function switchView(view) {
    state.view = view;
    ['overview', 'live', 'infrastructure', 'ai', 'database', 'mobile', 'jobs', 'integrity', 'businesses', 'inventory', 'support', 'errors', 'backups', 'readiness', 'team', 'deployments', 'checks', 'audit', 'security'].forEach(function (name) {
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
    if (view === 'backups') loadBackups();
    if (view === 'jobs') loadJobs();
    if (view === 'integrity') loadIntegrity();
    if (view === 'readiness') { loadReadiness(); loadOutbox(); }
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

  async function loadBackups() {
    var status = byId('backup-list-status');
    text(status, 'Reading backups from this host…');
    status.className = 'status-line';
    showError('dashboard-error', '');
    showError('backup-schedule-error', '');
    try {
      var data = await request('/backups');
      state.backups = data;
      renderBackups(data);
    } catch (error) {
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    }
  }

  function backupDeleteButton(row) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost small';
    button.setAttribute('data-backup-delete', row.name);
    if (state.newestArchive && state.newestArchive === row.name) {
      button.disabled = true;
      button.title = 'The newest archive is protected; the API refuses to delete it.';
      text(button, 'Protected');
      return button;
    }
    text(button, 'Delete');
    return button;
  }

  function renderBackups(data) {
    var host = data.host || {};
    var schedule = data.schedule || {};
    var task = schedule.task || {};
    var archives = data.archives || [];
    var runs = data.runs || [];
    var history = data.history || {};
    var newest = archives.length ? archives[0] : null;
    var lastRun = runs.length ? runs[0] : null;
    var canManage = hasCapability('platform.admin.manage');
    state.newestArchive = newest ? newest.name : null;

    var lastOk = lastRun ? lastRun.outcome === 'SUCCESS' : task.lastResult === 0;
    var lastLabel = lastRun
      ? (lastRun.outcome === 'SUCCESS' ? 'OK' : lastRun.outcome)
      : (task.lastResult === 0 ? 'OK' : (task.lastResult == null ? '—' : 'Failed ' + task.lastResult));

    renderCards(byId('backup-cards'), [
      { label: 'Archives on disk', value: formatNumber(archives.length), detail: host.available ? 'Encrypted, checksum re-read' : 'Not on this host', tone: host.available ? 'good' : 'warn' },
      { label: 'Newest archive', value: newest ? formatBytes(newest.sizeBytes) : '—', detail: newest ? formatTime(newest.createdAt) : 'None' },
      { label: 'Scheduled', value: schedule.time || '—', detail: (schedule.timeZone || '') + (task.nextRunTime ? ' · next ' + formatTime(task.nextRunTime) : '') },
      { label: 'Last run', value: lastLabel, detail: lastRun ? formatTime(lastRun.startedAt) : (task.lastRunTime ? formatTime(task.lastRunTime) : 'No recorded run'), tone: lastOk ? 'good' : (lastRun || task.lastResult != null ? 'bad' : '') }
    ]);

    var hostNode = byId('backup-host');
    clear(hostNode);
    var lines = [];
    lines.push(host.available
      ? 'Archives are readable on this host: ' + host.archiveDir
      : 'This API host cannot see the archive directory, so no backup history can be reported here.');
    lines.push('Archive directory: ' + (host.archiveDir || '—'));
    lines.push('Off-machine copy: ' + (host.copyDir || '—') + (host.copyDirExists ? '' : ' (not present on this host)'));
    lines.push('Scheduled task: ' + (host.taskName || '—'));
    lines.push('Scheduler log: ' + (host.schedulerLog || '—'));
    lines.push('Run history: ' + (history.note || 'unavailable') + (history.source === 'durable' ? '' : ' (source: ' + (history.source || 'unknown') + ')'));
    if (task.error) lines.push(task.error);
    (host.warnings || []).forEach(function (warning) { lines.push(warning); });
    lines.forEach(function (line) {
      var p = document.createElement('p');
      text(p, line);
      hostNode.appendChild(p);
    });

    byId('backup-time').value = schedule.time || '';
    byId('backup-archive-dir').value = host.archiveDir || '';
    byId('backup-copy-dir').value = host.copyDir || '';
    byId('backup-time').disabled = !canManage;
    byId('backup-archive-dir').disabled = !canManage;
    byId('backup-copy-dir').disabled = !canManage;
    byId('backup-schedule-save').hidden = !canManage;
    byId('backup-run-now').hidden = !canManage;

    var columns = [
      { label: 'Archive', value: function (row) { return row.name; }, className: 'mono' },
      { label: 'Created', value: function (row) { return formatTime(row.createdAt); }, className: 'nowrap' },
      { label: 'Size', value: function (row) { return formatBytes(row.sizeBytes); }, className: 'num' },
      { label: 'Checksum', value: function (row) { return row.checksumValid ? 'OK' : (row.sidecarPresent ? 'MISMATCH' : 'NO SIDECAR'); } },
      { label: 'Off-machine copy', value: function (row) { return row.offsite === 'identical' ? 'verified' : (row.offsite === 'differs' ? 'differs' : 'missing'); } }
    ];
    if (canManage) columns.push({ label: '', value: backupDeleteButton });

    renderTable(byId('backup-table'), columns, archives,
      host.available ? 'No encrypted archive on this host yet.' : 'Unavailable from this host.');

    renderTable(byId('backup-runs'), [
      { label: 'Started', value: function (row) { return formatTime(row.startedAt); }, className: 'nowrap' },
      { label: 'Finished', value: function (row) { return row.finishedAt ? formatTime(row.finishedAt) : '—'; }, className: 'nowrap' },
      { label: 'Outcome', value: function (row) { return row.outcome; } },
      { label: 'Trigger', value: function (row) { return row.trigger || '—'; } },
      { label: 'Archive', value: function (row) { return row.archive || '—'; }, className: 'mono' },
      { label: 'SHA-256', value: function (row) { return row.sha256 ? String(row.sha256).slice(0, 12) + '…' : '—'; }, className: 'mono' },
      { label: 'Detail', value: function (row) { return row.detail || ''; } }
    ], runs, history.source === 'durable' ? 'No durable run recorded yet.' : 'No scheduled run recorded on this host.');

    var runsSource = byId('backup-runs-source');
    if (runsSource) text(runsSource, history.source === 'durable' ? 'Durable run records · survive log rotation' : 'Parsed from the scheduler log on this host');

    var listStatus = byId('backup-list-status');
    text(listStatus, 'Read at ' + formatTime(data.asOf) + ' · ' + formatNumber(archives.length) + ' archive(s)');
    listStatus.className = 'status-line';
  }

  async function saveBackupSchedule(event) {
    event.preventDefault();
    var status = byId('backup-schedule-status');
    var button = byId('backup-schedule-save');
    showError('backup-schedule-error', '');
    text(status, '');
    busy(button, true, 'Saving…');
    try {
      var data = await request('/backups/schedule', {
        method: 'PUT',
        body: {
          time: byId('backup-time').value,
          archiveDir: byId('backup-archive-dir').value.trim(),
          copyDir: byId('backup-copy-dir').value.trim()
        }
      });
      state.backups = data;
      renderBackups(data);
      text(status, 'Schedule saved and the Windows task re-registered.');
      status.className = 'status-line good';
      loadBackups();
    } catch (error) {
      // The configuration file is written before the task is re-registered, so a
      // registration failure is a partial result, not a lost one. Reload so the
      // saved time and directories are visible beside the failure.
      if (error && error.code === 'PLATFORM_BACKUP_TASK_FAILED') {
        text(status, errorMessage(error));
        status.className = 'status-line bad';
        loadBackups();
      } else {
        showError('backup-schedule-error', errorMessage(error));
      }
    } finally {
      busy(button, false);
    }
  }

  async function runBackupNow() {
    var status = byId('backup-schedule-status');
    var button = byId('backup-run-now');
    showError('backup-schedule-error', '');
    text(status, '');
    busy(button, true, 'Starting…');
    try {
      var data = await request('/backups/run', { method: 'POST', body: {} });
      text(status, data.started
        ? 'Backup started. It takes about 20 seconds; this view refreshes itself when it finishes.'
        : 'A backup was started moments ago. Wait for it to finish before starting another.');
      status.className = 'status-line good';
      if (data.started) {
        // Two bounded refreshes, not a permanent poll: the run is a child process
        // this page cannot observe directly.
        window.setTimeout(function () { loadBackups(); }, 6000);
        window.setTimeout(function () { loadBackups(); }, 20000);
      }
    } catch (error) {
      showError('backup-schedule-error', errorMessage(error));
    } finally {
      busy(button, false);
    }
  }

  async function deleteBackup(name) {
    if (!window.confirm('Delete ' + name + ' and its checksum from both directories? This cannot be undone.')) return;
    var status = byId('backup-list-status');
    text(status, 'Deleting ' + name + '…');
    showError('dashboard-error', '');
    try {
      var result = await requestWithStepUp('/backups/' + encodeURIComponent(name), { method: 'DELETE' });
      state.newestArchive = null;
      await loadBackups();
      if (result && result.offsiteError) {
        text(status, 'Deleted ' + name + ' locally, but the off-machine copy could not be removed: ' + result.offsiteError);
        status.className = 'status-line bad';
      } else {
        text(status, 'Deleted ' + name + ' and its off-machine copy.');
        status.className = 'status-line good';
      }
    } catch (error) {
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    }
  }

  function formatAgeSpan(seconds) {
    if (seconds == null || !isFinite(seconds)) return '—';
    var total = Math.max(0, Math.round(seconds));
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + minutes + 'm';
    if (minutes) return minutes + 'm';
    return total + 's';
  }

  function noteLines(host, lines) {
    clear(host);
    lines.forEach(function (line) {
      var p = document.createElement('p');
      text(p, line);
      host.appendChild(p);
    });
  }

  async function loadJobs() {
    var status = byId('jobs-list-status');
    text(status, 'Reading scheduled tasks from this host…');
    status.className = 'status-line';
    showError('dashboard-error', '');
    showError('jobs-error', '');
    try {
      var data = await request('/jobs');
      state.jobs = data;
      renderJobs(data);
    } catch (error) {
      text(status, '');
      showError('dashboard-error', errorMessage(error));
    }
  }

  function selectedJob() {
    var data = state.jobs;
    if (!data || !data.jobs || !data.jobs.length) return null;
    var id = byId('jobs-task').value;
    for (var i = 0; i < data.jobs.length; i += 1) {
      if (data.jobs[i].id === id) return data.jobs[i];
    }
    return data.jobs[0];
  }

  function renderJobLog(job) {
    var node = byId('jobs-logs');
    var label = byId('jobs-log-task');
    if (!job) {
      text(label, '');
      text(node, 'No task selected.');
      return;
    }
    text(label, job.taskName + ' · ' + job.log.path);
    text(node, job.log.lines.length ? job.log.lines.join('\n') : (job.log.note || 'No log entries.'));
  }

  function syncJobForm() {
    var job = selectedJob();
    var canManage = hasCapability('platform.admin.manage');
    var hostOk = Boolean(state.jobs && state.jobs.host && state.jobs.host.available);
    byId('jobs-time').value = job && job.schedule.time ? job.schedule.time : '';
    byId('jobs-time').disabled = !canManage || !job || !job.reschedulable;
    byId('jobs-schedule-save').hidden = !canManage;
    byId('jobs-schedule-save').disabled = !canManage || !job || !job.reschedulable;
    byId('jobs-schedule-save').title = job && job.reschedulable
      ? 'Write the time to console-config.json and re-register the task.'
      : 'This task does not run on a daily schedule.';
    byId('jobs-enable').hidden = !canManage;
    byId('jobs-disable').hidden = !canManage;
    byId('jobs-enable').disabled = !canManage || !hostOk || !job || job.state !== 'DISABLED';
    byId('jobs-disable').disabled = !canManage || !hostOk || !job || (job.state !== 'READY' && job.state !== 'RUNNING');
    byId('jobs-enable').title = hostOk ? 'Enable the existing task. A task that is not registered is never created here.' : 'Task state cannot be read from this host.';
    byId('jobs-disable').title = hostOk ? 'Disable the existing task.' : 'Task state cannot be read from this host.';
    renderJobLog(job);
  }

  function renderJobs(data) {
    var jobs = data.jobs || [];
    var host = data.host || {};
    var summary = data.summary || {};
    var disabled = summary.disabled || 0;
    var missing = summary.missing || 0;

    renderCards(byId('jobs-cards'), [
      { label: 'Tasks tracked', value: formatNumber(summary.total || jobs.length), detail: host.available ? 'Read from Task Scheduler' : 'Host state unknown', tone: host.available ? '' : 'warn' },
      { label: 'Ready', value: formatNumber(summary.ready || 0), detail: summary.running ? summary.running + ' currently running' : 'Registered and enabled', tone: 'good' },
      { label: 'Disabled', value: formatNumber(disabled), detail: disabled ? 'Will not run until enabled' : 'None disabled', tone: disabled ? 'warn' : '' },
      { label: 'Not registered', value: formatNumber(missing), detail: missing ? 'Deliberate registration only' : 'None missing', tone: missing ? 'warn' : '' }
    ]);

    text(byId('jobs-source'), host.available
      ? 'Task Scheduler on this host' + (host.taskPrefix ? ' · prefix ' + host.taskPrefix : '')
      : 'Not readable from this API host');

    renderTable(byId('jobs-services'), [
      { label: 'Task', value: function (job) { return job.label + ' — ' + job.taskName; }, className: 'mono' },
      { label: 'State', value: function (job) { return job.stateLabel; } },
      { label: 'Schedule', value: function (job) {
        var description = job.schedule.description;
        if (job.schedule.time && job.schedule.registeredTime && job.schedule.time !== job.schedule.registeredTime) {
          description += ' (task fires at ' + job.schedule.registeredTime + ')';
        }
        return description;
      } },
      { label: 'Next run', value: function (job) { return job.schedule.nextRunTime ? formatTime(job.schedule.nextRunTime) : '—'; }, className: 'nowrap' },
      { label: 'Last run', value: function (job) { return job.lastRunTime ? formatTime(job.lastRunTime) : 'Never'; }, className: 'nowrap' },
      { label: 'Result', value: function (job) { return job.lastResultLabel || '—'; } },
      { label: 'Log', value: function (job) { return job.log.lines.length ? job.log.lines.length + ' line(s)' : '—'; } }
    ], jobs, host.available
      ? 'No scheduled task is defined.'
      : 'Unavailable from this host — this is not a report that the tasks are missing.');

    var select = byId('jobs-task');
    var previous = select.value;
    clear(select);
    jobs.forEach(function (job) {
      var option = document.createElement('option');
      option.value = job.id;
      option.textContent = job.label + ' — ' + job.stateLabel;
      select.appendChild(option);
    });
    if (previous) select.value = previous;
    syncJobForm();

    var lines = [];
    if (!host.available) lines.push(host.note || 'Task state cannot be read from this host.');
    (data.warnings || []).forEach(function (warning) { lines.push(warning); });
    jobs.forEach(function (job) {
      if (job.error) lines.push(job.label + ': ' + job.error);
      else if (job.stateDetail) lines.push(job.label + ': ' + job.stateDetail);
      (job.notes || []).forEach(function (note) { lines.push(job.label + ': ' + note); });
      if (job.lastRunOk === false) lines.push(job.label + ': the last run did not succeed (' + (job.lastResultLabel || job.lastResult) + ').');
      if (job.log.note && host.available) lines.push(job.label + ': ' + job.log.note);
    });
    if (!lines.length) lines.push('No warnings: every task and its log were read from this host.');
    noteLines(byId('jobs-unavailable'), lines);

    var status = byId('jobs-list-status');
    text(status, 'Read at ' + formatTime(data.asOf) + ' · ' + formatNumber(jobs.length) + ' task(s)');
    status.className = 'status-line';
  }

  async function changeJobState(enable) {
    var job = selectedJob();
    if (!job) return;
    var status = byId('jobs-status');
    showError('jobs-error', '');
    text(status, '');
    var button = byId(enable ? 'jobs-enable' : 'jobs-disable');
    busy(button, true, enable ? 'Enabling…' : 'Disabling…');
    try {
      var data = await requestWithStepUp('/jobs/' + encodeURIComponent(job.id) + (enable ? '/enable' : '/disable'), { method: 'POST', body: {} });
      state.jobs = data;
      renderJobs(data);
      var updated = selectedJob();
      text(status, (enable ? 'Enabled ' : 'Disabled ') + job.taskName + '. Task Scheduler now reports: ' + (updated ? updated.stateLabel : 'changed') + '.');
      status.className = 'status-line good';
    } catch (error) {
      showError('jobs-error', errorMessage(error));
    } finally {
      busy(button, false);
    }
  }

  async function saveJobSchedule(event) {
    event.preventDefault();
    var job = selectedJob();
    if (!job) return;
    var status = byId('jobs-status');
    showError('jobs-error', '');
    text(status, '');
    var button = byId('jobs-schedule-save');
    busy(button, true, 'Saving…');
    try {
      var data = await request('/jobs/' + encodeURIComponent(job.id) + '/schedule', { method: 'PUT', body: { time: byId('jobs-time').value } });
      state.jobs = data;
      renderJobs(data);
      text(status, 'Schedule saved and ' + job.taskName + ' re-registered.');
      status.className = 'status-line good';
    } catch (error) {
      // The configuration is written before the task is re-registered, so a
      // failure here is a partial result; reload so the saved time is visible.
      if (error && error.code === 'PLATFORM_JOB_TASK_FAILED') {
        text(status, errorMessage(error));
        status.className = 'status-line bad';
        loadJobs();
      } else {
        showError('jobs-error', errorMessage(error));
      }
    } finally {
      busy(button, false);
    }
  }

  async function loadIntegrity() {
    showError('dashboard-error', '');
    try {
      var data = await request('/integrity');
      state.integrity = data;
      renderIntegrity(data);
    } catch (error) {
      showError('dashboard-error', errorMessage(error));
    }
  }

  function renderIntegrity(data) {
    var hb = data.heartbeat || {};
    var view = hb.view || {};
    var latest = data.latest;
    var history = data.history || [];
    var newCount = latest && latest.comparison ? latest.comparison.newCount : null;
    var statusText = latest && latest.status ? String(latest.status).replace(/_/g, ' ') : 'Not checked';

    renderCards(byId('integrity-cards'), [
      { label: 'Heartbeat', value: hb.available ? String(view.state || 'unknown').toUpperCase() : 'Unavailable',
        detail: hb.available
          ? (view.auditStatus || '—') + (view.ageSeconds != null ? ' · ' + formatAgeSpan(view.ageSeconds) + ' ago' : '')
          : 'The database record could not be read',
        tone: !hb.available ? 'bad' : (view.fresh ? 'good' : 'warn') },
      { label: 'Last run', value: latest && latest.checkedAt ? formatTime(latest.checkedAt) : (view.lastCheckedAt ? formatTime(view.lastCheckedAt) : '—'),
        detail: latest && latest.ageSeconds != null ? formatAgeSpan(latest.ageSeconds) + ' old' + (latest.stale ? ' · stale' : ' · fresh') : 'No run file on this host',
        tone: latest && latest.stale ? 'warn' : '' },
      { label: 'New findings', value: newCount == null ? '—' : formatNumber(newCount),
        detail: statusText,
        tone: newCount ? 'bad' : 'good' },
      { label: 'Open findings', value: latest && latest.totals && latest.totals.total != null ? formatNumber(latest.totals.total) : '—',
        detail: latest && latest.baseline && latest.baseline.knownCount != null
          ? formatNumber(latest.baseline.knownCount) + ' in the accepted baseline'
          : 'No baseline recorded' }
    ]);

    noteLines(byId('integrity-heartbeat'), [
      'State: ' + (hb.available ? String(view.state || 'unknown') : 'unavailable') + (hb.available ? (view.fresh ? ' (fresh)' : ' (not fresh)') : ''),
      'Last heartbeat: ' + (view.lastCheckedAt ? formatTime(view.lastCheckedAt) : '—'),
      'Maximum age: ' + (view.maxAgeSeconds != null ? formatAgeSpan(view.maxAgeSeconds) : '—'),
      'Audit status: ' + (view.auditStatus || '—'),
      'New / resolved at last heartbeat: ' + (view.newCount == null ? '—' : formatNumber(view.newCount)) + ' / ' + (view.resolvedCount == null ? '—' : formatNumber(view.resolvedCount)),
      'Stock-in rows scanned: ' + (view.scannedStockIns == null ? '—' : formatNumber(view.scannedStockIns)),
      'Source: ' + (hb.available ? 'integrity_monitor_heartbeats (database) — the same document /api/health/integrity reports' : (hb.error || 'unavailable'))
    ]);

    if (!latest) {
      renderTable(byId('integrity-latest'), [{ label: 'Field', value: function () { return ''; } }], [], 'No latest.json on this host; the heartbeat above is the database record.');
    } else {
      var latestRows = [
        { field: 'Checked at', value: latest.checkedAt ? formatTime(latest.checkedAt) : '—' },
        { field: 'Status', value: statusText },
        { field: 'Database', value: latest.database || '—' },
        { field: 'Stock-in rows scanned', value: latest.scannedStockIns == null ? '—' : formatNumber(latest.scannedStockIns) },
        { field: 'Findings now', value: latest.totals.total == null ? '—' : formatNumber(latest.totals.total) },
        { field: 'Orphan stock-ins', value: latest.totals.orphanStockIns == null ? '—' : formatNumber(latest.totals.orphanStockIns) },
        { field: 'Unreceipted PO stock-ins', value: latest.totals.unreceiptedPoStockIns == null ? '—' : formatNumber(latest.totals.unreceiptedPoStockIns) },
        { field: 'Baseline', value: latest.baseline.knownCount == null ? '—' : formatNumber(latest.baseline.knownCount) + (latest.baseline.acceptedAt ? ' accepted ' + formatTime(latest.baseline.acceptedAt) : '') },
        { field: 'NEW since baseline', value: latest.comparison.newCount == null ? '—' : formatNumber(latest.comparison.newCount) },
        { field: 'UNCHANGED / resolved', value: latest.comparison.resolvedCount == null ? '—' : formatNumber(latest.comparison.resolvedCount) + ' resolved' },
        { field: 'Notification', value: latest.notification || '—' },
        { field: 'New finding ids', value: latest.comparison.newFindingIds.length ? latest.comparison.newFindingIds.slice(0, 5).join(', ') : 'None' }
      ];
      renderTable(byId('integrity-latest'), [
        { label: 'Field', value: function (row) { return row.field; } },
        { label: 'Value', value: function (row) { return row.value; } }
      ], latestRows, 'No latest run.');
    }

    renderTable(byId('integrity-history'), [
      { label: 'Checked', value: function (row) { return row.checkedAt ? formatTime(row.checkedAt) : '—'; }, className: 'nowrap' },
      { label: 'Status', value: function (row) { return row.status ? String(row.status).replace(/_/g, ' ') : '—'; } },
      { label: 'New', value: function (row) { return row.newCount == null ? '—' : formatNumber(row.newCount); }, className: 'num' },
      { label: 'Resolved', value: function (row) { return row.resolvedCount == null ? '—' : formatNumber(row.resolvedCount); }, className: 'num' },
      { label: 'Total', value: function (row) { return row.total == null ? '—' : formatNumber(row.total); }, className: 'num' },
      { label: 'Database', value: function (row) { return row.database || '—'; }, className: 'mono' }
    ], history, 'No history.jsonl on this host — that is not evidence that no run happened.');

    var lines = [
      data.host && data.host.note ? data.host.note : '',
      'Run directory: ' + ((data.host && data.host.historyDir) || '—'),
      'latest.json: ' + ((data.host && data.host.latestJson) || 'not present on this host'),
      'latest.md: ' + ((data.host && data.host.latestMarkdown) || 'not present on this host'),
      'history.jsonl: ' + ((data.host && data.host.historyFile) || 'not present on this host')
    ].filter(Boolean);
    (data.warnings || []).forEach(function (warning) { lines.push(warning); });
    noteLines(byId('integrity-unavailable'), lines);
    if (data.markdown) {
      var heading = document.createElement('p');
      text(heading, 'latest.md');
      var pre = document.createElement('pre');
      pre.className = 'mono small';
      text(pre, data.markdown);
      byId('integrity-unavailable').appendChild(heading);
      byId('integrity-unavailable').appendChild(pre);
    }
  }

  async function loadReadiness() {
    showError('dashboard-error', '');
    try {
      var data = await request('/readiness');
      renderReadiness(data);
    } catch (error) {
      showError('dashboard-error', errorMessage(error));
    }
  }

  function renderReadiness(data) {
    var rows = data.rows || [];
    var failing = rows.filter(function (row) { return !row.ready; }).length;
    renderCards(byId('readiness-cards'), [
      { label: 'Readiness verdict', value: data.ready ? 'PASS' : 'FAIL',
        detail: data.ready ? 'The /ready index gate is satisfied' : '/ready answers 503 on this gate',
        tone: data.ready ? 'good' : 'bad' },
      { label: 'Required indexes', value: formatNumber(rows.length), detail: 'REQUIRED_INDEX_SPECS' },
      { label: 'Passing', value: formatNumber(rows.length - failing), detail: 'Same inspection /ready uses', tone: failing ? '' : 'good' },
      { label: 'Failing', value: formatNumber(failing), detail: failing ? 'Named in the table' : 'None', tone: failing ? 'bad' : '' }
    ]);

    function keyLabel(key) {
      return Object.keys(key || {}).map(function (field) { return field + ':' + key[field]; }).join(', ');
    }

    renderTable(byId('readiness-indexes'), [
      { label: 'Index', value: function (row) { return row.name; }, className: 'mono' },
      { label: 'Key', value: function (row) { return keyLabel(row.key); }, className: 'mono' },
      { label: 'Unique', value: function (row) { return row.unique ? 'yes' : 'no'; } },
      { label: 'TTL', value: function (row) { return row.expireAfterSeconds == null ? '—' : formatAgeSpan(row.expireAfterSeconds); } },
      { label: 'Partial', value: function (row) { return row.partial ? 'yes' : 'no'; } },
      { label: 'Status', value: function (row) { return row.ready ? 'PASS' : 'FAIL'; } },
      { label: 'Reason', value: function (row) { return row.reason || ''; } }
    ], rows, 'No required index specification is defined.');

    text(byId('readiness-verdict'), data.ready ? 'All six required indexes pass' : 'Failing the required-index gate');
    var lines = [data.note];
    if (data.error) lines.push('Inspection error: ' + data.error);
    lines.push('Each index is inspected with a ' + formatAgeSpan((data.inspectionTimeoutMs || 0) / 1000) + ' timeout; a timeout is a failure, not a pass.');
    lines.push('/ready also fails when the database is not connected or the process is shutting down, so a passing index table alone does not mean /ready returns 200.');
    lines.push('This panel does not create, repair or migrate an index.');
    noteLines(byId('readiness-unavailable'), lines.filter(Boolean));
  }

  async function loadOutbox() {
    showError('dashboard-error', '');
    try {
      var data = await request('/audit-outbox');
      renderOutbox(data);
    } catch (error) {
      showError('dashboard-error', errorMessage(error));
    }
  }

  function renderOutbox(data) {
    var counts = data.counts || {};
    function value(count) { return count == null ? 'Unavailable' : formatNumber(count); }
    renderCards(byId('outbox-cards'), [
      { label: 'PENDING', value: value(counts.pending), detail: 'Waiting for delivery', tone: counts.pending ? 'warn' : (counts.pending === 0 ? 'good' : '') },
      { label: 'SENDING', value: value(counts.sending), detail: 'Claimed by a delivery worker', tone: counts.sending ? 'warn' : (counts.sending === 0 ? 'good' : '') },
      { label: 'FAILED', value: value(counts.failed), detail: 'Retries did not converge', tone: counts.failed ? 'bad' : (counts.failed === 0 ? 'good' : '') },
      { label: 'Oldest pending', value: data.oldestPending ? formatAgeSpan(data.oldestPending.ageSeconds) : (counts.pending === 0 ? 'None' : '—'),
        detail: data.oldestPending && data.oldestPending.createdAt ? 'Queued ' + formatTime(data.oldestPending.createdAt) : 'No pending record',
        tone: data.oldestPending && data.oldestPending.ageSeconds > 3600 ? 'warn' : '' }
    ]);
    var lines = [data.note];
    if (data.error) lines.push(data.error);
    if (counts.delivered != null) lines.push('Delivered rows retained for the TTL: ' + formatNumber(counts.delivered) + '.');
    lines.push('Read-only: nothing here retries, edits or deletes an audit record.');
    noteLines(byId('outbox-note'), lines.filter(Boolean));
  }

  function refreshCurrent() {
    if (state.view === 'live' || state.view === 'checks') loadStatus();
    else if (['overview', 'infrastructure', 'ai', 'database', 'businesses', 'inventory', 'errors'].indexOf(state.view) >= 0) loadOperations();
    else if (state.view === 'support') loadSupport();
    else if (state.view === 'team') loadTeam();
    else if (state.view === 'deployments') loadDeployments();
    else if (state.view === 'backups') loadBackups();
    else if (state.view === 'jobs') loadJobs();
    else if (state.view === 'integrity') loadIntegrity();
    else if (state.view === 'readiness') { loadReadiness(); loadOutbox(); }
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
      await requestWithStepUp('/admins/' + encodeURIComponent(id) + '/status', {
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
      await requestWithStepUp('/admins/' + encodeURIComponent(id), { method: 'DELETE' });
      text(byId('admin-status'), email + ' was deleted.');
      await loadAdmins();
    } catch (error) {
      showError('admin-error', errorMessage(error));
    }
  }

  async function removeAdminKey(id, email, credentialId) {
    if (!window.confirm('Remove this security key from ' + email + '? Their platform sessions will be revoked.')) return;
    try {
      await requestWithStepUp('/admins/' + encodeURIComponent(id) + '/webauthn/' + encodeURIComponent(credentialId), { method: 'DELETE' });
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

  async function generateForcedRecoveryCodes(event) {
    event.preventDefault();
    showError('recovery-setup-error', '');
    var password = byId('recovery-setup-password').value;
    var button = byId('recovery-setup-generate');
    if (!password) {
      showError('recovery-setup-error', 'Enter your current password to generate codes.');
      return;
    }
    busy(button, true, 'Generating…');
    try {
      var data = await request('/auth/recovery-codes', {
        method: 'POST',
        body: { password: password }
      });
      state.admin.recoveryCodesRemaining = data.remaining;
      byId('recovery-setup-password').value = '';
      text(byId('recovery-setup-codes'), data.codes.join('\n'));
      byId('recovery-setup-form').hidden = true;
      byId('recovery-setup-result').hidden = false;
      byId('recovery-setup-saved').checked = false;
      text(byId('recovery-setup-copy-status'), '');
    } catch (error) {
      showError('recovery-setup-error', errorMessage(error));
    } finally {
      busy(button, false);
    }
  }

  async function copyForcedRecoveryCodes() {
    var status = byId('recovery-setup-copy-status');
    try {
      await navigator.clipboard.writeText(byId('recovery-setup-codes').textContent || '');
      text(status, 'Copied to the clipboard. Store the codes offline.');
    } catch {
      text(status, 'Select the codes and copy them manually.');
    }
  }

  function continueRecoverySetup() {
    showError('recovery-setup-continue-error', '');
    if (!byId('recovery-setup-saved').checked) {
      showError('recovery-setup-continue-error', 'Confirm that you saved the codes before continuing.');
      return;
    }
    showOnly('dashboard-view');
    showDashboard();
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

  function activeStepUpToken() {
    if (!state.stepUpToken) return '';
    if (!state.stepUpExpiresAt || Date.now() >= state.stepUpExpiresAt) {
      forgetStepUp();
      return '';
    }
    return state.stepUpToken;
  }

  function forgetStepUp() {
    state.stepUpToken = '';
    state.stepUpExpiresAt = 0;
  }

  function clearStepUp(cancel) {
    var dialog = byId('step-up-dialog');
    forgetStepUp();
    if (dialog && dialog.open) dialog.close();
    var reject = state.stepUpReject;
    state.stepUpPromise = null;
    state.stepUpResolve = null;
    state.stepUpReject = null;
    if (cancel && reject) reject(new Error('Step-up cancelled.'));
  }

  function promptStepUp() {
    if (activeStepUpToken()) return Promise.resolve();
    if (state.stepUpPromise) return state.stepUpPromise;
    var dialog = byId('step-up-dialog');
    state.stepUpPromise = new Promise(function (resolve, reject) {
      state.stepUpResolve = resolve;
      state.stepUpReject = reject;
    });
    showError('step-up-error', '');
    byId('step-up-password').value = '';
    byId('step-up-code').value = '';
    if (dialog && dialog.showModal) dialog.showModal();
    byId('step-up-password').focus();
    return state.stepUpPromise;
  }

  async function submitStepUp(event) {
    event.preventDefault();
    showError('step-up-error', '');
    var submit = byId('step-up-submit');
    busy(submit, true, 'Verifying…');
    try {
      var data = await request('/auth/step-up', {
        method: 'POST',
        body: {
          password: byId('step-up-password').value,
          code: byId('step-up-code').value.trim()
        }
      });
      state.stepUpToken = data.stepUpToken;
      state.stepUpExpiresAt = data.tokenExpiresAt
        ? new Date(data.tokenExpiresAt).getTime()
        : Date.now() + Number(data.expiresIn || 0) * 1000;
      byId('step-up-password').value = '';
      byId('step-up-code').value = '';
      var dialog = byId('step-up-dialog');
      if (dialog && dialog.open) dialog.close();
      var resolve = state.stepUpResolve;
      state.stepUpPromise = null;
      state.stepUpResolve = null;
      state.stepUpReject = null;
      if (resolve) resolve();
    } catch (error) {
      showError('step-up-error', errorMessage(error));
    } finally {
      busy(submit, false);
    }
  }

  function cancelStepUp() {
    clearStepUp(true);
  }

  async function requestWithStepUp(path, options) {
    try {
      return await request(path, options);
    } catch (error) {
      if (!error || error.code !== 'PLATFORM_STEP_UP_REQUIRED') throw error;
      forgetStepUp();
      await promptStepUp();
      return request(path, options);
    }
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
    // A new password check starts a new sign-in. Any request from the previous
    // view can no longer clear this state with a late 401.
    state.sessionEpoch += 1;
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
    var epoch = state.sessionEpoch;
    try { await request('/auth/logout', { method: 'POST', body: {} }); } catch { /* session is ending anyway */ }
    // A sign-in that started while the logout request was in flight owns the
    // screen now; its challenge must not be cleared by this continuation.
    if (epoch !== state.sessionEpoch) return;
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
    byId('recovery-setup-form').addEventListener('submit', generateForcedRecoveryCodes);
    byId('recovery-setup-copy').addEventListener('click', copyForcedRecoveryCodes);
    byId('recovery-setup-continue').addEventListener('click', continueRecoverySetup);
    byId('recovery-setup-signout').addEventListener('click', logout);
    byId('copy-secret').addEventListener('click', copySecret);
    byId('webauthn-login-button').addEventListener('click', webAuthnLogin);
    byId('webauthn-register-button').addEventListener('click', registerWebAuthn);
    byId('recovery-login-button').addEventListener('click', recoveryLogin);
    byId('recovery-generate-button').addEventListener('click', generateRecoveryCodes);
    byId('password-change-button').addEventListener('click', changePassword);
    byId('admin-refresh').addEventListener('click', loadAdmins);
    byId('step-up-form').addEventListener('submit', submitStepUp);
    byId('step-up-cancel').addEventListener('click', cancelStepUp);
    byId('step-up-dialog').addEventListener('cancel', function (event) {
      event.preventDefault();
      cancelStepUp();
    });
    byId('logout-button').addEventListener('click', logout);
    byId('refresh-button').addEventListener('click', refreshCurrent);
    byId('audit-refresh').addEventListener('click', loadAudit);
    byId('backup-schedule-form').addEventListener('submit', saveBackupSchedule);
    byId('backup-run-now').addEventListener('click', runBackupNow);
    byId('jobs-form').addEventListener('submit', saveJobSchedule);
    byId('jobs-task').addEventListener('change', syncJobForm);
    byId('jobs-enable').addEventListener('click', function () { changeJobState(true); });
    byId('jobs-disable').addEventListener('click', function () { changeJobState(false); });
    byId('backup-table').addEventListener('click', function (event) {
      var target = event.target;
      var name = target && target.getAttribute ? target.getAttribute('data-backup-delete') : null;
      if (name) deleteBackup(name);
    });
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
