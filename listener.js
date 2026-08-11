(function () {
  "use strict";

  const SILENCE_MS = 2200;
  const MIN_RMS = 0.008;
  const MIN_SAMPLES = 16000 * 2;

  const $ = (id) => document.getElementById(id);
  const els = {
    badge: $("server-badge"),
    sessionId: $("session-id"),
    phoneUrl: $("phone-url"),
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    micMeter: $("mic-meter"),
    micLevel: $("mic-level"),
    audioHint: $("audio-hint"),
    transcript: $("transcript"),
    answer: $("answer"),
    context: $("context"),
    startBtn: $("start-btn"),
    forceBtn: $("force-btn"),
    hiddenVideo: $("hidden-video"),
    modeTab: $("mode-tab"),
    modeScreen: $("mode-screen"),
    modeMic: $("mode-mic"),
  };

  let sessionId = "";
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
      els.audioHint.textContent = "✓ Audio detected";
      els.audioHint.className = "mic-label audio-ok";
    } else {
      els.audioHint.textContent = "No audio — check share settings";
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
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      if (!data.apiConfigured) {
        els.badge.className = "badge error";
        els.badge.textContent = "No API key";
        setStatus("error", "Add OPENAI_API_KEY in Vercel Settings");
        return false;
      }
      els.badge.className = "badge ready";
      els.badge.textContent = "Ready";
      return true;
    } catch {
      els.badge.className = "badge error";
      els.badge.textContent = "Offline";
      setStatus("error", "Server not reachable");
      return false;
    }
  }

  async function createSession() {
    const res = await fetch("/api/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: els.context.value.trim(), model: "gpt-4o-mini" }),
    });
    const data = await res.json();
    sessionId = data.id;
    els.sessionId.textContent = sessionId;
    const url = `${location.origin}${location.pathname.replace("listener.html", "display.html")}?id=${sessionId}`;
    els.phoneUrl.textContent = url;
    await updateSession({ status: "ready" });
    setStatus("idle", "Click START — then share tab with audio ON");
    els.startBtn.disabled = false;
  }

  async function updateSession(partial) {
    if (!sessionId) return;
    try {
      await fetch(`/api/session/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
    } catch (e) {
      console.warn("Session sync failed", e);
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

  async function getAnswer(text) {
    const res = await fetch("/api/chat-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text,
        context: els.context.value.trim(),
        model: "gpt-4o-mini",
        rawTranscript: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Answer failed");
    return data.text || "";
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

  async function processSamples(chunks, sampleRate) {
    if (!chunks.length || isProcessing) return;

    const merged = mergeSamples(chunks);
    if (merged.length < MIN_SAMPLES) return;

    const wav = encodeWav(merged, sampleRate);
    if (wav.size < 3000) return;

    isProcessing = true;
    setStatus("processing", "Sending audio to Whisper AI…");
    await updateSession({ status: "transcribing" });

    try {
      const text = await transcribeWav(wav);
      if (!text || text.length < 2) {
        setStatus("listening", "No speech in clip — keep interview audio playing");
        return;
      }

      mergeText(text);
      els.transcript.textContent = fullTranscript;
      els.transcript.classList.remove("empty");
      await updateSession({ transcript: fullTranscript, status: "transcribed" });

      if (fullTranscript === lastAnswered) {
        setStatus("listening", "Listening — waiting for new question");
        return;
      }

      setStatus("processing", "Generating answer…");
      await updateSession({ status: "answering" });

      const answer = await getAnswer(fullTranscript);
      lastAnswered = fullTranscript;

      els.answer.textContent = answer;
      els.answer.classList.remove("empty");

      await updateSession({ transcript: fullTranscript, answer, status: "done" });
      setStatus("listening", "Answer ready — still listening");
    } catch (err) {
      console.error(err);
      setStatus("error", err.message);
      await updateSession({ status: "error" });
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

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error(
        captureMode === "tab"
          ? 'NO AUDIO! Share the Meet/Zoom TAB and check "Share tab audio".'
          : 'NO AUDIO! Share entire screen and check "Share system audio".'
      );
    }

    return new MediaStream([...audioTracks, ...stream.getVideoTracks()]);
  }

  async function startListening() {
    displayStream = await getAudioStream();

    audioContext = new AudioContext({ sampleRate: 48000 });
    if (audioContext.state === "suspended") await audioContext.resume();

    const source = audioContext.createMediaStreamSource(displayStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    sampleBuffer = [];
    lastSoundAt = 0;

    processor.onaudioprocess = (e) => {
      if (!isRunning) return;

      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      currentRms = rms;

      sampleBuffer.push(new Float32Array(input));

      if (rms > MIN_RMS) {
        lastSoundAt = Date.now();
      }

      const maxSamples = audioContext.sampleRate * 45;
      let total = 0;
      for (const c of sampleBuffer) total += c.length;
      if (total > maxSamples) {
        flushBuffer(true);
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isRunning = true;
    els.micMeter.classList.remove("hidden");
    els.startBtn.querySelector(".btn-label").textContent = "STOP";
    els.startBtn.classList.add("active");
    els.forceBtn.disabled = false;
    setStatus("listening", "Listening — audio meter should move when interviewer speaks");
    await updateSession({ status: "listening" });

    meterTimer = setInterval(() => updateMeter(currentRms), 100);

    flushTimer = setInterval(() => {
      if (lastSoundAt > 0 && Date.now() - lastSoundAt >= SILENCE_MS) {
        flushBuffer(false);
        lastSoundAt = 0;
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
    els.startBtn.querySelector(".btn-label").textContent = "START";
    els.startBtn.classList.remove("active");
    els.forceBtn.disabled = true;
    setStatus("idle", "Stopped");
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

  (async () => {
    const ok = await checkServer();
    if (ok) await createSession();
  })();
})();
