#!/usr/bin/env python3
"""Interview Assistant — local server with secure OpenAI proxy."""

import json
import os
import socket
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


@app.route("/api/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return ("", 204)

    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY missing. Add it to .env on your laptop."}), 500

    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    context = (body.get("context") or "").strip()
    model = (body.get("model") or DEFAULT_MODEL).strip()

    if not question:
        return jsonify({"error": "No question provided"}), 400

    system_prompt = (
        "Interview coach. Reply FAST with a short spoken answer (3-5 sentences max). "
        "Use bullets only if needed. No intro, no filler. Start with the answer immediately. "
        "For coding: brief steps or 3-5 lines of code max."
    )
    if context:
        system_prompt += f"\n\nCandidate:\n{context}"

    payload = {
        "model": model,
        "stream": True,
        "temperature": 0.2,
        "max_tokens": 350,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ],
    }

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
    print(f"  Phone URL (same Wi-Fi): {url}\n")

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
