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
 
function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
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
 
  const apiKey = process.env.OPENAI_API_KEY;
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
    "Use semantic judgment. Do not shorten text, emphasize opening words, resize content, or remove elements merely because of a numeric threshold.",
    "Prioritize meaningful improvements to clarity, grammar, concision, and slide-level takeaways. Ignore trailing spaces, dash styles, and other whitespace-, punctuation-, or typography-only changes.",
    "When you do rewrite a line, keep its original punctuation style intact — do not remove or change em dashes, en dashes, or hyphens, and do not swap them for commas or periods. Only change wording, never punctuation choices.",
    "Never change or remove font, color, size, or any other formatting when proposing a rewrite — proposedText carries only the new wording.",
    "Use proposals for wording changes. Use emphasis for meaning-based bold emphasis without changing any words.",
    "For emphasis, choose one to three exact, short phrases copied from a safeToEmphasize paragraph. Prefer key concepts, contrasts, outcomes, or actions that make the slide easier to scan.",
    "Never emphasize a title, an entire sentence, more than 40% of a paragraph, a repeated phrase, or merely the first words. Do not return both a rewrite and emphasis for the same paragraph.",
    "Do not propose deleting logos, icons, diagrams, charts, tables, citations, hyperlinks, or images without clear meaning-based evidence.",
    "Focus on rules 1-6, 8-10, and 12. Rules 7 and 11 require manual animation work and must not be proposed as automatic edits.",
    "Review every slide in the snapshot, not just the first few or the ones that stand out most. Slides with three or more bullet points or dense paragraphs need special attention: if several lines on the same slide are wordy or unclear, propose an edit for each one that needs it, not just the single worst line on that slide.",
    "Work in two passes: first inspect every paragraph for objective or meaning-based issues, then select the most useful changes across the whole deck.",
    "Return only proposals worth showing to a human for approval. Skip clear slides, but return an empty list only after checking every paragraph and finding no meaningful clarity, grammar, concision, or takeaway improvement.",
    "Return at most 20 combined wording and emphasis suggestions. If more than 20 slide lines deserve an edit, keep the 20 most impactful ones spread across the whole deck rather than concentrating them on one or two slides.",
    "Keep each explanation to one short sentence (15 words or fewer) — this keeps the response compact and within the account's token limits.",
    "",
    "Presentation snapshot:",
    JSON.stringify(snapshot),
  ].join("\n");
 
  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
        instructions: "You return only valid JSON matching the supplied schema. Never claim that a proposed edit was applied.",
        input: prompt,
        reasoning: { effort: "medium" },
        max_output_tokens: 6000,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "lucid_slide_proposals",
            strict: true,
            schema: proposalSchema(),
          },
        },
      }),
    });
    const payload = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      console.error("OpenAI analysis failed", payload?.error || openaiResponse.status);
      if (openaiResponse.status === 429 || payload?.error?.code === "rate_limit_exceeded") {
        return response.status(429).json({
          error: "The AI analysis account reached its current rate or spending limit. Wait a moment, then check OpenAI usage and billing if the problem continues.",
        });
      }
      if (openaiResponse.status === 401) {
        return response.status(503).json({ error: "The OpenAI API key was rejected. Update OPENAI_API_KEY in Vercel and redeploy." });
      }
      return response.status(502).json({ error: "The analysis service was unavailable." });
    }
    if (payload?.status === "incomplete") {
      console.error("OpenAI analysis incomplete", payload?.incomplete_details || payload?.status);
      return response.status(502).json({ error: "The analysis service could not finish reviewing this presentation." });
    }
    const text = responseOutputText(payload);
    if (!text) throw new Error("OpenAI returned no output text.");
    const parsed = JSON.parse(text);
    const proposals = validateProposalResponse(snapshot, parsed);
    return response.status(200).json({
      mode: "proposal-review",
      proposals,
      applied: false,
      message: proposals.length
        ? `${proposals.length} AI suggestion${proposals.length === 1 ? " is" : "s are"} ready for review. Nothing has been applied.`
        : "AI analysis completed, but it did not identify any meaningful suggestions for this presentation. Nothing was changed.",
    });
  } catch (error) {
    console.error("OpenAI analysis failed", error);
    return response.status(502).json({ error: "The analysis service returned an invalid response." });
  }
}
