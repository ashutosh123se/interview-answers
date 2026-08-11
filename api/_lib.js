export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

const sessions = globalThis.__sessions || (globalThis.__sessions = new Map());

export function getSession(id) {
  return sessions.get(id) || null;
}

export function setSession(id, data) {
  sessions.set(id, { ...data, updatedAt: Date.now() });
}

export function buildChatPayload(body) {
  const question = (body.question || "").trim();
  const context = (body.context || "").trim();
  const model = (body.model || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const rawTranscript = Boolean(body.rawTranscript);

  if (!question) {
    return { error: "No question provided", status: 400 };
  }

  let systemPrompt;
  let userContent;

  if (rawTranscript) {
    systemPrompt =
      "Expert interview assistant. You receive a transcript from a live job interview.\n\n" +
      "YOUR JOB:\n" +
      "1. Identify the interviewer's question.\n" +
      "2. If unclear, reply ONLY: Still listening — no clear question yet.\n" +
      "3. If found, start with: **Question:** <question>\n" +
      "4. Then give an accurate spoken answer (4-8 sentences). Be precise.\n" +
      "5. For technical/coding questions include steps or short code.";
    userContent = `Interview transcript:\n\n${question}`;
  } else {
    systemPrompt =
      "Interview coach. Give a concise spoken answer. No filler. Start immediately.";
    userContent = question;
  }

  if (context) {
    systemPrompt += `\n\nCandidate background:\n${context}`;
  }

  return {
    payload: {
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: rawTranscript ? 600 : 350,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    },
  };
}
