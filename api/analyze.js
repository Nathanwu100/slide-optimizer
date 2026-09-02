import { proposalSchema, validateProposalResponse, validateSnapshot } from "../lib/proposals.js";
import { ruleGuidanceText } from "../lib/rules.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
// 8 slides a batch keeps the request count — and therefore the bill — where it
// was. A batch that truncates is halved and retried (analyzeBatchDeep), so a
// lost batch no longer needs to be prevented by paying for small ones upfront.
const SLIDES_PER_BATCH = 8;
const MAX_CONCURRENT_BATCHES = 3;
const MAX_OUTPUT_TOKENS = 16_000;
// A line this short carries no filler worth cutting and no room for emphasis.
const MIN_WORDS_TO_EDIT = 4;
// The second pass costs extra requests, so it only runs when the first pass
// actually left a meaningful number of lines behind — not for one stray line.
const RETRY_WHEN_MISSING_ABOVE = 0.08;
// Missing paragraphs are packed densely: only the skipped lines travel, so one
// request usually covers the whole deck's leftovers.
const SLIDES_PER_RETRY_BATCH = 40;
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

function buildPrompt(batch, retry = false) {
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
    `- Return a proposal for EVERY paragraph of ${MIN_WORDS_TO_EDIT} words or more. Not most of them — all of them. A deck with 60 such paragraphs gets 60 proposals.`,
    "- A paragraph whose wording is already tight still gets a proposal: return its text as one line, essentially unchanged, with its key phrase in `emphasize`. Coverage matters more than restraint.",
    "- Short sub-bullets of the form 'Term: definition' count. Tighten the definition and emphasise the term.",
    `- Only paragraphs of ${MIN_WORDS_TO_EDIT - 1} words or fewer may be left out.`,
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
    "- `explanation` is a fragment of 8 words or fewer, e.g. 'cuts filler' or 'splits two ideas'. Never a full sentence.",
    "",
    "Writing style for every line:",
    "- Everyday words over jargon; active voice; concrete verbs.",
    "- Drop hedges, filler and throat-clearing: 'in order to', 'it is important to note that', 'basically', 'various', 'a number of'.",
    "- Turn full sentences into scannable phrases where that keeps the meaning.",
    "- Do not repeat words the slide title already says.",
    "",
    retry
      ? "THIS IS A SECOND PASS. Every paragraph below was missed on the first pass. Return a proposal for each one — no exceptions, no empty array."
      : "Return JSON matching the schema. An empty proposals array is almost always wrong.",
    "",
    "Presentation snapshot:",
    JSON.stringify(batch),
  ].join("\n");
}

