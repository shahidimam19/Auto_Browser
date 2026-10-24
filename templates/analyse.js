const fs = require('fs');
const path = require('path');

function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function runAnalysis(sessionDir = path.resolve(__dirname, '..')) {
  const reqFile = path.join(sessionDir, 'requests.jsonl');
  const resFile = path.join(sessionDir, 'responses.jsonl');
  const tokensFile = path.join(sessionDir, 'tokens.json');
  const analyseDir = path.join(sessionDir, 'analyse');

  if (!fs.existsSync(analyseDir)) {
    fs.mkdirSync(analyseDir, { recursive: true });
  }

  if (!fs.existsSync(reqFile)) {
    console.error('requests.jsonl not found in session folder.');
    return;
  }

  const requests = [];
  const reqLines = fs.readFileSync(reqFile, 'utf-8').split('\n').filter(l => l.trim());
  for (const line of reqLines) {
    try { requests.push(JSON.parse(line)); } catch (e) {}
  }

  const responses = new Map();
  if (fs.existsSync(resFile)) {
    const resLines = fs.readFileSync(resFile, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of resLines) {
      try {
        const res = JSON.parse(line);
        responses.set(res.requestId, res);
      } catch (e) {}
    }
  }

  const domainStats = {};
  const apiEndpoints = [];
  const staticAssets = [];
  const rscTransitions = [];
  const authHeadersFound = new Set();
  const statusDistribution = {};
  const capturedTokensMap = new Map();

  // Load pre-existing tokens.json if present
  if (fs.existsSync(tokensFile)) {
    try {
      const savedTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      for (const t of savedTokens) {
        capturedTokensMap.set(`${t.source}:${t.name}:${t.token}`, t);
      }
    } catch (e) {}
  }

  for (const req of requests) {
    const res = responses.get(req.requestId);
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url);
    } catch {
      continue;
    }

    const domain = parsedUrl.host;
    domainStats[domain] = (domainStats[domain] || 0) + 1;

    const status = res ? res.status : 'pending';
    statusDistribution[status] = (statusDistribution[status] || 0) + 1;

    // Scan Request Headers for Auth & Tokens
    if (req.headers) {
      for (const [h, val] of Object.entries(req.headers)) {
        if (/auth|token|key|ngrok|cookie|session/i.test(h)) {
          authHeadersFound.add(h);

          const valStr = String(val);
          if (valStr && valStr !== '[REDACTED]') {
            if (h.toLowerCase() === 'authorization') {
              const isBearer = valStr.toLowerCase().startsWith('bearer ');
              const tokenVal = isBearer ? valStr.slice(7).trim() : valStr.trim();
              const jwtPayload = decodeJwt(tokenVal);
              const key = `request_header:${h}:${tokenVal}`;
              if (!capturedTokensMap.has(key)) {
                capturedTokensMap.set(key, {
                  type: isBearer ? (jwtPayload ? 'Bearer JWT' : 'Bearer Token') : 'Authorization Header',
                  name: h,
                  token: tokenVal,
                  value: valStr,
                  source: 'request_header',
                  url: req.url,
                  jwtPayload
                });
              }
            } else if (h.toLowerCase() === 'cookie') {
              for (const cStr of valStr.split(';')) {
                const pair = cStr.trim().split('=');
                if (pair.length >= 2) {
                  const cName = pair[0].trim();
                  const cVal = pair.slice(1).join('=').trim();
                  if (/token|auth|jwt|session|sid|access/i.test(cName) || cVal.startsWith('ey')) {
                    const jwtPayload = decodeJwt(cVal);
                    const key = `request_cookie:${cName}:${cVal}`;
                    if (!capturedTokensMap.has(key)) {
                      capturedTokensMap.set(key, {
                        type: jwtPayload ? 'JWT Cookie' : 'Auth Cookie',
                        name: cName,
                        token: cVal,
                        value: `${cName}=${cVal}`,
                        source: 'request_cookie',
                        url: req.url,
                        jwtPayload
                      });
                    }
                  }
                }
              }
            } else if (/auth|token|key/i.test(h)) {
              const jwtPayload = decodeJwt(valStr.trim());
              const key = `request_header:${h}:${valStr.trim()}`;
              if (!capturedTokensMap.has(key)) {
                capturedTokensMap.set(key, {
                  type: jwtPayload ? 'JWT Token' : 'Auth Header',
                  name: h,
                  token: valStr.trim(),
                  value: valStr,
                  source: 'request_header',
                  url: req.url,
                  jwtPayload
                });
              }
            }
          }
        }
      }
    }

    // Scan Response Headers for Set-Cookie / Auth Tokens
    if (res?.headers) {
      for (const [h, val] of Object.entries(res.headers)) {
        if (h.toLowerCase() === 'set-cookie') {
          const valStr = String(val);
          for (const cStr of valStr.split('\n')) {
            const pair = cStr.trim().split(';')[0].split('=');
            if (pair.length >= 2) {
              const cName = pair[0].trim();
              const cVal = pair.slice(1).join('=').trim();
              if (/token|auth|jwt|session|sid|access/i.test(cName) || cVal.startsWith('ey')) {
                const jwtPayload = decodeJwt(cVal);
                const key = `response_cookie:${cName}:${cVal}`;
                if (!capturedTokensMap.has(key)) {
                  capturedTokensMap.set(key, {
                    type: jwtPayload ? 'JWT Cookie' : 'Set-Cookie Token',
                    name: cName,
                    token: cVal,
                    value: cStr.trim(),
                    source: 'response_cookie',
                    url: req.url,
                    jwtPayload
                  });
                }
              }
            }
          }
        }
      }
    }

    const isRsc = req.url.includes('_rsc=') || (req.headers && req.headers['rsc'] === '1');
    const isApi = domain.startsWith('api.') || parsedUrl.pathname.startsWith('/api/');
    const isStatic = /\.(js|css|woff2?|png|jpe?g|svg|ico)$/i.test(parsedUrl.pathname) || req.resourceType === 'Script' || req.resourceType === 'Stylesheet' || req.resourceType === 'Font';

    const entry = {
      method: req.method,
      url: req.url,
      pathname: parsedUrl.pathname,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      status: status,
      mimeType: res?.mimeType || 'unknown',
      resourceType: req.resourceType
    };

    if (isApi) {
      apiEndpoints.push(entry);
    } else if (isRsc) {
      rscTransitions.push(entry);
    } else if (isStatic) {
      staticAssets.push(entry);
    }
  }

  const capturedTokensList = Array.from(capturedTokensMap.values());

  // Extract Workers from /api/workers endpoints AND search/list endpoints
  const workersMap = new Map();

  const addWorker = (w, endpoint) => {
    if (!w || typeof w !== 'object') return;
    const uid = w.userId || w.id || w._id;
    if (!uid) return;

    const existing = workersMap.get(uid);
    const workerInfo = {
      workerId: w.id || w._id || (existing ? existing.workerId : 'N/A'),
      userId: w.userId || uid,
      name: w.name || w.fullName || (existing ? existing.name : 'Unknown'),
      gender: w.gender || (existing ? existing.gender : 'N/A'),
      age: w.age != null ? String(w.age) : (existing ? existing.age : 'N/A'),
      experienceYears: w.experienceYears != null ? String(w.experienceYears) : (existing ? existing.experienceYears : 'N/A'),
      category: (w.categories || []).map(c => c.name || c).join(', ') || (existing ? existing.category : 'N/A'),
      wage: w.wage ? `${w.wage.amount} / ${w.wage.type}` : (existing ? existing.wage : 'N/A'),
      address: (w.district || w.state) ? `${w.district || ''}, ${w.state || ''}`.replace(/^, |, $/g, '') : (w.address ? `${w.address.district || ''}, ${w.address.state || ''}` : (existing ? existing.address : 'N/A')),
      rating: w.avgRating != null ? String(w.avgRating) : (existing ? existing.rating : 'N/A'),
      isVerified: w.isVerified != null ? (w.isVerified ? 'Yes' : 'No') : (existing ? existing.isVerified : 'N/A'),
      endpoint: endpoint || (existing ? existing.endpoint : 'N/A')
    };
    workersMap.set(uid, workerInfo);
  };

  for (const req of requests) {
    const resFile = path.join(sessionDir, 'bodies', req.requestId + '_res.json');
    if (fs.existsSync(resFile)) {
      try {
        const body = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
        if (body.worker) {
          addWorker(body.worker, req.url);
        } else if (Array.isArray(body.results)) {
          body.results.forEach(w => addWorker(w, req.url));
        } else if (Array.isArray(body.workers)) {
          body.workers.forEach(w => addWorker(w, req.url));
        } else if (Array.isArray(body)) {
          body.forEach(w => addWorker(w, req.url));
        }
      } catch(e){}
    } else {
      const m = req.url.match(/\/api\/workers\/([a-f0-9]{24})/i);
      if (m && !workersMap.has(m[1])) {
        workersMap.set(m[1], {
          workerId: 'N/A',
          userId: m[1],
          name: 'Unknown',
          gender: 'N/A',
          age: 'N/A',
          experienceYears: 'N/A',
          category: 'N/A',
          wage: 'N/A',
          address: 'N/A',
          rating: 'N/A',
          isVerified: 'N/A',
          endpoint: req.url
        });
      }
    }
  }

  const workersList = Array.from(workersMap.values());
  if (workersList.length > 0) {
    const workersCsvPath = path.join(analyseDir, 'workers_captured.csv');
    const wHeaders = 'Worker_ID,User_ID,Name,Gender,Age,Experience_Years,Category,Wage,Location,Rating,Verified,API_Endpoint\n';
    const wRows = workersList.map(w =>
      `"${w.workerId}","${w.userId}","${w.name}","${w.gender}","${w.age}","${w.experienceYears}","${w.category}","${w.wage}","${w.address}","${w.rating}","${w.isVerified}","${w.endpoint}"`
    ).join('\n');
    fs.writeFileSync(workersCsvPath, wHeaders + wRows, 'utf-8');

    const workersJsonPath = path.join(analyseDir, 'workers_captured.json');
    fs.writeFileSync(workersJsonPath, JSON.stringify(workersList, null, 2), 'utf-8');
  }

  // Save CSV and JSON in analyse/
  const tokensCsvPath = path.join(analyseDir, 'tokens_captured.csv');
  const csvHeader = 'Source,Type,Name,Token,URL\n';
  const csvRows = capturedTokensList.map(t => {
    const safeToken = `"${(t.token || '').replace(/"/g, '""')}"`;
    const safeUrl = `"${(t.url || '').replace(/"/g, '""')}"`;
    return `${t.source},${t.type},${t.name},${safeToken},${safeUrl}`;
  }).join('\n');
  fs.writeFileSync(tokensCsvPath, csvHeader + csvRows, 'utf-8');

  const tokensJsonPath = path.join(analyseDir, 'tokens_captured.json');
  fs.writeFileSync(tokensJsonPath, JSON.stringify(capturedTokensList, null, 2), 'utf-8');

  const analysis = {
    sessionId: path.basename(sessionDir),
    analyzedAt: new Date().toISOString(),
    summary: {
      totalRequests: requests.length,
      totalResponses: responses.size,
      domainsCount: Object.keys(domainStats).length,
      apiCallsCount: apiEndpoints.length,
      rscCallsCount: rscTransitions.length,
      staticAssetsCount: staticAssets.length,
      tokensCapturedCount: capturedTokensList.length,
      workersCapturedCount: workersList.length,
      domains: domainStats,
      statusCodes: statusDistribution,
      authHeadersDetected: Array.from(authHeadersFound)
    },
    tokensCaptured: capturedTokensList,
    workersCaptured: workersList,
    apiEndpoints: apiEndpoints,
    nextJsServerComponents: rscTransitions,
    staticAssetsSummary: {
      count: staticAssets.length,
      types: staticAssets.reduce((acc, s) => {
        acc[s.resourceType] = (acc[s.resourceType] || 0) + 1;
        return acc;
      }, {})
    }
  };

  const jsonReportPath = path.join(analyseDir, 'analysis_report.json');
  fs.writeFileSync(jsonReportPath, JSON.stringify(analysis, null, 2), 'utf-8');

  let md = `# Session Traffic Analysis Report
**Session ID:** \`${analysis.sessionId}\`  
**Analyzed At:** ${analysis.analyzedAt}  
**Total Requests:** ${analysis.summary.totalRequests} | **Responses:** ${analysis.summary.totalResponses} | **Tokens:** ${capturedTokensList.length} | **Workers Captured:** ${workersList.length}

---

## 1. Domains Overview
| Domain | Request Count |
| :--- | :--- |
${Object.entries(domainStats).map(([d, c]) => `| \`${d}\` | **${c}** |`).join('\n')}

