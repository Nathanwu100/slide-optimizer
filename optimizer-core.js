export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const MAX_WORDS = 12;

const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

export function truncateToWords(text, limit = MAX_WORDS) {
  const list = words(text);
  if (list.length <= limit) return String(text || "").trim();
  return `${list.slice(0, limit).join(" ")}…`;
}

export function importantPhrase(text) {
  const list = words(text.replace(/…$/, ""));
  if (list.length < 3) return "";
  const count = Math.max(1, Math.min(4, Math.floor(list.length * 0.2)));
  return list.slice(0, count).join(" ");
}

export function elementKind(element) {
  if (element.shape) return element.shape.placeholder?.type ? "PLACEHOLDER" : "SHAPE";
  if (element.image) return "IMAGE";
  if (element.sheetsChart) return "SHEETS_CHART";
  if (element.table) return "TABLE";
  if (element.line) return "LINE";
  if (element.video) return "VIDEO";
  if (element.wordArt) return "WORD_ART";
  if (element.elementGroup) return "GROUP";
  return "OTHER";
}

export function shapeText(element) {
  const textElements = element.shape?.text?.textElements || [];
  return textElements.map((item) => item.textRun?.content || item.autoText?.content || "").join("");
}

function paragraphRecords(element) {
  const textElements = element.shape?.text?.textElements || [];
  const markers = textElements.filter((item) => item.paragraphMarker);
  return markers.map((marker) => {
    const startIndex = Number(marker.startIndex || 0);
    const endIndex = Number(marker.endIndex || startIndex);
    const text = textElements
      .filter((item) => item.textRun && Number(item.endIndex || 0) > startIndex && Number(item.startIndex || 0) < endIndex)
      .map((item) => item.textRun.content || "")
      .join("")
      .replace(/\n$/, "");
    return {
      startIndex,
      endIndex: Math.max(startIndex, endIndex - 1),
      text,
      bullet: Boolean(marker.paragraphMarker?.bullet),
    };
  });
}

function isTitleElement(element) {
  return TITLE_PLACEHOLDERS.has(element.shape?.placeholder?.type || "");
}

function slideElementSummary(element) {
  const text = shapeText(element).trim();
  return {
    objectId: element.objectId,
    kind: elementKind(element),
    placeholderType: element.shape?.placeholder?.type || "",
    text: text.slice(0, 4000),
    altTextTitle: String(element.title || "").slice(0, 300),
    altTextDescription: String(element.description || "").slice(0, 1000),
    hasBullets: paragraphRecords(element).some((paragraph) => paragraph.bullet),
  };
}

export function extractPresentationSnapshot(presentation, thumbnailUrls = new Map()) {
  let remainingCharacters = 300000;
  const slides = (presentation.slides || []).slice(0, 100).map((slide, index) => ({
    slideObjectId: slide.objectId,
    slideNumber: index + 1,
    thumbnailUrl: thumbnailUrls.get(slide.objectId) || "",
    elements: (slide.pageElements || []).slice(0, 150).map(slideElementSummary),
  }));
  for (const slide of slides) {
    for (const element of slide.elements) {
      for (const field of ["text", "altTextTitle", "altTextDescription"]) {
        element[field] = element[field].slice(0, Math.max(0, remainingCharacters));
        remainingCharacters -= element[field].length;
      }
    }
  }
  return {
    presentationId: presentation.presentationId,
    title: String(presentation.title || "").slice(0, 300),
    pageSize: presentation.pageSize || null,
    slides,
  };
}

export function buildMechanicalRequests(presentation) {
  const edits = [];
  const report = [];

  for (const [slideIndex, slide] of (presentation.slides || []).entries()) {
    let trimmed = 0;
    let emphasized = 0;
    for (const element of slide.pageElements || []) {
      if (!element.shape?.text || isTitleElement(element)) continue;
      for (const paragraph of paragraphRecords(element)) {
        const original = paragraph.text.trim();
        if (!original || paragraph.endIndex <= paragraph.startIndex) continue;
        const replacement = truncateToWords(original);
        const phrase = importantPhrase(replacement);
        edits.push({
          objectId: element.objectId,
          startIndex: paragraph.startIndex,
          endIndex: paragraph.endIndex,
          original,
          replacement,
          phrase,
        });
        if (replacement !== original) trimmed += 1;
        if (phrase) emphasized += 1;
      }
    }

    if (trimmed || emphasized) {
      report.push({
        slide: slideIndex + 1,
        message: `Mechanically shortened ${trimmed} text block${trimmed === 1 ? "" : "s"} and focused ${emphasized} key statement${emphasized === 1 ? "" : "s"}.`,
      });
    }
  }

  edits.sort((a, b) => a.objectId.localeCompare(b.objectId) || b.startIndex - a.startIndex);
  const requests = [];
  for (const edit of edits) {
    if (edit.replacement !== edit.original) {
      requests.push({
        deleteText: {
          objectId: edit.objectId,
          textRange: { type: "FIXED_RANGE", startIndex: edit.startIndex, endIndex: edit.endIndex },
        },
      });
      requests.push({
        insertText: { objectId: edit.objectId, insertionIndex: edit.startIndex, text: edit.replacement },
      });
    }

    const visibleText = edit.replacement;
    requests.push({
      updateTextStyle: {
        objectId: edit.objectId,
        textRange: {
          type: "FIXED_RANGE",
          startIndex: edit.startIndex,
          endIndex: edit.startIndex + visibleText.length,
        },
        style: { bold: false },
        fields: "bold",
      },
    });
    if (edit.phrase) {
      requests.push({
        updateTextStyle: {
          objectId: edit.objectId,
          textRange: {
            type: "FIXED_RANGE",
            startIndex: edit.startIndex,
            endIndex: edit.startIndex + edit.phrase.length,
          },
          style: { bold: true },
          fields: "bold",
        },
      });
    }
  }

  return { requests, report };
}

