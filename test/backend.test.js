import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/analyze.js";
import { validateProposalResponse, validateSnapshot } from "../lib/proposals.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const snapshot = {
  sourceHash: "abc",
  slides: [{ slide: 1, elements: [{
    objectId: "2",
    name: "Body",
    type: "text",
    text: "Original exact text.",
    paragraphs: [{ text: "Original exact text.", safeToAutoApply: true }],
  }] }],
};

test("missing OpenAI credentials returns explicit analysis-only mode", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const request = {
    method: "POST",
    headers: { "x-lucid-request": "analysis-v1" },
    body: { presentation: snapshot },
    socket: { remoteAddress: "test-missing-key" },
  };
  const response = mockResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.mode, "analysis-only");
  assert.deepEqual(response.payload.proposals, []);
  if (previousKey) process.env.OPENAI_API_KEY = previousKey;
});

test("OpenAI structured output is validated before proposals are returned", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.reasoning.effort, "medium");
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: "completed",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: JSON.stringify({ proposals: [
                { slide: 1, objectId: "2", originalText: "Original exact text.", proposedText: "A clearer version.", rule: 3, explanation: "Improves clarity." },
                { slide: 1, objectId: "99", originalText: "Invented source", proposedText: "Invalid", rule: 3, explanation: "Invalid." },
              ], emphasis: [] }),
            }],
          }],
        };
      },
    };
  };

  try {
    const request = {
      method: "POST",
      headers: { "x-lucid-request": "analysis-v1" },
      body: { presentation: snapshot },
      socket: { remoteAddress: "test-openai-success" },
    };
    const response = mockResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.mode, "proposal-review");
    assert.equal(response.payload.applied, false);
    assert.equal(response.payload.proposals.length, 1);
    assert.match(response.payload.message, /1 AI suggestion is ready/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("cross-origin requests are rejected when no explicit origin is configured", async () => {
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  delete process.env.ALLOWED_ORIGIN;
  const request = {
    method: "POST",
    headers: {
      "x-lucid-request": "analysis-v1",
      origin: "https://untrusted.example",
      host: "slide-optimizer.vercel.app",
      "x-forwarded-proto": "https",
    },
    body: { presentation: snapshot },
    socket: { remoteAddress: "127.0.0.3" },
  };
  const response = mockResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 403);
  if (previousOrigin) process.env.ALLOWED_ORIGIN = previousOrigin;
});

test("snapshot validation strips unknown fields and caps content", () => {
  const validated = validateSnapshot({ ...snapshot, secret: "discard", slides: [{ ...snapshot.slides[0], extra: "discard" }] });
  assert.deepEqual(Object.keys(validated).sort(), ["slides", "sourceHash"]);
  assert.deepEqual(Object.keys(validated.slides[0]).sort(), ["elements", "slide"]);
});

test("server rejects model proposals for invented elements or text", () => {
  const validatedSnapshot = validateSnapshot(snapshot);
  const proposals = validateProposalResponse(validatedSnapshot, { proposals: [
    { slide: 1, objectId: "2", originalText: "Original exact text.", proposedText: "A clearer version.", rule: 3, explanation: "Meaning-based rewrite." },
    { slide: 1, objectId: "2", originalText: "Invented source", proposedText: "Invalid", rule: 3, explanation: "Invalid." },
    { slide: 1, objectId: "99", originalText: "Original exact text.", proposedText: "Invalid", rule: 3, explanation: "Invalid." },
  ] });
  assert.equal(proposals.length, 1);
});

test("server converts exact semantic emphasis phrases into validated character ranges", () => {
  const validatedSnapshot = validateSnapshot({
    ...snapshot,
    slides: [{ slide: 1, elements: [{
      ...snapshot.slides[0].elements[0],
      type: "text",
      text: "The retina processes visual information before sending signals to the brain.",
      paragraphs: [{
        text: "The retina processes visual information before sending signals to the brain.",
        safeToAutoApply: true,
        safeToEmphasize: true,
      }],
    }] }],
  });
  const proposals = validateProposalResponse(validatedSnapshot, {
    proposals: [],
    emphasis: [{
      slide: 1,
      objectId: "2",
      originalText: "The retina processes visual information before sending signals to the brain.",
      phrases: ["visual information", "the brain"],
      rule: 4,
      explanation: "Highlights the process and outcome.",
    }],
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action, "emphasize");
  assert.deepEqual(proposals[0].boldRanges, [
    { start: 21, end: 39, text: "visual information" },
    { start: 66, end: 75, text: "the brain" },
  ]);
});
