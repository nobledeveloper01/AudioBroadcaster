require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.HOSTNAME || 'localhost';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 15 * 60 * 1000);
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
const MAX_LISTENERS = Number(process.env.MAX_LISTENERS_PER_SESSION || 200);

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);

// CRITICAL FIX: Trust proxy (Render, Fly.io, Heroku, etc.)
app.set('trust proxy', 1); // ← THIS FIXES ERR_ERL_UNEXPECTED_X_FORWARDED_FOR

// ------------------- Middleware -------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        mediaSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.use('/', express.static(path.join(__dirname, '..', 'public')));

// ------------------- Sessions -------------------
const sessions = new Map();

app.post('/api/session/create', (req, res) => {
  try {
    const id = uuidv4().slice(0, 8);
    const token = uuidv4().replace(/-/g, '');
    const createdAt = Date.now();
    const expireAt = createdAt + SESSION_TTL_MS;
    const fileName = `broadcast-${id}-${Date.now()}.webm`;
    const filePath = path.join(RECORDINGS_DIR, fileName);
    const wsStream = fs.createWriteStream(filePath, { flags: 'a' });

    const session = {
      id,
      token,
      createdAt,
      expireAt,
      active: true,
      broadcasterSocket: null,
      listeners: new Set(),
      wsWriteStream: wsStream,
      filePath,
      cleanupTimer: null,
      initSegment: null,
      initSegmentReceived: false,
    };

    session.cleanupTimer = setTimeout(() => {
      if (sessions.has(id)) {
        console.log(`Session ${id} expired; cleaning up.`);
        teardownSession(id, 'expired');
      }
    }, SESSION_TTL_MS);

    sessions.set(id, session);

    const listenPath = `/listener.html?sid=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
    res.json({
      sessionId: id,
      token,
      listenUrl: listenPath,
      expiresAt: new Date(expireAt).toISOString()
    });
  } catch (err) {
    console.error('create session error', err);
    res.status(500).json({ error: 'could not create session' });
  }
});

app.post('/api/session/:id/stop', (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  teardownSession(id, 'stopped-by-broadcaster');
  res.json({ ok: true, recording: path.basename(session.filePath) });
});

app.get('/api/recording/:file', (req, res) => {
  const file = req.params.file;
  const fp = path.join(RECORDINGS_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.download(fp);
});

// ------------------- WebSocket Server -------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sid = url.searchParams.get('sid');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('t') || null;

  if (!sid || !role) return socket.destroy();

  const sess = sessions.get(sid);
  if (!sess || !sess.active) return socket.destroy();
  if (role === 'listener' && token !== sess.token) return socket.destroy();
  if (role === 'listener' && sess.listeners.size >= MAX_LISTENERS) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, { sid, role });
  });
});

wss.on('connection', (ws, req, meta) => {
  const { sid, role } = meta;
  const session = sessions.get(sid);
  if (!session) return ws.close();

  if (role === 'broadcaster') {
    if (session.broadcasterSocket) {
      ws.send(JSON.stringify({ type: 'error', message: 'broadcaster already connected' }));
      return ws.close();
    }

    session.broadcasterSocket = ws;
    console.log(`Broadcaster connected for session ${sid}`);

    for (const l of session.listeners) {
      try { l.send(JSON.stringify({ type: 'broadcast-started' })); } catch (e) {}
    }

    let draining = false;
    session.wsWriteStream.on('drain', () => {
      draining = false;
      try { ws.send(JSON.stringify({ type: 'drain' })); } catch (e) {}
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'keyframe-ready') {
            // Optional: future use
          }
        } catch (e) {}
        return;
      }

      const chunk = Buffer.from(data);

      // Cache init segment
      if (!session.initSegmentReceived) {
        session.initSegment = chunk;
        session.initSegmentReceived = true;
        console.log(`Init segment cached (${chunk.length} bytes)`);
      }

      const ok = session.wsWriteStream.write(chunk);
      if (!ok && !draining) {
        draining = true;
        ws.send(JSON.stringify({ type: 'backpressure' }));
      }

      // Broadcast to all listeners
      for (const l of session.listeners) {
        if (l.readyState === WebSocket.OPEN) {
          l.send(data, { binary: true });
        }
      }
    });

    ws.on('close', () => teardownSession(sid, 'broadcaster-disconnected'));
    ws.on('error', () => teardownSession(sid, 'error'));
  }

  else if (role === 'listener') {
    session.listeners.add(ws);
    console.log(`Listener joined ${sid} (${session.listeners.size} total)`);

    ws.send(JSON.stringify({ type: 'ok', sessionId: sid }));

    // Send cached init segment to late joiners
    if (session.initSegment) {
      try {
        ws.send(JSON.stringify({ type: 'init-segment', size: session.initSegment.length }));
        ws.send(session.initSegment, { binary: true });
      } catch (e) {
        console.error('Failed to send init segment to listener:', e);
      }
    }

    if (session.broadcasterSocket) {
      ws.send(JSON.stringify({ type: 'broadcast-started' }));
    }

    notifyListenerCount(session);

    ws.on('close', () => {
      session.listeners.delete(ws);
      notifyListenerCount(session);
    });
    ws.on('error', () => {
      session.listeners.delete(ws);
      notifyListenerCount(session);
    });
  }
});

function notifyListenerCount(session) {
  if (session.broadcasterSocket?.readyState === WebSocket.OPEN) {
    session.broadcasterSocket.send(JSON.stringify({
      type: 'listener-count',
      count: session.listeners.size
    }));
  }
}

function teardownSession(id, reason = 'stopped') {
  const session = sessions.get(id);
  if (!session) return;

  console.log(`Tearing down session ${id}: ${reason}`);
  session.active = false;

  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  if (session.broadcasterSocket) session.broadcasterSocket.close();
  for (const l of session.listeners) {
    try { l.send(JSON.stringify({ type: 'session-ended', reason })); } catch (e) {}
    l.close();
  }
  session.listeners.clear();

  if (session.wsWriteStream) {
    session.wsWriteStream.end(() => {
      console.log(`Recording saved: ${session.filePath}`);
    });
  }

  sessions.delete(id);
}

// ------------------- Start Server -------------------
server.listen(PORT, () => {
  console.log(`Live audio server running on http://${HOSTNAME}:${PORT}`);
  console.log(`Recordings saved to: ${RECORDINGS_DIR}`);
});