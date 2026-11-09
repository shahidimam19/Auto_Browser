const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const NetworkRecorder = require('./recorder');
const InteractionManager = require('./interaction');

// Chromium flags to strip automation detection and disguise as standard Google Chrome
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');

const CHROME_VERSION = '131.0.6778.205';
const CHROME_MAJOR = '131';
const STANDARD_CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

app.userAgentFallback = STANDARD_CHROME_UA;

const ROOT_DIR = path.resolve(__dirname, '..');

let mainWindow = null;
const tabs = new Map(); // tabId -> { id, view, title, url, isLoading, canGoBack, canGoForward }
let activeTabId = null;
let currentBrowserBounds = { x: 0, y: 0, width: 0, height: 0, hidden: false };
let recorder = null;
let interactionManager = null;
let settings = {};
const settingsPath = path.join(ROOT_DIR, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed reading settings.json:', e);
    settings = {
      autoRecord: false,
      captureBodies: true,
      maxBodySizeBytes: 5242880,
      redactEnabled: false,
      redactHeaders: [],
      homeUrl: 'auto://home',
      storageDir: 'recordings'
    };
  }
}

function saveSettings(newSettings) {
  settings = Object.assign(settings, newSettings);
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed saving settings.json:', e);
  }
  if (recorder) {
    recorder.settings = Object.assign(recorder.settings, settings);
  }
}

function sendToUI(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function getActiveTab() {
  if (activeTabId && tabs.has(activeTabId)) {
    return tabs.get(activeTabId);
  }
  if (tabs.size > 0) {
    return tabs.values().next().value;
  }
  return null;
}

function getTabsSummary() {
  const list = [];
  for (const [id, tab] of tabs.entries()) {
    list.push({
      id: tab.id,
      title: tab.title || (tab.url === 'auto://home' ? 'Home' : tab.url) || 'New Tab',
      url: tab.url || '',
      isLoading: !!tab.isLoading,
      isActive: id === activeTabId
    });
  }
  return { tabs: list, activeTabId };
}

function broadcastTabs() {
  sendToUI('tabs:updated', getTabsSummary());
}

function broadcastBrowserState() {
  const activeTab = getActiveTab();
  if (!activeTab || !mainWindow || activeTab.view.webContents.isDestroyed()) return;
  const wc = activeTab.view.webContents;
  sendToUI('browser:state', {
    tabId: activeTab.id,
    url: activeTab.url || wc.getURL(),
    title: activeTab.title || wc.getTitle(),
    isLoading: !!activeTab.isLoading,
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false)
  });
}

