const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const NetworkRecorder = require('./recorder');
const InteractionManager = require('./interaction');

let mainWindow = null;
let browserView = null;
let recorder = null;
let interactionManager = null;
let settings = {};
const settingsPath = path.join(__dirname, 'settings.json');

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
      homeUrl: 'https://httpbin.org',
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

function broadcastBrowserState() {
  if (!browserView || !mainWindow || browserView.webContents.isDestroyed()) return;
  const wc = browserView.webContents;
  sendToUI('browser:state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    isLoading: wc.isLoading(),
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false)
  });
}

function createMainWindow() {
  loadSettings();
  recorder = new NetworkRecorder(__dirname, settings);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 650,
    title: 'Auto_Browser - Custom Chromium Browser & Network Recorder',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenu(null);

  // Create embedded Chromium Browser view
  browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      javascript: true
    }
  });

  mainWindow.contentView.addChildView(browserView);

  const bwc = browserView.webContents;

  // Track browser events
  bwc.on('did-start-navigation', (e, url) => {
    broadcastBrowserState();
  });
  bwc.on('did-navigate', (e, url) => {
    broadcastBrowserState();
  });
  bwc.on('did-navigate-in-page', (e, url) => {
    broadcastBrowserState();
  });
  bwc.on('did-start-loading', () => {
    broadcastBrowserState();
  });
  bwc.on('did-stop-loading', () => {
    broadcastBrowserState();
  });
  bwc.on('page-title-updated', (e, title) => {
    broadcastBrowserState();
  });

  // Attach Chrome DevTools Protocol to browser view
  attachCDP(bwc);

  // Initialize interaction manager for button controls & element picker
  interactionManager = new InteractionManager(bwc, __dirname);

  // Intercept element picker events from browserView
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

  // Intercept tel: phone links and dialer triggers to capture mobile numbers directly
  bwc.on('will-navigate', (event, navUrl) => {
    if (navUrl && navUrl.startsWith('tel:')) {
      event.preventDefault();
      const phone = navUrl.replace(/^tel:\+?/, '').trim();
      console.log('[Auto_Browser] Captured phone number from click:', phone);
      sendToUI('interaction:phoneCaptured', { phone, rawUrl: navUrl });
    }
  });

  // Load the initial home page
  const homeUrl = settings.homeUrl || 'https://httpbin.org';
  bwc.loadURL(homeUrl);

  // Auto record if configured
  if (settings.autoRecord) {
    recorder.startSession();
  }

  // Load UI into mainWindow
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('UI finished load successfully');
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
    browserView = null;
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('browser:updateBounds', (event, bounds) => {
  if (!browserView || !mainWindow) return;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.hidden) {
    browserView.setVisible(false);
  } else {
    browserView.setVisible(true);
    browserView.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    });
  }
});

ipcMain.handle('browser:navigate', async (event, inputUrl) => {
  if (!browserView) return;
  let target = inputUrl.trim();
  if (!target) return;

  if (target.toLowerCase().startsWith('javascript:')) {
    const code = target.slice(11);
    try {
      const res = await browserView.webContents.executeJavaScript(code);
      return { executed: true, result: res };
    } catch (e) {
      return { executed: false, error: e.message };
    }
  }

  if (!/^https?:\/\//i.test(target) && !/^about:/i.test(target)) {
    if (target.includes('.') && !target.includes(' ')) {
      target = 'https://' + target;
    } else {
      target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
    }
  }
  browserView.webContents.loadURL(target);
});

ipcMain.handle('browser:executeScript', async (event, script) => {
  if (browserView && !browserView.webContents.isDestroyed()) {
    try {
      const result = await browserView.webContents.executeJavaScript(script);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'browserView unavailable' };
});

ipcMain.handle('browser:goBack', () => {
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
});

ipcMain.handle('browser:goForward', () => {
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
});

ipcMain.handle('browser:reload', () => {
  if (browserView) browserView.webContents.reload();
});

ipcMain.handle('browser:stop', () => {
  if (browserView) browserView.webContents.stop();
});

ipcMain.handle('browser:openDevTools', () => {
  if (browserView) {
    browserView.webContents.openDevTools({ mode: 'detach' });
  }
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
  const sessionDir = sessionId ? path.join(__dirname, 'recordings', sessionId) : path.join(__dirname, 'recordings');
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

  const defaultPath = path.join(__dirname, 'recordings', `${sessionId || 'session'}.har`);
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

ipcMain.handle('interaction:evaluate', async (event, expression) => {
  if (interactionManager) return await interactionManager.evaluate(expression);
  return { success: false, error: 'Interaction manager not available' };
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
          if (browserView && !browserView.webContents.isDestroyed()) {
            browserView.webContents.loadURL(target);
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

        case '/exec': {
          if (!data.script) return jsonResponse(res, 400, { error: 'Missing script parameter' });
          if (browserView && !browserView.webContents.isDestroyed()) {
            try {
              const result = await browserView.webContents.executeJavaScript(data.script);
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
