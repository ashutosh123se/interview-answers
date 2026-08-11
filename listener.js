(function () {
  "use strict";

  const CHUNK_MS = 5000;
  const MIN_BYTES = 2000;

  const $ = (id) => document.getElementById(id);
  const els = {
    badge: $("server-badge"),
    sessionId: $("session-id"),
    phoneUrl: $("phone-url"),
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    transcript: $("transcript"),
    context: $("context"),
    startBtn: $("start-btn"),
  };

  let sessionId = "";
  let mediaRecorder = null;
  let audioStream = null;
  let isRunning = false;
  let isProcessing = false;
  let fullTranscript = "";
  let lastAnswered = "";
  let chunkTimer = null;

  function setStatus(mode, text) {
    els.statusBar.className = "status " + mode;
    els.statusText.textContent = text;
  }

  async function checkServer() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      if (!data.apiConfigured) {
        els.badge.className = "badge error";
        els.badge.textContent = "No API key";
        setStatus("error", "Add OPENAI_API_KEY in Vercel or .env");
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
      body: JSON.stringify({
        context: els.context.value.trim(),
        model: "gpt-4o-mini",
      }),
    });
    const data = await res.json();
    sessionId = data.id;
    els.sessionId.textContent = sessionId;
    const url = `${location.origin}${location.pathname.replace("listener.html", "display.html")}?id=${sessionId}`;
    els.phoneUrl.textContent = url;
    await updateSession({ status: "ready" });
    setStatus("idle", "Session ready — click START and share Meet tab");
    els.startBtn.disabled = false;
  }

  async function updateSession(partial) {
    if (!sessionId) return;
    await fetch(`/api/session/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });
  }

  async function transcribe(blob) {
    const form = new FormData();
    form.append("audio", blob, "tab-audio.webm");
    form.append("language", "en");
    form.append("prompt", fullTranscript.slice(-220) || "Job interview. Interviewer asks a question.");

    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcribe failed");
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
    if (!fullTranscript) { fullTranscript = newText; return; }
    const a = fullTranscript.toLowerCase();
    const b = newText.toLowerCase();
    if (b.includes(a) || newText.length > fullTranscript.length + 5) {
      fullTranscript = newText;
    } else if (!a.includes(b)) {
      fullTranscript += " " + newText;
    }
  }

  async function processChunk(blob) {
    if (!blob || blob.size < MIN_BYTES || isProcessing) return;

    isProcessing = true;
    setStatus("processing", "Transcribing tab audio…");
    await updateSession({ status: "transcribing" });

    try {
      const text = await transcribe(blob);
      if (!text || text.length < 3) {
        setStatus("listening", "Listening to Meet tab…");
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

      setStatus("processing", "Analyzing question & answering…");
      await updateSession({ status: "answering" });

      const answer = await getAnswer(fullTranscript);
      lastAnswered = fullTranscript;

      await updateSession({ transcript: fullTranscript, answer, status: "done" });
      setStatus("listening", "Answer sent to phone — still listening");
    } catch (err) {
      console.error(err);
      setStatus("error", err.message);
      await updateSession({ status: "error" });
    } finally {
      isProcessing = false;
    }
  }

  async function captureTabAudio() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    stream.getVideoTracks().forEach((t) => t.stop());

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio captured. Check "Share tab audio" when sharing Meet/Zoom tab.');
    }

    return new MediaStream(audioTracks);
  }

  async function startListening() {
    audioStream = await captureTabAudio();

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: mime,
      audioBitsPerSecond: 128000,
    });

    let chunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      if (chunks.length) {
        const blob = new Blob(chunks, { type: mime });
        chunks = [];
        await processChunk(blob);
      }
      if (isRunning && mediaRecorder && mediaRecorder.state === "inactive") {
        try { mediaRecorder.start(); } catch {}
      }
    };

    isRunning = true;
    els.startBtn.querySelector(".btn-label").textContent = "STOP";
    els.startBtn.classList.add("active");
    setStatus("listening", "Hearing Meet tab directly — perfect audio");
    await updateSession({ status: "listening" });

    function beginChunk() {
      chunks = [];
      try {
        mediaRecorder.start();
      } catch (e) {
        console.error(e);
      }
      chunkTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, CHUNK_MS);
    }

    mediaRecorder.onstop = async () => {
      if (chunkTimer) {
        clearTimeout(chunkTimer);
        chunkTimer = null;
      }

      if (chunks.length) {
        const blob = new Blob(chunks, { type: mime });
        chunks = [];
        await processChunk(blob);
      }

      if (isRunning) beginChunk();
    };

    beginChunk();
  }

  function stopListening() {
    isRunning = false;
    if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch {}
    }
    mediaRecorder = null;
    if (audioStream) {
      audioStream.getTracks().forEach((t) => t.stop());
      audioStream = null;
    }
    els.startBtn.querySelector(".btn-label").textContent = "START — Share Meet Tab Audio";
    els.startBtn.classList.remove("active");
    setStatus("idle", "Stopped");
  }

  els.startBtn.addEventListener("click", async () => {
    if (isRunning) { stopListening(); return; }
    try {
      await startListening();
    } catch (err) {
      alert(err.message);
      setStatus("error", err.message);
    }
  });

  (async () => {
    const ok = await checkServer();
    if (ok) await createSession();
  })();
})();
