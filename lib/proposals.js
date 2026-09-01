import { AUTOMATIC_RULES } from "./rules.js";

const MAX_SLIDES = 200;
const MAX_ELEMENTS_PER_SLIDE = 120;
const MAX_ELEMENT_TEXT = 6000;
const MAX_PARAGRAPHS_PER_ELEMENT = 300;
const MAX_PROPOSALS = 400;
const MAX_LINES = 5;
const EMPHASIS_SHARE_LIMIT = 0.6;

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function validateSnapshot(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.slides)) {
    throw new Error("A presentation snapshot is required.");
  }
  if (input.slides.length < 1 || input.slides.length > MAX_SLIDES) {
    throw new Error(`Presentation must contain between 1 and ${MAX_SLIDES} slides.`);
  }
  const slides = input.slides.map((slide) => {
    const slideNumber = Number(slide.slide);
    if (!Number.isInteger(slideNumber) || slideNumber < 1) throw new Error("Invalid slide number.");
    if (!Array.isArray(slide.elements) || slide.elements.length > MAX_ELEMENTS_PER_SLIDE) {
      throw new Error(`Slide ${slideNumber} contains too many elements.`);
    }
    return {
      slide: slideNumber,
      elements: slide.elements.map((element) => ({
        objectId: cleanString(element.objectId, 160),
        name: cleanString(element.name, 160),
        type: cleanString(element.type, 32),
        text: cleanString(element.text, MAX_ELEMENT_TEXT),
        paragraphs: Array.isArray(element.paragraphs)
          ? element.paragraphs
            .slice(0, MAX_PARAGRAPHS_PER_ELEMENT)
            .map((paragraph) => ({
              text: cleanString(paragraph.text, 1200),
              editable: paragraph.editable !== false,
            }))
            .filter((paragraph) => paragraph.text)
          : [],
      })).filter((element) => element.objectId),
    };
  });
  return { sourceHash: cleanString(input.sourceHash, 128), slides };
}

/* One proposal per paragraph, made of one or more `lines`. A single line
 * replaces the paragraph in place; several lines split it into that many
 * bullets. Each line carries its own `emphasize` phrases, so a line can be
 * shortened and have its key words bolded in one edit. */
export function proposalSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: MAX_PROPOSALS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slide", "objectId", "originalText", "lines", "rule", "explanation"],
          properties: {
            slide: { type: "integer", minimum: 1, maximum: MAX_SLIDES },
            objectId: { type: "string", minLength: 1, maxLength: 160 },
            originalText: { type: "string", minLength: 1, maxLength: 1200 },
            lines: {
              type: "array",
              minItems: 1,
              maxItems: MAX_LINES,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "emphasize"],
                properties: {
                  text: { type: "string", minLength: 1, maxLength: 600 },
                  emphasize: {
                    type: "array",
                    maxItems: 2,
                    items: { type: "string", minLength: 1, maxLength: 80 },
                  },
                },
              },
            },
            rule: { type: "integer", minimum: 1, maximum: 12 },
            explanation: { type: "string", minLength: 1, maxLength: 400 },
          },
        },
      },
    },
  };
}

/* Maps requested emphasis phrases onto character ranges inside `text`.
 * Returns [] (not null) when emphasis is absent or unusable — emphasis is a
 * bonus on top of the rewrite, so a bad phrase must never discard the rewrite. */
export function emphasisRanges(text, values) {
  if (!Array.isArray(values) || !values.length) return [];
  const found = [];
  for (const value of values) {
    const phrase = cleanString(value, 80).trim();
    if (!phrase || phrase.split(/\s+/).length > 8) continue;
    const start = text.indexOf(phrase);
    if (start < 0 || start !== text.lastIndexOf(phrase)) continue;
    found.push({ start, end: start + phrase.length, text: phrase });
  }
  found.sort((a, b) => a.start - b.start);
  const kept = [];
  for (const range of found) {
    if (kept.length && range.start < kept[kept.length - 1].end) continue;
    kept.push(range);
  }
  if (!kept.length || !text.trim().length) return [];
  const selected = kept.reduce((sum, range) => sum + range.end - range.start, 0);
  if (selected >= text.trim().length || selected / text.length > EMPHASIS_SHARE_LIMIT) return [];
  return kept;
}

export function validateProposalResponse(snapshot, input) {
  const lookup = new Map();
  for (const slide of snapshot.slides) {
    for (const element of slide.elements) lookup.set(`${slide.slide}:${element.objectId}`, element);
  }
  const incoming = Array.isArray(input?.proposals) ? input.proposals : [];
  const seen = new Set();
  const accepted = [];

  for (const proposal of incoming.slice(0, MAX_PROPOSALS)) {
    const slide = Number(proposal.slide);
    const objectId = cleanString(proposal.objectId, 160);
    const element = lookup.get(`${slide}:${objectId}`);
    const originalText = cleanString(proposal.originalText, 1200);
    const explanation = cleanString(proposal.explanation, 400).trim();
    const rule = Number(proposal.rule);
    if (!element) continue;

    const paragraph = element.paragraphs.find((candidate) => candidate.text === originalText);
    if (!paragraph || paragraph.editable === false) continue;
    if (!explanation) continue;
    if (!Number.isInteger(rule) || !AUTOMATIC_RULES.includes(rule)) continue;

    const key = `${slide}:${objectId}:${originalText}`;
    if (seen.has(key)) continue;

    const incoming = Array.isArray(proposal.lines) && proposal.lines.length
      ? proposal.lines
      : [{ text: proposal.proposedText, emphasize: proposal.emphasize }];
    const lines = incoming
      .slice(0, MAX_LINES)
      .map((line) => {
        const text = cleanString(line?.text, 600).trim();
        return text ? { text, boldRanges: emphasisRanges(text, line?.emphasize) } : null;
      })
      .filter(Boolean);
    if (!lines.length) continue;

    // Splitting a title across bullets makes no sense.
    if (element.type === "title" && lines.length > 1) lines.splice(1);

    const proposedText = lines.map((line) => line.text).join("\n");
    // A proposal that neither changes the wording nor adds emphasis is a no-op.
    if (proposedText === originalText && lines.every((line) => !line.boldRanges.length)) continue;

    seen.add(key);
    accepted.push({ slide, objectId, originalText, lines, proposedText, rule, explanation });
  }
  return accepted;
}

export { MAX_LINES, MAX_PROPOSALS, MAX_SLIDES };
