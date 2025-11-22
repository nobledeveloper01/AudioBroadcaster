(() => {
  const BASE_URL = `${location.protocol}//${location.host}`;

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusBadge = document.getElementById('statusBadge');
  const statusOffline = document.getElementById('statusOffline');
  const linkPanel = document.getElementById('linkPanel');
  const linkEl = document.getElementById('link');
  const copyBtn = document.getElementById('copyBtn');
  const openListen = document.getElementById('openListen');
  const downloadBtn = document.getElementById('downloadBtn');
  const timerEl = document.getElementById('timer');
  const levelBar = document.getElementById('levelBar');
  const levelContainer = document.getElementById('levelContainer');
  const listenerCount = document.getElementById('listenerCount');

  let mediaStream = null;
  let recorder = null;
  let ws = null;
  let sessionId = null;
  let token = null;
  let listenUrl = null;
  let timerInterval = null;
  let startTime = null;

  // Audio analysis
  let audioContext = null;
  let analyser = null;
  let animationId = null;

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) {
      return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function startTimer() {
    startTime = Date.now();
    timerInterval = setInterval(() => {
      timerEl.textContent = fmtTime(Date.now() - startTime);
    }, 500);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerEl.textContent = '00:00';
  }

  // Audio level meter
  function initAudioAnalyser(stream) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      // Don't connect to destination to avoid feedback
      
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
    if (levelContainer) levelContainer.classList.add('hidden');
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  }

  async function createSession() {
    const res = await fetch(`${BASE_URL}/api/session/create`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
  }

  // Backpressure handling
  let paused = false;
  let pendingChunks = [];
  const MAX_PENDING = 10;

  function sendChunk(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    if (paused) {
      // Queue chunks while paused, but limit queue size
      if (pendingChunks.length < MAX_PENDING) {
        pendingChunks.push(data);
      }
      // If queue is full, drop oldest chunk (prioritize live data)
      else {
        pendingChunks.shift();
        pendingChunks.push(data);
      }
      return;
    }
    
    ws.send(data);
  }

  function flushPendingChunks() {
    while (pendingChunks.length > 0 && !paused && ws?.readyState === WebSocket.OPEN) {
      ws.send(pendingChunks.shift());
    }
  }

  function openWs(sid) {
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?sid=${sid}&role=broadcaster`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      statusOffline.classList.add('hidden');
      statusBadge.classList.remove('hidden');
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'listener-count' && listenerCount) {
            listenerCount.textContent = msg.count;
          }
          if (msg.type === 'backpressure') {
            // Server is overwhelmed, pause sending
            paused = true;
            console.warn('Server backpressure - pausing');
          }
          if (msg.type === 'drain') {
            // Server is ready for more data
            paused = false;
            console.log('Server drained - resuming');
            flushPendingChunks();
          }
          if (msg.type === 'error') {
            console.error('Server error:', msg.message);
          }
        } catch (e) {}
      }
    };

    ws.onclose = () => {
      statusBadge.classList.add('hidden');
      statusOffline.classList.remove('hidden');
    };

    ws.onerror = (e) => console.error('WS error', e);
  }

  async function startBroadcast() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
    } catch (e) {
      alert('Microphone access is required.');
      return;
    }

    // Initialize audio level meter
    initAudioAnalyser(mediaStream);

    let session;
    try {
      session = await createSession();
    } catch (e) {
      alert('Failed to create session. Please try again.');
      mediaStream.getTracks().forEach(t => t.stop());
      stopLevelMeter();
      return;
    }

    sessionId = session.sessionId;
    token = session.token;
    listenUrl = `${BASE_URL}${session.listenUrl}`;

    linkEl.textContent = listenUrl;
    openListen.href = listenUrl;
    linkPanel.classList.remove('hidden');

    openWs(sessionId);

    // Determine best supported mime type
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    
    let mimeType = '';
    for (const type of mimeTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        break;
      }
    }

    if (!mimeType) {
      alert('No supported audio format found.');
      return;
    }

    recorder = new MediaRecorder(mediaStream, { mimeType });

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        sendChunk(ev.data);
      }
    };

    recorder.onerror = (e) => {
      console.error('MediaRecorder error:', e);
    };

    recorder.start(250); // Send chunks every 250ms for lower latency
    
    // Periodically restart recorder to create fresh keyframes for late-joiners
    // This ensures new listeners can always sync up
    setInterval(() => {
      if (recorder && recorder.state === 'recording' && ws?.readyState === WebSocket.OPEN) {
        recorder.stop();
        recorder.start(250);
        // Notify server that fresh keyframe is coming
        ws.send(JSON.stringify({ type: 'keyframe-ready' }));
      }
    }, 5000); // Every 5 seconds

    startTimer();
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    downloadBtn.disabled = true;
  }

  async function stopBroadcast() {
    // Stop recording
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    
    // Stop media tracks
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    // Close WebSocket
    if (ws) {
      ws.close();
      ws = null;
    }

    stopTimer();
    stopLevelMeter();

    if (sessionId) {
      downloadBtn.disabled = false;
      
      const recordingFile = `broadcast-${sessionId}`;
      downloadBtn.onclick = () => {
        // Fetch available recordings
        window.open(`${BASE_URL}/api/recording/${recordingFile}`, '_blank');
      };

      // Tell server to stop session
      try {
        const res = await fetch(`${BASE_URL}/api/session/${sessionId}/stop`, { method: 'POST' });
        const data = await res.json();
        if (data.recording) {
          downloadBtn.onclick = () => {
            window.open(`${BASE_URL}/api/recording/${data.recording}`, '_blank');
          };
        }
      } catch (e) {
        console.error('Error stopping broadcast', e);
      }
    }

    sessionId = null;
    token = null;
    recorder = null;
    paused = false;
    pendingChunks = [];

    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    linkPanel.classList.add('hidden');
  }

  startBtn.addEventListener('click', startBroadcast);
  stopBtn.addEventListener('click', stopBroadcast);

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkEl.textContent);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1300);
    } catch (e) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = linkEl.textContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1300);
    }
  });

  // Warn before leaving if broadcasting
  window.addEventListener('beforeunload', (e) => {
    if (recorder && recorder.state === 'recording') {
      e.preventDefault();
      e.returnValue = 'You are currently broadcasting. Are you sure you want to leave?';
      return e.returnValue;
    }
  });
})();