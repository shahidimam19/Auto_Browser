const fs = require('fs');
const path = require('path');
const runAnalysis = require('../templates/analyse');

function getLocalTimestampString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

class NetworkRecorder {
  constructor(baseDir, settings = {}) {
    this.baseDir = baseDir;
    this.recordingsDir = path.join(baseDir, settings.storageDir || 'recordings');
    this.settings = Object.assign({
      autoRecord: false,
      captureBodies: true,
      maxBodySizeBytes: 5 * 1024 * 1024,
      redactHeaders: [],
      redactEnabled: false
    }, settings);

    this.status = 'idle'; // 'idle' | 'recording' | 'paused'
    this.currentSession = null;
    this.records = new Map(); // requestId -> combined record
    this.capturedTokens = new Map(); // uniqueKey -> token object
    this.stats = {
      totalRequests: 0,
      totalResponses: 0,
      failedRequests: 0,
      totalBytes: 0,
      startTime: null
    };

    this.ensureDirectory(this.recordingsDir);
  }

  ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  startSession(customName = null) {
    const timestamp = getLocalTimestampString();
    const sessionId = customName ? customName.replace(/[^a-zA-Z0-9_-]/g, '_') : `session_${timestamp}`;
    const sessionPath = path.join(this.recordingsDir, sessionId);
    const bodiesPath = path.join(sessionPath, 'bodies');

    const analysePath = path.join(sessionPath, 'analyse');

    this.ensureDirectory(sessionPath);
    this.ensureDirectory(bodiesPath);
    this.ensureDirectory(analysePath);

    try {
      const tplJs = path.join(this.baseDir, 'templates', 'analyse.js');
      const tplPy = path.join(this.baseDir, 'templates', 'analyse.py');
      if (fs.existsSync(tplJs)) fs.copyFileSync(tplJs, path.join(analysePath, 'analyse.js'));
      if (fs.existsSync(tplPy)) fs.copyFileSync(tplPy, path.join(analysePath, 'analyse.py'));
    } catch (e) {}

    this.currentSession = {
      id: sessionId,
      path: sessionPath,
      bodiesPath: bodiesPath,
      analysePath: analysePath,
      requestsJsonl: path.join(sessionPath, 'requests.jsonl'),
      responsesJsonl: path.join(sessionPath, 'responses.jsonl'),
      tokensJson: path.join(sessionPath, 'tokens.json'),
      metaPath: path.join(sessionPath, 'session_meta.json'),
      startTime: new Date().toISOString(),
      endTime: null,
      requestCount: 0,
      responseCount: 0,
      totalBytes: 0
    };

    this.records.clear();
    this.capturedTokens.clear();
    this.stats = {
      totalRequests: 0,
      totalResponses: 0,
      failedRequests: 0,
      totalBytes: 0,
      startTime: Date.now()
    };
    this.status = 'recording';

    this.writeMeta();
    return this.currentSession;
  }

  pauseSession() {
    if (this.status === 'recording') {
      this.status = 'paused';
    }
  }

  resumeSession() {
    if (this.status === 'paused') {
      this.status = 'recording';
    }
  }

  stopSession() {
    if (this.currentSession) {
      this.currentSession.endTime = new Date().toISOString();
      this.saveTokens();
      this.writeMeta();
      try {
        runAnalysis(this.currentSession.path);
      } catch (err) {
        console.error('Failed auto-running analysis on stopSession:', err);
      }
    }
    this.status = 'idle';
    const finishedSession = this.currentSession;
    return finishedSession;
  }

