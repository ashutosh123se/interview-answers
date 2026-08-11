export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
      "Expert interview assistant. You receive a RAW microphone transcript captured " +
      "from a phone near a laptop during a live job interview.\n\n" +
      "YOUR JOB:\n" +
      "1. Find the interviewer's actual question in the messy text (ignore noise, " +
      "filler, duplicate words, candidate speech if mixed in).\n" +
      "2. If no real question yet, reply ONLY: Still listening — no clear question yet.\n" +
      "3. If a question is found, start with one line: **Question:** <the question>\n" +
      "4. Then give an accurate, natural spoken answer (4-7 sentences). " +
      "Be precise and factual. For coding/technical questions include key steps or short code.\n" +
      "5. Do not say 'As an AI' or add filler.";
    userContent = `Raw transcript from room audio:\n\n${question}`;
  } else {
    systemPrompt =
      "Interview coach. Reply FAST with a short spoken answer (3-5 sentences max). " +
      "Use bullets only if needed. No intro, no filler. Start with the answer immediately. " +
      "For coding: brief steps or 3-5 lines of code max.";
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
      max_tokens: rawTranscript ? 500 : 350,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    },
  };
}
