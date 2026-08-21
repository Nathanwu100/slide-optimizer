const MAX_SLIDES = 80;
const MAX_ELEMENTS_PER_SLIDE = 120;
const MAX_ELEMENT_TEXT = 6000;
const MAX_PARAGRAPHS_PER_ELEMENT = 300;

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
          ? element.paragraphs.slice(0, MAX_PARAGRAPHS_PER_ELEMENT).map((paragraph) => ({
            text: cleanString(paragraph.text, 1200),
            safeToAutoApply: paragraph.safeToAutoApply === true,
          })).filter((paragraph) => paragraph.text)
          : [],
      })).filter((element) => element.objectId),
    };
  });
  return { sourceHash: cleanString(input.sourceHash, 128), slides };
}

export function proposalSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slide", "objectId", "originalText", "proposedText", "rule", "explanation"],
          properties: {
            slide: { type: "integer", minimum: 1, maximum: MAX_SLIDES },
            objectId: { type: "string", minLength: 1, maxLength: 160 },
            originalText: { type: "string", minLength: 1, maxLength: 1200 },
            proposedText: { type: "string", minLength: 1, maxLength: 1200 },
            rule: { type: "integer", minimum: 1, maximum: 12 },
            explanation: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
  };
}

export function validateProposalResponse(snapshot, input) {
  const lookup = new Map();
  for (const slide of snapshot.slides) {
    for (const element of slide.elements) lookup.set(`${slide.slide}:${element.objectId}`, element);
  }
  const proposals = Array.isArray(input?.proposals) ? input.proposals : [];
  return proposals.slice(0, 200).flatMap((proposal) => {
    const slide = Number(proposal.slide);
    const objectId = cleanString(proposal.objectId, 160);
    const element = lookup.get(`${slide}:${objectId}`);
    const originalText = cleanString(proposal.originalText, 1200);
    const proposedText = cleanString(proposal.proposedText, 1200).trim();
    const explanation = cleanString(proposal.explanation, 1000).trim();
    const rule = Number(proposal.rule);
    if (!element || !originalText || !element.paragraphs.some((paragraph) => paragraph.text === originalText)) return [];
    if (!proposedText || proposedText === originalText || !explanation) return [];
    if (!Number.isInteger(rule) || rule < 1 || rule > 12) return [];
    return [{ slide, objectId, originalText, proposedText, rule, explanation }];
  });
}
