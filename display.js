(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    syncBadge: $("sync-badge"),
    joinPanel: $("join-panel"),
    sessionInput: $("session-input"),
    joinBtn: $("join-btn"),
    statusBar: $("status-bar"),
    statusText: $("status-text"),
    transcript: $("transcript"),
    answer: $("answer"),
  };

  let sessionId = "";
  let pollTimer = null;
  let lastUpdate = 0;

  function setStatus(mode, text) {
    els.statusBar.className = "status " + mode;
    els.statusText.textContent = text;
  }

  function getIdFromUrl() {
    const params = new URLSearchParams(location.search);
    return (params.get("id") || "").toUpperCase();
  }

  async function pollSession() {
    if (!sessionId) return;

    try {
      const res = await fetch(`/api/session/${sessionId}`);
      if (!res.ok) {
        els.syncBadge.className = "badge error";
        els.syncBadge.textContent = "Not found";
        setStatus("error", "Session not found — check ID from laptop");
        return;
      }

      const data = await res.json();
      els.syncBadge.className = "badge ready";
      els.syncBadge.textContent = "Live";

      if (data.updatedAt && data.updatedAt !== lastUpdate) {
        lastUpdate = data.updatedAt;

        if (data.transcript) {
          els.transcript.textContent = data.transcript;
          els.transcript.classList.remove("empty");
        }

        if (data.answer) {
          els.answer.textContent = data.answer;
          els.answer.classList.remove("empty");
        }
      }

      const statusMap = {
        waiting: "Waiting for laptop to start…",
        ready: "Laptop ready — waiting for tab share",
        listening: "Laptop hearing Meet tab…",
        transcribing: "Transcribing question…",
        transcribed: "Question captured…",
        answering: "Generating answer…",
        done: "Answer ready",
        error: "Error on laptop — check listener",
      };

      setStatus(data.status === "done" ? "listening" : "idle", statusMap[data.status] || "Connected");
    } catch {
      els.syncBadge.className = "badge error";
      els.syncBadge.textContent = "Offline";
    }
  }

  function connect(id) {
    sessionId = id.toUpperCase();
    els.joinPanel.style.display = "none";
    history.replaceState(null, "", `?id=${sessionId}`);
    pollSession();
    pollTimer = setInterval(pollSession, 1000);
  }

  els.joinBtn.addEventListener("click", () => {
    const id = els.sessionInput.value.trim().toUpperCase();
    if (id.length < 4) {
      alert("Enter the session ID shown on your laptop");
      return;
    }
    connect(id);
  });

  const urlId = getIdFromUrl();
  if (urlId) {
    els.sessionInput.value = urlId;
    connect(urlId);
  }
})();
