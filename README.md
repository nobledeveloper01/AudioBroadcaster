# Live Audio (production-ready small-scale)

## Quick start (local / dev)
1. copy `.env.example` -> `.env` and edit values.
2. npm install
3. npm start
4. Open http://localhost:3000

## How it works (summary)
- Broadcaster creates a session via `/api/session/create` -> server returns sessionId + token + listen URL.
- Broadcaster opens a WebSocket as `role=broadcaster&sid=...`.
- Broadcaster streams MediaRecorder binary chunks to the WS; server appends chunks to a server-side file and relays them to connected listeners.
- Listeners connect with `role=listener&sid=...&t=token`. Server validates token and relays binary chunks.
- Broadcaster POSTs `/api/session/:id/stop` or closes connection -> server finalizes file and ends session.

## Production deployment recommendations
- Run behind a reverse proxy (Nginx) with TLS termination (Let's Encrypt). Forward WebSocket upgrades.
- Replace in-memory sessions with Redis (for multi-instance/horizontal scaling). Store session metadata, token, TTL, and use pub/sub to relay chunks between nodes or route listener ws to same node.
- For large audiences / low-latency, integrate a media server (mediasoup / Janus / Jitsi) or a managed streaming service (Livepeer, Mux).
- For long-term storage, move recordings to cloud storage (S3), and optionally transcode with `ffmpeg` to .mp3 or AAC.
- Harden CORS to allow only your domain(s), add authentication for session creation if needed.
- Add monitoring, logging, rotating logs, and disk space checks for recordings folder.