async function callOpenAi(apiKey, model, batch, retry) {
  const request = {
    model,
    instructions: "You return only valid JSON matching the supplied schema.",
    input: buildPrompt(batch, retry),
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
 * Returns { proposals, error, truncated } — a failed batch never fails the deck. */
async function analyzeBatch(apiKey, batch, state, retry = false) {
  const candidates = state.model ? [state.model] : modelCandidates();
  let lastError = "The analysis service was unavailable.";

  for (const model of candidates) {
    const { ok, status, payload } = await callOpenAi(apiKey, model, batch, retry);

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
      const truncated = payload?.status === "incomplete";
      const reason = truncated ? `truncated (${payload?.incomplete_details?.reason || "length"})` : "empty response";
      return { proposals: [], error: `OpenAI returned no usable output: ${reason}.`, truncated };
    }
    try {
      return { proposals: JSON.parse(text)?.proposals || [], error: null };
    } catch {
      // A cut-off JSON body is a truncation in disguise.
      return { proposals: [], error: "OpenAI returned malformed JSON.", truncated: true };
    }
  }
  return { proposals: [], error: lastError };
}

/* A batch whose answer did not fit is halved and retried rather than dropped.
 * Losing a whole batch is what left entire stretches of a deck untouched. */
async function analyzeBatchDeep(apiKey, batch, state, retry = false) {
  const outcome = await analyzeBatch(apiKey, batch, state, retry);
  if (!outcome.truncated || batch.slides.length < 2) return outcome;

  const middle = Math.ceil(batch.slides.length / 2);
  const halves = [
    { slides: batch.slides.slice(0, middle) },
    { slides: batch.slides.slice(middle) },
  ];
  const results = [];
  for (const half of halves) results.push(await analyzeBatchDeep(apiKey, half, state, retry));
  const proposals = results.flatMap((result) => result.proposals);
  const errors = results.map((result) => result.error).filter(Boolean);
  return { proposals, error: proposals.length ? null : errors[0] || outcome.error };
}

function chunkSlides(slides, size) {
  const batches = [];
  for (let index = 0; index < slides.length; index += size) {
    batches.push({ slides: slides.slice(index, index + size) });
  }
  return batches;
}

function paragraphKey(slide, objectId, text) {
  return `${slide} ${objectId} ${text}`;
}

function countEditableParagraphs(snapshot) {
  let total = 0;
  for (const slide of snapshot.slides) {
    for (const element of slide.elements) {
      for (const paragraph of element.paragraphs) {
        if (paragraph.text.trim().split(/\s+/).length >= MIN_WORDS_TO_EDIT) total += 1;
      }
    }
  }
  return total;
}

/* Rebuilds a snapshot containing only the paragraphs no proposal came back for,
 * so the second pass sees a short, unambiguous list instead of the whole deck. */
function snapshotOfMissing(snapshot, covered) {
  const slides = [];
  for (const slide of snapshot.slides) {
    const elements = [];
    for (const element of slide.elements) {
      const paragraphs = element.paragraphs.filter((paragraph) =>
        paragraph.text.trim().split(/\s+/).length >= MIN_WORDS_TO_EDIT
        && !covered.has(paragraphKey(slide.slide, element.objectId, paragraph.text)));
      if (paragraphs.length) {
        elements.push({
          objectId: element.objectId,
          name: element.name,
          type: element.type,
          text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
          paragraphs,
        });
      }
    }
    if (elements.length) slides.push({ slide: slide.slide, elements });
  }
  return slides;
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
    const state = { model: null };
    const batches = chunkSlides(snapshot.slides, SLIDES_PER_BATCH);
    const outcomes = await runWithConcurrency(
      batches,
      MAX_CONCURRENT_BATCHES,
      (batch) => analyzeBatchDeep(apiKey, batch, state),
    );

    let rawProposals = outcomes.flatMap((outcome) => outcome.proposals);
    const errors = [...new Set(outcomes.map((outcome) => outcome.error).filter(Boolean))];

    // Every batch failed and nothing came back — surface the real reason.
    if (!rawProposals.length && errors.length === outcomes.length) {
      return response.status(502).json({ error: errors[0], proposals: [] });
    }

    // Second pass: anything the first pass walked past gets asked for again, on
    // its own, with an instruction that leaves no room to skip it. Without this,
    // a model that decides a line is "already fine" leaves it untouched forever.
    const covered = new Set(rawProposals.map((proposal) =>
      paragraphKey(Number(proposal.slide), String(proposal.objectId || ""), String(proposal.originalText || ""))));
    const editable = countEditableParagraphs(snapshot);
    const missingSlides = snapshotOfMissing(snapshot, covered);
    const missingCount = missingSlides.reduce(
      (sum, slide) => sum + slide.elements.reduce((count, element) => count + element.paragraphs.length, 0),
      0,
    );
    // Only worth another request when a real chunk of the deck was skipped.
    if (missingCount && editable && missingCount / editable > RETRY_WHEN_MISSING_ABOVE) {
      const retryBatches = chunkSlides(missingSlides, SLIDES_PER_RETRY_BATCH);
      const retryOutcomes = await runWithConcurrency(
        retryBatches,
        MAX_CONCURRENT_BATCHES,
        (batch) => analyzeBatchDeep(apiKey, batch, state, true),
      );
      rawProposals = rawProposals.concat(retryOutcomes.flatMap((outcome) => outcome.proposals));
    }

    const proposals = validateProposalResponse(snapshot, { proposals: rawProposals });
    const uncovered = Math.max(0, editable - proposals.length);
    const partial = errors.length ? ` ${errors.length} of ${batches.length} slide batches failed.` : "";
    const gap = uncovered ? ` ${uncovered} line${uncovered === 1 ? "" : "s"} were left as they were.` : "";

    return response.status(200).json({
      mode: "auto-simplify",
      model: state.model,
      proposals,
      coverage: { editableParagraphs: editable, simplified: proposals.length },
      message: proposals.length
        ? `${proposals.length} of ${editable} slide lines simplified.${gap}${partial}`
        : `No lines could be simplified.${partial}`,
      warnings: errors,
    });
  } catch (error) {
    console.error("OpenAI analysis failed", error);
    return response.status(502).json({ error: `The analysis service failed: ${error.message}`, proposals: [] });
  }
}
