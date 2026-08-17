const OBJECT_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/;

const nullable = (schema) => ({ anyOf: [{ type: "null" }, schema] });

export const OPTIMIZATION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slides: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slideObjectId: { type: "string" },
          slideNumber: { type: "integer", minimum: 1 },
          takeaway: { type: "string", maxLength: 300 },
          title: nullable({
            type: "object",
            additionalProperties: false,
            properties: {
              objectId: { type: "string" },
              newText: { type: "string", maxLength: 180 },
            },
            required: ["objectId", "newText"],
          }),
          dominant: nullable({
            type: "object",
            additionalProperties: false,
            properties: {
              objectId: { type: "string" },
              phrase: { type: "string", maxLength: 180 },
              fontSizePt: { type: "integer", minimum: 24, maximum: 44 },
            },
            required: ["objectId", "phrase", "fontSizePt"],
          }),
          statistic: nullable({
            type: "object",
            additionalProperties: false,
            properties: {
              objectId: { type: "string" },
              existingText: { type: "string", maxLength: 120 },
              replacementText: { type: "string", maxLength: 120 },
            },
            required: ["objectId", "existingText", "replacementText"],
          }),
          removeObjectIds: { type: "array", maxItems: 30, items: { type: "string" } },
          split: nullable({
            type: "object",
            additionalProperties: false,
            properties: {
              groups: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string", maxLength: 120 },
                    keepObjectIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
                  },
                  required: ["label", "keepObjectIds"],
                },
              },
            },
            required: ["groups"],
          }),
          chartConclusion: { type: "string", maxLength: 180 },
          passesThreeSecondTest: { type: "boolean" },
          manualReview: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
        },
        required: [
          "slideObjectId",
          "slideNumber",
          "takeaway",
          "title",
          "dominant",
          "statistic",
          "removeObjectIds",
          "split",
          "chartConclusion",
          "passesThreeSecondTest",
          "manualReview",
        ],
      },
    },
  },
  required: ["slides"],
};

function cleanString(value, maxLength = 300) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validObjectId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

function wordLimit(value, limit) {
  return cleanString(value, 300).split(/\s+/).filter(Boolean).slice(0, limit).join(" ");
}

function safeThumbnailUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    const trusted = host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") || host === "google.com" || host.endsWith(".google.com");
    return url.protocol === "https:" && trusted ? url.toString() : "";
  } catch {
    return "";
  }
}

export function validatePresentationInput(value) {
  const raw = value?.presentation;
  if (!raw || !Array.isArray(raw.slides) || raw.slides.length === 0 || raw.slides.length > 100) {
    throw new Error("A presentation with 1–100 slides is required.");
  }

  let totalText = 0;
  const slides = raw.slides.map((slide, index) => {
    if (!validObjectId(slide.slideObjectId)) throw new Error(`Slide ${index + 1} has an invalid object ID.`);
    if (!Array.isArray(slide.elements) || slide.elements.length > 150) throw new Error(`Slide ${index + 1} has too many elements.`);
    const elements = slide.elements.map((element) => {
      if (!validObjectId(element.objectId)) throw new Error(`Slide ${index + 1} contains an invalid element ID.`);
      const text = cleanString(element.text, 4000);
      const altTextTitle = cleanString(element.altTextTitle, 300);
      const altTextDescription = cleanString(element.altTextDescription, 1000);
      totalText += text.length + altTextTitle.length + altTextDescription.length;
      return {
        objectId: element.objectId,
        kind: cleanString(element.kind, 30),
        placeholderType: cleanString(element.placeholderType, 50),
        text,
        altTextTitle,
        altTextDescription,
        hasBullets: Boolean(element.hasBullets),
      };
    });
    return {
      slideObjectId: slide.slideObjectId,
      slideNumber: index + 1,
      thumbnailUrl: safeThumbnailUrl(slide.thumbnailUrl),
      elements,
    };
  });

  if (totalText > 300000) throw new Error("This presentation contains too much text for one optimization run.");
  return { title: cleanString(raw.title, 300), slides };
}

function containsText(element, phrase) {
  return element && cleanString(element.text, 4000).toLocaleLowerCase().includes(cleanString(phrase, 180).toLocaleLowerCase());
}

export function normalizePlan(rawPlan, presentation) {
  const proposedSlides = new Map((Array.isArray(rawPlan?.slides) ? rawPlan.slides : []).map((slide) => [slide.slideObjectId, slide]));
  return {
    slides: presentation.slides.map((slide) => {
      const proposed = proposedSlides.get(slide.slideObjectId) || {};
      const elements = new Map(slide.elements.map((element) => [element.objectId, element]));
      const titleElement = elements.get(proposed.title?.objectId);
      const title = titleElement && ["TITLE", "CENTERED_TITLE"].includes(titleElement.placeholderType)
        ? { objectId: titleElement.objectId, newText: wordLimit(proposed.title.newText, 10) }
        : null;

      const dominantElement = elements.get(proposed.dominant?.objectId);
      const dominantIsVisual = dominantElement && ["IMAGE", "SHEETS_CHART"].includes(dominantElement.kind) && !cleanString(proposed.dominant?.phrase, 180);
      const dominant = containsText(dominantElement, proposed.dominant?.phrase) || dominantIsVisual
        ? {
            objectId: dominantElement.objectId,
            phrase: cleanString(proposed.dominant.phrase, 180),
            fontSizePt: Math.max(24, Math.min(44, Number(proposed.dominant.fontSizePt) || 30)),
          }
        : null;

      const statisticElement = elements.get(proposed.statistic?.objectId);
      const statistic = containsText(statisticElement, proposed.statistic?.existingText)
        ? {
            objectId: statisticElement.objectId,
            existingText: cleanString(proposed.statistic.existingText, 120),
            replacementText: cleanString(proposed.statistic.replacementText, 120),
          }
        : null;

      const removeObjectIds = [...new Set(Array.isArray(proposed.removeObjectIds) ? proposed.removeObjectIds : [])].filter((id) => {
        const element = elements.get(id);
        return element && !element.text && ["IMAGE", "LINE", "SHAPE", "WORD_ART"].includes(element.kind) && !["TITLE", "CENTERED_TITLE"].includes(element.placeholderType);
      });

      let split = null;
      if (Array.isArray(proposed.split?.groups) && proposed.split.groups.length >= 2 && proposed.split.groups.length <= 4) {
        const groups = proposed.split.groups.map((group) => ({
          label: cleanString(group.label, 120),
          keepObjectIds: [...new Set(Array.isArray(group.keepObjectIds) ? group.keepObjectIds : [])].filter((id) => elements.has(id) && !removeObjectIds.includes(id)),
        })).filter((group) => group.keepObjectIds.length > 0);
        if (groups.length >= 2) split = { groups };
      }

      const hasChart = slide.elements.some((element) => element.kind === "SHEETS_CHART");
      return {
        slideObjectId: slide.slideObjectId,
        slideNumber: slide.slideNumber,
        takeaway: cleanString(proposed.takeaway, 300),
        title: title?.newText ? title : null,
        dominant,
        statistic: statistic?.replacementText ? statistic : null,
        removeObjectIds,
        split,
        chartConclusion: hasChart ? wordLimit(proposed.chartConclusion, 12) : "",
        passesThreeSecondTest: Boolean(proposed.passesThreeSecondTest),
        manualReview: (Array.isArray(proposed.manualReview) ? proposed.manualReview : []).map((item) => cleanString(item, 300)).filter(Boolean).slice(0, 10),
      };
    }),
  };
}
