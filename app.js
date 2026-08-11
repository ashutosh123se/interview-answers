(function () {
  "use strict";

  const STORAGE_KEY = "interview_assistant_settings";
  const VOLUME_THRESHOLD = 3;
  const MIN_AUDIO_BYTES = 800;
  const MAX_SEGMENT_MS = 90000;
  const RECORD_SLICE_MS = 200;
  const PRE_ROLL_MS = 2000;
  const POST_ROLL_MS = 1800;
  const BUFFER_KEEP_MS = 120000;

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
  let lastAnsweredText = "";
  let pendingProcess = false;

  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let mediaRecorder = null;
  let chunkLog = [];
  let vadTimer = null;
  let lastSpeechAt = 0;
  let speechWindowStart = 0;
  let sessionStartedAt = 0;
  let finalizeTimer = null;

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
      silenceMs: 2800,
    };
  }

  function saveSettingsToStorage() {
    settings = {
      hearingMode: els.hearingMode.value,
      model: els.model.value,
      context: els.context.value.trim(),
      silenceMs: Number(els.silenceMs.value) || 2800,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToForm() {
    els.hearingMode.value = settings.hearingMode || "whisper";
    els.model.value = settings.model || "gpt-4o-mini";
    els.context.value = settings.context || "";
    els.silenceMs.value = settings.silenceMs || 2800;
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

  function mergeTranscript(newText) {
    const clean = (newText || "").trim();
    if (!clean) return;

    if (!fullTranscript) {
      fullTranscript = clean;
      return;
    }

    const prev = fullTranscript.trim();
    const prevLow = prev.toLowerCase();
    const cleanLow = clean.toLowerCase();

    if (cleanLow === prevLow) return;

    if (cleanLow.startsWith(prevLow) || clean.length > prev.length + 8) {
      fullTranscript = clean;
      return;
    }

    if (prevLow.includes(cleanLow)) return;

    fullTranscript = prev + " " + clean;
  }

  function updateTranscriptDisplay() {
    if (!fullTranscript) {
      els.transcript.textContent = isListening
        ? "Recording every word — speak or play audio near phone…"
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
    const pct = Math.min(100, Math.round((volume / 35) * 100));
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

    const timeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeData.length) * 100;

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    let freqSum = 0;
    for (let i = 0; i < freqData.length; i++) freqSum += freqData[i];
    const freqAvg = freqSum / freqData.length;

    return Math.max(rms * 1.4, freqAvg * 0.35);
  }

  function trimOldChunks() {
    const cutoff = Date.now() - BUFFER_KEEP_MS;
    chunkLog = chunkLog.filter((c) => c.t >= cutoff);
  }

  function buildBlobFromWindow(startTime, endTime) {
    const blobs = chunkLog
      .filter((c) => c.t >= startTime && c.t <= endTime)
      .map((c) => c.blob);

    if (!blobs.length) return null;

    const mime = mediaRecorder?.mimeType || "audio/webm";
    return new Blob(blobs, { type: mime });
  }

  function clearFinalizeTimer() {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
  }

  function scheduleFinalize() {
    clearFinalizeTimer();
    const waitMs = settings.silenceMs + POST_ROLL_MS;

    finalizeTimer = setTimeout(() => {
      if (!isListening) return;
      const now = Date.now();
      const silentFor = lastSpeechAt ? now - lastSpeechAt : Infinity;

      if (silentFor >= settings.silenceMs && speechWindowStart) {
        triggerProcessWindow();
      }
    }, waitMs);
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
        setStatus("error", "Add OPENAI_API_KEY in Vercel or .env on laptop");
        return;
      }

      serverReady = true;
      setServerBadge("ready", "Ready");
      els.listenBtn.disabled = false;
      setStatus("idle", "Tap START — records every word continuously");
    } catch {
      serverReady = false;
      setServerBadge("error", "Offline");
      setStatus("error", "Cannot reach server");
    }
  }

  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append("audio", blob, "recording.webm");
    form.append("language", "en");

    const prompt = fullTranscript.slice(-220) || "Job interview. Interviewer asks a question.";
    form.append("prompt", prompt);

    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(data.error || "Transcription failed");
    return (data.text || "").trim();
  }

  function shouldSkipAnswer(text) {
    if (!text) return true;
    const low = text.toLowerCase().replace(/\s+/g, " ").trim();
    const prev = lastAnsweredText.toLowerCase().replace(/\s+/g, " ").trim();
    if (!prev) return false;
    if (low === prev) return true;
    if (low.length < prev.length + 12 && prev.includes(low)) return true;
    return false;
  }

  async function processWindow(startTime, endTime) {
    const blob = buildBlobFromWindow(startTime, endTime);
    if (!blob || blob.size < MIN_AUDIO_BYTES) return;

    isProcessing = true;
    setStatus("processing", "Transcribing full audio capture…");

    try {
      const text = await transcribeBlob(blob);

      if (!text || text.length < 2) {
        if (isListening) setStatus("listening", "Recording — turn up laptop volume");
        return;
      }

      mergeTranscript(text);
      updateTranscriptDisplay();

      if (shouldSkipAnswer(fullTranscript)) {
        if (isListening) setStatus("listening", "Recording — captured words, waiting for new question");
        return;
      }

      setStatus("processing", "Analyzing full question & answering…");
      await sendRawTranscript(fullTranscript);
      lastAnsweredText = fullTranscript;
    } catch (err) {
      console.error(err);
      setStatus("error", err.message);
      setTimeout(() => {
        if (isListening) setStatus("listening", "Still recording — every word captured");
      }, 2000);
    } finally {
      isProcessing = false;

      if (pendingProcess) {
        pendingProcess = false;
        triggerProcessWindow();
      }
    }
  }

  function triggerProcessWindow() {
    if (!speechWindowStart) return;

    const endTime = Date.now();
    const startTime = Math.max(speechWindowStart - PRE_ROLL_MS, sessionStartedAt);
    const windowMs = endTime - startTime;

    speechWindowStart = 0;
    lastSpeechAt = 0;
    clearFinalizeTimer();

    if (windowMs < 600) return;

    if (isProcessing) {
      pendingProcess = true;
      return;
    }

    processWindow(startTime, endTime);
  }

  function checkVoiceActivity() {
    if (!isListening || !analyser) return;

    const volume = readVolume();
    const now = Date.now();
    updateMicLevel(volume);
    trimOldChunks();

    if (volume > VOLUME_THRESHOLD) {
      if (!speechWindowStart) {
        speechWindowStart = now;
      }
      lastSpeechAt = now;
      clearFinalizeTimer();
      return;
    }

    if (!speechWindowStart || !lastSpeechAt) return;

    const silentFor = now - lastSpeechAt;
    const windowAge = now - speechWindowStart;

    if (silentFor >= settings.silenceMs) {
      scheduleFinalize();
    }

    if (windowAge >= MAX_SEGMENT_MS) {
      triggerProcessWindow();
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
        channelCount: 1,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    const mimeType = getSupportedMimeType();
    const options = { audioBitsPerSecond: 128000 };
    if (mimeType) options.mimeType = mimeType;

    mediaRecorder = MediaRecorder.isTypeSupported(mimeType || "")
      ? new MediaRecorder(mediaStream, options)
      : new MediaRecorder(mediaStream);

    chunkLog = [];
    sessionStartedAt = Date.now();
    speechWindowStart = 0;
    lastSpeechAt = 0;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunkLog.push({ t: Date.now(), blob: event.data });
      }
    };

    mediaRecorder.start(RECORD_SLICE_MS);

    isListening = true;
    setMainButton(true);
    showMicMeter(true);
    setStatus("listening", "Recording ALL words — nothing skipped");
    vadTimer = setInterval(checkVoiceActivity, 80);
  }

  function stopContinuousListening() {
    if (vadTimer) {
      clearInterval(vadTimer);
      vadTimer = null;
    }

    clearFinalizeTimer();

    if (speechWindowStart && lastSpeechAt) {
      triggerProcessWindow();
    }

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    mediaRecorder = null;
    chunkLog = [];

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

  async function forceProcessNow() {
    if (!isListening || !chunkLog.length) {
      if (fullTranscript) sendQuestion(fullTranscript);
      return;
    }

    const endTime = Date.now();
    const startTime = speechWindowStart
      ? Math.max(speechWindowStart - PRE_ROLL_MS, sessionStartedAt)
      : Math.max(endTime - 30000, sessionStartedAt);

    if (isProcessing) {
      pendingProcess = true;
      return;
    }

    await processWindow(startTime, endTime);
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
      els.answer.textContent = "Could not generate answer. Tap Process Now to retry.";
    } else if (fullAnswer.toLowerCase().includes("still listening")) {
      setStatus("listening", "Recording — need more words, keep listening");
    } else if (isListening) {
      setStatus("listening", "Answer ready — still recording every word");
    }
  }

  async function sendQuestion(text) {
    if (!text || isProcessing || !serverReady) return;

    isProcessing = true;
    setStatus("processing", "Analyzing & answering…");
    els.askBtn.disabled = true;

    try {
      await sendRawTranscript(text);
      lastAnsweredText = text;
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
      alert("Server not ready. Check Vercel deploy or run start.bat locally.");
      return;
    }

    fullTranscript = "";
    lastAnsweredText = "";
    pendingProcess = false;
    updateTranscriptDisplay();
    els.answer.textContent = "Answer appears after full question is captured…";
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
    forceProcessNow();
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
