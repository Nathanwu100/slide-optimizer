import { proposalSchema, validateProposalResponse, validateSnapshot } from "../lib/proposals.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const buckets = new Map();

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function allowOrigin(request) {
  const configured = process.env.ALLOWED_ORIGIN;
  const requestOrigin = request.headers.origin;
  if (configured) return requestOrigin === configured;
  if (!requestOrigin) return true;
  const directProtocol = request.socket?.encrypted ? "https" : "http";
  const protocol = String(request.headers["x-forwarded-proto"] || directProtocol).split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return Boolean(host) && requestOrigin === `${protocol}://${host}`;
}

function rateLimited(request) {
  const now = Date.now();
  const key = String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "unknown").split(",")[0];
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

function bodySize(request) {
  if (typeof request.body === "string") return Buffer.byteLength(request.body);
  return Buffer.byteLength(JSON.stringify(request.body || {}));
}

export default async function handler(request, response) {
  setSecurityHeaders(response);
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed." });
  if (!allowOrigin(request)) return response.status(403).json({ error: "Origin not allowed." });
  if (request.headers["x-lucid-request"] !== "analysis-v1") {
    return response.status(400).json({ error: "Missing analysis request marker." });
  }
  if (bodySize(request) > 750_000) return response.status(413).json({ error: "Analysis request is too large." });
  if (rateLimited(request)) return response.status(429).json({ error: "Too many analysis requests. Try again shortly." });

  let snapshot;
  try {
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    snapshot = validateSnapshot(body?.presentation);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      mode: "analysis-only",
      proposals: [],
      message: "AI analysis is not configured. Local findings are available and the presentation remains unchanged.",
    });
  }

  const prompt = [
    "Analyze this presentation snapshot and propose optional edits; never claim an edit was applied.",
    "Every proposal must identify an existing slide and objectId and set originalText to one complete paragraph copied exactly from that element.",
    "Use semantic judgment. Do not shorten text, bold opening words, resize content, or remove elements merely because of a numeric threshold.",
    "Do not propose deleting logos, icons, diagrams, charts, tables, citations, hyperlinks, or images without clear meaning-based evidence.",
    "Focus on rules 1-6, 8-10, and 12. Rules 7 and 11 require manual animation work and must not be proposed as automatic edits.",
    "Review every slide in the snapshot, not just the first few or the ones that stand out most. Slides with three or more bullet points or dense paragraphs need special attention: if several lines on the same slide are wordy or unclear, propose an edit for each one that needs it, not just the single worst line on that slide.",
    "Return only proposals worth showing to a human for approval — it is valid to skip a slide entirely if every line on it is already clear and concise. It is valid to return an empty list.",
    "Return at most 20 proposals total. If more than 20 slide lines deserve an edit, keep the 20 most impactful ones spread across the whole deck rather than concentrating them on one or two slides.",
    "Keep each explanation to one short sentence (15 words or fewer) — this keeps the response compact and within the account's token limits.",
    "",
    'Respond with ONLY a JSON object in exactly this shape, nothing else:',
    '{"proposals":[{"slide":1,"objectId":"123","originalText":"exact original text","proposedText":"your rewrite","rule":3,"explanation":"why this helps"}]}',
    'If nothing is worth changing, respond with {"proposals":[]}',
    "",
    "Presentation snapshot:",
    JSON.stringify(snapshot),
  ].join("\n");

  // Groq enforces a tokens-per-minute cap that counts prompt tokens PLUS the
  // requested max_tokens up front (not just actual usage). A fixed max_tokens
  // can exceed that cap on larger decks, so size it dynamically against a
  // rough prompt-token estimate (~4 chars/token) instead of a flat constant.
  const TPM_BUDGET = 7500; // stays under the 8000 TPM limit seen on smaller Groq tiers, with margin
  const estimatedPromptTokens = Math.ceil(prompt.length / 4);
  const remainingCompletionTokens = TPM_BUDGET - estimatedPromptTokens;
  if (remainingCompletionTokens < 1200) {
    return response.status(413).json({
      error: "This presentation is too large for AI analysis on the current Groq plan/model. Try a smaller deck, or raise the account's token limit.",
    });
  }
  const maxCompletionTokens = Math.min(6000, remainingCompletionTokens);

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        temperature: 0.2,
        max_tokens: maxCompletionTokens,
        reasoning_effort: "low",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lucid_slide_proposals",
            strict: true,
            schema: proposalSchema(),
          },
        },
        messages: [
          {
            role: "system",
            content: "You are an assistant that returns only valid JSON matching the schema the user provides. Never include prose outside the JSON object.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    const payload = await groqResponse.json().catch(() => ({}));
    if (!groqResponse.ok) {
      console.error("Groq analysis failed", payload?.error || groqResponse.status);
      if (payload?.error?.code === "rate_limit_exceeded") {
        return response.status(429).json({
          error: "The AI analysis account hit its per-minute token limit. Wait a moment and try again, or switch GROQ_MODEL to a smaller model with a higher limit in Vercel's environment variables.",
        });
      }
      return response.status(502).json({ error: "The analysis service was unavailable." });
    }
    const text = payload?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);
    return response.status(200).json({
      mode: "proposal-review",
      proposals: validateProposalResponse(snapshot, parsed),
      applied: false,
    });
  } catch (error) {
    console.error("Groq analysis failed", error);
    return response.status(502).json({ error: "The analysis service returned an invalid response." });
  }
}
