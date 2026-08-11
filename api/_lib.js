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
  const detailed = Boolean(body.detailed);

  if (!question) {
    return { error: "No question provided", status: 400 };
  }

  let systemPrompt;
  let userContent;
  let maxTokens = 350;

  if (rawTranscript) {
    systemPrompt =
      "You are an expert interview coach. The candidate is in a LIVE job interview on their laptop.\n\n" +
      "You receive a transcript of what the interviewer said.\n\n" +
      "YOUR JOB:\n" +
      "1. Identify the interviewer's exact question from the transcript.\n" +
      "2. If no clear question yet, reply ONLY: Still listening — no clear question yet.\n" +
      "3. If a question is found, write:\n" +
      "   **Question:** <the question>\n\n" +
      "   **Answer to say aloud:**\n" +
      "   A detailed, accurate answer the candidate can speak (8-12 sentences).\n\n" +
      "   **Key points:**\n" +
      "   - Bullet the most important facts\n\n" +
      "   **If technical/coding:** include step-by-step approach and code if needed.\n\n" +
      "Be thorough, factual, and personalized to the candidate's background. " +
      "Do not say 'As an AI'. Write naturally.";

    if (detailed) {
      maxTokens = 1200;
    } else {
      maxTokens = 700;
    }

    userContent = `Interview audio transcript:\n\n${question}`;
  } else {
    systemPrompt = "Interview coach. Give a clear detailed answer. No filler.";
    userContent = question;
    maxTokens = 600;
  }

  if (context) {
    systemPrompt += `\n\nCandidate background:\n${context}`;
  }

  return {
    payload: {
      model,
      stream: true,
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    },
  };
}
