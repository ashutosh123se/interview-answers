# Interview Assistant

Phone app that hears interview questions (from your laptop speaker) and shows AI answers — fast and private.

## Setup (one time)

### 1. Run setup on your laptop

Double-click **`setup.bat`**

This installs dependencies and creates a `.env` file.

### 2. Add your OpenAI API key

Open **`.env`** in Notepad and replace the placeholder:

```
OPENAI_API_KEY=sk-your-actual-key-here
OPENAI_MODEL=gpt-4o-mini
PORT=8080
```

**Do not share your API key in chat or commit `.env` to git.**  
If you already shared it publicly, revoke it at [platform.openai.com](https://platform.openai.com/api-keys) and create a new one.

### 3. Start the server

Double-click **`start.bat`**

The terminal shows a URL like `http://192.168.1.5:8080`.

## Use during interview

1. **Laptop** — join the interview call (Meet / Zoom / Teams)
2. **Phone** — open the URL from the terminal (same Wi‑Fi)
3. Allow **microphone** when asked
4. Optional: **Settings** → add your job role & skills
5. Tap **▶ START — Hear & Answer**
6. Place phone **near laptop speaker** (30–50 cm)
7. Read answers on your phone (not on shared screen)

## How it works

```
Laptop speaker → Phone mic → Speech-to-text → Your laptop server → OpenAI → Answer on phone
```

- API key stays on your **laptop** (`.env`) — never on the phone
- **START** = hear + auto-analyze + show answer
- **Send Now** = manual trigger if auto-detect misses a question

## Speed tips

| Setting | Value |
|---------|-------|
| Model | `gpt-4o-mini` (default, fastest) |
| Auto-send silence | 500–900 ms in Settings |
| Laptop volume | Medium-high |
| Phone | Keep screen on, Chrome on Android works best |

## Files

| File | Purpose |
|------|---------|
| `start.bat` | Launch server |
| `setup.bat` | First-time setup |
| `.env` | Your API key (local only) |
| `server.py` | Server + secure OpenAI proxy |
| `index.html` / `app.js` | Phone UI |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Badge says **No API key** | Add key to `.env`, restart `start.bat` |
| Badge says **Offline** | Run `start.bat`, same Wi‑Fi on phone |
| Mic not working | Allow microphone in browser settings |
| Slow answers | Use `gpt-4o-mini`, lower silence to 600 ms |
