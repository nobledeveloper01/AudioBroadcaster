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

  // State
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY_MS = 2000;
  let reconnectAttempts = 0;
  let reconnectTimeout = null;
  let intentionallyClosed = false;
  let userHasInteracted = false;
  let isPlaying = false;

  // MediaSource
  let mediaSource = null;
  let sourceBuffer = null;
  let queue = [];
  let isAppending = false;

  // Audio analysis
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let animationId = null;

  // WebSocket
  let ws = null;

  function createMediaSource() {
    // Clean up existing
    if (mediaSource) {
      try {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      } catch (e) {}
    }
    
    queue = [];
    isAppending = false;
    
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

          sourceBuffer.addEventListener('error', (e) => {
            console.error('SourceBuffer error:', e);
          });
          
          resolve();
        } catch (e) {
          console.error('Failed to create SourceBuffer:', e);
          reject(e);
        }
      });

      mediaSource.addEventListener('error', (e) => {
        console.error('MediaSource error:', e);
        reject(e);
      });
    });
  }

  function isSourceBufferReady() {
    return sourceBuffer && 
           mediaSource && 
           mediaSource.readyState === 'open' && 
           !sourceBuffer.updating;
  }

  function processQueue() {
    if (isAppending || queue.length === 0) return;
    if (!isSourceBufferReady()) return;

    isAppending = true;
    const chunk = queue.shift();
    
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      console.error('Error appending buffer:', e);
      isAppending = false;
      
      if (e.name === 'QuotaExceededError') {
        tryTrimBuffer();
        queue.unshift(chunk); // Put it back
      }
    }
  }

  function appendChunk(data) {
    // Don't queue if MediaSource isn't ready
    if (!mediaSource || mediaSource.readyState !== 'open') {
      return;
    }
    queue.push(data);
    processQueue();
  }

  function tryTrimBuffer() {
    if (!isSourceBufferReady()) return;
    if (!sourceBuffer.buffered.length) return;
    
    const currentTime = player.currentTime;
    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(0);
    
    // Keep only ~3 seconds behind
    if (currentTime - start > 3) {
      try {
        sourceBuffer.remove(start, currentTime - 1);
      } catch (e) {}
    }
    
    // Skip ahead if too far behind
    if (end - currentTime > 1.5 && isPlaying) {
      player.currentTime = end - 0.2;
    }
  }

  // Audio level meter
  function initAudioAnalyser() {
    if (audioContext) return;
    
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      sourceNode = audioContext.createMediaElementSource(player);
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
      
      if (levelContainer) levelContainer.classList.remove('hidden');
      updateLevelMeter();
    } catch (e) {
      console.error('Failed to init audio analyser:', e);
    }
  }

  function updateLevelMeter() {
    if (!analyser || !levelBar) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const level = Math.min(100, (avg / 255) * 100 * 1.5);
    
    levelBar.style.width = `${level}%`;
    
    if (level > 80) {
      levelBar.className = 'h-full bg-red-500 rounded transition-all duration-75';
    } else if (level > 50) {
      levelBar.className = 'h-full bg-yellow-500 rounded transition-all duration-75';
    } else {
      levelBar.className = 'h-full bg-green-500 rounded transition-all duration-75';
    }
    
    animationId = requestAnimationFrame(updateLevelMeter);
  }

  function stopLevelMeter() {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (levelBar) levelBar.style.width = '0%';
  }

  // Start playback (called after user interaction)
  async function startPlayback() {
    if (!sourceBuffer?.buffered.length) return;
    
    try {
      // Jump to live edge
      player.currentTime = sourceBuffer.buffered.end(0) - 0.1;
      await player.play();
      isPlaying = true;
      statusEl.textContent = 'Live — playing';
      messageEl.textContent = '';
      if (listenBtn) listenBtn.classList.add('hidden');
      initAudioAnalyser();
    } catch (e) {
      console.error('Play failed:', e);
      messageEl.textContent = 'Failed to play. Click the button to try again.';
    }
  }

  // WebSocket connection
  async function connect() {
    queue = [];
    isAppending = false;
    
    try {
      await createMediaSource();
    } catch (e) {
      statusEl.textContent = 'Error initializing audio';
      messageEl.textContent = 'Your browser may not support this audio format.';
      return;
    }

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?sid=${encodeURIComponent(sid)}&role=listener&t=${encodeURIComponent(token)}`;
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
          handleJsonMessage(JSON.parse(ev.data));
        } catch (e) {}
        return;
      }

      if (ev.data instanceof ArrayBuffer) {
        handleBinaryData(ev.data);
      }
    };

    ws.onclose = () => {
      stopLevelMeter();
      isPlaying = false;
      
      if (intentionallyClosed) return;
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        statusEl.textContent = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
        reconnectTimeout = setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        statusEl.textContent = 'Disconnected';
        messageEl.textContent = 'Could not reconnect. Refresh to try again.';
      }
    };

    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
    };
  }

  function handleJsonMessage(msg) {
    switch (msg.type) {
      case 'session-ended':
        intentionallyClosed = true;
        statusEl.textContent = 'Broadcast ended';
        messageEl.textContent = 'The broadcaster has stopped the stream.';
        if (listenBtn) listenBtn.classList.add('hidden');
        if (mediaSource?.readyState === 'open') {
          try { mediaSource.endOfStream(); } catch (e) {}
        }
        stopLevelMeter();
        ws.close();
        break;
        
      case 'broadcast-started':
        statusEl.textContent = userHasInteracted ? 'Live — buffering...' : 'Live — click to listen';
        break;
        
      case 'ok':
        console.log('Connected to session:', msg.sessionId);
        break;
        
      case 'init-segment':
        console.log('Receiving init segment:', msg.size, 'bytes');
        break;
    }
  }

  function handleBinaryData(data) {
    appendChunk(data);
    
    // Auto-play if user has already interacted
    if (userHasInteracted && !isPlaying && sourceBuffer?.buffered.length) {
      startPlayback();
    }
  }

  // User interaction handler
  function onUserInteraction() {
    userHasInteracted = true;
    
    // Resume audio context if suspended
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
    
    if (sourceBuffer?.buffered.length) {
      startPlayback();
    } else {
      statusEl.textContent = 'Waiting for audio data...';
      messageEl.textContent = '';
    }
  }

  // Event listeners
  if (listenBtn) {
    listenBtn.addEventListener('click', onUserInteraction);
  }

  player.addEventListener('play', () => {
    userHasInteracted = true;
    isPlaying = true;
    statusEl.textContent = 'Live — playing';
    messageEl.textContent = '';
    if (listenBtn) listenBtn.classList.add('hidden');
    initAudioAnalyser();
    
    if (audioContext?.state === 'suspended') {
      audioContext.resume();
    }
  });

  player.addEventListener('pause', () => {
    isPlaying = false;
    stopLevelMeter();
  });

  window.addEventListener('beforeunload', () => {
    intentionallyClosed = true;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    stopLevelMeter();
  });

  // Start connection immediately
  connect();
})();