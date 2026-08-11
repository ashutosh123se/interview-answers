(function () {
  "use strict";

  const STORAGE_KEY = "interview_assistant_settings";
  const VOLUME_THRESHOLD = 8;
  const MIN_AUDIO_BYTES = 3000;
  const MAX_SEGMENT_MS = 18000;
  const RECORD_SLICE_MS = 400;

  const $ = (id) => document.getElementById(id);

  const els = {
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    micMeter: $("mic-meter"),
    micLevel: $("mic-level"),
    serverBadge: $("server-badge"),
    transcript: $("transcript"),
    answer: $("answer"),
    listenBtn: $("listen-btn"),
    askBtn: $("ask-btn"),
    settingsBtn: $("settings-btn"),
    settingsOverlay: $("settings-overlay"),
    closeSettings: $("close-settings"),
    saveSettings: $("save-settings"),
    hearingMode: $("hearing-mode"),
    model: $("model"),
    context: $("context"),
    silenceMs: $("silence-ms"),
  };

  let settings = loadSettings();
  let serverReady = false;
  let isListening = false;
  let isProcessing = false;
  let fullTranscript = "";
  let lastProcessedText = "";
  let pendingBlob = null;

  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let mediaRecorder = null;
  let segmentChunks = [];
  let vadTimer = null;
  let lastSpeechAt = 0;
  let segmentStartedAt = 0;
  let heardSpeechInSegment = false;

  function loadSettings() {
    try {
      return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    } catch {
      return defaultSettings();
    }
  }

  function defaultSettings() {
    return {
      hearingMode: "whisper",
      model: "gpt-4o-mini",
      context: "",
      silenceMs: 1400,
    };
  }

  function saveSettingsToStorage() {
    settings = {
      hearingMode: els.hearingMode.value,
      model: els.model.value,
      context: els.context.value.trim(),
      silenceMs: Number(els.silenceMs.value) || 1400,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToForm() {
    els.hearingMode.value = settings.hearingMode || "whisper";
    els.model.value = settings.model || "gpt-4o-mini";
    els.context.value = settings.context || "";
    els.silenceMs.value = settings.silenceMs || 1400;
  }

  function setStatus(mode, text) {
    els.statusBar.className = "status " + mode;
    els.statusText.textContent = text;
  }

  function setServerBadge(state, text) {
    els.serverBadge.className = "badge " + state;
    els.serverBadge.textContent = text;
  }

  function setMainButton(active) {
    const icon = els.listenBtn.querySelector(".btn-icon");
    const label = els.listenBtn.querySelector(".btn-label");
    if (active) {
      icon.textContent = "■";
      label.textContent = "STOP";
      els.listenBtn.classList.add("active");
    } else {
      icon.textContent = "▶";
      label.textContent = "START — Grab All & Answer";
      els.listenBtn.classList.remove("active");
    }
  }

  function setTranscript(text) {
    fullTranscript = text || "";
    updateTranscriptDisplay();
  }

  function updateTranscriptDisplay() {
    if (!fullTranscript) {
      els.transcript.textContent = isListening
        ? "Recording all sound — waiting for a question…"
        : "Waiting for speech…";
      els.transcript.classList.add("empty");
    } else {
      els.transcript.textContent = fullTranscript;
      els.transcript.classList.remove("empty");
    }
    els.askBtn.disabled = !fullTranscript || isProcessing || !serverReady;
  }

  function showMicMeter(show) {
    els.micMeter.classList.toggle("hidden", !show);
    if (!show) {
      els.micLevel.style.width = "0%";
      els.micLevel.classList.remove("loud");
    }
  }

  function updateMicLevel(volume) {
    const pct = Math.min(100, Math.round((volume / 70) * 100));
    els.micLevel.style.width = pct + "%";
    els.micLevel.classList.toggle("loud", volume > VOLUME_THRESHOLD);
  }

  function getSupportedMimeType() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  function readVolume() {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length;
  }

  function resetSegment() {
    segmentChunks = [];
    heardSpeechInSegment = false;
    segmentStartedAt = Date.now();
    lastSpeechAt = 0;
  }

  function blobFromSegment() {
    if (!segmentChunks.length) return null;
    const mime = mediaRecorder?.mimeType || "audio/webm";
    return new Blob(segmentChunks, { type: mime });
  }

  async function checkServer() {
    setServerBadge("checking", "Checking…");
    els.listenBtn.disabled = true;

    try {
      const res = await fetch("/api/health");
      const data = await res.json();

      if (!data.apiConfigured) {
        serverReady = false;
        setServerBadge("error", "No API key");
        setStatus("error", "Add OPENAI_API_KEY to .env on laptop, then restart server");
        return;
      }

      serverReady = true;
      setServerBadge("ready", "Ready");
      els.listenBtn.disabled = false;
      setStatus("idle", "Tap START — mic grabs ALL sound instantly");
    } catch {
      serverReady = false;
      setServerBadge("error", "Offline");
      setStatus("error", "Cannot reach server — run start.bat on laptop");
    }
  }

  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append("audio", blob, "recording.webm");
    form.append("language", "en");

    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(data.error || "Transcription failed");
    return (data.text || "").trim();
  }

  function isSimilarText(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^\w\s]/g, "").trim();
    const nb = b.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (!na || !nb) return false;
    if (na === nb) return true;
    return na.includes(nb) || nb.includes(na);
  }

  async function processSegment(blob) {
    if (!blob || blob.size < MIN_AUDIO_BYTES) return;

    isProcessing = true;
    setStatus("processing", "Transcribing everything heard…");

    try {
      const text = await transcribeBlob(blob);
      if (!text || text.length < 3) {
        if (isListening) setStatus("listening", "Recording all sound — speak louder on laptop");
        return;
      }

      if (isSimilarText(text, lastProcessedText)) {
        if (isListening) setStatus("listening", "Recording — waiting for new question");
        return;
      }

      setTranscript(text);
      setStatus("processing", "Analyzing question & generating answer…");
      await sendRawTranscript(text);
      lastProcessedText = text;
    } catch (err) {
      console.error(err);
      setStatus("error", err.message);
      setTimeout(() => {
        if (isListening) setStatus("listening", "Still recording all sound…");
      }, 2000);
    } finally {
      isProcessing = false;

      if (pendingBlob) {
        const next = pendingBlob;
        pendingBlob = null;
        processSegment(next);
      }
    }
  }

  function finalizeSegment() {
    const blob = blobFromSegment();
    resetSegment();

    if (!blob || blob.size < MIN_AUDIO_BYTES) return;

    if (isProcessing) {
      pendingBlob = blob;
      return;
    }

    processSegment(blob);
  }

  function checkVoiceActivity() {
    if (!isListening || !analyser) return;

    const volume = readVolume();
    const now = Date.now();
    updateMicLevel(volume);

    if (volume > VOLUME_THRESHOLD) {
      lastSpeechAt = now;
      heardSpeechInSegment = true;
    }

    if (!heardSpeechInSegment) return;

    const silentFor = lastSpeechAt ? now - lastSpeechAt : 0;
    const segmentAge = now - segmentStartedAt;

    const silenceReached = lastSpeechAt > 0 && silentFor >= settings.silenceMs;
    const maxLengthReached = segmentAge >= MAX_SEGMENT_MS;

    if (silenceReached || maxLengthReached) {
      finalizeSegment();
    }
  }

  async function startContinuousListening() {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Microphone not supported in this browser.");
      return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    const mimeType = getSupportedMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) segmentChunks.push(event.data);
    };

    resetSegment();
    mediaRecorder.start(RECORD_SLICE_MS);

    isListening = true;
    setMainButton(true);
    showMicMeter(true);
    setStatus("listening", "Recording ALL sound — mic is live");
    vadTimer = setInterval(checkVoiceActivity, 100);
  }

  function stopContinuousListening() {
    if (vadTimer) {
      clearInterval(vadTimer);
      vadTimer = null;
    }

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    const blob = blobFromSegment();
    if (blob && blob.size >= MIN_AUDIO_BYTES && !isProcessing) {
      processSegment(blob);
    } else if (blob && blob.size >= MIN_AUDIO_BYTES) {
      pendingBlob = blob;
    }

    mediaRecorder = null;
    resetSegment();

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }

    analyser = null;
    showMicMeter(false);
  }

  async function sendRawTranscript(text) {
    els.answer.textContent = "";
    els.answer.classList.remove("empty");

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text,
        context: settings.context,
        model: settings.model,
        rawTranscript: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "Server error " + response.status);
    }

    setStatus("processing", "Answer streaming…");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullAnswer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullAnswer += delta;
            els.answer.textContent = fullAnswer;
            els.answer.scrollTop = els.answer.scrollHeight;
          }
        } catch {}
      }
    }

    if (!fullAnswer.trim()) {
      els.answer.textContent = "Could not generate answer. Tap Send Now to retry.";
    } else if (fullAnswer.toLowerCase().includes("still listening")) {
      setStatus("listening", "Recording — question not clear yet, keep listening");
    } else if (isListening) {
      setStatus("listening", "Answer ready — still recording all sound");
    }
  }

  async function sendQuestion(text) {
    if (!text || isProcessing || !serverReady) return;

    isProcessing = true;
    setStatus("processing", "Analyzing & answering…");
    els.askBtn.disabled = true;

    try {
      await sendRawTranscript(text);
    } catch (err) {
      console.error(err);
      els.answer.textContent = "Error: " + err.message;
      setStatus("error", "Request failed");
    } finally {
      isProcessing = false;
      updateTranscriptDisplay();
    }
  }

  async function startListening() {
    if (!serverReady) {
      alert("Server not ready. Run start.bat on your laptop.");
      return;
    }

    fullTranscript = "";
    lastProcessedText = "";
    pendingBlob = null;
    updateTranscriptDisplay();
    els.answer.textContent = "Answer appears after AI detects a question…";
    els.answer.classList.add("empty");

    try {
      await startContinuousListening();
    } catch (err) {
      console.error(err);
      stopListening();
      setStatus("error", "Mic blocked — allow microphone in browser");
    }
  }

  function stopListening() {
    isListening = false;
    stopContinuousListening();
    setMainButton(false);
    setStatus("idle", "Stopped — tap START when ready");
    updateTranscriptDisplay();
  }

  function openSettings() {
    applySettingsToForm();
    els.settingsOverlay.classList.remove("hidden");
  }

  function closeSettingsPanel() {
    els.settingsOverlay.classList.add("hidden");
  }

  els.listenBtn.addEventListener("click", () => {
    if (isListening) stopListening();
    else startListening();
  });

  els.askBtn.addEventListener("click", () => {
    if (fullTranscript) sendQuestion(fullTranscript);
  });

  els.settingsBtn.addEventListener("click", openSettings);
  els.closeSettings.addEventListener("click", closeSettingsPanel);
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) closeSettingsPanel();
  });

  els.saveSettings.addEventListener("click", () => {
    saveSettingsToStorage();
    closeSettingsPanel();
    setStatus("idle", "Settings saved");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isListening) {
      setStatus("listening", "Keep screen ON — recording stops in background");
    }
  });

  applySettingsToForm();
  setMainButton(false);
  checkServer();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
