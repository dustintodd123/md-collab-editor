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
app.use(express.json({ limit: "1mb" }));

// ── Storage backend ──
// Uses Turso if TURSO_URL is set, otherwise falls back to local files.
let db;
const useTurso = !!(process.env.TURSO_URL && process.env.TURSO_AUTH_TOKEN);

async function initDB() {
  if (!useTurso) {
    console.log("No TURSO_URL set — using local file storage");
    const DATA_DIR = path.join(__dirname, "data");
    const VERSIONS_DIR = path.join(DATA_DIR, "versions");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR);
    return;
  }

  const { createClient } = require("@libsql/client");
  db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_versions_room ON versions(room_id, created_at DESC)`);

  console.log("Connected to Turso database");
}

const CHECKPOINT_INTERVAL = 10 * 60 * 1000; // 10 minutes
const VERSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// ── File-based storage (local dev fallback) ──
function safeId(roomId) {
  return roomId.replace(/[^a-zA-Z0-9_-]/g, "");
}

const fileStore = {
  async load(roomId) {
    try {
      return fs.readFileSync(path.join(__dirname, "data", safeId(roomId) + ".md"), "utf-8");
    } catch { return ""; }
  },
  async save(roomId, content) {
    fs.writeFileSync(path.join(__dirname, "data", safeId(roomId) + ".md"), content, "utf-8");
  },
  async saveVersion(roomId, content) {
    if (!content.trim()) return;
    const dir = path.join(__dirname, "data", "versions", safeId(roomId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, Date.now() + ".md"), content, "utf-8");
  },
  async listVersions(roomId) {
    const dir = path.join(__dirname, "data", "versions", safeId(roomId));
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(".md"))
        .map(f => parseInt(f.replace(".md", ""), 10))
        .filter(ts => !isNaN(ts))
        .sort((a, b) => b - a);
    } catch { return []; }
  },
  async loadVersion(roomId, timestamp) {
    try {
      return fs.readFileSync(path.join(__dirname, "data", "versions", safeId(roomId), timestamp + ".md"), "utf-8");
    } catch { return null; }
  },
  async purgeOldVersions() {
    const cutoff = Date.now() - VERSION_MAX_AGE;
    const versionsDir = path.join(__dirname, "data", "versions");
    try {
      for (const dir of fs.readdirSync(versionsDir)) {
        const full = path.join(versionsDir, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full)) {
          const ts = parseInt(f.replace(".md", ""), 10);
          if (!isNaN(ts) && ts < cutoff) fs.unlinkSync(path.join(full, f));
        }
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      }
    } catch { /* ignore */ }
  }
};

// ── Turso storage ──
const tursoStore = {
  async load(roomId) {
    const result = await db.execute({ sql: "SELECT content FROM rooms WHERE id = ?", args: [roomId] });
    return result.rows.length ? result.rows[0].content : "";
  },
  async save(roomId, content) {
    await db.execute({
      sql: "INSERT INTO rooms (id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = ?, updated_at = ?",
      args: [roomId, content, Date.now(), content, Date.now()]
    });
  },
  async saveVersion(roomId, content) {
    if (!content.trim()) return;
    await db.execute({
      sql: "INSERT INTO versions (room_id, content, created_at) VALUES (?, ?, ?)",
      args: [roomId, content, Date.now()]
    });
  },
  async listVersions(roomId) {
    const result = await db.execute({
      sql: "SELECT created_at FROM versions WHERE room_id = ? ORDER BY created_at DESC",
      args: [roomId]
    });
    return result.rows.map(r => r.created_at);
  },
  async loadVersion(roomId, timestamp) {
    const result = await db.execute({
      sql: "SELECT content FROM versions WHERE room_id = ? AND created_at = ?",
      args: [roomId, Number(timestamp)]
    });
    return result.rows.length ? result.rows[0].content : null;
  },
  async purgeOldVersions() {
    const cutoff = Date.now() - VERSION_MAX_AGE;
    await db.execute({ sql: "DELETE FROM versions WHERE created_at < ?", args: [cutoff] });
  }
};

function store() {
  return useTurso ? tursoStore : fileStore;
}

// ── Room state (in-memory) ──
const rooms = new Map();

async function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const content = await store().load(roomId);
    rooms.set(roomId, {
      content,
      clients: new Set(),
      dirty: false,
      lastCheckpoint: 0
    });
  }
  return rooms.get(roomId);
}

function markDirty(room) {
  room.dirty = true;
}

function broadcast(room, message, exclude) {
  const data = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

// Periodic autosave — flush dirty rooms every 30 seconds
setInterval(async () => {
  for (const [roomId, room] of rooms) {
    if (!room.dirty) continue;
    try {
      await store().save(roomId, room.content);
      room.dirty = false;
      broadcast(room, { type: "saved" });

      const now = Date.now();
      if (now - room.lastCheckpoint >= CHECKPOINT_INTERVAL) {
        await store().saveVersion(roomId, room.content);
        room.lastCheckpoint = now;
      }
    } catch (err) {
      console.error("Autosave error for room", roomId, err.message);
    }
  }
}, 30 * 1000);

// Purge old versions every hour
setInterval(() => { store().purgeOldVersions().catch(() => {}); }, 60 * 60 * 1000);

// Flush all rooms on shutdown
async function flushAll() {
  for (const [roomId, room] of rooms) {
    try { await store().save(roomId, room.content); } catch {}
  }
}

process.on("SIGINT", async () => { await flushAll(); process.exit(); });
process.on("SIGTERM", async () => { await flushAll(); process.exit(); });
process.on("SIGHUP", async () => { await flushAll(); process.exit(); });

// ── Save API ──
app.post("/api/rooms/:roomId/save", async (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (room) {
    await store().save(roomId, room.content);
    room.dirty = false;
    broadcast(room, { type: "saved" });
  }
  res.json({ ok: true });
});

// ── Version API ──
app.get("/api/rooms/:roomId/versions", async (req, res) => {
  const timestamps = await store().listVersions(req.params.roomId);
  res.json(timestamps.map(ts => ({ timestamp: ts, date: new Date(ts).toISOString() })));
});

app.post("/api/rooms/:roomId/revert/:timestamp", async (req, res) => {
  const { roomId, timestamp } = req.params;
  const content = await store().loadVersion(roomId, timestamp);
  if (content === null) return res.status(404).json({ error: "Version not found" });

  const current = await store().load(roomId);
  if (current.trim()) await store().saveVersion(roomId, current);

  await store().save(roomId, content);

  const room = await getRoom(roomId);
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

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");

  if (!roomId) {
    ws.close(1008, "Missing room ID");
    return;
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const room = await getRoom(roomId);
  room.clients.add(ws);

  ws.send(JSON.stringify({ type: "init", content: room.content }));
  broadcast(room, { type: "presence", count: room.clients.size });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "edit") {
      room.content = msg.content;
      markDirty(room);
      broadcast(room, { type: "edit", content: msg.content }, ws);
    }
  });

  ws.on("close", async () => {
    room.clients.delete(ws);
    broadcast(room, { type: "presence", count: room.clients.size });

    if (room.clients.size === 0) {
      try { await store().save(roomId, room.content); } catch {}
      rooms.delete(roomId);
    }
  });
});

// ── Start ──
initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
