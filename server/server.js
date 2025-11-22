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

// ------------------- Middleware -------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "ws:"],
        mediaSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', apiLimiter);

app.use('/', express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

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
      // NEW: Store init segment for late-joining listeners
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
    res.json({ sessionId: id, token, listenUrl: listenPath, expiresAt: new Date(expireAt).toISOString() });
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

// ------------------- WebSocket -------------------
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

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { sid, role }));
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

    // Notify existing listeners
    for (const l of session.listeners) {
      try { l.send(JSON.stringify({ type: 'broadcast-started', startedAt: Date.now() })); } catch(e) {}
    }

    // Track backpressure state
    let draining = false;

    // Handle drain event - file stream is ready for more data
    session.wsWriteStream.on('drain', () => {
      draining = false;
      try {
        ws.send(JSON.stringify({ type: 'drain' }));
      } catch (e) {}
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'meta') broadcastToListeners(session, JSON.stringify({ type: 'meta', meta: msg.meta }));
          if (msg.type === 'stop') teardownSession(sid, 'stopped-by-broadcaster');
        } catch (e) {}
        return;
      }

      const chunk = Buffer.from(data);

      // Cache the first chunk as the init segment
      if (!session.initSegmentReceived) {
        session.initSegment = chunk;
        session.initSegmentReceived = true;
        console.log(`Init segment cached for session ${sid} (${chunk.length} bytes)`);
      }

      // Write to file with backpressure handling
      try {
        const ok = session.wsWriteStream.write(chunk);
        if (!ok && !draining) {
          draining = true;
          ws.send(JSON.stringify({ type: 'backpressure' }));
        }
      } catch (err) { 
        console.error('write chunk error', err); 
      }

      // Broadcast to listeners (don't let file I/O block streaming)
      for (const l of session.listeners) {
        if (l.readyState === l.OPEN) {
          try {
            l.send(data, { binary: true }, (err) => { 
              if (err) { l.terminate(); session.listeners.delete(l); } 
            });
          } catch(e) { l.terminate(); session.listeners.delete(l); }
        }
      }
    });

    ws.on('close', () => teardownSession(sid, 'broadcaster-disconnected'));
    ws.on('error', (err) => { console.error('broadcaster ws error', err); teardownSession(sid, 'error'); });

  } else if (role === 'listener') {
    session.listeners.add(ws);
    console.log(`Listener connected to ${sid} (total=${session.listeners.size})`);

    // Send connection confirmation
    try { 
      ws.send(JSON.stringify({ type: 'ok', message: 'connected', sessionId: sid })); 
    } catch(e) {}

    // Notify broadcaster of listener count
    notifyListenerCount(session);

    // NEW: Send init segment if we have it (for late-joining listeners)
    if (session.initSegment) {
      try {
        ws.send(JSON.stringify({ type: 'init-segment', size: session.initSegment.length }));
        ws.send(session.initSegment, { binary: true }, (err) => {
          if (err) console.error('Error sending init segment:', err);
        });
        console.log(`Sent init segment to late-joining listener in session ${sid}`);
      } catch (e) {
        console.error('Failed to send init segment:', e);
      }
    }

    // Notify listener if broadcast is already live
    if (session.broadcasterSocket) {
      try { 
        ws.send(JSON.stringify({ type: 'broadcast-started', startedAt: session.createdAt })); 
      } catch(e) {}
    }

    ws.on('close', () => {
      session.listeners.delete(ws);
      notifyListenerCount(session);
    });
    ws.on('error', () => {
      session.listeners.delete(ws);
      notifyListenerCount(session);
    });
  } else {
    ws.close();
  }
});

function notifyListenerCount(session) {
  if (session.broadcasterSocket && session.broadcasterSocket.readyState === session.broadcasterSocket.OPEN) {
    try {
      session.broadcasterSocket.send(JSON.stringify({ 
        type: 'listener-count', 
        count: session.listeners.size 
      }));
    } catch (e) {}
  }
}

function broadcastToListeners(session, msg) {
  for (const l of session.listeners) {
    if (l.readyState === l.OPEN) {
      try { l.send(msg); } catch(e) {}
    }
  }
}

function teardownSession(id, reason='stopped') {
  const session = sessions.get(id);
  if (!session) return;
  console.log(`Tearing down session ${id}: ${reason}`);

  session.active = false;
  if (session.cleanupTimer) { clearTimeout(session.cleanupTimer); session.cleanupTimer = null; }

  if (session.broadcasterSocket) { 
    try { session.broadcasterSocket.close(); } catch(e) {} 
    session.broadcasterSocket = null; 
  }

  for (const l of session.listeners) {
    try { 
      l.send(JSON.stringify({ type: 'session-ended', reason })); 
      l.close(); 
    } catch(e) { 
      try { l.terminate(); } catch(er) {} 
    }
  }
  session.listeners.clear();

  // Clear init segment
  session.initSegment = null;

  if (session.wsWriteStream) {
    session.wsWriteStream.end(() => console.log(`Recording finalized: ${session.filePath}`));
  }
  sessions.delete(id);
}

server.listen(PORT, () => {
  console.log(`Live-audio server running on http://${HOSTNAME}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});