async function attachCDP(webContents) {
  try {
    if (webContents.debugger.isAttached()) {
      webContents.debugger.detach();
    }
    webContents.debugger.attach('1.3');

    webContents.debugger.on('detach', (event, reason) => {
      console.log('Debugger detached:', reason);
      // Re-attach if still valid
      if (!webContents.isDestroyed()) {
        setTimeout(() => attachCDP(webContents), 500);
      }
    });

    webContents.debugger.on('message', async (event, method, params) => {
      if (!recorder) return;

      if (method === 'Network.requestWillBeSent') {
        // If request has post data that needs to be fetched
        if (params.request.hasPostData && !params.request.postData) {
          try {
            const postDataRes = await webContents.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId });
            if (postDataRes && postDataRes.postData) {
              params.request.postData = postDataRes.postData;
            }
          } catch (e) {}
        }
        if (params.request.url && params.request.url.startsWith('tel:')) {
          const phone = params.request.url.replace(/^tel:\+?/, '').trim();
          sendToUI('interaction:phoneCaptured', { phone, rawUrl: params.request.url });
        }
        const record = recorder.recordRequest(params);
        if (record) {
          sendToUI('network:event', { type: 'request', data: record, stats: recorder.stats });
        }
      } else if (method === 'Network.responseReceived') {
        const record = recorder.recordResponse(params);
        if (record) {
          sendToUI('network:event', { type: 'response', data: record, stats: recorder.stats });
        }
      } else if (method === 'Network.loadingFinished') {
        let bodyData = null;
        if (settings.captureBodies) {
          try {
            bodyData = await webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          } catch (e) {
            // Body might not be cached or stream was closed
          }
        }
        const updated = recorder.recordFinished(params, bodyData);
        if (updated) {
          sendToUI('network:event', { type: 'finished', data: updated, stats: recorder.stats });
        }
      } else if (method === 'Network.loadingFailed') {
        const updated = recorder.recordFailed(params);
        if (updated) {
          sendToUI('network:event', { type: 'failed', data: updated, stats: recorder.stats });
        }
      }
    });

    await webContents.debugger.sendCommand('Network.enable', {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize: 50 * 1024 * 1024,
    });

    try {
      await webContents.debugger.sendCommand('Network.setUserAgentOverride', {
        userAgent: STANDARD_CHROME_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Win32',
        userAgentMetadata: {
          brands: [
            { brand: 'Google Chrome', version: CHROME_MAJOR },
            { brand: 'Chromium', version: CHROME_MAJOR },
            { brand: 'Not_A Brand', version: '24' }
          ],
          fullVersionList: [
            { brand: 'Google Chrome', version: CHROME_VERSION },
            { brand: 'Chromium', version: CHROME_VERSION },
            { brand: 'Not_A Brand', version: '24.0.0.0' }
          ],
          fullVersion: CHROME_VERSION,
          platform: 'Windows',
          platformVersion: '10.0.0',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false
        }
      });
    } catch (e) {
      console.warn('Network.setUserAgentOverride notice:', e.message);
    }

    try {
      await webContents.debugger.sendCommand('Page.enable');
      await webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          try {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => undefined,
              configurable: true
            });
            if (!window.chrome) {
              window.chrome = {};
            }
            if (!window.chrome.runtime) {
              window.chrome.runtime = {
                OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
                OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
                PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
                PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
                PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
                RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" }
              };
            }
          } catch (e) {}
        `
      });
    } catch (e) {
      console.warn('Page.addScriptToEvaluateOnNewDocument notice:', e.message);
    }

    try {
      await webContents.debugger.sendCommand('DOM.enable');
      await webContents.debugger.sendCommand('Runtime.enable');
    } catch (e) {
      console.warn('DOM/Runtime enable notice:', e.message);
    }

    console.log('CDP attached and Network.enable initiated.');
  } catch (err) {
    console.error('Error attaching CDP:', err);
  }
}

function createTab(initialUrl = 'auto://home') {
  if (!mainWindow) return null;

  const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'stealth_preload.js'),
      contextIsolation: true,
      sandbox: true,
      javascript: true
    }
  });

  mainWindow.contentView.addChildView(view);

  const bwc = view.webContents;

  // Spoof clean standard Chrome User-Agent
  bwc.setUserAgent(STANDARD_CHROME_UA);

  // Auto-grant permissions
  if (bwc.session) {
    bwc.session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true);
    });
    bwc.session.setPermissionCheckHandler(() => true);
  }

  // Intercept window.open / target="_blank"
  bwc.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: 'deny' };
  });

  const tabObj = {
    id: tabId,
    view: view,
    title: 'New Tab',
    url: initialUrl || 'auto://home',
    isLoading: true,
    canGoBack: false,
    canGoForward: false
  };

  tabs.set(tabId, tabObj);

  // Track browser events
  bwc.on('did-start-navigation', (e, url) => {
    tabObj.url = url;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });
  bwc.on('did-navigate', (e, url) => {
    tabObj.url = url;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });
  bwc.on('did-navigate-in-page', (e, url) => {
    tabObj.url = url;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });
  bwc.on('did-start-loading', () => {
    tabObj.isLoading = true;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });
  bwc.on('did-stop-loading', () => {
    tabObj.isLoading = false;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });
  bwc.on('page-title-updated', (e, title) => {
    tabObj.title = title;
    if (tabId === activeTabId) broadcastBrowserState();
    broadcastTabs();
  });

  // Attach CDP for network recording
  attachCDP(bwc);

  // Intercept element picker events from webContents
  bwc.on('console-message', (e, level, message) => {
    if (typeof message === 'string') {
      if (message.startsWith('__AB_ELEMENT_PICKED__:')) {
        try {
          const elementData = JSON.parse(message.slice(22));
          sendToUI('interaction:elementSelected', elementData);
        } catch (err) {
          console.error('Failed to parse picked element:', err);
        }
      } else if (message === '__AB_PICKER_CANCELLED__') {
        sendToUI('interaction:pickerCancelled', {});
      }
    }
  });

  // Intercept tel: phone links
  bwc.on('will-navigate', (event, navUrl) => {
    if (navUrl && navUrl.startsWith('tel:')) {
      event.preventDefault();
      const phone = navUrl.replace(/^tel:\+?/, '').trim();
      console.log('[Auto_Browser] Captured phone number from click:', phone);
      sendToUI('interaction:phoneCaptured', { phone, rawUrl: navUrl });
    }
  });

  // Load URL
  const homeFile = path.join(ROOT_DIR, 'ui', 'home.html');
  const targetUrl = (initialUrl || '').trim();
  if (!targetUrl || targetUrl === 'auto://home' || targetUrl === 'about:home' || targetUrl === 'about:blank' || targetUrl === 'https://httpbin.org') {
    bwc.loadFile(homeFile);
  } else {
    let finalUrl = targetUrl;
    if (!/^https?:\/\//i.test(finalUrl) && !/^file:\/\//i.test(finalUrl)) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }
    bwc.loadURL(finalUrl);
  }

  switchTab(tabId);
  return tabId;
}

function switchTab(tabId) {
  if (!tabs.has(tabId)) return;
  activeTabId = tabId;

  for (const [id, tab] of tabs.entries()) {
    if (id === tabId) {
      if (!currentBrowserBounds.hidden && currentBrowserBounds.width > 0 && currentBrowserBounds.height > 0) {
        tab.view.setVisible(true);
        tab.view.setBounds({
          x: Math.round(currentBrowserBounds.x),
          y: Math.round(currentBrowserBounds.y),
          width: Math.round(currentBrowserBounds.width),
          height: Math.round(currentBrowserBounds.height)
        });
      } else {
        tab.view.setVisible(false);
      }
      if (interactionManager) {
        interactionManager.webContents = tab.view.webContents;
      }
    } else {
      tab.view.setVisible(false);
    }
  }

  broadcastTabs();
  broadcastBrowserState();
}

function closeTab(tabId) {
  if (!tabs.has(tabId)) return;
  const tabToClose = tabs.get(tabId);
  const tabIds = Array.from(tabs.keys());
  const index = tabIds.indexOf(tabId);

  let nextActiveId = null;
  if (activeTabId === tabId) {
    if (tabIds.length > 1) {
      if (index > 0) {
        nextActiveId = tabIds[index - 1];
      } else {
        nextActiveId = tabIds[index + 1];
      }
    }
  } else {
    nextActiveId = activeTabId;
  }

  try {
    mainWindow.contentView.removeChildView(tabToClose.view);
    if (!tabToClose.view.webContents.isDestroyed()) {
      tabToClose.view.webContents.close();
    }
  } catch (e) {
    console.warn('Error removing tab view:', e);
  }

  tabs.delete(tabId);

  if (tabs.size === 0) {
    createTab('auto://home');
  } else if (nextActiveId) {
    switchTab(nextActiveId);
  } else {
    broadcastTabs();
  }
}

function createMainWindow() {
  loadSettings();
  recorder = new NetworkRecorder(ROOT_DIR, settings);

  let winWidth = 1200;
  let winHeight = 760;
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    winWidth = Math.min(1280, Math.max(750, screenWidth - 40));
    winHeight = Math.min(840, Math.max(500, screenHeight - 60));
  } catch (e) {
    console.warn('Could not read display workAreaSize:', e);
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 500,
    minHeight: 400,
    center: true,
    title: 'Auto_Browser - Custom Chromium Browser & Network Recorder',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#080c16',
      symbolColor: '#94a3b8',
      height: 38
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenu(null);

  // Initialize interaction manager
  interactionManager = new InteractionManager(null, ROOT_DIR);

  // Auto record if configured
  if (settings.autoRecord) {
    recorder.startSession();
  }

  // Inject Google Chrome Client Hints & clean headers across all requests
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = Object.assign({}, details.requestHeaders);
    requestHeaders['User-Agent'] = STANDARD_CHROME_UA;
    requestHeaders['sec-ch-ua'] = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;
    requestHeaders['sec-ch-ua-mobile'] = '?0';
    requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    callback({ cancel: false, requestHeaders });
  });

  // Create initial tab
  createTab(settings.homeUrl || 'auto://home');

  // Load UI into mainWindow
  mainWindow.loadFile(path.join(ROOT_DIR, 'ui', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('UI finished load successfully');
    broadcastTabs();
    broadcastBrowserState();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('UI failed to load:', code, desc);
  });

  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[UI Console] ${message}`);
  });

  mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 1000);
  console.log('mainWindow created and show() called, isVisible:', mainWindow.isVisible());

  mainWindow.on('closed', () => {
    if (recorder) recorder.stopSession();
    tabs.clear();
    activeTabId = null;
    mainWindow = null;
  });
}

