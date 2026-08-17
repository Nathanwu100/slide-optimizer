import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgmentRequests,
  buildMechanicalRequests,
  extractPresentationSnapshot,
  importantPhrase,
  truncateToWords,
} from "../optimizer-core.js";

function textShape(objectId, text, placeholderType = "BODY", bullet = false) {
  return {
    objectId,
    shape: {
      placeholder: { type: placeholderType },
      text: {
        textElements: [
          { startIndex: 0, endIndex: text.length + 1, paragraphMarker: bullet ? { bullet: { nestingLevel: 0 } } : {} },
          { startIndex: 0, endIndex: text.length + 1, textRun: { content: `${text}\n` } },
        ],
      },
    },
  };
}

const longBody = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen";
const presentation = {
  presentationId: "presentation_123",
  title: "Test deck",
  pageSize: {
    width: { magnitude: 9144000, unit: "EMU" },
    height: { magnitude: 5143500, unit: "EMU" },
  },
  slides: [
    {
      objectId: "slide_001",
      pageElements: [
        textShape("title_001", "Old vague title", "TITLE"),
        textShape("body_0001", longBody, "BODY", true),
        {
          objectId: "image_001",
          image: {},
          title: "decorative flourish",
          size: { width: { magnitude: 2000000 }, height: { magnitude: 1000000 } },
          transform: { scaleX: 1, scaleY: 1, translateX: 300000, translateY: 400000, unit: "EMU" },
        },
      ],
    },
  ],
};

test("word helpers cap text and selective emphasis", () => {
  assert.equal(truncateToWords(longBody), "One two three four five six seven eight nine ten eleven twelve…");
  assert.equal(importantPhrase("One two three four five six seven eight nine ten"), "One two");
});

test("mechanical rules skip title shapes and edit body text", () => {
  const result = buildMechanicalRequests(presentation);
  assert.ok(result.requests.some((request) => request.deleteText?.objectId === "body_0001"));
  assert.ok(result.requests.some((request) => request.insertText?.text.endsWith("twelve…")));
  assert.ok(!result.requests.some((request) => request.deleteText?.objectId === "title_001"));
  assert.equal(result.report[0].slide, 1);
});

test("snapshot contains only reduced slide data", () => {
  const snapshot = extractPresentationSnapshot(presentation);
  assert.equal(snapshot.slides[0].elements[0].placeholderType, "TITLE");
  assert.equal(snapshot.slides[0].elements[2].kind, "IMAGE");
  assert.equal(snapshot.slides[0].elements[2].altTextTitle, "decorative flourish");
  assert.equal("pageElements" in snapshot.slides[0], false);
});

test("judgment requests rewrite only the duplicate presentation structure", () => {
  const plan = {
    slides: [{
      slideObjectId: "slide_001",
      slideNumber: 1,
      title: { objectId: "title_001", newText: "A clear takeaway" },
      dominant: { objectId: "body_0001", phrase: "One two", fontSizePt: 32 },
      statistic: null,
      removeObjectIds: ["image_001"],
      split: null,
      chartConclusion: "",
      passesThreeSecondTest: true,
    }],
  };
  const result = buildJudgmentRequests(presentation, plan);
  assert.ok(result.requests.some((request) => request.deleteText?.objectId === "title_001"));
  assert.ok(result.requests.some((request) => request.deleteObject?.objectId === "image_001"));
  assert.ok(result.requests.some((request) => request.updateTextStyle?.style?.fontSize?.magnitude === 32));
});

test("a judgment-selected image can become dominant without changing its center", () => {
  const plan = {
    slides: [{
      slideObjectId: "slide_001",
      slideNumber: 1,
      title: null,
      dominant: { objectId: "image_001", phrase: "", fontSizePt: 30 },
      statistic: null,
      removeObjectIds: [],
      split: null,
      chartConclusion: "",
      passesThreeSecondTest: true,
    }],
  };
  const result = buildJudgmentRequests(presentation, plan);
  const transform = result.requests.find((request) => request.updatePageElementTransform)?.updatePageElementTransform.transform;
  assert.equal(transform.scaleX, 1.12);
  assert.equal(transform.translateX, 180000);
  assert.equal(transform.translateY, 340000);
});
