import { cors, getSession, setSession } from "../_lib.js";

export default function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  const id = (req.query.id || "").toString().toUpperCase();
  if (!id) return res.status(400).json({ error: "Session ID required" });

  if (req.method === "GET") {
    const session = getSession(id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    return res.status(200).json({ id, ...session });
  }

  if (req.method === "POST") {
    const existing = getSession(id) || {
      transcript: "",
      answer: "",
      status: "waiting",
      context: "",
      model: "gpt-4o-mini",
    };

    const body = req.body || {};
    setSession(id, {
      ...existing,
      transcript: body.transcript ?? existing.transcript,
      answer: body.answer ?? existing.answer,
      status: body.status ?? existing.status,
      context: body.context ?? existing.context,
      model: body.model ?? existing.model,
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
