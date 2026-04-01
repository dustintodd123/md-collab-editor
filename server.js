const express = require("express");
const http = require("http");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

// Persistence directories
const DATA_DIR = path.join(__dirname, "data");
const VERSIONS_DIR = path.join(DATA_DIR, "versions");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR);

const CHECKPOINT_INTERVAL = 10 * 60 * 1000; // 10 minutes
const VERSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// Sanitize room ID to a safe filename
function safeId(roomId) {
  return roomId.replace(/[^a-zA-Z0-9_-]/g, "");
}

function roomFile(roomId) {
  return path.join(DATA_DIR, safeId(roomId) + ".md");
}

function roomVersionDir(roomId) {
  const dir = path.join(VERSIONS_DIR, safeId(roomId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

function loadRoom(roomId) {
  try {
    return fs.readFileSync(roomFile(roomId), "utf-8");
  } catch {
    return "";
  }
}

function saveRoom(roomId, content) {
  fs.writeFileSync(roomFile(roomId), content, "utf-8");
}

// Save a timestamped checkpoint
function saveCheckpoint(roomId, content) {
  if (!content.trim()) return;
  const dir = roomVersionDir(roomId);
  const ts = Date.now();
  fs.writeFileSync(path.join(dir, ts + ".md"), content, "utf-8");
}

// List versions for a room, newest first
function listVersions(roomId) {
  const dir = roomVersionDir(roomId);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => parseInt(f.replace(".md", ""), 10))
      .filter(ts => !isNaN(ts))
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

function loadVersion(roomId, timestamp) {
  const file = path.join(roomVersionDir(roomId), timestamp + ".md");
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

// Purge versions older than 24 hours
function purgeOldVersions() {
  const cutoff = Date.now() - VERSION_MAX_AGE;
  try {
    const roomDirs = fs.readdirSync(VERSIONS_DIR);
    for (const dir of roomDirs) {
      const full = path.join(VERSIONS_DIR, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      const files = fs.readdirSync(full);
      for (const f of files) {
        const ts = parseInt(f.replace(".md", ""), 10);
        if (!isNaN(ts) && ts < cutoff) {
          fs.unlinkSync(path.join(full, f));
        }
      }
      // Remove empty room version dirs
      if (fs.readdirSync(full).length === 0) {
        fs.rmdirSync(full);
      }
    }
  } catch { /* ignore */ }
}

// Run purge every hour
setInterval(purgeOldVersions, 60 * 60 * 1000);
purgeOldVersions();

// Room state: { content, clients: Set<ws>, saveTimer, lastCheckpoint }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      content: loadRoom(roomId),
      clients: new Set(),
      dirty: false,
      lastCheckpoint: 0
    });
  }
  return rooms.get(roomId);
}

// Track dirty state per room
function markDirty(room) {
  room.dirty = true;
}

// Periodic autosave — flush dirty rooms every 30 seconds
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (!room.dirty) continue;
    saveRoom(roomId, room.content);
    room.dirty = false;
    broadcast(room, { type: "saved" });

    // Checkpoint every 10 minutes of editing
    const now = Date.now();
    if (now - room.lastCheckpoint >= CHECKPOINT_INTERVAL) {
      saveCheckpoint(roomId, room.content);
      room.lastCheckpoint = now;
    }
  }
}, 30 * 1000);

// Flush all rooms on shutdown
function flushAll() {
  for (const [roomId, room] of rooms) {
    saveRoom(roomId, room.content);
  }
}

process.on("SIGINT", () => { flushAll(); process.exit(); });
process.on("SIGTERM", () => { flushAll(); process.exit(); });
process.on("SIGHUP", () => { flushAll(); process.exit(); });

function broadcast(room, message, exclude) {
  const data = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

app.use(express.json({ limit: "1mb" }));

// ── Save API ──
app.post("/api/rooms/:roomId/save", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (room) {
    saveRoom(roomId, room.content);
    room.dirty = false;
    broadcast(room, { type: "saved" });
  }
  res.json({ ok: true });
});

// ── Version API ──
app.get("/api/rooms/:roomId/versions", (req, res) => {
  const timestamps = listVersions(req.params.roomId);
  res.json(timestamps.map(ts => ({ timestamp: ts, date: new Date(ts).toISOString() })));
});

app.post("/api/rooms/:roomId/revert/:timestamp", (req, res) => {
  const { roomId, timestamp } = req.params;
  const content = loadVersion(roomId, timestamp);
  if (content === null) return res.status(404).json({ error: "Version not found" });

  // Checkpoint current state before reverting
  const current = loadRoom(roomId);
  if (current.trim()) saveCheckpoint(roomId, current);

  saveRoom(roomId, content);

  // Push to all connected clients
  const room = getRoom(roomId);
  room.content = content;
  broadcast(room, { type: "edit", content });

  res.json({ ok: true });
});

// Ping all clients every 30s to detect dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30 * 1000);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");

  if (!roomId) {
    ws.close(1008, "Missing room ID");
    return;
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const room = getRoom(roomId);
  room.clients.add(ws);

  // Send current document state and presence count
  ws.send(JSON.stringify({ type: "init", content: room.content }));
  broadcast(room, { type: "presence", count: room.clients.size });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "edit") {
      room.content = msg.content;
      markDirty(room);
      broadcast(room, { type: "edit", content: msg.content }, ws);
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    broadcast(room, { type: "presence", count: room.clients.size });

    // Flush to disk and clean up when last user leaves
    if (room.clients.size === 0) {
      saveRoom(roomId, room.content);
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
