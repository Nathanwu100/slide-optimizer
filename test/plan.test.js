import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan, validatePresentationInput } from "../lib/plan.js";

const requestBody = {
  presentation: {
    title: "Example",
    slides: [{
      slideObjectId: "slide_001",
      slideNumber: 1,
      elements: [
        { objectId: "title_001", kind: "PLACEHOLDER", placeholderType: "TITLE", text: "Old title", hasBullets: false },
        { objectId: "body_0001", kind: "PLACEHOLDER", placeholderType: "BODY", text: "Revenue increased by 34% this year", hasBullets: true },
        { objectId: "image_001", kind: "IMAGE", placeholderType: "", text: "", altTextTitle: "decoration", hasBullets: false },
      ],
    }],
  },
};

test("input validation strips unknown fields and preserves valid IDs", () => {
  const value = validatePresentationInput(requestBody);
  assert.equal(value.slides[0].slideObjectId, "slide_001");
  assert.equal(value.slides[0].elements[0].text, "Old title");
});

test("plan normalization rejects invented IDs and caps titles", () => {
  const presentation = validatePresentationInput(requestBody);
  const plan = normalizePlan({
    slides: [{
      slideObjectId: "slide_001",
      title: { objectId: "title_001", newText: "One two three four five six seven eight nine ten eleven twelve" },
      dominant: { objectId: "made_up", phrase: "fake", fontSizePt: 99 },
      statistic: { objectId: "body_0001", existingText: "34%", replacementText: "+34% year-over-year revenue" },
      removeObjectIds: ["image_001", "made_up"],
      split: null,
      chartConclusion: "Unsupported chart conclusion",
      passesThreeSecondTest: false,
      manualReview: ["Check the pacing"],
    }],
  }, presentation);

  assert.equal(plan.slides[0].title.newText.split(/\s+/).length, 10);
  assert.equal(plan.slides[0].dominant, null);
  assert.equal(plan.slides[0].statistic.existingText, "34%");
  assert.deepEqual(plan.slides[0].removeObjectIds, ["image_001"]);
  assert.equal(plan.slides[0].chartConclusion, "");
});

test("invalid presentation IDs are rejected", () => {
  const invalid = structuredClone(requestBody);
  invalid.presentation.slides[0].slideObjectId = "bad";
  assert.throws(() => validatePresentationInput(invalid), /invalid object ID/);
});

test("thumbnail URLs are restricted to Google-owned HTTPS hosts", () => {
  const safe = structuredClone(requestBody);
  safe.presentation.slides[0].thumbnailUrl = "https://lh3.googleusercontent.com/example";
  assert.equal(validatePresentationInput(safe).slides[0].thumbnailUrl, "https://lh3.googleusercontent.com/example");

  const unsafe = structuredClone(requestBody);
  unsafe.presentation.slides[0].thumbnailUrl = "https://example.com/private-slide.png";
  assert.equal(validatePresentationInput(unsafe).slides[0].thumbnailUrl, "");
});
