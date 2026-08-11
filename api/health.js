import { cors } from "./_lib.js";

export default function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    ok: true,
    apiConfigured: Boolean(process.env.OPENAI_API_KEY),
    defaultModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  });
}
