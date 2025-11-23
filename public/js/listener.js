(() => {
  const urlParams = new URLSearchParams(location.search);
  const sid = urlParams.get('sid');
  const token = urlParams.get('t');
  const statusEl = document.getElementById('status');
  const messageEl = document.getElementById('message');
  const player = document.getElementById('player');
  const levelBar = document.getElementById('levelBar');
  const levelContainer = document.getElementById('levelContainer');
  const listenBtn = document.getElementById('listenBtn');

  if (!sid || !token) {
    statusEl.textContent = 'Invalid link';
    messageEl.textContent = 'Missing session id or token.';
    return;
  }

  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY_MS = 2000;
  let reconnectAttempts = 0;
  let reconnectTimeout = null;
  let intentionallyClosed = false;
  let userHasInteracted = false;
  let isPlaying = false;

  let mediaSource = null;
  let sourceBuffer = null;
  let queue = [];
  let isAppending = false;

  let audioContext = null;
  let analyser = null;
  let animationId = null;
  let ws = null;

  // FIXED: Safe SourceBuffer check (works in all browsers)
  function isSourceBufferValid() {
    if (!sourceBuffer || !mediaSource || mediaSource.readyState !== 'open') return false;
    for (let i = 0; i < mediaSource.sourceBuffers.length; i++) {
      if (mediaSource.sourceBuffers[i] === sourceBuffer) return true;
    }
    return false;
  }

  function resetMediaSource() {
    queue = [];
    isAppending = false;

    if (sourceBuffer && mediaSource) {
      for (let i = 0; i < mediaSource.sourceBuffers.length; i++) {
        if (mediaSource.sourceBuffers[i] === sourceBuffer) {
          try { mediaSource.removeSourceBuffer(sourceBuffer); } catch (e) {}
          break;
        }
      }
      sourceBuffer = null;
    }

    if (mediaSource) {
      try { mediaSource.endOfStream(); } catch (e) {}
      mediaSource = null;
    }
  }

  async function createMediaSource() {
    resetMediaSource();
    mediaSource = new MediaSource();
    player.src = URL.createObjectURL(mediaSource);

    return new Promise((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/webm;codecs=opus');
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', () => {
            isAppending = false;
            processQueue();
            tryTrimBuffer();
          });
          resolve();
        } catch (e) {
          reject(e);
        }
      }, { once: true });

      mediaSource.addEventListener('error', () => reject(new Error('MediaSource error')));
    });
  }

  function processQueue() {
    if (isAppending || queue.length === 0 || !isSourceBufferValid() || sourceBuffer.updating) return;
    isAppending = true;
    const chunk = queue.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      isAppending = false;
      if (e.name === 'QuotaExceededError') {
        tryTrimBuffer();
        queue.unshift(chunk);
      }
    }
  }

  function appendChunk(data) {
    if (!isSourceBufferValid() || mediaSource.readyState !== 'open') return;
    queue.push(data);
    processQueue();
  }

  function tryTrimBuffer() {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return;
    const current = player.currentTime;
    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(0);

    if (current - start > 3) {
      try { sourceBuffer.remove(start, current - 1); } catch (e) {}
    }
    if (end - current > 1.5 && isPlaying) {
      player.currentTime = end - 0.2;
    }
  }

  function initAudioAnalyser() {
    if (audioContext) return;
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      const source = audioContext.createMediaElementSource(player);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      levelContainer.classList.remove('hidden');
      updateLevelMeter();
    } catch (e) { console.error('Analyser init failed', e); }
  }

  function updateLevelMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const level = Math.min(100, (avg / 255) * 150);
    levelBar.style.width = level + '%';
    levelBar.className = `h-full rounded transition-all duration-75 ${level > 80 ? 'bg-red-500' : level > 50 ? 'bg-yellow-500' : 'bg-green-500'}`;
    animationId = requestAnimationFrame(updateLevelMeter);
  }

  async function startPlayback() {
    if (!isSourceBufferValid() || !sourceBuffer.buffered.length) return;
    try {
      player.currentTime = sourceBuffer.buffered.end(0) - 0.1;
      await player.play();
      isPlaying = true;
      statusEl.textContent = 'Live — playing';
      messageEl.textContent = '';
      listenBtn?.classList.add('hidden');
      initAudioAnalyser();
    } catch (e) {
      messageEl.textContent = 'Click to play (autoplay blocked)';
    }
  }

  function onUserInteraction() {
    userHasInteracted = true;
    audioContext?.resume();
    if (sourceBuffer?.buffered.length) startPlayback();
  }

  async function connect() {
    queue = [];
    isAppending = false;
    try {
      await createMediaSource();
    } catch (e) {
      statusEl.textContent = 'Unsupported format';
      messageEl.textContent = 'Your browser may not support WebM/Opus';
      return;
    }

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?sid=${sid}&role=listener&t=${token}`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectAttempts = 0;
      statusEl.textContent = 'Connected — waiting for audio...';
      messageEl.textContent = userHasInteracted ? '' : 'Click "Start Listening" when ready';
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'broadcast-started') {
            statusEl.textContent = userHasInteracted ? 'Live — buffering...' : 'Live — click to listen';
          }
          if (msg.type === 'session-ended') {
            intentionallyClosed = true;
            statusEl.textContent = 'Broadcast ended';
            messageEl.textContent = 'The broadcaster has stopped.';
            listenBtn?.classList.add('hidden');
            ws.close();
          }
        } catch (e) {}
        return;
      }
      appendChunk(ev.data);
      if (userHasInteracted && !isPlaying && sourceBuffer?.buffered.length) {
        startPlayback();
      }
    };

    ws.onclose = () => {
      if (animationId) cancelAnimationFrame(animationId);
      isPlaying = false;
      if (intentionallyClosed) return;
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        statusEl.textContent = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
        reconnectTimeout = setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        statusEl.textContent = 'Disconnected';
        messageEl.textContent = 'Refresh to try again.';
      }
    };
  }

  listenBtn?.addEventListener('click', onUserInteraction);
  player.addEventListener('play', () => {
    userHasInteracted = true;
    isPlaying = true;
    statusEl.textContent = 'Live — playing';
    listenBtn?.classList.add('hidden');
    initAudioAnalyser();
  });

  window.addEventListener('beforeunload', () => {
    intentionallyClosed = true;
    if (ws) ws.close();
  });

  connect();
})();