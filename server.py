#!/usr/bin/env python3
"""Interview Assistant — local server with secure OpenAI proxy."""

import json
import os
import random
import string
import socket
import time
import webbrowser
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory

load_dotenv()

ROOT = Path(__file__).resolve().parent
PORT = int(os.getenv("PORT", "8080"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()

app = Flask(__name__, static_folder=str(ROOT))
SESSIONS = {}


def make_session_id():
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def build_chat_messages(body):
    question = (body.get("question") or "").strip()
    context = (body.get("context") or "").strip()
    model = (body.get("model") or DEFAULT_MODEL).strip()
    raw_transcript = bool(body.get("rawTranscript"))

    if not question:
        return None, None, None, "No question provided"

    if raw_transcript:
        system_prompt = (
            "Expert interview assistant. You receive a transcript from a live job interview.\n\n"
            "YOUR JOB:\n"
            "1. Identify the interviewer's question.\n"
            "2. If unclear, reply ONLY: Still listening — no clear question yet.\n"
            "3. If found, start with: **Question:** <question>\n"
            "4. Then give an accurate spoken answer (4-8 sentences). Be precise.\n"
            "5. For technical/coding questions include steps or short code."
        )
        user_content = f"Interview transcript:\n\n{question}"
        max_tokens = 600
    else:
        system_prompt = (
            "Interview coach. Give a concise spoken answer. No filler. Start immediately."
        )
        user_content = question
        max_tokens = 350

    if context:
        system_prompt += f"\n\nCandidate background:\n{context}"

    payload = {
        "model": model,
        "stream": body.get("stream", True),
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    }
    return payload, question, model, None


def local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


@app.after_request
def cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    if filename.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(ROOT, filename)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify(
        {
            "ok": True,
            "apiConfigured": bool(OPENAI_API_KEY),
            "defaultModel": DEFAULT_MODEL,
        }
    )


@app.route("/api/transcribe", methods=["POST", "OPTIONS"])
def transcribe():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY missing. Add it to .env on your laptop."}), 500

    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "No audio uploaded"}), 400

    language = (request.form.get("language") or "en").strip()
    prompt = (request.form.get("prompt") or "Job interview. Interviewer asks a question.").strip()

    try:
        upstream = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={
                "file": (
                    audio.filename or "audio.webm",
                    audio.stream,
                    audio.mimetype or "audio/webm",
                )
            },
            data={
                "model": "whisper-1",
                "language": language,
                "prompt": prompt,
            },
            timeout=45,
        )
    except requests.RequestException as exc:
        return jsonify({"error": f"Network error: {exc}"}), 502

    if upstream.status_code != 200:
        try:
            err = upstream.json()
            message = err.get("error", {}).get("message", upstream.text)
        except Exception:
            message = upstream.text or f"Whisper error {upstream.status_code}"
        return jsonify({"error": message}), upstream.status_code

    try:
        text = upstream.json().get("text", "").strip()
    except Exception:
        text = ""

    return jsonify({"text": text})


@app.route("/api/session/create", methods=["POST", "OPTIONS"])
def session_create():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    sid = make_session_id()
    SESSIONS[sid] = {
        "transcript": "",
        "answer": "",
        "status": "waiting",
        "context": (body.get("context") or "").strip(),
        "model": body.get("model") or DEFAULT_MODEL,
        "updatedAt": int(time.time() * 1000),
    }
    return jsonify({"id": sid})


@app.route("/api/session/<sid>", methods=["GET", "POST", "OPTIONS"])
def session_handler(sid):
    if request.method == "OPTIONS":
        return ("", 204)

    sid = sid.upper()

    if request.method == "GET":
        session = SESSIONS.get(sid)
        if not session:
            return jsonify({"error": "Session not found"}), 404
        return jsonify({"id": sid, **session})

    body = request.get_json(silent=True) or {}
    existing = SESSIONS.get(sid) or {
        "transcript": "",
        "answer": "",
        "status": "waiting",
        "context": "",
        "model": DEFAULT_MODEL,
    }
    SESSIONS[sid] = {
        **existing,
        "transcript": body.get("transcript", existing["transcript"]),
        "answer": body.get("answer", existing["answer"]),
        "status": body.get("status", existing["status"]),
        "context": body.get("context", existing["context"]),
        "model": body.get("model", existing["model"]),
        "updatedAt": int(time.time() * 1000),
    }
    return jsonify({"ok": True})


@app.route("/api/chat-sync", methods=["POST", "OPTIONS"])
def chat_sync():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY missing"}), 500

    body = request.get_json(silent=True) or {}
    body["stream"] = False
    payload, _, _, err = build_chat_messages(body)
    if err:
        return jsonify({"error": err}), 400

    try:
        upstream = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        return jsonify({"error": f"Network error: {exc}"}), 502

    if upstream.status_code != 200:
        try:
            err_body = upstream.json()
            message = err_body.get("error", {}).get("message", upstream.text)
        except Exception:
            message = upstream.text
        return jsonify({"error": message}), upstream.status_code

    text = upstream.json()["choices"][0]["message"]["content"]
    return jsonify({"text": text})


@app.route("/api/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY missing. Add it to .env on your laptop."}), 500

    body = request.get_json(silent=True) or {}
    payload, _, _, err = build_chat_messages(body)
    if err:
        return jsonify({"error": err}), 400

    try:
        upstream = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            stream=True,
            timeout=60,
        )
    except requests.RequestException as exc:
        return jsonify({"error": f"Network error: {exc}"}), 502

    if upstream.status_code != 200:
        try:
            err = upstream.json()
            message = err.get("error", {}).get("message", upstream.text)
        except Exception:
            message = upstream.text or f"OpenAI error {upstream.status_code}"
        return jsonify({"error": message}), upstream.status_code

    def stream():
        for line in upstream.iter_lines(decode_unicode=True):
            if line:
                yield line + "\n"
            else:
                yield "\n"

    return Response(stream(), mimetype="text/event-stream")


if __name__ == "__main__":
    ip = local_ip()
    url = f"http://{ip}:{PORT}"

    print("\n  Interview Assistant\n")
    print(f"  Laptop listener: {url}/listener.html")
    print(f"  Phone display:   {url}/display.html\n")

    if OPENAI_API_KEY:
        print("  API key: loaded from .env")
    else:
        print("  WARNING: No API key found!")
        print("  1. Copy .env.example to .env")
        print("  2. Paste your OpenAI key into .env")
        print("  3. Restart this server\n")

    print("  Keep this window open during your interview.\n")

    try:
        webbrowser.open(f"http://127.0.0.1:{PORT}")
    except Exception:
        pass

    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
