(function () {
  "use strict";

  const STORAGE_KEY = "interview_assistant_settings";
  const QUESTION_MARK_DELAY = 300;
  const FAST_SILENCE_MS = 500;

  const $ = (id) => document.getElementById(id);

  const els = {
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    serverBadge: $("server-badge"),
    transcript: $("transcript"),
    answer: $("answer"),
    listenBtn: $("listen-btn"),
    askBtn: $("ask-btn"),
    settingsBtn: $("settings-btn"),
    settingsOverlay: $("settings-overlay"),
    closeSettings: $("close-settings"),
    saveSettings: $("save-settings"),
    model: $("model"),
    context: $("context"),
    silenceMs: $("silence-ms"),
  };

  let settings = loadSettings();
  let serverReady = false;
  let recognition = null;
  let isListening = false;
  let isProcessing = false;
  let silenceTimer = null;
  let fullTranscript = "";
  let interimTranscript = "";
  let lastSentQuestion = "";
  let pendingQuestion = "";

  function loadSettings() {
    try {
      return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    } catch {
      return defaultSettings();
    }
  }

  function defaultSettings() {
    return {
      model: "gpt-4o-mini",
      context: "",
      silenceMs: 900,
    };
  }

  function saveSettingsToStorage() {
    settings = {
      model: els.model.value,
      context: els.context.value.trim(),
      silenceMs: Number(els.silenceMs.value) || 900,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToForm() {
    els.model.value = settings.model || "gpt-4o-mini";
    els.context.value = settings.context || "";
    els.silenceMs.value = settings.silenceMs || 900;
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
      label.textContent = "START — Hear & Answer";
      els.listenBtn.classList.remove("active");
    }
  }

  function getCombinedTranscript() {
    return (fullTranscript + " " + interimTranscript).trim();
  }

  function looksLikeQuestion(text) {
    const t = text.toLowerCase();
    if (t.includes("?")) return true;
    const cues = [
      "what ", "how ", "why ", "when ", "where ", "who ", "which ",
      "can you", "could you", "would you", "tell me", "explain",
      "describe", "walk me through", "difference between", "define ",
    ];
    return cues.some((c) => t.includes(c));
  }

  function updateTranscriptDisplay() {
    const text = getCombinedTranscript();
    if (!text) {
      els.transcript.textContent = isListening ? "Listening…" : "Waiting for speech…";
      els.transcript.classList.add("empty");
    } else {
      els.transcript.textContent = text;
      els.transcript.classList.remove("empty");
    }
    els.askBtn.disabled = !text || isProcessing || !serverReady;
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function getAutoSendDelay(hadFinal) {
    const question = getCombinedTranscript();
    if (question.endsWith("?")) return QUESTION_MARK_DELAY;
    if (hadFinal && looksLikeQuestion(question)) return FAST_SILENCE_MS;
    if (hadFinal) return Math.min(settings.silenceMs, 700);
    return settings.silenceMs;
  }

  function scheduleAutoSend(hadFinal) {
    clearSilenceTimer();
    const question = getCombinedTranscript();
    if (question.length < 6) return;

    const delay = getAutoSendDelay(hadFinal);

    silenceTimer = setTimeout(() => {
      const q = getCombinedTranscript();
      if (q.length < 6 || q === lastSentQuestion) return;

      if (isProcessing) {
        pendingQuestion = q;
        setStatus("processing", "Analyzing… (next question queued)");
        return;
      }

      sendQuestion(q);
    }, delay);
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
        els.listenBtn.disabled = true;
        return;
      }

      serverReady = true;
      setServerBadge("ready", "Ready");
      els.listenBtn.disabled = false;
      setStatus("idle", "Tap START — place phone near laptop speaker");
    } catch {
      serverReady = false;
      setServerBadge("error", "Offline");
      setStatus("error", "Cannot reach server — run start.bat on laptop");
      els.listenBtn.disabled = true;
    }
  }

  function getSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setStatus("listening", "Hearing — answer comes automatically");
    };

    rec.onresult = (event) => {
      interimTranscript = "";
      let hadFinal = false;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;

        if (result.isFinal) {
          fullTranscript = (fullTranscript + " " + text).trim();
          hadFinal = true;
        } else {
          interimTranscript = (interimTranscript + " " + text).trim();
        }
      }

      updateTranscriptDisplay();

      const combined = getCombinedTranscript();
      if (combined.endsWith("?") && combined.length >= 6 && !isProcessing) {
        scheduleAutoSend(true);
      } else if (hadFinal) {
        scheduleAutoSend(true);
      } else {
        scheduleAutoSend(false);
      }
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;

      console.warn("Speech error:", event.error);
      if (event.error === "not-allowed") {
        setStatus("error", "Microphone blocked — allow mic in browser settings");
        stopListening();
      } else if (event.error === "network") {
        setStatus("error", "Speech network error — check Wi-Fi");
      }
    };

    rec.onend = () => {
      if (isListening) {
        try {
          rec.start();
        } catch {
          stopListening();
        }
      }
    };

    return rec;
  }

  function startListening() {
    if (!serverReady) {
      alert("Server not ready. Run start.bat on your laptop and add API key to .env");
      return;
    }

    if (!getSpeechRecognition()) {
      alert(
        "Speech recognition not supported.\n\nUse Chrome on Android or Safari/Chrome on iPhone (iOS 17+)."
      );
      return;
    }

    fullTranscript = "";
    interimTranscript = "";
    lastSentQuestion = "";
    pendingQuestion = "";
    updateTranscriptDisplay();
    els.answer.textContent = "Answer will appear here automatically…";
    els.answer.classList.add("empty");

    recognition = getSpeechRecognition();
    isListening = true;
    setMainButton(true);

    try {
      recognition.start();
    } catch (err) {
      console.error(err);
      stopListening();
      setStatus("error", "Could not start microphone");
    }
  }

  function stopListening() {
    isListening = false;
    clearSilenceTimer();

    if (recognition) {
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {}
      recognition = null;
    }

    setMainButton(false);
    setStatus("idle", "Stopped — tap START when ready");
    updateTranscriptDisplay();
  }

  async function sendQuestion(question) {
    if (!question || isProcessing || !serverReady) return;
    if (question === lastSentQuestion) return;

    lastSentQuestion = question;
    isProcessing = true;
    clearSilenceTimer();
    setStatus("processing", "Analyzing — answer coming…");
    els.askBtn.disabled = true;

    els.answer.textContent = "";
    els.answer.classList.remove("empty");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          context: settings.context,
          model: settings.model,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Server error " + response.status);
      }

      setStatus("processing", "Streaming answer…");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotFirstToken = false;

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
              if (!gotFirstToken) {
                gotFirstToken = true;
                els.answer.classList.remove("empty");
                if (isListening) {
                  setStatus("listening", "Answer ready — still listening");
                }
              }
              els.answer.textContent += delta;
              els.answer.scrollTop = els.answer.scrollHeight;
            }
          } catch {}
        }
      }

      if (!els.answer.textContent.trim()) {
        els.answer.textContent = "No answer returned. Tap Send Now to retry.";
      }

      fullTranscript = "";
      interimTranscript = "";
      updateTranscriptDisplay();

      if (isListening && !gotFirstToken) {
        setStatus("listening", "Hearing — ready for next question");
      }
    } catch (err) {
      console.error(err);
      els.answer.textContent = "Error: " + err.message;
      setStatus("error", "Request failed — check laptop server");
      lastSentQuestion = "";
    } finally {
      isProcessing = false;
      updateTranscriptDisplay();

      if (pendingQuestion && pendingQuestion !== lastSentQuestion) {
        const next = pendingQuestion;
        pendingQuestion = "";
        sendQuestion(next);
      }
    }
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
    const question = getCombinedTranscript();
    if (question) {
      clearSilenceTimer();
      sendQuestion(question);
    }
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
      setStatus("listening", "Keep screen on — mic may pause in background");
    }
  });

  applySettingsToForm();
  setMainButton(false);
  checkServer();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
