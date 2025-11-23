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

  // SUPER SAFE: Check if sourceBuffer is still attached and alive
  function isSourceBufferValid() {
    return (
      sourceBuffer &&
      mediaSource &&
      mediaSource.readyState === 'open' &&
      mediaSource.sourceBuffers &&
      Array.from(mediaSource.sourceBuffers).includes(sourceBuffer)
    );
  }

  function resetMediaSource() {
    queue = [];
    isAppending = false;

    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.removeSourceBuffer(sourceBuffer);
      } catch (e) {}
    }
    sourceBuffer = null;

    if (mediaSource) {
      try { mediaSource.endOfStream(); } catch (e) {}
      if (player.src) URL.revokeObjectURL(player.src);
      mediaSource = null;
    }
    player.src = '';
  }

  async function createMediaSource() {
    resetMediaSource();

    mediaSource = new MediaSource();
    player.src = URL.createObjectURL(mediaSource);

    return new Promise((resolve, reject) => {
      const onSourceOpen = () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/webm;codecs=opus');
          sourceBuffer.mode = 'sequence';

          sourceBuffer.addEventListener('updateend', () => {
            isAppending = false;
            processQueue();
            tryTrimBuffer();
          });

          sourceBuffer.addEventListener('error', (e) => {
            console.error('SourceBuffer error:', e);
          });

          resolve();
        } catch (e) {
          reject(e);
        }
        mediaSource.removeEventListener('sourceopen', onSourceOpen);
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen);
      mediaSource.addEventListener('error', () => reject(new Error('MediaSource error')));
    });
  }

  function processQueue() {
    if (isAppending || queue.length === 0) return;
    if (!isSourceBufferValid() || sourceBuffer.updating) return;

    isAppending = true;
    const chunk = queue.shift();

    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      console.error('appendBuffer error:', e);
      isAppending = false;

      if (e.name === 'QuotaExceededError') {
        tryTrimBuffer();
        queue.unshift(chunk);
        setTimeout(processQueue, 100);
      }
    }
  }

  function appendChunk(data) {
    if (!isSourceBufferValid() || mediaSource.readyState !== 'open') {
      console.warn('Dropping chunk: SourceBuffer not valid');
      return;
    }
    queue.push(data);
    processQueue();
  }

  function tryTrimBuffer() {
    if (!isSourceBufferValid() || sourceBuffer.updating) return;
    if (!sourceBuffer.buffered || sourceBuffer.buffered.length === 0) return;

    try {
      const current = player.currentTime;
      const start = sourceBuffer.buffered.start(0);
      const end = sourceBuffer.buffered.end(0);

      if (current - start > 3) {
        sourceBuffer.remove(start, current - 1);
      }

      if (end - current > 1.5 && isPlaying) {
        player.currentTime = end - 0.2;
      }
    } catch (e) {
      // This is expected during teardown — silently ignore
      // console.warn('tryTrimBuffer failed (normal during cleanup):', e);
    }
  }

  function initAudioAnalyser() {
    if (audioContext || !player) return;
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
    } catch (e) {
      console.error('Failed to create analyser:', e);
    }
  }

  function updateLevelMeter() {
    if (!analyser || !levelBar) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const level = Math.min(100, (avg / 255) * 150);
    levelBar.style.width = level + '%';
    levelBar.className = `h-full rounded transition-all duration-75 ${level > 80 ? 'bg-red-500' : level > 50 ? 'bg-yellow-500' : 'bg-green-500'}`;
    animationId = requestAnimationFrame(updateLevelMeter);
  }

  function stopLevelMeter() {
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    if (levelBar) levelBar.style.width = '0%';
  }

  async function startPlayback() {
    if (!isSourceBufferValid()) return;

    try {
      if (sourceBuffer.buffered.length > 0) {
        player.currentTime = sourceBuffer.buffered.end(0) - 0.1;
      }
      await player.play();
      isPlaying = true;
      statusEl.textContent = 'Live — playing';
      messageEl.textContent = '';
      listenBtn?.classList.add('hidden');
      initAudioAnalyser();
    } catch (e) {
      messageEl.textContent = 'Click "Start Listening" to play';
    }
  }

  function onUserInteraction() {
    userHasInteracted = true;
    audioContext?.resume();

    if (isSourceBufferValid() && sourceBuffer.buffered.length > 0) {
      startPlayback();
    } else {
      statusEl.textContent = 'Waiting for audio...';
    }
  }

  async function connect() {
    queue = [];
    isAppending = false;
    stopLevelMeter();

    try {
      await createMediaSource();
      statusEl.textContent = 'Connected — waiting for audio...';
    } catch (e) {
      statusEl.textContent = 'Browser not supported';
      messageEl.textContent = 'Try? Your browser may not support WebM/Opus';
      return;
    }

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?sid=${sid}&role=listener&t=${token}`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectAttempts = 0;
      statusEl.textContent = 'Connected — waiting for audio...';
      messageEl.textContent = 'Click "Start Listening" when ready';
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

      // CRITICAL: Check validity BEFORE touching sourceBuffer
      if (!isSourceBufferValid()) {
        console.warn('Received audio chunk but SourceBuffer is gone — ignoring');
        return;
      }

      appendChunk(ev.data);

      if (userHasInteracted && !isPlaying && sourceBuffer?.buffered.length > 0) {
        startPlayback();
      }
    };

    ws.onclose = () => {
      stopLevelMeter();
      isPlaying = false;

      if (intentionallyClosed) return;

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        statusEl.textContent = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
        setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        statusEl.textContent = 'Disconnected';
        messageEl.textContent = 'Refresh to try again.';
      }
    };

    ws.onerror = (e) => console.error('WebSocket error:', e);
  }

  listenBtn?.addEventListener('click', onUserInteraction);

  player.addEventListener('play', () => {
    isPlaying = true;
    statusEl.textContent = 'Live — playing';
    listenBtn?.classList.add('hidden');
    initAudioAnalyser();
  });

  player.addEventListener('pause', stopLevelMeter);

  window.addEventListener('beforeunload', () => {
    intentionallyClosed = true;
    if (ws) ws.close();
  });

  connect();
})();