function safeObjectId(prefix = "lucid") {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${random}`.slice(0, 45);
}

function getSlideLookup(presentation) {
  const map = new Map();
  for (const slide of presentation.slides || []) {
    map.set(slide.objectId, {
      slide,
      elements: new Map((slide.pageElements || []).map((element) => [element.objectId, element])),
    });
  }
  return map;
}

function textRangeForPhrase(element, phrase) {
  const fullText = shapeText(element);
  const index = fullText.toLocaleLowerCase().indexOf(String(phrase || "").toLocaleLowerCase());
  if (index < 0 || !phrase) return null;
  return { startIndex: index, endIndex: index + phrase.length };
}

function pageMagnitude(pageSize, axis, fallback) {
  const value = Number(pageSize?.[axis]?.magnitude);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function buildJudgmentRequests(presentation, plan) {
  const lookup = getSlideLookup(presentation);
  const requests = [];
  const report = [];
  const pageWidth = pageMagnitude(presentation.pageSize, "width", 9144000);
  const pageHeight = pageMagnitude(presentation.pageSize, "height", 5143500);

  for (const decision of plan.slides || []) {
    const current = lookup.get(decision.slideObjectId);
    if (!current) continue;
    const { slide, elements } = current;
    const removed = new Set();
    const forcedKeep = new Set();
    const replacementTextById = new Map();

    if (decision.title?.objectId && decision.title.newText) {
      const titleElement = elements.get(decision.title.objectId);
      if (titleElement?.shape?.text) {
        const newText = truncateToWords(decision.chartConclusion || decision.title.newText, 10);
        requests.push({ deleteText: { objectId: titleElement.objectId, textRange: { type: "ALL" } } });
        requests.push({ insertText: { objectId: titleElement.objectId, insertionIndex: 0, text: newText } });
        replacementTextById.set(titleElement.objectId, newText);
        forcedKeep.add(titleElement.objectId);
        report.push({ slide: decision.slideNumber, message: `Rewrote the title as “${newText}”.` });
      }
    }

    if (decision.statistic?.objectId && decision.statistic.replacementText) {
      const statElement = elements.get(decision.statistic.objectId);
      if (statElement?.shape?.text && statElement.objectId !== decision.title?.objectId) {
        const range = textRangeForPhrase(statElement, decision.statistic.existingText);
        if (range) {
          const replacement = String(decision.statistic.replacementText).slice(0, 120);
          requests.push({
            deleteText: { objectId: statElement.objectId, textRange: { type: "FIXED_RANGE", ...range } },
          });
          requests.push({ insertText: { objectId: statElement.objectId, insertionIndex: range.startIndex, text: replacement } });
          requests.push({
            updateTextStyle: {
              objectId: statElement.objectId,
              textRange: { type: "FIXED_RANGE", startIndex: range.startIndex, endIndex: range.startIndex + replacement.length },
              style: { bold: true, fontSize: { magnitude: 30, unit: "PT" } },
              fields: "bold,fontSize",
            },
          });
          replacementTextById.set(statElement.objectId, shapeText(statElement).replace(decision.statistic.existingText, replacement));
          report.push({ slide: decision.slideNumber, message: `Added context to the key statistic: “${replacement}”.` });
        }
      }
    }

    let chartHeadlineId = "";
    if (decision.chartConclusion && !decision.title?.objectId) {
      chartHeadlineId = safeObjectId("lucid_chart_title");
      requests.push({
        createShape: {
          objectId: chartHeadlineId,
          shapeType: "TEXT_BOX",
          elementProperties: {
            pageObjectId: slide.objectId,
            size: {
              width: { magnitude: pageWidth * 0.8, unit: "EMU" },
              height: { magnitude: pageHeight * 0.12, unit: "EMU" },
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: pageWidth * 0.1,
              translateY: pageHeight * 0.04,
              unit: "EMU",
            },
          },
        },
      });
      requests.push({ insertText: { objectId: chartHeadlineId, insertionIndex: 0, text: decision.chartConclusion } });
      requests.push({
        updateTextStyle: {
          objectId: chartHeadlineId,
          textRange: { type: "ALL" },
          style: { bold: true, fontSize: { magnitude: 24, unit: "PT" } },
          fields: "bold,fontSize",
        },
      });
      forcedKeep.add(chartHeadlineId);
      report.push({ slide: decision.slideNumber, message: "Added a conclusion headline for the chart." });
    }

    if (decision.dominant?.objectId && decision.dominant.phrase) {
      const dominantElement = elements.get(decision.dominant.objectId);
      if (dominantElement?.shape?.text) {
        const effectiveText = replacementTextById.get(dominantElement.objectId) || shapeText(dominantElement);
        const index = effectiveText.toLocaleLowerCase().indexOf(decision.dominant.phrase.toLocaleLowerCase());
        if (index >= 0) {
          requests.push({
            updateTextStyle: {
              objectId: dominantElement.objectId,
              textRange: { type: "FIXED_RANGE", startIndex: index, endIndex: index + decision.dominant.phrase.length },
              style: {
                bold: true,
                fontSize: { magnitude: Math.max(24, Math.min(44, Number(decision.dominant.fontSizePt) || 30)), unit: "PT" },
              },
              fields: "bold,fontSize",
            },
          });
          forcedKeep.add(dominantElement.objectId);
          report.push({ slide: decision.slideNumber, message: `Made “${decision.dominant.phrase}” visually dominant.` });
        }
      }
    }

    if (decision.dominant?.objectId && !decision.dominant.phrase) {
      const visual = elements.get(decision.dominant.objectId);
      const kind = visual ? elementKind(visual) : "OTHER";
      const scaleX = Number(visual?.transform?.scaleX);
      const scaleY = Number(visual?.transform?.scaleY);
      const translateX = Number(visual?.transform?.translateX);
      const translateY = Number(visual?.transform?.translateY);
      const width = Number(visual?.size?.width?.magnitude);
      const height = Number(visual?.size?.height?.magnitude);
      const canScale = ["IMAGE", "SHEETS_CHART"].includes(kind) && [scaleX, scaleY, translateX, translateY, width, height].every(Number.isFinite);
      if (canScale) {
        const factor = 1.12;
        requests.push({
          updatePageElementTransform: {
            objectId: visual.objectId,
            applyMode: "ABSOLUTE",
            transform: {
              scaleX: scaleX * factor,
              scaleY: scaleY * factor,
              shearX: Number(visual.transform.shearX) || 0,
              shearY: Number(visual.transform.shearY) || 0,
              translateX: Math.round(translateX - (width * scaleX * (factor - 1)) / 2),
              translateY: Math.round(translateY - (height * scaleY * (factor - 1)) / 2),
              unit: visual.transform.unit || "EMU",
            },
          },
        });
        forcedKeep.add(visual.objectId);
        report.push({ slide: decision.slideNumber, message: "Made the key visual more dominant while preserving its center point." });
      }
    }

    for (const objectId of decision.removeObjectIds || []) {
      const element = elements.get(objectId);
      const kind = element ? elementKind(element) : "OTHER";
      const safeToRemove = element && !isTitleElement(element) && ["IMAGE", "LINE", "SHAPE", "WORD_ART"].includes(kind) && !shapeText(element).trim();
      if (safeToRemove) {
        requests.push({ deleteObject: { objectId } });
        removed.add(objectId);
      }
    }
    if (removed.size) report.push({ slide: decision.slideNumber, message: `Removed ${removed.size} decorative element${removed.size === 1 ? "" : "s"}.` });

    const groups = decision.split?.groups || [];
    if (groups.length >= 2 && groups.length <= 4) {
      const remainingIds = (slide.pageElements || []).map((element) => element.objectId).filter((id) => !removed.has(id));
      const duplicateMappings = [];
      for (let groupIndex = 1; groupIndex < groups.length; groupIndex += 1) {
        const mapping = Object.fromEntries(remainingIds.map((id) => [id, safeObjectId("lucid_element")]));
        mapping[slide.objectId] = safeObjectId("lucid_slide");
        requests.push({ duplicateObject: { objectId: slide.objectId, objectIds: mapping } });
        duplicateMappings.push(mapping);
      }

      const deleteUnkept = (group, mapping = null) => {
        const keep = new Set([...(group.keepObjectIds || []), ...forcedKeep]);
        for (const originalId of remainingIds) {
          if (keep.has(originalId)) continue;
          requests.push({ deleteObject: { objectId: mapping ? mapping[originalId] : originalId } });
        }
      };
      deleteUnkept(groups[0]);
      duplicateMappings.forEach((mapping, index) => deleteUnkept(groups[index + 1], mapping));
      report.push({ slide: decision.slideNumber, message: `Split ${groups.length} separate ideas into ${groups.length} focused slides.` });
    }

    if (!decision.passesThreeSecondTest) {
      report.push({ slide: decision.slideNumber, message: "Flagged for a final human clarity check because the main point may still take more than three seconds to identify." });
    }
    for (const note of decision.manualReview || []) {
      report.push({ slide: decision.slideNumber, message: `Manual review: ${note}` });
    }
  }

  return { requests, report };
}