// IPC Handlers - Tab Management
ipcMain.handle('tabs:create', (event, url) => {
  return createTab(url || 'auto://home');
});

ipcMain.handle('tabs:switch', (event, tabId) => {
  switchTab(tabId);
  return true;
});

ipcMain.handle('tabs:close', (event, tabId) => {
  closeTab(tabId);
  return true;
});

ipcMain.handle('tabs:getAll', () => {
  return getTabsSummary();
});

// Browser Controls & Bounds
ipcMain.handle('browser:updateBounds', (event, bounds) => {
  currentBrowserBounds = bounds || { x: 0, y: 0, width: 0, height: 0, hidden: true };
  const activeTab = getActiveTab();
  if (!activeTab || !mainWindow) return;

  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.hidden) {
    activeTab.view.setVisible(false);
  } else {
    activeTab.view.setVisible(true);
    activeTab.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    });
  }
});

ipcMain.handle('browser:navigate', async (event, inputUrl) => {
  const activeTab = getActiveTab();
  if (!activeTab) return;
  let target = (inputUrl || '').trim();
  if (!target) return;

  if (target === 'auto://home' || target === 'about:home' || target === 'about:blank') {
    activeTab.view.webContents.loadFile(path.join(ROOT_DIR, 'ui', 'home.html'));
    return;
  }

  if (target.toLowerCase().startsWith('javascript:')) {
    const code = target.slice(11);
    try {
      const res = await activeTab.view.webContents.executeJavaScript(code);
      return { executed: true, result: res };
    } catch (e) {
      return { executed: false, error: e.message };
    }
  }

  if (!/^https?:\/\//i.test(target) && !/^file:\/\//i.test(target)) {
    if (target.includes('.') && !target.includes(' ')) {
      target = 'https://' + target;
    } else {
      target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
    }
  }
  activeTab.view.webContents.loadURL(target);
});

