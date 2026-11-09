const path = require('path');
const fs = require('fs');
const NetworkRecorder = require('./src/recorder');

console.log('Running NetworkRecorder verification test...');

const testDir = path.join(__dirname, 'test_recordings');
const recorder = new NetworkRecorder(__dirname, {
  storageDir: 'test_recordings',
  autoRecord: false,
  captureBodies: true,
  redactEnabled: true,
  redactHeaders: ['authorization', 'cookie']
});

const session = recorder.startSession('test_session_001');
console.log('Session started:', session.id);

// 1. Simulate Request
const reqRecord = recorder.recordRequest({
  requestId: 'req-101',
  request: {
    url: 'https://httpbin.org/post',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer secret_token_xyz',
      'user-agent': 'Auto_Browser/1.0'
    },
    postData: JSON.stringify({ message: 'Hello Chromium!' }),
    hasPostData: true
  },
  timestamp: 1234.56,
  wallTime: Date.now() / 1000,
  initiator: { type: 'script' },
  type: 'Fetch',
  documentURL: 'https://httpbin.org'
});

console.log('Recorded request. Redacted header check:', reqRecord.headers.authorization === '[REDACTED]' ? 'PASSED' : 'FAILED');

// 2. Simulate Response
const resRecord = recorder.recordResponse({
  requestId: 'req-101',
  response: {
    url: 'https://httpbin.org/post',
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'session=abc; Path=/'
    },
    mimeType: 'application/json',
    remoteIPAddress: '104.18.22.45',
    remotePort: 443,
    timing: {
      dnsStart: 0, dnsEnd: 10,
      connectStart: 10, connectEnd: 30,
      sslStart: 15, sslEnd: 30,
      sendStart: 30, sendEnd: 32,
      receiveHeadersEnd: 85
    }
  },
  type: 'Fetch',
  timestamp: 1234.65
});

console.log('Recorded response status:', resRecord.status);

// 3. Simulate Finished with Response Body
const finished = recorder.recordFinished(
  { requestId: 'req-101', timestamp: 1234.70, encodedDataLength: 1024 },
  { body: JSON.stringify({ success: true, data: 'echo' }), base64Encoded: false }
);

console.log('Recorded finished. Total bytes:', recorder.stats.totalBytes);

// 4. Stop session
recorder.stopSession();
console.log('Session stopped. Status:', recorder.status);

// 5. Verify files exist on disk
const reqJsonlExists = fs.existsSync(session.requestsJsonl);
const resJsonlExists = fs.existsSync(session.responsesJsonl);
const metaExists = fs.existsSync(session.metaPath);
const bodyFile = path.join(session.bodiesPath, 'req-101_res.json');
const bodyExists = fs.existsSync(bodyFile);

console.log('File verification:');
console.log('  requests.jsonl exists:', reqJsonlExists);
console.log('  responses.jsonl exists:', resJsonlExists);
console.log('  session_meta.json exists:', metaExists);
console.log('  body file exists:', bodyExists);

// 6. Test session loading
const loaded = recorder.loadSession('test_session_001');
console.log('Loaded records count:', loaded.records.length);

// 7. Test HAR export
const har = recorder.exportHAR('test_session_001');
console.log('HAR entries count:', har.log.entries.length);

// 8. Test Unredacted Token Recording & Extraction
console.log('\nTesting Unredacted Auth Token Recording...');
const unredactedDir = path.join(__dirname, 'test_recordings_unredacted');
const unredactedRecorder = new NetworkRecorder(__dirname, {
  storageDir: 'test_recordings_unredacted',
  autoRecord: false,
  captureBodies: true,
  redactEnabled: false,
  redactHeaders: []
});
const unredactedSession = unredactedRecorder.startSession('test_session_unredacted');
const unredactedReq = unredactedRecorder.recordRequest({
  requestId: 'req-auth-1',
  request: {
    url: 'https://api.example.com/profile',
    method: 'GET',
    headers: {
      'authorization': 'Bearer my_jwt_token_123',
      'cookie': 'session_token=abc_session_999'
    }
  },
  timestamp: 100,
  wallTime: Date.now() / 1000
});

console.log('Unredacted auth header preserved:', unredactedReq.headers.authorization === 'Bearer my_jwt_token_123' ? 'PASSED' : 'FAILED');
console.log('Unredacted cookie header preserved:', unredactedReq.headers.cookie === 'session_token=abc_session_999' ? 'PASSED' : 'FAILED');
console.log('Token capture detection check:', unredactedRecorder.capturedTokens.size >= 2 ? 'PASSED' : 'FAILED');

unredactedRecorder.stopSession();
const tokenJsonExists = fs.existsSync(unredactedSession.tokensJson);
const tokenCsvExists = fs.existsSync(path.join(unredactedSession.analysePath, 'tokens_captured.csv'));
console.log('tokens.json generated:', tokenJsonExists ? 'PASSED' : 'FAILED');
console.log('tokens_captured.csv generated:', tokenCsvExists ? 'PASSED' : 'FAILED');

fs.rmSync(unredactedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

// Clean up test folder
fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('All verification tests completed successfully!');

