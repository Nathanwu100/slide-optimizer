import { proposalSchema, validateProposalResponse, validateSnapshot } from "../lib/proposals.js";
import { ruleGuidanceText } from "../lib/rules.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const SLIDES_PER_BATCH = 8;
const MAX_CONCURRENT_BATCHES = 3;
const MAX_OUTPUT_TOKENS = 16_000;
const buckets = new Map();

/* Tried in order. A model the account cannot reach falls through to the next
 * rather than failing the whole run — the old hard-coded model was the reason
 * the site silently produced zero changes. */
function modelCandidates() {
  const configured = process.env.OPENAI_MODEL;
  // gpt-4.1 leads: no reasoning tokens competing for the output budget, which is
  // what truncated the old single-shot request into returning nothing.
  const defaults = ["gpt-4.1", "gpt-5.1", "gpt-4o", "gpt-4.1-mini"];
  return configured ? [configured, ...defaults.filter((name) => name !== configured)] : defaults;
}

function supportsReasoning(model) {
  return /^(o\d|gpt-5)/.test(model);
}

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
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function buildPrompt(batch) {
  return [
    "You rewrite presentation slides so a reader with ADHD can take them in at a glance.",
    "",
    "Your job is to SIMPLIFY AND SHORTEN. Be decisive. This is not a light proofread:",
    "you are producing a summarised, stripped-down version of the deck's wording.",
    "",
    "Apply these rules:",
    ruleGuidanceText(),
    "",
    "How to work:",
    "- Go through EVERY paragraph in the snapshot, slide by slide, in order.",
    "- Return a proposal for every paragraph that is longer, denser, or more abstract than it needs to be. On a typical deck that is most of the body text, not one or two lines.",
    "- Skip a paragraph only when it is already short, plain and concrete, and no emphasis would help.",
    "",
    "GIVE THE TEXT STRUCTURE. Each proposal is a list of `lines`:",
    "- A dense paragraph that contains two, three or four separate points becomes two, three or four lines — one point each. They are written back into the slide as separate bullets. This is the preferred outcome for any body paragraph longer than about 15 words.",
    "- A paragraph carrying a single point becomes one line.",
    "- A title is always exactly one line. Never split a title.",
    "- Never return more than 5 lines, and never pad: 3 sharp lines beat 5 thin ones.",
    "- Each line is one idea, about 10 words or fewer, and reads as a bullet: a phrase, not a full sentence with a trailing period where a phrase would do.",
    "- Lines in one proposal share a grammatical shape — all starting with a verb, or all noun phrases — so the eye can run down them.",
    "",
    "Hard requirements for each proposal:",
    "- `originalText` must be one complete paragraph copied EXACTLY, character for character, from a `paragraphs[].text` value in the snapshot. Do not trim, merge, or re-punctuate it.",
    "- `slide` and `objectId` must match the element that paragraph came from.",
    "- `lines[].text` is plain text. No bullet characters, no dashes at the start, no markdown, no asterisks, no numbering, no surrounding quotes — the slide adds the bullet itself.",
    "- Keep every fact, number, name, unit and citation that was in the original, spread across the lines. Never invent information. Never merge two source paragraphs into one proposal.",
    "- Keep the original language of the slide.",
    "- `lines[].emphasize` lists 0-2 short phrases copied EXACTLY from that same line's `text` (not from the original). Each must appear exactly once in that line and together stay under half of it.",
    "- Emphasise on EVERY body line that has 4 or more words. Do this regardless of what colour or style the original text is — coloured, bold and heading-styled lines need it just as much. Leave `emphasize` empty only for titles and for lines of 3 words or fewer.",
    "- `rule` is the rule number that best explains the change. Never use 7 or 11.",
    "- `explanation` is one short sentence, 12 words or fewer.",
    "",
    "Writing style for every line:",
    "- Everyday words over jargon; active voice; concrete verbs.",
    "- Drop hedges, filler and throat-clearing: 'in order to', 'it is important to note that', 'basically', 'various', 'a number of'.",
    "- Turn full sentences into scannable phrases where that keeps the meaning.",
    "- Do not repeat words the slide title already says.",
    "",
    "Return JSON matching the schema. Return an empty proposals array only if literally every paragraph is already short and plain.",
    "",
    "Presentation snapshot:",
    JSON.stringify(batch),
  ].join("\n");
}