ipcMain.handle('browser:executeScript', async (event, script) => {
  const activeTab = getActiveTab();
  if (activeTab && !activeTab.view.webContents.isDestroyed()) {
    try {
      const result = await activeTab.view.webContents.executeJavaScript(script);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'Active browser view unavailable' };
});

ipcMain.handle('browser:goBack', () => {
  const activeTab = getActiveTab();
  if (activeTab && activeTab.view.webContents.canGoBack()) {
    activeTab.view.webContents.goBack();
  }
});

ipcMain.handle('browser:goForward', () => {
  const activeTab = getActiveTab();
  if (activeTab && activeTab.view.webContents.canGoForward()) {
    activeTab.view.webContents.goForward();
  }
});

ipcMain.handle('browser:reload', () => {
  const activeTab = getActiveTab();
  if (activeTab) activeTab.view.webContents.reload();
});

ipcMain.handle('browser:stop', () => {
  const activeTab = getActiveTab();
  if (activeTab) activeTab.view.webContents.stop();
});

ipcMain.handle('browser:openDevTools', () => {
  const activeTab = getActiveTab();
  if (activeTab) {
    activeTab.view.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.handle('browser:openExternal', (event, url) => {
  const target = url || (getActiveTab() ? getActiveTab().url : null);
  if (target && /^https?:\/\//i.test(target)) {
    shell.openExternal(target);
    return true;
  }
  return false;
});

// Recorder IPC Handlers
ipcMain.handle('recorder:start', (event, customName) => {
  if (!recorder) return null;
  const session = recorder.startSession(customName);
  return { status: recorder.status, session, stats: recorder.stats };
});

ipcMain.handle('recorder:pause', () => {
  if (recorder) recorder.pauseSession();
  return { status: recorder.status };
});

ipcMain.handle('recorder:resume', () => {
  if (recorder) recorder.resumeSession();
  return { status: recorder.status };
});

ipcMain.handle('recorder:stop', () => {
  if (!recorder) return null;
  const session = recorder.stopSession();
  return { status: recorder.status, session, stats: recorder.stats };
});

ipcMain.handle('recorder:getStatus', () => {
  if (!recorder) return { status: 'idle', stats: {} };
  return {
    status: recorder.status,
    currentSession: recorder.currentSession,
    stats: recorder.stats
  };
});

ipcMain.handle('recorder:clear', () => {
  if (recorder) {
    recorder.records.clear();
    recorder.stats = { totalRequests: 0, totalResponses: 0, failedRequests: 0, totalBytes: 0, startTime: Date.now() };
  }
  return true;
});

ipcMain.handle('recorder:listSessions', () => {
  if (!recorder) return [];
  return recorder.listSessions();
});

ipcMain.handle('recorder:loadSession', (event, sessionId) => {
  if (!recorder) return null;
  return recorder.loadSession(sessionId);
});

ipcMain.handle('recorder:openSessionFolder', (event, sessionId) => {
  const sessionDir = sessionId ? path.join(ROOT_DIR, 'recordings', sessionId) : path.join(ROOT_DIR, 'recordings');
  if (fs.existsSync(sessionDir)) {
    shell.openPath(sessionDir);
    return true;
  }
  return false;
});

ipcMain.handle('recorder:deleteSession', (event, sessionId) => {
  if (!recorder) return false;
  return recorder.deleteSession(sessionId);
});

ipcMain.handle('recorder:clearAllRecordings', () => {
  if (!recorder) return false;
  return recorder.clearAllRecordings();
});

ipcMain.handle('recorder:exportHAR', (event, sessionId) => {
  if (!recorder) return null;
  const har = recorder.exportHAR(sessionId);
  if (!har) return null;

  const defaultPath = path.join(ROOT_DIR, 'recordings', `${sessionId || 'session'}.har`);
  const chosenPath = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export HTTP Archive (HAR)',
    defaultPath: defaultPath,
    filters: [{ name: 'HAR Files', extensions: ['har', 'json'] }]
  });

  if (chosenPath) {
    fs.writeFileSync(chosenPath, JSON.stringify(har, null, 2), 'utf-8');
    return chosenPath;
  }
  return null;
});

// Settings Handlers
ipcMain.handle('settings:get', () => {
  loadSettings();
  return settings;
});

ipcMain.handle('settings:save', (event, newSettings) => {
  saveSettings(newSettings);
  return settings;
});

// Element Interaction & Button Control IPC Handlers
ipcMain.handle('interaction:startPicker', async () => {
  if (interactionManager) return await interactionManager.startPicker();
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:stopPicker', async () => {
  if (interactionManager) return await interactionManager.stopPicker();
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:click', async (event, target) => {
  if (interactionManager) return await interactionManager.click(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:dblclick', async (event, target) => {
  if (interactionManager) return await interactionManager.dblclick(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:rightclick', async (event, target) => {
  if (interactionManager) return await interactionManager.rightclick(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:hover', async (event, target) => {
  if (interactionManager) return await interactionManager.hover(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:type', async (event, target) => {
  if (interactionManager) return await interactionManager.type(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:pressKey', async (event, key) => {
  if (interactionManager) return await interactionManager.pressKey(key);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:scroll', async (event, target) => {
  if (interactionManager) return await interactionManager.scroll(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:getElementInfo', async (event, selector) => {
  if (interactionManager) return await interactionManager.getElementInfo(selector);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:setValue', async (event, selector, value) => {
  if (interactionManager) return await interactionManager.setValue(selector, value);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:selectOption', async (event, selector, value) => {
  if (interactionManager) return await interactionManager.selectOption(selector, value);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:getAttribute', async (event, selector, attribute) => {
  if (interactionManager) return await interactionManager.getAttribute(selector, attribute);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:waitForElement', async (event, selector, timeout) => {
  if (interactionManager) return await interactionManager.waitForElement(selector, timeout);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:uploadFile', async (event, target) => {
  if (interactionManager) return await interactionManager.uploadFile(target);
  return { success: false, error: 'Interaction manager not available' };
});

ipcMain.handle('interaction:evaluate', async (event, expression) => {
  if (interactionManager) return await interactionManager.evaluate(expression);
  return { success: false, error: 'Interaction manager not available' };
});

// Chrome 3-Dots Popup Menu Handler (Native OS overlay)
ipcMain.handle('app:showMenu', (event, { x, y, isInspectorVisible, isRecording, isPaused } = {}) => {
  if (!mainWindow) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '📑 New Tab',
      accelerator: 'Ctrl+T',
      click: () => {
        createTab('auto://home');
      }
    },
    {
      label: '✖ Close Tab',
      accelerator: 'Ctrl+W',
      click: () => {
        if (activeTabId) closeTab(activeTabId);
      }
    },
    {
      label: '🌐 Open in External Browser',
      click: () => {
        const activeTab = getActiveTab();
        if (activeTab && activeTab.url && /^https?:\/\//i.test(activeTab.url)) {
          shell.openExternal(activeTab.url);
        }
      }
    },
    { type: 'separator' },
    {
      label: '📊 Network Inspector',
      type: 'checkbox',
      checked: !!isInspectorVisible,
      click: () => {
        mainWindow.webContents.send('menu:action', 'toggleInspector');
      }
    },
    {
      label: '🎯 Pick Element',
      accelerator: 'Ctrl+Shift+C',
      click: () => {
        mainWindow.webContents.send('menu:action', 'pickElement');
      }
    },
    {
      label: '✍ Button Controls Panel',
      click: () => {
        mainWindow.webContents.send('menu:action', 'toggleControls');
      }
    },
    {
      label: '🛠️ Chromium DevTools',
      accelerator: 'F12',
      click: () => {
        mainWindow.webContents.send('menu:action', 'openDevTools');
      }
    },
    { type: 'separator' },
    {
      label: isPaused ? '▶ Resume Recording' : '⏸ Pause Recording',
      enabled: !!isRecording,
      click: () => {
        mainWindow.webContents.send('menu:action', 'togglePause');
      }
    },
    {
      label: '🔄 New Session',
      click: () => {
        mainWindow.webContents.send('menu:action', 'newSession');
      }
    },
    {
      label: '📁 Saved Sessions...',
      click: () => {
        mainWindow.webContents.send('menu:action', 'openSessions');
      }
    },
    {
      label: '💾 Export HAR Archive...',
      click: () => {
        mainWindow.webContents.send('menu:action', 'exportHar');
      }
    },
    {
      label: '🧹 Clear Network Log',
      click: () => {
        mainWindow.webContents.send('menu:action', 'clearLog');
      }
    },
    { type: 'separator' },
    {
      label: '⚙️ Settings...',
      click: () => {
        mainWindow.webContents.send('menu:action', 'openSettings');
      }
    }
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.round(x || 0),
    y: Math.round(y || 0)
  });
});

function startLocalAutomationServer() {
  const jsonResponse = (res, statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const parseBody = (req) => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
    });
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method !== 'POST') {
      return jsonResponse(res, 404, { error: 'Not found' });
    }

    try {
      const data = await parseBody(req);

      if (!interactionManager) {
        return jsonResponse(res, 503, { error: 'Interaction manager not available' });
      }

      switch (req.url) {
        case '/navigate': {
          let target = (data.url || '').trim();
          if (!target) return jsonResponse(res, 400, { error: 'Missing url parameter' });
          if (!/^https?:\/\//i.test(target) && !/^about:/i.test(target)) {
            target = 'https://' + target;
          }
          const activeTab = getActiveTab();
          if (activeTab && !activeTab.view.webContents.isDestroyed()) {
            activeTab.view.webContents.loadURL(target);
            return jsonResponse(res, 200, { success: true, url: target });
          }
          return jsonResponse(res, 503, { error: 'Browser view not available' });
        }

        case '/click': {
          const target = data.selector ? { selector: data.selector } : (typeof data.x === 'number' ? { x: data.x, y: data.y } : null);
          if (!target) return jsonResponse(res, 400, { error: 'Provide selector or x, y coordinates' });
          const result = await interactionManager.click(target);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/dblclick': {
          const target = data.selector ? { selector: data.selector } : (typeof data.x === 'number' ? { x: data.x, y: data.y } : null);
          if (!target) return jsonResponse(res, 400, { error: 'Provide selector or x, y coordinates' });
          const result = await interactionManager.dblclick(target);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/rightclick': {
          const target = data.selector ? { selector: data.selector } : (typeof data.x === 'number' ? { x: data.x, y: data.y } : null);
          if (!target) return jsonResponse(res, 400, { error: 'Provide selector or x, y coordinates' });
          const result = await interactionManager.rightclick(target);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/hover': {
          const target = data.selector ? { selector: data.selector } : (typeof data.x === 'number' ? { x: data.x, y: data.y } : null);
          if (!target) return jsonResponse(res, 400, { error: 'Provide selector or x, y coordinates' });
          const result = await interactionManager.hover(target);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/type': {
          if (!data.text) return jsonResponse(res, 400, { error: 'Missing text parameter' });
          const result = await interactionManager.type({ selector: data.selector, text: data.text });
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/pressKey': {
          if (!data.key) return jsonResponse(res, 400, { error: 'Missing key parameter' });
          const result = await interactionManager.pressKey(data.key);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/scroll': {
          const result = await interactionManager.scroll({
            selector: data.selector,
            deltaX: data.deltaX || 0,
            deltaY: data.deltaY || 0
          });
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/elementInfo': {
          if (!data.selector) return jsonResponse(res, 400, { error: 'Missing selector parameter' });
          const result = await interactionManager.getElementInfo(data.selector);
          return jsonResponse(res, result.success ? 200 : 404, result);
        }

        case '/waitForElement': {
          if (!data.selector) return jsonResponse(res, 400, { error: 'Missing selector parameter' });
          const result = await interactionManager.waitForElement(data.selector, data.timeout || 5000);
          return jsonResponse(res, result.success ? 200 : 408, result);
        }

        case '/setValue': {
          if (!data.selector || data.value === undefined) return jsonResponse(res, 400, { error: 'Missing selector or value' });
          const result = await interactionManager.setValue(data.selector, data.value);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/selectOption': {
          if (!data.selector || data.value === undefined) return jsonResponse(res, 400, { error: 'Missing selector or value' });
          const result = await interactionManager.selectOption(data.selector, data.value);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/upload':
        case '/uploadFile': {
          if (!data.selector) return jsonResponse(res, 400, { error: 'Missing selector parameter' });
          const result = await interactionManager.uploadFile(data);
          return jsonResponse(res, result.success ? 200 : 400, result);
        }

        case '/exec': {
          if (!data.script) return jsonResponse(res, 400, { error: 'Missing script parameter' });
          const activeTab = getActiveTab();
          if (activeTab && !activeTab.view.webContents.isDestroyed()) {
            try {
              const result = await activeTab.view.webContents.executeJavaScript(data.script);
              return jsonResponse(res, 200, { success: true, result });
            } catch (err) {
              return jsonResponse(res, 500, { error: err.message });
            }
          }
          return jsonResponse(res, 503, { error: 'Browser view not available' });
        }

        default:
          return jsonResponse(res, 404, { error: 'Unknown endpoint: ' + req.url });
      }
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('Local automation server: port 4045 already in use, skipping.');
    } else {
      console.error('Local automation server error:', err);
    }
  });

  server.listen(4045, '127.0.0.1', () => {
    console.log('Local automation server listening on http://127.0.0.1:4045');
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();
    startLocalAutomationServer();
  });
}

app.on('before-quit', () => {
  if (recorder && recorder.activeSession) {
    recorder.stopSession();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
