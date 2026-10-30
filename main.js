const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const NetworkRecorder = require('./recorder');

let mainWindow = null;
let browserView = null;
let recorder = null;
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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

function startLocalAutomationServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === '/click' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { selector } = JSON.parse(body || '{}');
          if (!selector) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing selector' }));
          }
          if (browserView && !browserView.webContents.isDestroyed()) {
            const script = `
              (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (el) {
                  el.click();
                  return { clicked: true, tag: el.tagName, href: el.href || null };
                }
                return { clicked: false, error: 'Element not found' };
              })()
            `;
            const result = await browserView.webContents.executeJavaScript(script);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, result }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Browser view not available' }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.url === '/exec' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { script } = JSON.parse(body || '{}');
          if (!script) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing script' }));
          }
          if (browserView && !browserView.webContents.isDestroyed()) {
            const result = await browserView.webContents.executeJavaScript(script);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, result }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Browser view not available' }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
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
