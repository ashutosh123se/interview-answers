# Interview Assistant

Laptop-only interview helper. Hears the interviewer directly from your Meet/Zoom tab and shows **detailed answers** on the same page.

## How it works

```
Meet/Zoom (Chrome) → Share tab audio → This website hears it → Whisper AI → Detailed answer on screen
```

Everything runs on your **laptop** — no phone needed.

## Setup

### Vercel (online)
1. Import [github.com/ashutosh123se/interview-answers](https://github.com/ashutosh123se/interview-answers) on [vercel.com](https://vercel.com)
2. Add env var: `OPENAI_API_KEY=sk-...`
3. Open your Vercel URL

### Local
1. Run `setup.bat`, add API key to `.env`
2. Run `start.bat`
3. Open `http://localhost:8080`

## During interview

1. Join Meet/Zoom in **Chrome** (browser tab)
2. Open this app in another Chrome tab/window
3. Settings → add your job role, skills, projects
4. Click **START — Listen & Answer**
5. Select your **Meet/Zoom tab** → check **"Share tab audio"**
6. Audio meter should move when interviewer speaks
7. Read **detailed answers** on the same page

## Audio modes

| Mode | Use when |
|------|----------|
| Meet/Zoom Tab | Interview in Chrome tab (recommended) |
| Entire Screen | Zoom desktop app — share screen + system audio |
| Laptop Mic | Fallback — uses laptop microphone |

## Tips

- Use **Chrome** only
- Keep **tab audio** sharing ON
- Watch the **audio meter** — must move when interviewer speaks
- Use **Process Now** if auto-detect misses a question
- Fill in **background** in Settings for personalized answers
