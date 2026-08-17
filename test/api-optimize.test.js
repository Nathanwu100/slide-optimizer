import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/optimize.js";

function responseRecorder() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("optimization endpoint requests non-stored structured output and revalidates IDs", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let sentBody;
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    const modelPlan = {
      slides: [{
        slideObjectId: "slide_001",
        slideNumber: 1,
        takeaway: "Focus on the result",
        title: { objectId: "title_001", newText: "The result is clear" },
        dominant: { objectId: "invented_001", phrase: "not present", fontSizePt: 44 },
        statistic: null,
        removeObjectIds: ["invented_001"],
        split: null,
        chartConclusion: "",
        passesThreeSecondTest: true,
        manualReview: ["Animations remain manual"],
      }],
    };
    return {
      ok: true,
      json: async () => ({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(modelPlan) }] }],
      }),
    };
  };

  const req = {
    method: "POST",
    headers: { "x-lucid-request": "1", "x-forwarded-for": "203.0.113.8", "content-type": "application/json" },
    body: {
      presentation: {
        title: "Deck",
        slides: [{
          slideObjectId: "slide_001",
          slideNumber: 1,
          elements: [{
            objectId: "title_001",
            kind: "PLACEHOLDER",
            placeholderType: "TITLE",
            text: "Old title",
            altTextTitle: "",
            altTextDescription: "",
            hasBullets: false,
          }],
        }],
      },
    },
  };
  const res = responseRecorder();

  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(sentBody.store, false);
  assert.equal(sentBody.text.format.type, "json_schema");
  assert.equal(sentBody.text.format.strict, true);
  assert.equal(res.body.slides[0].dominant, null);
  assert.deepEqual(res.body.slides[0].removeObjectIds, []);
  assert.equal(res.body.slides[0].title.newText, "The result is clear");
});
