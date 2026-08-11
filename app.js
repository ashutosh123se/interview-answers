(function () {
  "use strict";

  const STORAGE_KEY = "interview_assistant_settings";
  const SILENCE_MS = 2400;
  const MIN_RMS = 0.008;
  const MIN_SAMPLES = 16000 * 2;

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
  let captureMode = "tab";
  let displayStream = null;
  let audioContext = null;
  let processor = null;
  let isRunning = false;
  let isProcessing = false;
  let fullTranscript = "";
  let lastAnswered = "";
  let sampleBuffer = [];
  let lastSoundAt = 0;
  let flushTimer = null;
  let meterTimer = null;
  let currentRms = 0;
  let serverReady = false;

  function loadSettings() {
    try {
      return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    } catch {
      return defaultSettings();
    }
  }

  function defaultSettings() {
    return { model: "gpt-4o-mini", context: "" };
  }

  function saveSettingsToStorage() {
    settings = {
      model: els.model.value,
      context: els.context.value.trim(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToForm() {
    els.model.value = settings.model || "gpt-4o-mini";
    els.context.value = settings.context || "";
  }

  function setStatus(mode, text) {
    els.statusBar.className = "status " + mode;
    els.statusText.textContent = text;
  }

  function setMode(mode) {
    captureMode = mode;
    els.modeTab.classList.toggle("active", mode === "tab");
    els.modeScreen.classList.toggle("active", mode === "screen");
    els.modeMic.classList.toggle("active", mode === "mic");
  }

  function updateMeter(rms) {
    currentRms = rms;
    const pct = Math.min(100, Math.round((rms / 0.08) * 100));
    els.micLevel.style.width = pct + "%";
    els.micLevel.classList.toggle("loud", rms > MIN_RMS);
    if (rms > MIN_RMS) {
      els.audioHint.textContent = "✓ Hearing audio";
      els.audioHint.className = "mic-label audio-ok";
    } else {
      els.audioHint.textContent = "No audio yet";
      els.audioHint.className = "mic-label audio-bad";
    }
  }

  function encodeWav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function mergeSamples(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  async function checkServer() {
    els.badge.className = "badge checking";
    els.badge.textContent = "Checking…";
    els.startBtn.disabled = true;

    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      if (!data.apiConfigured) {
        serverReady = false;
        els.badge.className = "badge error";
        els.badge.textContent = "No API key";
        setStatus("error", "Add OPENAI_API_KEY to .env or Vercel settings");
        return;
      }
      serverReady = true;
      els.badge.className = "badge ready";
      els.badge.textContent = "Ready";
      els.startBtn.disabled = false;
      setStatus("idle", "Click START → share Meet/Zoom tab with audio ON");
    } catch {
      serverReady = false;
      els.badge.className = "badge error";
      els.badge.textContent = "Offline";
      setStatus("error", "Server not running — run start.bat or check Vercel");
    }
  }

  async function transcribeWav(wavBlob) {
    const form = new FormData();
    form.append("audio", wavBlob, "audio.wav");
    form.append("language", "en");
    form.append("prompt", fullTranscript.slice(-220) || "Job interview. Interviewer asks a question.");

    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcription failed");
    return (data.text || "").trim();
  }

  function mergeText(newText) {
    if (!newText) return;
    if (!fullTranscript) {
      fullTranscript = newText;
      return;
    }
    const a = fullTranscript.toLowerCase();
    const b = newText.toLowerCase();
    if (b.length >= a.length && (b.includes(a) || newText.length > fullTranscript.length + 8)) {
      fullTranscript = newText;
    } else if (!a.includes(b)) {
      fullTranscript = fullTranscript.trim() + " " + newText;
    }
  }

  async function streamAnswer(text) {
    els.answer.textContent = "";
    els.answer.classList.remove("empty");

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

    setStatus("processing", "Writing detailed answer…");

    const reader = res.body.getReader();
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

    return fullAnswer;
  }

  async function processSamples(chunks, sampleRate) {
    if (!chunks.length || isProcessing) return;

    const merged = mergeSamples(chunks);
    if (merged.length < MIN_SAMPLES) return;

    const wav = encodeWav(merged, sampleRate);
    if (wav.size < 3000) return;

    isProcessing = true;
    setStatus("processing", "Transcribing what interviewer said…");

    try {
      const text = await transcribeWav(wav);
      if (!text || text.length < 2) {
        setStatus("listening", "Listening… (no speech in last clip)");
        return;
      }

      mergeText(text);
      els.transcript.textContent = fullTranscript;
      els.transcript.classList.remove("empty");

      if (fullTranscript === lastAnswered) {
        setStatus("listening", "Listening for next question…");
        return;
      }

      setStatus("processing", "Generating detailed answer…");
      await streamAnswer(fullTranscript);
      lastAnswered = fullTranscript;
      setStatus("listening", "Answer ready — listening for next question");
    } catch (err) {
      console.error(err);
      setStatus("error", err.message);
      setTimeout(() => {
        if (isRunning) setStatus("listening", "Still listening…");
      }, 2500);
    } finally {
      isProcessing = false;
    }
  }

  function flushBuffer(force) {
    if (!sampleBuffer.length || !audioContext) return;
    const silentFor = Date.now() - lastSoundAt;
    if (!force && silentFor < SILENCE_MS) return;
    if (!force && lastSoundAt === 0) return;

    const chunks = sampleBuffer.slice();
    sampleBuffer = [];
    const rate = audioContext.sampleRate;
    if (!force) lastSoundAt = 0;
    processSamples(chunks, rate);
  }

  async function getAudioStream() {
    if (captureMode === "mic") {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 320, height: 240, frameRate: 1 },
      audio: true,
    });

    els.hiddenVideo.srcObject = stream;
    await els.hiddenVideo.play().catch(() => {});

    if (!stream.getAudioTracks().length) {
      throw new Error(
        captureMode === "tab"
          ? 'No audio! Pick the Meet/Zoom TAB and enable "Share tab audio".'
          : 'No audio! Pick screen and enable "Share system audio".'
      );
    }

    return stream;
  }

  async function startListening() {
    if (!serverReady) {
      alert("Add OPENAI_API_KEY first (Settings or .env file)");
      return;
    }

    displayStream = await getAudioStream();

    audioContext = new AudioContext({ sampleRate: 48000 });
    if (audioContext.state === "suspended") await audioContext.resume();

    const source = audioContext.createMediaStreamSource(displayStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    sampleBuffer = [];
    lastSoundAt = 0;
    fullTranscript = "";
    lastAnswered = "";
    els.transcript.textContent = "Listening…";
    els.transcript.classList.remove("empty");
    els.answer.textContent = "Detailed answer will appear here…";
    els.answer.classList.add("empty");

    processor.onaudioprocess = (e) => {
      if (!isRunning) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      currentRms = rms;
      sampleBuffer.push(new Float32Array(input));
      if (rms > MIN_RMS) lastSoundAt = Date.now();

      let total = 0;
      for (const c of sampleBuffer) total += c.length;
      if (total > audioContext.sampleRate * 60) flushBuffer(true);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isRunning = true;
    els.micMeter.classList.remove("hidden");
    els.startBtn.querySelector(".btn-label").textContent = "STOP";
    els.startBtn.classList.add("active");
    els.forceBtn.disabled = false;
    setStatus("listening", "Hearing interview audio — speak from Meet/Zoom");

    meterTimer = setInterval(() => updateMeter(currentRms), 100);
    flushTimer = setInterval(() => {
      if (lastSoundAt > 0 && Date.now() - lastSoundAt >= SILENCE_MS) {
        flushBuffer(false);
      }
    }, 300);
  }

  function stopListening() {
    isRunning = false;
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    flushBuffer(true);

    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (displayStream) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    }
    els.hiddenVideo.srcObject = null;
    els.micMeter.classList.add("hidden");
    els.startBtn.querySelector(".btn-label").textContent = "START — Listen & Answer";
    els.startBtn.classList.remove("active");
    els.forceBtn.disabled = true;
    setStatus("idle", "Stopped");
  }

  function openSettings() {
    applySettingsToForm();
    els.settingsOverlay.classList.remove("hidden");
  }

  function closeSettings() {
    els.settingsOverlay.classList.add("hidden");
  }

  els.modeTab.addEventListener("click", () => setMode("tab"));
  els.modeScreen.addEventListener("click", () => setMode("screen"));
  els.modeMic.addEventListener("click", () => setMode("mic"));

  els.startBtn.addEventListener("click", async () => {
    if (isRunning) { stopListening(); return; }
    try {
      await startListening();
    } catch (err) {
      alert(err.message);
      setStatus("error", err.message);
    }
  });

  els.forceBtn.addEventListener("click", () => flushBuffer(true));
  els.settingsBtn.addEventListener("click", openSettings);
  els.closeSettings.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  els.saveSettings.addEventListener("click", () => {
    saveSettingsToStorage();
    closeSettings();
    setStatus("idle", "Settings saved");
  });

  applySettingsToForm();
  checkServer();
})();
