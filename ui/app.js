// Auto_Browser Application Logic
document.addEventListener('DOMContentLoaded', async () => {
  // Elements: Navigation
  const btnBack = document.getElementById('btn-back');
  const btnForward = document.getElementById('btn-forward');
  const btnReload = document.getElementById('btn-reload');
  const btnHome = document.getElementById('btn-home');
  const urlInput = document.getElementById('url-input');
  const btnGo = document.getElementById('btn-go');
  const sslBadge = document.getElementById('ssl-badge');
  const loadingSpinner = document.getElementById('loading-spinner');
  const btnDevtools = document.getElementById('btn-devtools');

  // Layout Controls
  const workspace = document.getElementById('workspace');
  const browserMount = document.getElementById('browser-mount');
  const splitter = document.getElementById('splitter');
  const btnLayoutSplitH = document.getElementById('btn-layout-split-h');
  const btnLayoutSplitV = document.getElementById('btn-layout-split-v');
  const btnLayoutBrowser = document.getElementById('btn-layout-browser');
  const btnLayoutInspector = document.getElementById('btn-layout-inspector');

  // Recorder Elements
  const btnRecordToggle = document.getElementById('btn-record-toggle');
  const recBtnText = document.getElementById('rec-btn-text');
  const btnPauseToggle = document.getElementById('btn-pause-toggle');
  const pauseBtnText = document.getElementById('pause-btn-text');
  const activeSessionIdElem = document.getElementById('active-session-id');
  const recordingTimerElem = document.getElementById('recording-timer');
  const btnSaveSession = document.getElementById('btn-save-session');
  const btnClear = document.getElementById('btn-clear');
  const btnSessionsDrawer = document.getElementById('btn-sessions-drawer');
  const btnExportHar = document.getElementById('btn-export-har');
  const btnSettings = document.getElementById('btn-settings');

  // Metrics
  const metricRequests = document.getElementById('metric-requests');
  const metricErrors = document.getElementById('metric-errors');
  const metricBytes = document.getElementById('metric-bytes');

  // Inspector & Filter Elements
  const filterInput = document.getElementById('filter-input');
  const btnClearFilter = document.getElementById('btn-clear-filter');
  const pillFilters = document.querySelectorAll('.pill-filter');
  const chkPreserveLog = document.getElementById('chk-preserve-log');
  const requestsTable = document.getElementById('requests-table');
  const requestsTbody = document.getElementById('requests-tbody');
  const tableEmptyState = document.getElementById('table-empty-state');
  const tableContainer = document.getElementById('table-container');

  // Detail Panel Elements
  const detailPanel = document.getElementById('detail-panel');
  const detailMethod = document.getElementById('detail-method');
  const detailStatus = document.getElementById('detail-status');
  const detailUrl = document.getElementById('detail-url');
  const btnCopyUrl = document.getElementById('btn-copy-url');
  const btnCloseDetail = document.getElementById('btn-close-detail');
  const detailTabs = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  // Modals
  const modalSessions = document.getElementById('modal-sessions');
  const btnCloseSessions = document.getElementById('btn-close-sessions');
  const btnDismissSessions = document.getElementById('btn-dismiss-sessions');
  const sessionsList = document.getElementById('sessions-list');
  const btnOpenRecordingsDir = document.getElementById('btn-open-recordings-dir');

  const modalSettings = document.getElementById('modal-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const settingAutoRecord = document.getElementById('setting-auto-record');
  const settingCaptureBodies = document.getElementById('setting-capture-bodies');
  const settingMaxBodySize = document.getElementById('setting-max-body-size');
  const settingRedactHeaders = document.getElementById('setting-redact-headers');
  const settingRedactEnabled = document.getElementById('setting-redact-enabled');
  const settingHomeUrl = document.getElementById('setting-home-url');

  // Auth & Token elements
  const tabAuthBadge = document.getElementById('tab-auth-badge');
  const authTokensCount = document.getElementById('auth-tokens-count');
  const authTokensList = document.getElementById('auth-tokens-list');
  const tokenStatusBadge = document.getElementById('token-status-badge');

  // State
  let currentLayout = 'split-h'; // 'split-h' | 'split-v' | 'browser' | 'inspector'
  let splitRatio = 0.5; // percentage
  let isDraggingSplitter = false;
  let recorderStatus = 'idle'; // 'idle' | 'recording' | 'paused'
  let activeSessionId = 'session_001';
  let timerInterval = null;
  let timerSeconds = 0;
  let currentFilterType = 'all';
  let currentSearchQuery = '';
  let selectedRequestId = null;
  const records = new Map(); // requestId -> record

  // Initialize workspace layout
  workspace.className = 'layout-split-h';

  // =========================================================================
  // Bounds Synchronization with WebContentsView
  // =========================================================================
  function isAnyModalOpen() {
    return (!modalSessions.classList.contains('hidden')) || 
           (!modalSettings.classList.contains('hidden'));
  }

  function syncBrowserBounds() {
    if (currentLayout === 'inspector' || isAnyModalOpen()) {
      window.api.updateBounds({ x: 0, y: 0, width: 0, height: 0, hidden: true });
      return;
    }

    const rect = browserMount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      window.api.updateBounds({ x: 0, y: 0, width: 0, height: 0, hidden: true });
      return;
    }

    window.api.updateBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      hidden: false
    });
  }

  window.addEventListener('resize', () => {
    syncBrowserBounds();
  });

  // Call sync on a small timeout to let CSS layout stabilize
  setTimeout(syncBrowserBounds, 100);
  setInterval(syncBrowserBounds, 1000);

  // =========================================================================
  // Layout Controls
  // =========================================================================
  function setLayout(mode) {
    currentLayout = mode;
    workspace.className = `layout-${mode}`;

    btnLayoutSplitH.classList.toggle('active', mode === 'split-h');
    btnLayoutSplitV.classList.toggle('active', mode === 'split-v');
    btnLayoutBrowser.classList.toggle('active', mode === 'browser');
    btnLayoutInspector.classList.toggle('active', mode === 'inspector');

    if (mode === 'split-h') {
      browserMount.style.height = `${splitRatio * 100}%`;
      browserMount.style.width = '100%';
    } else if (mode === 'split-v') {
      browserMount.style.width = `${splitRatio * 100}%`;
      browserMount.style.height = '100%';
    }

    setTimeout(syncBrowserBounds, 50);
  }

  btnLayoutSplitH.addEventListener('click', () => setLayout('split-h'));
  btnLayoutSplitV.addEventListener('click', () => setLayout('split-v'));
  btnLayoutBrowser.addEventListener('click', () => setLayout('browser'));
  btnLayoutInspector.addEventListener('click', () => setLayout('inspector'));

  // Splitter Dragging
  splitter.addEventListener('mousedown', (e) => {
    isDraggingSplitter = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingSplitter) return;
    const wsRect = workspace.getBoundingClientRect();

    if (currentLayout === 'split-h') {
      const offset = e.clientY - wsRect.top;
      const ratio = Math.max(0.15, Math.min(0.85, offset / wsRect.height));
      splitRatio = ratio;
      browserMount.style.height = `${ratio * 100}%`;
    } else if (currentLayout === 'split-v') {
      const offset = e.clientX - wsRect.left;
      const ratio = Math.max(0.15, Math.min(0.85, offset / wsRect.width));
      splitRatio = ratio;
      browserMount.style.width = `${ratio * 100}%`;
    }
    syncBrowserBounds();
  });

  window.addEventListener('mouseup', () => {
    if (isDraggingSplitter) {
      isDraggingSplitter = false;
      splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      syncBrowserBounds();
    }
  });

  // =========================================================================
  // Browser Navigation
  // =========================================================================
  function doNavigate() {
    const val = urlInput.value.trim();
    if (val) {
      window.api.navigate(val);
    }
  }

  btnGo.addEventListener('click', doNavigate);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doNavigate();
  });

  btnBack.addEventListener('click', () => window.api.goBack());
  btnForward.addEventListener('click', () => window.api.goForward());
  btnReload.addEventListener('click', () => window.api.reload());
  btnHome.addEventListener('click', async () => {
    const settings = await window.api.getSettings();
    window.api.navigate(settings.homeUrl || 'https://httpbin.org');
  });
  btnDevtools.addEventListener('click', () => window.api.openDevTools());

  // Listen to browser state updates from main process
  window.api.onBrowserState((state) => {
    if (document.activeElement !== urlInput) {
      urlInput.value = state.url || '';
    }
    btnBack.disabled = !state.canGoBack;
    btnForward.disabled = !state.canGoForward;
    loadingSpinner.classList.toggle('hidden', !state.isLoading);

    if (state.url && state.url.startsWith('https://')) {
      sslBadge.className = 'ssl-indicator secure';
      sslBadge.title = 'Secure HTTPS Connection';
    } else {
      sslBadge.className = 'ssl-indicator';
      sslBadge.title = 'Insecure or Local Connection';
    }
  });

  // =========================================================================
  // Recorder Controller Logic
  // =========================================================================
  function updateTimerDisplay() {
    const h = String(Math.floor(timerSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((timerSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(timerSeconds % 60).padStart(2, '0');
    recordingTimerElem.textContent = `${h}:${m}:${s}`;
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (recorderStatus === 'recording') {
        timerSeconds++;
        updateTimerDisplay();
      }
    }, 1000);
  }

  function setRecorderUIState(status, session = null) {
    recorderStatus = status;

    if (session) {
      activeSessionId = session.id;
      activeSessionIdElem.textContent = session.id;
    }

    if (status === 'recording') {
      btnRecordToggle.className = 'rec-btn recording';
      recBtnText.textContent = 'Stop Recording';
      btnPauseToggle.disabled = false;
      pauseBtnText.textContent = 'Pause';
      startTimer();
    } else if (status === 'paused') {
      btnRecordToggle.className = 'rec-btn recording';
      recBtnText.textContent = 'Stop Recording';
      btnPauseToggle.disabled = false;
      pauseBtnText.textContent = 'Resume';
    } else {
      btnRecordToggle.className = 'rec-btn idle';
      recBtnText.textContent = 'Start Recording';
      btnPauseToggle.disabled = true;
      pauseBtnText.textContent = 'Pause';
      if (timerInterval) clearInterval(timerInterval);
    }
  }

  btnRecordToggle.addEventListener('click', async () => {
    if (recorderStatus === 'recording' || recorderStatus === 'paused') {
      const res = await window.api.stopRecording();
      setRecorderUIState(res.status, res.session);
    } else {
      const res = await window.api.startRecording();
      timerSeconds = 0;
      updateTimerDisplay();
      setRecorderUIState(res.status, res.session);
    }
  });

  btnPauseToggle.addEventListener('click', async () => {
    if (recorderStatus === 'recording') {
      const res = await window.api.pauseRecording();
      setRecorderUIState(res.status);
    } else if (recorderStatus === 'paused') {
      const res = await window.api.resumeRecording();
      setRecorderUIState(res.status);
    }
  });

  btnSaveSession.addEventListener('click', async () => {
    const res = await window.api.startRecording();
    timerSeconds = 0;
    updateTimerDisplay();
    setRecorderUIState(res.status, res.session);
  });

  btnClear.addEventListener('click', async () => {
    await window.api.clearCurrentRecords();
    records.clear();
    requestsTbody.innerHTML = '';
    tableEmptyState.style.display = 'flex';
    selectedRequestId = null;
    detailPanel.classList.add('hidden');
    metricRequests.textContent = '0';
    metricErrors.textContent = '0';
    metricBytes.textContent = '0 KB';
  });

  btnExportHar.addEventListener('click', async () => {
    const path = await window.api.exportHAR(activeSessionId);
    if (path) {
      alert(`HAR file exported successfully to:\n${path}`);
    }
  });

  // Initial status check
  const initStatus = await window.api.getStatus();
  setRecorderUIState(initStatus.status, initStatus.currentSession);

  // =========================================================================
  // Network Event Handling & Table Rendering
  // =========================================================================
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDuration(ms) {
    if (!ms && ms !== 0) return '-';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function getStatusClass(status) {
    if (!status || status === 0) return 'pending';
    if (status >= 200 && status < 300) return 's2xx';
    if (status >= 300 && status < 400) return 's3xx';
    if (status >= 400 && status < 500) return 's4xx';
    return 's5xx';
  }

  function extractNameAndDomain(fullUrl) {
    try {
      const u = new URL(fullUrl);
      const pathname = u.pathname;
      const filename = pathname.split('/').filter(Boolean).pop() || (pathname === '/' ? '/' : pathname);
      const query = u.search ? u.search.slice(0, 30) + (u.search.length > 30 ? '...' : '') : '';
      return {
        name: filename + query,
        domain: u.host,
        fullPath: pathname + u.search
      };
    } catch {
      return {
        name: fullUrl.slice(0, 40),
        domain: 'unknown',
        fullPath: fullUrl
      };
    }
  }

  function updateMetrics(stats) {
    if (!stats) return;
    metricRequests.textContent = stats.totalRequests || 0;
    metricErrors.textContent = stats.failedRequests || 0;
    metricBytes.textContent = formatBytes(stats.totalBytes || 0);
  }

  function renderRow(record) {
    const req = record.request;
    const res = record.response;
    const { name, domain } = extractNameAndDomain(req?.url || '');
    const status = res ? res.status : (record.failed ? 'Fail' : '...');
    const statusCls = getStatusClass(res ? res.status : 0);
    const method = req?.method || 'GET';
    const type = req?.resourceType || res?.resourceType || 'Other';
    const size = record.encodedDataLength ? formatBytes(record.encodedDataLength) : (record.status ? '-' : '...');
    const time = formatDuration(record.durationMs);

    let tr = document.getElementById(`req-row-${record.requestId}`);
    const isNew = !tr;

    if (isNew) {
      tr = document.createElement('tr');
      tr.id = `req-row-${record.requestId}`;
      tr.dataset.requestId = record.requestId;
      tr.dataset.type = type;
      tr.dataset.url = req?.url || '';
      tr.dataset.method = method;

      tr.addEventListener('click', () => {
        selectRequest(record.requestId);
      });
    }

    tr.innerHTML = `
      <td class="col-status"><span class="status-pill ${statusCls}">${status}</span></td>
      <td class="col-method"><span class="method-tag ${method}">${method}</span></td>
      <td class="col-name" title="${req?.url || ''}">${name}</td>
      <td class="col-domain" title="${domain}">${domain}</td>
      <td class="col-type">${type}</td>
      <td class="col-size">${size}</td>
      <td class="col-time">${time}</td>
      <td class="col-waterfall">
        <div class="waterfall-track">
          <div class="waterfall-bar" style="width: ${Math.min(100, Math.max(10, (record.durationMs || 50) / 10))}%"></div>
        </div>
      </td>
    `;

    if (isNew) {
      requestsTbody.appendChild(tr);
      tableEmptyState.style.display = 'none';
    }

    applyFilterToRow(tr);

    if (selectedRequestId === record.requestId) {
      tr.classList.add('selected');
      updateDetailPane(record);
    }
  }

  window.api.onNetworkEvent((event) => {
    const { type, data, stats } = event;
    updateMetrics(stats);

    if (type === 'request') {
      const record = {
        requestId: data.requestId,
        request: data,
        response: null,
        status: null,
        durationMs: null,
        startTime: Date.now()
      };
      records.set(data.requestId, record);
      renderRow(record);
    } else if (type === 'response') {
      const record = records.get(data.requestId) || { requestId: data.requestId, request: null };
      record.response = data;
      record.status = data.status;
      records.set(data.requestId, record);
      renderRow(record);
    } else if (type === 'finished' || type === 'failed') {
      const record = records.get(data.requestId) || data;
      Object.assign(record, data);
      records.set(data.requestId, record);
      renderRow(record);
    }
  });

  // =========================================================================
  // Filtering & Searching
  // =========================================================================
  function applyFilterToRow(tr) {
    const type = tr.dataset.type || '';
    const url = (tr.dataset.url || '').toLowerCase();
    const method = (tr.dataset.method || '').toLowerCase();
    const query = currentSearchQuery.toLowerCase();

    let matchesType = false;
    if (currentFilterType === 'all') {
      matchesType = true;
    } else if (currentFilterType === 'error') {
      const statusPill = tr.querySelector('.status-pill');
      const isError = statusPill && (statusPill.classList.contains('s4xx') || statusPill.classList.contains('s5xx') || statusPill.textContent === 'Fail');
      matchesType = isError;
    } else {
      matchesType = type.toLowerCase().includes(currentFilterType.toLowerCase());
    }

    const matchesSearch = !query || url.includes(query) || method.includes(query);

    if (matchesType && matchesSearch) {
      tr.style.display = '';
    } else {
      tr.style.display = 'none';
    }
  }

  function applyAllFilters() {
    const rows = requestsTbody.querySelectorAll('tr');
    rows.forEach(applyFilterToRow);
  }

  filterInput.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value.trim();
    btnClearFilter.classList.toggle('hidden', !currentSearchQuery);
    applyAllFilters();
  });

  btnClearFilter.addEventListener('click', () => {
    filterInput.value = '';
    currentSearchQuery = '';
    btnClearFilter.classList.add('hidden');
    applyAllFilters();
  });

  pillFilters.forEach(pill => {
    pill.addEventListener('click', () => {
      pillFilters.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilterType = pill.dataset.filter;
      applyAllFilters();
    });
  });

  // =========================================================================
  // Request Detail Inspector Panel
  // =========================================================================
  function selectRequest(requestId) {
    selectedRequestId = requestId;
    const allRows = requestsTbody.querySelectorAll('tr');
    allRows.forEach(r => r.classList.remove('selected'));

    const tr = document.getElementById(`req-row-${requestId}`);
    if (tr) tr.classList.add('selected');

    const record = records.get(requestId);
    if (!record) return;

    detailPanel.classList.remove('hidden');
    updateDetailPane(record);
  }

  btnCloseDetail.addEventListener('click', () => {
    detailPanel.classList.add('hidden');
    selectedRequestId = null;
    const allRows = requestsTbody.querySelectorAll('tr');
    allRows.forEach(r => r.classList.remove('selected'));
  });

  btnCopyUrl.addEventListener('click', () => {
    const url = detailUrl.textContent;
    if (url) {
      navigator.clipboard.writeText(url);
      btnCopyUrl.title = 'Copied!';
      setTimeout(() => btnCopyUrl.title = 'Copy URL', 1500);
    }
  });

  // Detail Tabs
  detailTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      detailTabs.forEach(t => t.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(`tab-pane-${tab.dataset.tab}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  function decodeClientJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;
    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const json = atob(b64);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function extractTokensFromRecord(record) {
    if (record.tokens && record.tokens.length) {
      return record.tokens;
    }
    const found = [];
    const reqHeaders = record.request?.headers || {};
    const resHeaders = record.response?.headers || {};

    // Check Authorization & Request Headers
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (!v || v === '[REDACTED]') continue;
      const kl = k.toLowerCase();
      if (kl === 'authorization') {
        const isBearer = String(v).toLowerCase().startsWith('bearer ');
        const tokenVal = isBearer ? String(v).slice(7).trim() : String(v).trim();
        const jwt = decodeClientJwt(tokenVal);
        found.push({
          type: isBearer ? (jwt ? 'Bearer JWT' : 'Bearer Token') : 'Authorization Header',
          source: 'request_header',
          name: k,
          token: tokenVal,
          value: v,
          jwtPayload: jwt
        });
      } else if (/auth|token|jwt|api[-_]?key|secret|session/i.test(kl)) {
        const jwt = decodeClientJwt(String(v).trim());
        found.push({
          type: jwt ? 'JWT Token' : (/key/i.test(kl) ? 'API Key' : 'Auth Header'),
          source: 'request_header',
          name: k,
          token: String(v).trim(),
          value: v,
          jwtPayload: jwt
        });
      } else if (kl === 'cookie') {
        const cStrings = String(v).split(';');
        for (const c of cStrings) {
          const parts = c.trim().split('=');
          if (parts.length >= 2) {
            const cn = parts[0].trim();
            const cv = parts.slice(1).join('=').trim();
            if (/token|auth|jwt|session|sid|access/i.test(cn) || cv.startsWith('ey')) {
              const jwt = decodeClientJwt(cv);
              found.push({
                type: jwt ? 'JWT Cookie' : 'Auth Cookie',
                source: 'request_cookie',
                name: cn,
                token: cv,
                value: c.trim(),
                jwtPayload: jwt
              });
            }
          }
        }
      }
    }

    // Check Set-Cookie
    for (const [k, v] of Object.entries(resHeaders)) {
      if (!v || v === '[REDACTED]') continue;
      if (k.toLowerCase() === 'set-cookie') {
        const lines = String(v).split('\n');
        for (const line of lines) {
          const first = line.split(';')[0];
          const parts = first.split('=');
          if (parts.length >= 2) {
            const cn = parts[0].trim();
            const cv = parts.slice(1).join('=').trim();
            if (/token|auth|jwt|session|sid|access/i.test(cn) || cv.startsWith('ey')) {
              const jwt = decodeClientJwt(cv);
              found.push({
                type: jwt ? 'JWT Cookie' : 'Set-Cookie Token',
                source: 'response_cookie',
                name: cn,
                token: cv,
                value: line.trim(),
                jwtPayload: jwt
              });
            }
          }
        }
      }
    }

    // Check Response Body if JSON
    if (record.responseBody && typeof record.responseBody === 'string') {
      try {
        const parsed = JSON.parse(record.responseBody);
        const scan = (obj, prefix = '') => {
          if (!obj || typeof obj !== 'object') return;
          for (const [k, val] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (typeof val === 'string' && val.length > 5) {
              if (/token|jwt|access_token|accessToken|id_token|refresh_token|refreshToken|apiKey|api_key|authToken/i.test(k) || val.startsWith('eyJ')) {
                const jwt = decodeClientJwt(val);
                found.push({
                  type: jwt ? 'JWT Token' : 'Response Body Token',
                  source: 'response_body',
                  name: path,
                  token: val,
                  value: val,
                  jwtPayload: jwt
                });
              }
            } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
              scan(val, path);
            }
          }
        };
        scan(parsed);
      } catch {}
    }

    return found;
  }

  function updateDetailPane(record) {
    const req = record.request;
    const res = record.response;

    // Header Summary
    detailMethod.textContent = req?.method || 'GET';
    detailMethod.className = `method-badge ${req?.method || 'GET'}`;
    const statusText = res ? `${res.status} ${res.statusText || 'OK'}` : (record.failed ? 'Failed' : 'Pending');
    detailStatus.textContent = statusText;
    detailStatus.className = `status-badge ${getStatusClass(res?.status)}`;
    detailUrl.textContent = req?.url || '';

    // --- Tab 1: Headers ---
    const generalList = document.getElementById('general-headers-list');
    let generalHtml = `
      <div class="kv-key">Request URL:</div><div class="kv-val">${req?.url || '-'}</div>
      <div class="kv-key">Request Method:</div><div class="kv-val">${req?.method || '-'}</div>
      <div class="kv-key">Status Code:</div><div class="kv-val">${statusText}</div>
      <div class="kv-key">Remote Address:</div><div class="kv-val">${res?.remoteIPAddress ? `${res.remoteIPAddress}:${res.remotePort}` : '-'}</div>
      <div class="kv-key">Resource Type:</div><div class="kv-val">${req?.resourceType || '-'}</div>
    `;
    generalList.innerHTML = generalHtml;

    // Response Headers
    const resHeadersList = document.getElementById('response-headers-list');
    const resHeadersCount = document.getElementById('res-headers-count');
    const resHeaders = res?.headers || {};
    const resHeaderKeys = Object.keys(resHeaders);
    resHeadersCount.textContent = resHeaderKeys.length;

    let resHeadersHtml = '';
    for (const [k, v] of Object.entries(resHeaders)) {
      const isRedacted = v === '[REDACTED]';
      resHeadersHtml += `
        <div class="kv-key">${k}:</div>
        <div class="kv-val ${isRedacted ? 'redacted' : ''}">${v}</div>
      `;
    }
    resHeadersList.innerHTML = resHeadersHtml || '<div class="kv-key">No headers</div><div>-</div>';

    // Request Headers
    const reqHeadersList = document.getElementById('request-headers-list');
    const reqHeadersCount = document.getElementById('req-headers-count');
    const redactedBadge = document.getElementById('redacted-badge');
    const reqHeaders = req?.headers || {};
    const reqHeaderKeys = Object.keys(reqHeaders);
    reqHeadersCount.textContent = reqHeaderKeys.length;

    let hasRedacted = false;
    let reqHeadersHtml = '';
    for (const [k, v] of Object.entries(reqHeaders)) {
      const isRedacted = v === '[REDACTED]';
      if (isRedacted) hasRedacted = true;
      reqHeadersHtml += `
        <div class="kv-key">${k}:</div>
        <div class="kv-val ${isRedacted ? 'redacted' : ''}">${v}</div>
      `;
    }
    reqHeadersList.innerHTML = reqHeadersHtml || '<div class="kv-key">No headers</div><div>-</div>';
    redactedBadge.classList.toggle('hidden', !hasRedacted);

    // --- Tab: Auth & Tokens ---
    const detectedTokens = extractTokensFromRecord(record);
    authTokensCount.textContent = detectedTokens.length;
    if (detectedTokens.length > 0) {
      tabAuthBadge.textContent = detectedTokens.length;
      tabAuthBadge.classList.remove('hidden');

      authTokensList.innerHTML = detectedTokens.map((t, idx) => `
        <div class="auth-token-card">
          <div class="auth-token-card-header">
            <div class="token-tags">
              <span class="token-type-tag">${t.type}</span>
              <span class="token-source-tag">${t.source}</span>
              <span class="token-name-label">${t.name}</span>
            </div>
            <button class="btn-copy-token" data-token="${encodeURIComponent(t.token)}" title="Copy full token">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              Copy
            </button>
          </div>
          <div class="token-raw-value">${t.token}</div>
          ${t.jwtPayload ? `
            <div class="jwt-claims-box">
              <div class="jwt-claims-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                Decoded JWT Claims
              </div>
              <div class="jwt-claims-grid">
                ${Object.entries(t.jwtPayload).map(([k, v]) => `
                  <div class="jwt-claim-k">${k}:</div>
                  <div class="jwt-claim-v">${typeof v === 'object' ? JSON.stringify(v) : v}</div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `).join('');

      authTokensList.querySelectorAll('.btn-copy-token').forEach(btn => {
        btn.addEventListener('click', () => {
          const raw = decodeURIComponent(btn.dataset.token);
          navigator.clipboard.writeText(raw);
          const orig = btn.innerHTML;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.innerHTML = orig, 1200);
        });
      });
    } else {
      tabAuthBadge.classList.add('hidden');
      authTokensList.innerHTML = '<div class="empty-hint">No authorization tokens detected for this request/response.</div>';
    }

    if (hasRedacted) {
      tokenStatusBadge.textContent = 'Redactions Active';
      tokenStatusBadge.style.color = 'var(--accent-amber)';
      tokenStatusBadge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
    } else {
      tokenStatusBadge.textContent = 'Unredacted (Full Capture)';
      tokenStatusBadge.style.color = 'var(--accent-emerald)';
      tokenStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    }

    // --- Tab 2: Payload ---
    const queryParamsList = document.getElementById('query-params-list');
    const queryParamsCount = document.getElementById('query-params-count');
    try {
      const u = new URL(req?.url || '');
      const searchParams = Array.from(u.searchParams.entries());
      queryParamsCount.textContent = searchParams.length;
      if (searchParams.length > 0) {
        queryParamsList.innerHTML = searchParams.map(([k, v]) => `
          <div class="kv-key">${k}:</div>
          <div class="kv-val">${decodeURIComponent(v)}</div>
        `).join('');
      } else {
        queryParamsList.innerHTML = '<div class="kv-key">No query parameters</div><div></div>';
      }
    } catch {
      queryParamsList.innerHTML = '<div class="kv-key">Invalid URL</div><div></div>';
    }

    const postBodyViewer = document.getElementById('post-body-viewer');
    if (req?.postData) {
      try {
        const parsed = JSON.parse(req.postData);
        postBodyViewer.textContent = JSON.stringify(parsed, null, 2);
      } catch {
        postBodyViewer.textContent = req.postData;
      }
    } else {
      postBodyViewer.textContent = 'No post data payload for this request';
    }

    // --- Tab 3: Response Body ---
    const responseTypeInfo = document.getElementById('response-type-info');
    const responseViewer = document.getElementById('response-viewer');
    const responseImageContainer = document.getElementById('response-image-container');
    const responseImagePreview = document.getElementById('response-image-preview');

    const mime = res?.mimeType || 'unknown';
    responseTypeInfo.textContent = mime;

    if (mime.startsWith('image/') && record.responseBody) {
      responseImageContainer.classList.remove('hidden');
      responseViewer.classList.add('hidden');
      responseImagePreview.src = `data:${mime};base64,${record.responseBody}`;
    } else {
      responseImageContainer.classList.add('hidden');
      responseViewer.classList.remove('hidden');
      if (record.responseBody) {
        if (mime.includes('json')) {
          try {
            responseViewer.textContent = JSON.stringify(JSON.parse(record.responseBody), null, 2);
          } catch {
            responseViewer.textContent = record.responseBody;
          }
        } else {
          responseViewer.textContent = record.responseBody.slice(0, 50000);
        }
      } else {
        responseViewer.textContent = record.failed ? `Request Failed: ${record.errorText || 'Unknown error'}` : 'No response body recorded or captured.';
      }
    }

    // --- Tab 4: Timing ---
    const timingBreakdownList = document.getElementById('timing-breakdown-list');
    const timing = res?.timing;
    if (timing) {
      const dns = Math.max(0, (timing.dnsEnd || 0) - (timing.dnsStart || 0));
      const connect = Math.max(0, (timing.connectEnd || 0) - (timing.connectStart || 0));
      const ssl = Math.max(0, (timing.sslEnd || 0) - (timing.sslStart || 0));
      const send = Math.max(0, (timing.sendEnd || 0) - (timing.sendStart || 0));
      const ttfb = Math.max(0, (timing.receiveHeadersEnd || 0) - (timing.sendEnd || 0));
      const total = dns + connect + ssl + send + ttfb;

      timingBreakdownList.innerHTML = `
        <div class="timing-row">
          <span class="timing-phase">DNS Lookup</span>
          <div class="timing-bar-container"><div class="timing-bar-fill" style="width: ${total ? (dns / total) * 100 : 0}%; background: #38bdf8;"></div></div>
          <span class="timing-dur">${Math.round(dns)} ms</span>
        </div>
        <div class="timing-row">
          <span class="timing-phase">Initial Connection</span>
          <div class="timing-bar-container"><div class="timing-bar-fill" style="width: ${total ? (connect / total) * 100 : 0}%; background: #818cf8;"></div></div>
          <span class="timing-dur">${Math.round(connect)} ms</span>
        </div>
        <div class="timing-row">
          <span class="timing-phase">SSL Handshake</span>
          <div class="timing-bar-container"><div class="timing-bar-fill" style="width: ${total ? (ssl / total) * 100 : 0}%; background: #a78bfa;"></div></div>
          <span class="timing-dur">${Math.round(ssl)} ms</span>
        </div>
        <div class="timing-row">
          <span class="timing-phase">Waiting for server (TTFB)</span>
          <div class="timing-bar-container"><div class="timing-bar-fill" style="width: ${total ? (ttfb / total) * 100 : 0}%; background: #10b981;"></div></div>
          <span class="timing-dur">${Math.round(ttfb)} ms</span>
        </div>
      `;
    } else {
      timingBreakdownList.innerHTML = `<div class="timing-row"><span class="timing-phase">Total Duration</span><span class="timing-dur">${formatDuration(record.durationMs)}</span></div>`;
    }

    // --- Tab 5: Cookies ---
    const reqCookiesList = document.getElementById('request-cookies-list');
    const resCookiesList = document.getElementById('response-cookies-list');
    const cookieHeader = reqHeaders['cookie'] || reqHeaders['Cookie'];
    if (cookieHeader && cookieHeader !== '[REDACTED]') {
      const cookies = cookieHeader.split(';').map(c => c.trim().split('='));
      reqCookiesList.innerHTML = cookies.map(([k, v]) => `
        <div class="kv-key">${k}:</div><div class="kv-val">${v || ''}</div>
      `).join('');
    } else {
      reqCookiesList.innerHTML = `<div class="kv-key">${cookieHeader === '[REDACTED]' ? 'Cookie [REDACTED]' : 'No request cookies'}</div><div></div>`;
    }

    const setCookieHeader = resHeaders['set-cookie'] || resHeaders['Set-Cookie'];
    if (setCookieHeader) {
      resCookiesList.innerHTML = `<div class="kv-key">Set-Cookie:</div><div class="kv-val">${setCookieHeader}</div>`;
    } else {
      resCookiesList.innerHTML = '<div class="kv-key">No set-cookie headers</div><div></div>';
    }

    // --- Tab 6: Raw JSONL Record ---
    const rawJsonViewer = document.getElementById('raw-json-viewer');
    rawJsonViewer.textContent = JSON.stringify(record, null, 2);
  }

  // Response Actions
  document.getElementById('btn-copy-response').addEventListener('click', () => {
    const text = document.getElementById('response-viewer').textContent;
    navigator.clipboard.writeText(text);
  });

  document.getElementById('btn-format-json').addEventListener('click', () => {
    const viewer = document.getElementById('response-viewer');
    try {
      const parsed = JSON.parse(viewer.textContent);
      viewer.textContent = JSON.stringify(parsed, null, 2);
    } catch {}
  });

  document.getElementById('btn-copy-payload').addEventListener('click', () => {
    const text = document.getElementById('post-body-viewer').textContent;
    navigator.clipboard.writeText(text);
  });

  document.getElementById('btn-copy-raw').addEventListener('click', () => {
    const text = document.getElementById('raw-json-viewer').textContent;
    navigator.clipboard.writeText(text);
  });

  // =========================================================================
  // Past Saved Sessions Modal
  // =========================================================================
  async function refreshSessionsList() {
    const sessions = await window.api.listSessions();

    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML = '<p class="modal-desc">No saved sessions yet. Start browsing with recorder active to automatically create sessions.</p>';
      return;
    }

    sessionsList.innerHTML = sessions.map(s => `
      <div class="session-item-card" id="card-${s.id}">
        <div class="session-item-info">
          <h4>${s.id}</h4>
          <div class="session-item-meta">
            ${s.requestCount || 0} requests &bull; ${formatBytes(s.totalBytes || 0)} &bull; ${s.startTime ? new Date(s.startTime).toLocaleString() : 'N/A'}
          </div>
        </div>
        <div class="session-item-actions">
          <button class="subtle-btn btn-load-session" data-id="${s.id}">Load</button>
          <button class="subtle-btn btn-export-session" data-id="${s.id}">HAR</button>
          <button class="btn-danger btn-delete-session" data-id="${s.id}" title="Delete session from disk">Delete</button>
        </div>
      </div>
    `).join('');

    sessionsList.querySelectorAll('.btn-load-session').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const loaded = await window.api.loadSession(id);
        if (loaded && loaded.records) {
          records.clear();
          requestsTbody.innerHTML = '';
          activeSessionId = id;
          activeSessionIdElem.textContent = id;

          for (const rec of loaded.records) {
            records.set(rec.requestId, rec);
            renderRow(rec);
          }
          if (loaded.meta) {
            metricRequests.textContent = loaded.meta.requestCount || 0;
            metricErrors.textContent = loaded.meta.failedRequests || 0;
            metricBytes.textContent = formatBytes(loaded.meta.totalBytes || 0);
          }
          modalSessions.classList.add('hidden');
          syncBrowserBounds();
        }
      });
    });

    sessionsList.querySelectorAll('.btn-export-session').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.exportHAR(btn.dataset.id);
      });
    });

    sessionsList.querySelectorAll('.btn-delete-session').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (confirm(`Are you sure you want to delete session "${id}" from disk?`)) {
          const success = await window.api.deleteSession(id);
          if (success) {
            await refreshSessionsList();
          }
        }
      });
    });
  }

  btnSessionsDrawer.addEventListener('click', async () => {
    modalSessions.classList.remove('hidden');
    syncBrowserBounds();
    await refreshSessionsList();
  });

  const btnClearAllSessions = document.getElementById('btn-clear-all-sessions');
  if (btnClearAllSessions) {
    btnClearAllSessions.addEventListener('click', async () => {
      if (confirm('Are you sure you want to permanently delete ALL recorded sessions from disk?')) {
        await window.api.clearAllRecordings();
        await refreshSessionsList();
      }
    });
  }

  btnCloseSessions.addEventListener('click', () => {
    modalSessions.classList.add('hidden');
    syncBrowserBounds();
  });
  btnDismissSessions.addEventListener('click', () => {
    modalSessions.classList.add('hidden');
    syncBrowserBounds();
  });
  modalSessions.addEventListener('click', (e) => {
    if (e.target === modalSessions) {
      modalSessions.classList.add('hidden');
      syncBrowserBounds();
    }
  });

  btnOpenRecordingsDir.addEventListener('click', () => {
    window.api.openSessionFolder();
  });

  // =========================================================================
  // Settings & Redaction Modal
  // =========================================================================
  btnSettings.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    settingAutoRecord.checked = !!s.autoRecord;
    settingCaptureBodies.checked = !!s.captureBodies;
    settingMaxBodySize.value = Math.round((s.maxBodySizeBytes || 5242880) / (1024 * 1024));
    settingRedactEnabled.checked = !!s.redactEnabled;
    settingRedactHeaders.value = (s.redactHeaders || []).join(', ');
    settingHomeUrl.value = s.homeUrl || 'https://httpbin.org';
    modalSettings.classList.remove('hidden');
    syncBrowserBounds();
  });

  btnCloseSettings.addEventListener('click', () => {
    modalSettings.classList.add('hidden');
    syncBrowserBounds();
  });
  btnCancelSettings.addEventListener('click', () => {
    modalSettings.classList.add('hidden');
    syncBrowserBounds();
  });
  modalSettings.addEventListener('click', (e) => {
    if (e.target === modalSettings) {
      modalSettings.classList.add('hidden');
      syncBrowserBounds();
    }
  });

  btnSaveSettings.addEventListener('click', async () => {
    const newSettings = {
      autoRecord: settingAutoRecord.checked,
      captureBodies: settingCaptureBodies.checked,
      maxBodySizeBytes: parseInt(settingMaxBodySize.value, 10) * 1024 * 1024,
      redactEnabled: settingRedactEnabled.checked,
      redactHeaders: settingRedactHeaders.value.split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
      homeUrl: settingHomeUrl.value.trim()
    };
    await window.api.saveSettings(newSettings);
    modalSettings.classList.add('hidden');
    syncBrowserBounds();
  });
});