  writeMeta() {
    if (!this.currentSession) return;
    const meta = {
      id: this.currentSession.id,
      startTime: this.currentSession.startTime,
      endTime: this.currentSession.endTime,
      requestCount: this.stats.totalRequests,
      responseCount: this.stats.totalResponses,
      failedRequests: this.stats.failedRequests,
      totalBytes: this.stats.totalBytes,
      capturedTokensCount: this.capturedTokens ? this.capturedTokens.size : 0,
      status: this.status
    };
    try {
      fs.writeFileSync(this.currentSession.metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write session metadata:', err);
    }
  }

  decodeJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;
    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
      const payload = JSON.parse(jsonStr);
      return payload;
    } catch {
      return null;
    }
  }

  detectTokensFromHeaders(headers, url, requestId, isResponse = false) {
    if (!headers) return [];
    const found = [];
    const source = isResponse ? 'response_header' : 'request_header';

    for (const [key, rawVal] of Object.entries(headers)) {
      if (!rawVal || rawVal === '[REDACTED]') continue;
      const lower = key.toLowerCase();
      const valStr = String(rawVal);

      // Authorization Header
      if (lower === 'authorization') {
        const isBearer = valStr.toLowerCase().startsWith('bearer ');
        const tokenVal = isBearer ? valStr.slice(7).trim() : valStr.trim();
        const jwtPayload = this.decodeJwt(tokenVal);
        found.push({
          type: isBearer ? (jwtPayload ? 'Bearer JWT' : 'Bearer Token') : 'Authorization Header',
          name: key,
          token: tokenVal,
          value: valStr,
          source,
          url,
          requestId,
          isJwt: !!jwtPayload,
          jwtPayload,
          timestamp: new Date().toISOString()
        });
      }
      // Custom Auth / Token / API Key Headers
      else if (/auth|token|jwt|api[-_]?key|secret|session/i.test(lower)) {
        const jwtPayload = this.decodeJwt(valStr.trim());
        found.push({
          type: jwtPayload ? 'JWT Token' : (/key/i.test(lower) ? 'API Key' : 'Auth Header'),
          name: key,
          token: valStr.trim(),
          value: valStr,
          source,
          url,
          requestId,
          isJwt: !!jwtPayload,
          jwtPayload,
          timestamp: new Date().toISOString()
        });
      }
      // Cookies
      else if (lower === 'cookie' || lower === 'set-cookie') {
        const cookieStrings = Array.isArray(rawVal) ? rawVal : valStr.split(lower === 'cookie' ? ';' : '\n');
        for (const cStr of cookieStrings) {
          const cookiePair = cStr.trim().split(';')[0];
          const eqIdx = cookiePair.indexOf('=');
          if (eqIdx > 0) {
            const cName = cookiePair.slice(0, eqIdx).trim();
            const cVal = cookiePair.slice(eqIdx + 1).trim();
            const isAuthCookie = /auth|token|jwt|session|sid|access|id_token|ticket/i.test(cName) || cVal.startsWith('ey');
            if (isAuthCookie && cVal) {
              const jwtPayload = this.decodeJwt(cVal);
              found.push({
                type: jwtPayload ? 'JWT Cookie' : 'Auth Cookie',
                name: cName,
                token: cVal,
                value: cookiePair,
                source: isResponse ? 'response_cookie' : 'request_cookie',
                url,
                requestId,
                isJwt: !!jwtPayload,
                jwtPayload,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      }
    }
    return found;
  }

  detectTokensFromBody(bodyText, url, requestId, isResponse = false) {
    if (!bodyText || typeof bodyText !== 'string') return [];
    const found = [];
    const source = isResponse ? 'response_body' : 'request_body';

    try {
      const parsed = JSON.parse(bodyText);
      const scanObject = (obj, prefix = '') => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${k}` : k;
          if (typeof v === 'string' && v.length > 5) {
            if (/token|jwt|access_token|accessToken|id_token|refresh_token|refreshToken|apiKey|api_key|authToken|sessionToken/i.test(k) || v.startsWith('eyJ')) {
              const jwtPayload = this.decodeJwt(v);
              found.push({
                type: jwtPayload ? 'JWT Token' : 'Body Token',
                name: fullKey,
                token: v,
                value: v,
                source,
                url,
                requestId,
                isJwt: !!jwtPayload,
                jwtPayload,
                timestamp: new Date().toISOString()
              });
            }
          } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            scanObject(v, fullKey);
          }
        }
      };
      scanObject(parsed);
    } catch {}
    return found;
  }

  registerCapturedTokens(tokens) {
    if (!tokens || !tokens.length || !this.currentSession) return;
    let newCount = 0;
    for (const t of tokens) {
      const key = `${t.source}:${t.name}:${t.token}`;
      if (!this.capturedTokens.has(key)) {
        this.capturedTokens.set(key, t);
        newCount++;
      }
    }
    if (newCount > 0) {
      this.saveTokens();
    }
  }

  saveTokens() {
    if (!this.currentSession) return;
    const tokenList = Array.from(this.capturedTokens.values());
    try {
      fs.writeFileSync(this.currentSession.tokensJson, JSON.stringify(tokenList, null, 2), 'utf-8');

      const csvHeader = 'Timestamp,Source,Type,Name,Token,URL\n';
      const csvRows = tokenList.map(t => {
        const safeToken = `"${(t.token || '').replace(/"/g, '""')}"`;
        const safeUrl = `"${(t.url || '').replace(/"/g, '""')}"`;
        return `${t.timestamp},${t.source},${t.type},${t.name},${safeToken},${safeUrl}`;
      }).join('\n');

      const csvPath = path.join(this.currentSession.analysePath, 'tokens_captured.csv');
      fs.writeFileSync(csvPath, csvHeader + csvRows, 'utf-8');
    } catch (err) {
      console.error('Failed saving tokens to disk:', err);
    }
  }

  redactHeaders(headers) {
    if (!this.settings.redactEnabled || !headers) return headers;
    if (!this.settings.redactHeaders || !this.settings.redactHeaders.length) return headers;
    const redacted = {};
    const sensitive = (this.settings.redactHeaders || []).map(h => h.toLowerCase());

    for (const [key, value] of Object.entries(headers)) {
      if (sensitive.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  recordRequest(params) {
    if (this.status !== 'recording') return null;

    const { requestId, request, timestamp, wallTime, initiator, type, documentURL } = params;
    
    const sanitizedHeaders = this.redactHeaders(request.headers);
    const postData = request.postData;

    // Detect and capture auth tokens
    const tokens = this.detectTokensFromHeaders(request.headers, request.url, requestId, false);
    if (postData) {
      tokens.push(...this.detectTokensFromBody(postData, request.url, requestId, false));
    }
    this.registerCapturedTokens(tokens);

    let bodySavedFile = null;
    if (postData && this.currentSession && this.settings.captureBodies) {
      try {
        const bodyFilename = `${requestId}_req.txt`;
        const bodyFilePath = path.join(this.currentSession.bodiesPath, bodyFilename);
        fs.writeFileSync(bodyFilePath, postData, 'utf-8');
        bodySavedFile = `bodies/${bodyFilename}`;
      } catch (e) {
        console.error('Failed to save request body:', e);
      }
    }

    const reqRecord = {
      requestId,
      url: request.url,
      method: request.method,
      headers: sanitizedHeaders,
      postData: postData,
      postDataFile: bodySavedFile,
      hasPostData: request.hasPostData || !!postData,
      tokens: tokens,
      timestamp: timestamp,
      wallTime: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
      initiator: initiator,
      resourceType: type || 'Other',
      documentURL: documentURL
    };

    if (this.currentSession) {
      try {
        fs.appendFileSync(this.currentSession.requestsJsonl, JSON.stringify(reqRecord) + '\n', 'utf-8');
      } catch (err) {
        console.error('Failed appending to requests.jsonl:', err);
      }
    }

    this.stats.totalRequests++;
    this.records.set(requestId, {
      requestId,
      request: reqRecord,
      response: null,
      tokens: tokens,
      status: 'pending',
      durationMs: null,
      startTime: Date.now()
    });

    return reqRecord;
  }

  recordResponse(params) {
    if (this.status !== 'recording' && this.status !== 'paused') return null;

    const { requestId, response, type, timestamp } = params;
    const sanitizedHeaders = this.redactHeaders(response.headers);

    // Detect response tokens (Set-Cookie, Auth headers, etc.)
    const tokens = this.detectTokensFromHeaders(response.headers, response.url, requestId, true);
    this.registerCapturedTokens(tokens);

    const resRecord = {
      requestId,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: sanitizedHeaders,
      mimeType: response.mimeType,
      remoteIPAddress: response.remoteIPAddress,
      remotePort: response.remotePort,
      timing: response.timing,
      fromDiskCache: response.fromDiskCache,
      fromServiceWorker: response.fromServiceWorker,
      resourceType: type,
      tokens: tokens,
      timestamp: timestamp,
      wallTime: new Date().toISOString()
    };

    if (this.currentSession) {
      try {
        fs.appendFileSync(this.currentSession.responsesJsonl, JSON.stringify(resRecord) + '\n', 'utf-8');
      } catch (err) {
        console.error('Failed appending to responses.jsonl:', err);
      }
    }

    this.stats.totalResponses++;
    if (response.status >= 400) {
      this.stats.failedRequests++;
    }

    const item = this.records.get(requestId) || { requestId, request: null, startTime: Date.now() };
    item.response = resRecord;
    item.status = response.status;
    if (tokens && tokens.length) {
      item.tokens = (item.tokens || []).concat(tokens);
    }
    this.records.set(requestId, item);

    return resRecord;
  }

  recordFinished(params, bodyData = null) {
    const { requestId, timestamp, encodedDataLength } = params;
    const item = this.records.get(requestId);
    if (!item) return;

    if (item.startTime) {
      item.durationMs = Date.now() - item.startTime;
    }
    item.encodedDataLength = encodedDataLength || 0;
    this.stats.totalBytes += (encodedDataLength || 0);

    if (bodyData && this.currentSession && this.settings.captureBodies) {
      try {
        const ext = this.getExtensionForMime(item.response?.mimeType);
        const bodyFilename = `${requestId}_res.${ext}`;
        const bodyFilePath = path.join(this.currentSession.bodiesPath, bodyFilename);

        if (bodyData.base64Encoded) {
          const buffer = Buffer.from(bodyData.body, 'base64');
          fs.writeFileSync(bodyFilePath, buffer);
        } else {
          fs.writeFileSync(bodyFilePath, bodyData.body, 'utf-8');

          // Detect tokens in response JSON payload
          const bodyTokens = this.detectTokensFromBody(bodyData.body, item.request?.url, requestId, true);
          if (bodyTokens && bodyTokens.length) {
            this.registerCapturedTokens(bodyTokens);
            item.tokens = (item.tokens || []).concat(bodyTokens);
          }
        }
        item.responseBodyFile = `bodies/${bodyFilename}`;
        item.responseBody = bodyData.body;
        item.isBase64 = bodyData.base64Encoded;
      } catch (err) {
        console.error('Failed to save response body:', err);
      }
    }

    this.writeMeta();
    return item;
  }

  recordFailed(params) {
    const { requestId, errorText, canceled } = params;
    const item = this.records.get(requestId);
    if (item) {
      item.failed = true;
      item.errorText = errorText;
      item.canceled = canceled;
      if (item.startTime) item.durationMs = Date.now() - item.startTime;
    }
    this.stats.failedRequests++;
    this.writeMeta();
    return item;
  }

  getExtensionForMime(mimeType) {
    if (!mimeType) return 'bin';
    if (mimeType.includes('json')) return 'json';
    if (mimeType.includes('html')) return 'html';
    if (mimeType.includes('javascript')) return 'js';
    if (mimeType.includes('css')) return 'css';
    if (mimeType.includes('image/png')) return 'png';
    if (mimeType.includes('image/jpeg')) return 'jpg';
    if (mimeType.includes('image/svg')) return 'svg';
    if (mimeType.includes('image/webp')) return 'webp';
    if (mimeType.includes('text/plain')) return 'txt';
    return 'bin';
  }

  listSessions() {
    this.ensureDirectory(this.recordingsDir);
    const dirs = fs.readdirSync(this.recordingsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    const sessions = [];
    for (const dirName of dirs) {
      const metaFile = path.join(this.recordingsDir, dirName, 'session_meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
          sessions.push(meta);
        } catch {
          sessions.push({ id: dirName, startTime: null, requestCount: 0 });
        }
      } else {
        sessions.push({ id: dirName, startTime: null, requestCount: 0 });
      }
    }

    return sessions.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
  }

  loadSession(sessionId) {
    const sessionPath = path.join(this.recordingsDir, sessionId);
    if (!fs.existsSync(sessionPath)) return null;

    const reqFile = path.join(sessionPath, 'requests.jsonl');
    const resFile = path.join(sessionPath, 'responses.jsonl');
    const metaFile = path.join(sessionPath, 'session_meta.json');

    let meta = null;
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (e) {}
    }

    const requests = [];
    if (fs.existsSync(reqFile)) {
      const lines = fs.readFileSync(reqFile, 'utf-8').split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try { requests.push(JSON.parse(line)); } catch (e) {}
        }
      }
    }

    const responses = new Map();
    if (fs.existsSync(resFile)) {
      const lines = fs.readFileSync(resFile, 'utf-8').split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            responses.set(parsed.requestId, parsed);
          } catch (e) {}
        }
      }
    }

    const combined = requests.map(req => {
      const res = responses.get(req.requestId) || null;
      let body = null;
      let isBase64 = false;
      const ext = this.getExtensionForMime(res?.mimeType);
      const bodyPath = path.join(sessionPath, 'bodies', `${req.requestId}_res.${ext}`);
      if (fs.existsSync(bodyPath)) {
        try {
          if (['png', 'jpg', 'webp', 'bin'].includes(ext)) {
            body = fs.readFileSync(bodyPath).toString('base64');
            isBase64 = true;
          } else {
            body = fs.readFileSync(bodyPath, 'utf-8');
          }
        } catch (e) {}
      }

      const recObj = {
        requestId: req.requestId,
        request: req,
        response: res,
        tokens: req.tokens || res?.tokens || [],
        status: res ? res.status : 0,
        responseBody: body,
        isBase64: isBase64,
        responseBodyFile: body ? `bodies/${req.requestId}_res.${ext}` : null
      };
      return recObj;
    });

    const tokensFile = path.join(sessionPath, 'tokens.json');
    let tokens = [];
    if (fs.existsSync(tokensFile)) {
      try { tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8')); } catch (e) {}
    } else {
      for (const rec of combined) {
        if (rec.request?.headers) {
          tokens.push(...this.detectTokensFromHeaders(rec.request.headers, rec.request.url, rec.requestId, false));
        }
        if (rec.request?.postData) {
          tokens.push(...this.detectTokensFromBody(rec.request.postData, rec.request.url, rec.requestId, false));
        }
        if (rec.response?.headers) {
          tokens.push(...this.detectTokensFromHeaders(rec.response.headers, rec.response.url, rec.requestId, true));
        }
        if (rec.responseBody && !rec.isBase64) {
          tokens.push(...this.detectTokensFromBody(rec.responseBody, rec.request?.url, rec.requestId, true));
        }
      }
    }

    return {
      meta,
      records: combined,
      tokens
    };
  }

  deleteSession(sessionId) {
    const sessionPath = path.join(this.recordingsDir, sessionId);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        return true;
      } catch (err) {
        console.error('Failed to delete session:', err);
        return false;
      }
    }
    return false;
  }

  clearAllRecordings() {
    this.ensureDirectory(this.recordingsDir);
    try {
      const items = fs.readdirSync(this.recordingsDir);
      for (const item of items) {
        const itemPath = path.join(this.recordingsDir, item);
        fs.rmSync(itemPath, { recursive: true, force: true });
      }
      return true;
    } catch (err) {
      console.error('Failed to clear all recordings:', err);
      return false;
    }
  }

  exportHAR(sessionId) {
    const data = this.loadSession(sessionId);
    if (!data) return null;

    const entries = data.records.map(r => {
      const req = r.request;
      const res = r.response;
      return {
        startedDateTime: req?.wallTime || new Date().toISOString(),
        time: r.durationMs || 50,
        request: {
          method: req?.method || 'GET',
          url: req?.url || '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(req?.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: req?.postData ? Buffer.byteLength(req.postData) : 0,
          postData: req?.postData ? { mimeType: 'application/octet-stream', text: req.postData } : undefined
        },
        response: {
          status: res?.status || 0,
          statusText: res?.statusText || '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(res?.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
          cookies: [],
          content: {
            size: r.encodedDataLength || 0,
            mimeType: res?.mimeType || 'application/octet-stream',
            text: r.responseBody || '',
            encoding: r.isBase64 ? 'base64' : undefined
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: r.encodedDataLength || 0
        },
        cache: {},
        timings: {
          send: 0,
          wait: r.durationMs || 50,
          receive: 0
        }
      };
    });

    return {
      log: {
        version: '1.2',
        creator: { name: 'Auto_Browser Network Recorder', version: '1.0.0' },
        pages: [],
        entries: entries
      }
    };
  }
}

module.exports = NetworkRecorder;