---

## 2. API Endpoints Discovered (${apiEndpoints.length})
These are direct backend REST / GraphQL APIs called by the frontend:

| Method | Endpoint | Status | Description |
| :--- | :--- | :--- | :--- |
${apiEndpoints.map(e => `| \`${e.method}\` | \`${e.pathname}\` | \`${e.status}\` | ${e.query && Object.keys(e.query).length ? 'Query: ' + JSON.stringify(e.query) : '-'} |`).join('\n')}

---

## 3. Next.js React Server Components (RSC) Transitions (${rscTransitions.length})
The application is using Next.js App Router. These requests fetch pre-rendered component payloads and server state:

| Method | Target Route | Status |
| :--- | :--- | :--- |
${rscTransitions.map(r => `| \`${r.method}\` | \`${r.pathname}\` | \`${r.status}\` |`).join('\n')}

---

## 4. Captured Workers & Profiles (${workersList.length})
Worker profiles discovered across \`/api/workers/:id\` API calls and responses:

| Worker ID | User ID | Name | Category | Wage | Location |
| :--- | :--- | :--- | :--- | :--- | :--- |
${workersList.map(w => `| \`${w.workerId}\` | \`${w.userId}\` | **${w.name}** | \`${w.category}\` | ${w.wage} | ${w.address} |`).join('\n') || '| - | - | None | - | - | - |'}

---

## 5. Captured Authentication Tokens & Credentials (${capturedTokensList.length})
All auth tokens, Bearer JWTs, session cookies, and API keys extracted from network traffic:

| Type | Source | Name | Token / Value | URL |
| :--- | :--- | :--- | :--- | :--- |
${capturedTokensList.map(t => `| **${t.type}** | \`${t.source}\` | \`${t.name}\` | \`${t.token.slice(0, 40)}${t.token.length > 40 ? '...' : ''}\` | \`${t.url}\` |`).join('\n') || '| - | - | None | - | - |'}

---

## 6. Status Code Distribution
| Status Code | Count |
| :--- | :--- |
${Object.entries(statusDistribution).map(([s, c]) => `| \`${s}\` | **${c}** |`).join('\n')}
`;

  const mdReportPath = path.join(analyseDir, 'analysis_report.md');
  fs.writeFileSync(mdReportPath, md, 'utf-8');

  return { jsonReportPath, mdReportPath, analysis, tokensCsvPath, tokensJsonPath };
}

if (require.main === module) {
  runAnalysis();
}

module.exports = runAnalysis;
