import { cors, setSession } from "../_lib.js";

function makeId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const id = makeId();
  setSession(id, {
    transcript: "",
    answer: "",
    status: "waiting",
    context: (req.body?.context || "").trim(),
    model: req.body?.model || "gpt-4o-mini",
  });

  return res.status(200).json({ id });
}
