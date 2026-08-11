# Interview Assistant

Phone app that listens to interview questions and shows AI answers in real time.

Works **locally** (laptop + phone on same Wi‑Fi) or **online** via Vercel (phone opens HTTPS URL anywhere).

## Deploy to Vercel (recommended for phone)

### 1. Push to GitHub

Already at: [github.com/ashutosh123se/interview-answers](https://github.com/ashutosh123se/interview-answers)

### 2. Import on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import **ashutosh123se/interview-answers**
3. Click **Deploy** (no build command needed)

### 3. Add environment variable on Vercel

In Vercel → Project → **Settings → Environment Variables**:

| Key | Value |
|-----|--------|
| `OPENAI_API_KEY` | Your OpenAI key (`sk-proj-...`) |
| `OPENAI_MODEL` | `gpt-4o-mini` (optional) |

Turn **Sensitive** ON. Redeploy after adding.

### 4. Open on phone

Open your Vercel URL on your phone (e.g. `https://interview-answers.vercel.app`):

- HTTPS = mic works properly on phone
- No laptop server needed
- Works on any Wi‑Fi / mobile data

---

## Local setup (alternative)

### 1. Setup

Double-click **`setup.bat`**, then add API key to **`.env`**

### 2. Run

Double-click **`start.bat`**, open the local URL on your phone (same Wi‑Fi)

---

## How to use

1. Open app on phone (Vercel URL or local URL)
2. Allow **microphone**
3. Settings → add your **job role & skills**
4. Tap **▶ START — Grab All & Answer**
5. Place phone near laptop speaker during interview
6. Read answers on phone

---

## Files

| File | Purpose |
|------|---------|
| `api/` | Vercel serverless API (chat, transcribe, health) |
| `vercel.json` | Vercel config |
| `server.py` | Local Flask server (optional) |
| `app.js` | Phone UI + continuous audio capture |

## Security

Never commit `.env`. Add `OPENAI_API_KEY` only in Vercel dashboard or local `.env`.