async function callOpenAi(apiKey, model, batch) {
  const request = {
    model,
    instructions: "You return only valid JSON matching the supplied schema.",
    input: buildPrompt(batch),
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "lucid_slide_proposals",
        strict: true,
        schema: proposalSchema(),
      },
    },
  };
  if (supportsReasoning(model)) request.reasoning = { effort: "low" };

  const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await openaiResponse.json().catch(() => ({}));
  return { ok: openaiResponse.ok, status: openaiResponse.status, payload };
}

function isModelProblem(status, payload) {
  const code = payload?.error?.code || "";
  const message = String(payload?.error?.message || "");
  if (code === "model_not_found") return true;
  if (status === 404) return true;
  if (status === 400 && /model|unsupported|does not exist|not supported/i.test(message)) return true;
  return false;
}

/* Runs one batch of slides, walking the model candidates until one answers.
 * Returns { proposals, error } — a failed batch never fails the whole deck. */
async function analyzeBatch(apiKey, batch, state) {
  const candidates = state.model ? [state.model] : modelCandidates();
  let lastError = "The analysis service was unavailable.";

  for (const model of candidates) {
    const { ok, status, payload } = await callOpenAi(apiKey, model, batch);

    if (!ok) {
      if (isModelProblem(status, payload) && !state.model) {
        lastError = `Model ${model} is not available to this API key.`;
        continue;
      }
      if (status === 401) return { proposals: [], error: "The OpenAI API key was rejected. Update OPENAI_API_KEY and redeploy." };
      if (status === 429) return { proposals: [], error: "OpenAI rate or spending limit reached. Wait a moment and try again." };
      return { proposals: [], error: payload?.error?.message || `OpenAI returned ${status}.` };
    }

    // Lock the working model in so later batches skip the fallback probing.
    state.model = model;

    const text = responseOutputText(payload);
    if (!text) {
      const reason = payload?.status === "incomplete"
        ? `truncated (${payload?.incomplete_details?.reason || "length"})`
        : "empty response";
      return { proposals: [], error: `OpenAI returned no usable output: ${reason}.` };
    }
    try {
      return { proposals: JSON.parse(text)?.proposals || [], error: null };
    } catch {
      return { proposals: [], error: "OpenAI returned malformed JSON." };
    }
  }
  return { proposals: [], error: lastError };
}

function chunkSlides(snapshot) {
  const batches = [];
  for (let index = 0; index < snapshot.slides.length; index += SLIDES_PER_BATCH) {
    batches.push({ slides: snapshot.slides.slice(index, index + SLIDES_PER_BATCH) });
  }
  return batches;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export default async function handler(request, response) {
  setSecurityHeaders(response);
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed." });
  if (!allowOrigin(request)) return response.status(403).json({ error: "Origin not allowed." });
  if (request.headers["x-lucid-request"] !== "analysis-v1") {
    return response.status(400).json({ error: "Missing analysis request marker." });
  }
  if (bodySize(request) > 2_000_000) return response.status(413).json({ error: "Analysis request is too large." });
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
      error: "AI analysis is not configured. Set OPENAI_API_KEY and redeploy.",
      proposals: [],
    });
  }

  try {
    const batches = chunkSlides(snapshot);
    const state = { model: null };
    const outcomes = await runWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) => analyzeBatch(apiKey, batch, state));

    const rawProposals = outcomes.flatMap((outcome) => outcome.proposals);
    const errors = [...new Set(outcomes.map((outcome) => outcome.error).filter(Boolean))];

    // Every batch failed and nothing came back — surface the real reason.
    if (!rawProposals.length && errors.length === outcomes.length) {
      return response.status(502).json({ error: errors[0], proposals: [] });
    }

    const proposals = validateProposalResponse(snapshot, { proposals: rawProposals });
    const partial = errors.length ? ` ${errors.length} of ${batches.length} slide batches could not be analysed.` : "";

    return response.status(200).json({
      mode: "auto-simplify",
      model: state.model,
      proposals,
      message: proposals.length
        ? `${proposals.length} slide line${proposals.length === 1 ? "" : "s"} simplified.${partial}`
        : `No lines needed simplifying.${partial}`,
      warnings: errors,
    });
  } catch (error) {
    console.error("OpenAI analysis failed", error);
    return response.status(502).json({ error: `The analysis service failed: ${error.message}`, proposals: [] });
  }
}
