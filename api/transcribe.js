import formidable from "formidable";
import fs from "fs";
import { cors } from "./_lib.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: 25 * 1024 * 1024,
      keepExtensions: true,
    });

    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not set in Vercel environment variables" });
  }

  try {
    const { fields, files } = await parseForm(req);
    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const language = (fields.language?.[0] || fields.language || "en").trim();
    const prompt = (fields.prompt?.[0] || fields.prompt || "Job interview. Interviewer asks a question.").trim();
    const buffer = fs.readFileSync(audioFile.filepath);
    const blob = new Blob([buffer], { type: audioFile.mimetype || "audio/webm" });

    const formData = new FormData();
    formData.append("file", blob, audioFile.originalFilename || "audio.wav");
    formData.append("model", "whisper-1");
    formData.append("language", language);
    formData.append("prompt", prompt);

    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    fs.unlink(audioFile.filepath, () => {});

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({
        error: err.error?.message || `Whisper error ${upstream.status}`,
      });
    }

    const data = await upstream.json();
    return res.status(200).json({ text: (data.text || "").trim() });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Transcription failed" });
  }
}
