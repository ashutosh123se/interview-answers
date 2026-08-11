(function () {
  "use strict";

  const STORAGE_KEY = "interview_assistant_settings";
  const RECORD_EVERY_MS = 7000;
  const MIN_BLOB = 1500;

  const $ = (id) => document.getElementById(id);

  const els = {
    badge: $("server-badge"),
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    micMeter: $("mic-meter"),
    micLevel: $("mic-level"),
    audioHint: $("audio-hint"),
    transcript: $("transcript"),
    answer: $("answer"),
    debugLog: $("debug-log"),
    startBtn: $("start-btn"),
    forceBtn: $("force-btn"),
    hiddenVideo: $("hidden-video"),
    modeTab: $("mode-tab"),
    modeScreen: $("mode-screen"),
    modeMic: $("mode-mic"),
    settingsBtn: $("settings-btn"),
    settingsOverlay: $("settings-overlay"),
    closeSettings: $("close-settings"),
    saveSettings: $("save-settings"),
    model: $("model"),
    context: $("context"),
  };

  let settings = loadSettings();
  let captureMode = "mic";
  let isRunning = false;
  let isProcessing = false;
  let serverReady = false;
  let fullTranscript = "";
  let interimText = "";
  let lastAnswered = "";
  let pendingQueue = false;

  let mediaStream = null;
  let mediaRecorder = null;
  let recognition = null;
  let audioContext = null;
  let analyser = null;
  let meterTimer = null;
  let currentLevel = 0;
  let speechSilenceTimer = null;

  function loadSettings() {
    try {
      return { ...{ model: "gpt-4o-mini", context: "" }, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    } catch {
      return { model: "gpt-4o-mini", context: "" };
    }
  }

  function saveSettingsToStorage() {
    settings = { model: els.model.value, context: els.context.value.trim() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToForm() {
    els.model.value = settings.model || "gpt-4o-mini";
    els.context.value = settings.context || "";
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    els.debugLog.textContent = `[${t}] ${msg}\n` + els.debugLog.textContent.slice(0, 800);
    console.log(msg);
  }

  function setStatus(mode, text) {
    els.statusBar.className = "status " + mode;
    els.statusText.textContent = text;
  }

  function setMode(mode) {
    captureMode = mode;
    els.modeMic.classList.toggle("active", mode === "mic");
    els.modeTab.classList.toggle("active", mode === "tab");
    els.modeScreen.classList.toggle("active", mode === "screen");
  }

  function showTranscript() {
    const text = (fullTranscript + " " + interimText).trim();
    els.transcript.textContent = text || "Listening…";
    els.transcript.classList.toggle("empty", !text);
  }

  function updateMeter(level) {
    currentLevel = level;
    const pct = Math.min(100, Math.round(level * 100));
    els.micLevel.style.width = pct + "%";
    els.micLevel.classList.toggle("loud", level > 0.02);
    els.audioHint.textContent = level > 0.02 ? "✓ Audio detected" : "Waiting for sound…";
    els.audioHint.className = "mic-label " + (level > 0.02 ? "audio-ok" : "audio-bad");
  }

  function startMeter(stream) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    els.micMeter.classList.remove("hidden");
    meterTimer = setInterval(() => {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      updateMeter(sum / data.length / 255);
    }, 150);
  }

  function stopMeter() {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    els.micMeter.classList.add("hidden");
  }

  async function checkServer() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      if (!data.apiConfigured) {
        els.badge.className = "badge error";
        els.badge.textContent = "No API key";
        setStatus("error", "Add OPENAI_API_KEY in Vercel or .env");
        return;
      }
      serverReady = true;
      els.badge.className = "badge ready";
      els.badge.textContent = "Ready";
      els.startBtn.disabled = false;
      setStatus("idle", "Click START — use Laptop Mic mode (recommended)");
      log("Server ready");
    } catch (e) {
      els.badge.className = "badge error";
      els.badge.textContent = "Offline";
      setStatus("error", "Server offline");
      log("Server offline: " + e.message);
    }
  }

  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");
    form.append("language", "en");
    form.append("prompt", fullTranscript.slice(-200) || "Job interview question.");

    log("Sending " + Math.round(blob.size / 1024) + "KB to Whisper…");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcribe failed");
    return (data.text || "").trim();
  }

  function mergeText(newText) {
    if (!newText) return;
    const n = newText.trim();
    if (!fullTranscript) {
      fullTranscript = n;
      return;
    }
    const a = fullTranscript.toLowerCase();
    const b = n.toLowerCase();
    if (b.includes(a) && n.length > fullTranscript.length) fullTranscript = n;
    else if (!a.includes(b)) fullTranscript = fullTranscript + " " + n;
  }

  async function streamAnswer(text) {
    els.answer.textContent = "";
    els.answer.classList.remove("empty");
    setStatus("processing", "Generating detailed answer…");
    log("Asking AI…");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text,
        context: settings.context,
        model: settings.model,
        rawTranscript: true,
        detailed: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Answer failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim().startsWith("data:")) continue;
        const d = line.trim().slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const delta = JSON.parse(d).choices?.[0]?.delta?.content;
          if (delta) {
            answer += delta;
            els.answer.textContent = answer;
            els.answer.scrollTop = els.answer.scrollHeight;
          }
        } catch {}
      }
    }
    log("Answer received (" + answer.length + " chars)");
    return answer;
  }

  async function handleText(text) {
    if (!text || text.length < 3) return;

    mergeText(text);
    interimText = "";
    showTranscript();
    log('Heard: "' + text.slice(0, 60) + (text.length > 60 ? "…" : "") + '"');

    if (fullTranscript === lastAnswered) return;

    if (isProcessing) {
      pendingQueue = true;
      return;
    }

    isProcessing = true;
    try {
      await streamAnswer(fullTranscript);
      lastAnswered = fullTranscript;
      if (isRunning) setStatus("listening", "Listening for next question…");
    } catch (err) {
      log("Error: " + err.message);
      setStatus("error", err.message);
    } finally {
      isProcessing = false;
      if (pendingQueue) {
        pendingQueue = false;
        if (fullTranscript !== lastAnswered) handleText(fullTranscript);
      }
    }
  }

  async function processBlob(blob) {
    if (!blob || blob.size < MIN_BLOB) {
      log("Clip too small (" + (blob?.size || 0) + " bytes), skipping");
      return;
    }
    if (isProcessing) {
      pendingQueue = true;
      return;
    }
    isProcessing = true;
    setStatus("processing", "Transcribing audio…");
    try {
      const text = await transcribeBlob(blob);
      if (text) {
        await handleText(text);
      } else {
        log("Whisper returned empty — turn up volume");
        if (isRunning) setStatus("listening", "Listening…");
      }
    } catch (err) {
      log("Transcribe error: " + err.message);
      setStatus("error", err.message);
    } finally {
      isProcessing = false;
    }
  }

  function scheduleSpeechAnswer() {
    clearTimeout(speechSilenceTimer);
    speechSilenceTimer = setTimeout(() => {
      const text = (fullTranscript + " " + interimText).trim();
      if (text.length >= 8) {
        interimText = "";
        handleText(text);
      }
    }, 1800);
  }

  function startSpeechEngine() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("Speech recognition not supported. Use Chrome.");

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (e) => {
      interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (!t) continue;
        if (e.results[i].isFinal) {
          fullTranscript = (fullTranscript + " " + t).trim();
        } else {
          interimText = (interimText + " " + t).trim();
        }
      }
      showTranscript();
      scheduleSpeechAnswer();
    };

    recognition.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      log("Speech error: " + e.error);
      if (e.error === "not-allowed") setStatus("error", "Allow microphone in browser");
    };

    recognition.onend = () => {
      if (isRunning) {
        try { recognition.start(); log("Speech restarted"); } catch {}
      }
    };

    recognition.start();
    log("Speech recognition started (laptop mic)");
  }

  async function startRecorderEngine() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 640, height: 360, frameRate: 5 },
      audio: true,
    });

    els.hiddenVideo.srcObject = stream;
    await els.hiddenVideo.play().catch(() => {});

    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('NO AUDIO! Enable "Share tab audio" or "Share system audio".');
    }

    log("Tab/screen audio captured: " + stream.getAudioTracks().length + " track(s)");
    mediaStream = stream;
    startMeter(stream);

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size >= MIN_BLOB) {
        log("Auto clip: " + Math.round(e.data.size / 1024) + "KB");
        processBlob(e.data);
      }
    };

    mediaRecorder.onerror = (e) => log("Recorder error: " + e.error);

    mediaRecorder.start(RECORD_EVERY_MS);
    log("Recording every " + RECORD_EVERY_MS / 1000 + "s from tab audio");
  }

  async function startMicRecorderEngine() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });

    startMeter(mediaStream);
    startSpeechEngine();

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size >= MIN_BLOB) processBlob(e.data);
    };

    mediaRecorder.start(RECORD_EVERY_MS);
    log("Mic + speech recognition active");
  }

  async function startListening() {
    if (!serverReady) {
      alert("Add OPENAI_API_KEY first");
      return;
    }

    fullTranscript = "";
    interimText = "";
    lastAnswered = "";
    showTranscript();
    els.answer.textContent = "Answer appears here…";
    els.answer.classList.add("empty");

    isRunning = true;
    els.startBtn.querySelector(".btn-label").textContent = "STOP";
    els.startBtn.classList.add("active");
    els.forceBtn.disabled = false;
    setStatus("listening", "Listening…");

    if (captureMode === "mic") {
      await startMicRecorderEngine();
      setStatus("listening", "Mic active — play interview on laptop speaker");
    } else {
      await startRecorderEngine();
      setStatus("listening", "Tab audio recording every 7 seconds");
    }
  }

  function stopListening() {
    isRunning = false;
    clearTimeout(speechSilenceTimer);

    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch {}
      recognition = null;
    }

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch {}
    }
    mediaRecorder = null;

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    els.hiddenVideo.srcObject = null;
    stopMeter();

    els.startBtn.querySelector(".btn-label").textContent = "START";
    els.startBtn.classList.remove("active");
    els.forceBtn.disabled = true;
    setStatus("idle", "Stopped");
    log("Stopped");
  }

  function forceAnswer() {
    const text = (fullTranscript + " " + interimText).trim();
    if (text.length >= 3) {
      interimText = "";
      handleText(text);
    } else {
      log("Nothing heard yet — speak or play audio");
      alert("Nothing heard yet.\n\n1. Check audio meter moves\n2. Turn up laptop volume\n3. Use Laptop Mic mode");
    }
  }

  els.modeMic.addEventListener("click", () => setMode("mic"));
  els.modeTab.addEventListener("click", () => setMode("tab"));
  els.modeScreen.addEventListener("click", () => setMode("screen"));

  els.startBtn.addEventListener("click", async () => {
    if (isRunning) { stopListening(); return; }
    try {
      await startListening();
    } catch (err) {
      log("Start failed: " + err.message);
      alert(err.message);
      setStatus("error", err.message);
      stopListening();
    }
  });

  els.forceBtn.addEventListener("click", forceAnswer);
  els.settingsBtn.addEventListener("click", () => {
    applySettingsToForm();
    els.settingsOverlay.classList.remove("hidden");
  });
  els.closeSettings.addEventListener("click", () => els.settingsOverlay.classList.add("hidden"));
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) els.settingsOverlay.classList.add("hidden");
  });
  els.saveSettings.addEventListener("click", () => {
    saveSettingsToStorage();
    els.settingsOverlay.classList.add("hidden");
    log("Settings saved");
  });

  applySettingsToForm();
  setMode("mic");
  checkServer();
})();
