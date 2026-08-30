/* Lucid Slides — PPTX analysis and simplification engine.
 *
 * Safety contract:
 * - The original file/bytes passed in are never mutated in place.
 * - Only exact, single-paragraph text matches from validated AI proposals
 *   are applied, and only to a freshly generated in-memory copy.
 * - Threshold-based local findings (rules with no AI-approved rewrite) are
 *   never auto-applied — only proposals with real, validated replacement
 *   text are written into the generated copy.
 */
 
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"];
const PLACEHOLDER_TEXT = "AI analysis required — Lucid Slides will not guess which wording or element is important.";
 
function decodeXml(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}
 
function readAttribute(xml = "", name) {
  const match = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}
 
function textFromXml(xml = "") {
  return Array.from(xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g), (match) => decodeXml(match[1])).join("");
}
 
function wordCount(text = "") {
  const value = String(text).trim();
  return value ? value.split(/\s+/).length : 0;
}
 
function boldWordCount(paragraphXml = "") {
  let count = 0;
  for (const run of paragraphXml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g)) {
    const runXml = run[0];
    const properties = runXml.match(/<a:rPr\b[^>]*>/)?.[0] || "";
    if (/\bb="(?:1|true)"/.test(properties)) count += wordCount(textFromXml(runXml));
  }
  return count;
}
 
const FORMATTING_ATTR_PATTERN = /\b(?:b|i|u|strike|sz|baseline|kumimoji|cap|spc|normalizeH|noProof)\s*=/;
 
// Two runs with identical formatting can still be serialized with their XML
// attributes in a different order (common from Google Slides exports and
// hand-edited decks). Comparing raw matched text treats that as "different"
// formatting and skips an otherwise-safe paragraph. Sorting attributes into a
// canonical order before comparing fixes that false mismatch.
function normalizedRunProperties(runXml = "") {
  const match = runXml.match(/<a:rPr\b([^>]*)(\/>|>([\s\S]*?)<\/a:rPr>)/);
  if (!match) return "";
  const [, attrText, closeOrBody, childrenRaw] = match;
  const isSelfClosing = closeOrBody === "/>";
  if (isSelfClosing && !FORMATTING_ATTR_PATTERN.test(attrText)) return "";
  const attrs = [...attrText.matchAll(/([\w:.-]+)="([^"]*)"/g)]
    .map(([, name, value]) => `${name}="${value}"`)
    .sort()
    .join(" ");
  const children = (childrenRaw || "").replace(/\s+/g, " ").trim();
  return `${attrs}|${children}`;
}
 
export function assessParagraphEditSafety(paragraphXml = "") {
  if (/<a:hlink(?:Click|MouseOver)\b/.test(paragraphXml)) {
    return { safe: false, reason: "Hyperlinked text requires a manual PowerPoint edit." };
  }
  if (/<a:fld\b/.test(paragraphXml)) {
    return { safe: false, reason: "Field-generated text requires a manual PowerPoint edit." };
  }
  if (/<a:br\b/.test(paragraphXml)) {
    return { safe: false, reason: "Text containing a manual line break requires a manual PowerPoint edit." };
  }
 
  const runs = [...paragraphXml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g)]
    .map((match) => match[0])
    .filter((runXml) => /<a:t\b/.test(runXml));
  if (!runs.length) {
    return { safe: false, reason: "No editable text run was found." };
  }
 
  const formattingSignatures = new Set(runs.map(normalizedRunProperties));
  if (formattingSignatures.size > 1) {
    return { safe: false, reason: "Mixed formatting is preserved by leaving this paragraph for manual review." };
  }
  return { safe: true, reason: "The paragraph uses one uniform text style that can be preserved exactly." };
}
 
export function assessParagraphEmphasisSafety(paragraphXml = "") {
  const editSafety = assessParagraphEditSafety(paragraphXml);
  if (!editSafety.safe) return editSafety;
  const runs = [...paragraphXml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g)]
    .map((match) => match[0])
    .filter((runXml) => /<a:t\b/.test(runXml));
  if (runs.length !== 1) {
    return { safe: false, reason: "Text split across multiple PowerPoint runs is left for manual emphasis." };
  }
  const properties = runs[0].match(/<a:rPr\b[^>]*>/)?.[0] || "";
  if (/\bb="(?:1|true)"/.test(properties)) {
    return { safe: false, reason: "Text that is already bold is left unchanged." };
  }
  return { safe: true, reason: "This plain, single-run paragraph can be emphasized without changing its wording." };
}
 
function elementType(elementXml, tagName) {
  if (tagName === "pic") return "image";
  if (/<a:tbl\b/.test(elementXml)) return "table";
  if (/<c:chart\b/.test(elementXml)) return "chart";
  const placeholder = elementXml.match(/<p:ph\b[^>]*>/)?.[0] || "";
  const placeholderType = readAttribute(placeholder, "type");
  if (placeholderType === "title" || placeholderType === "ctrTitle") return "title";
  return "text";
}
 
export function analyzeSlideXml(xml, slideNumber) {
  if (typeof xml !== "string" || !/<p:sld\b/.test(xml)) {
    throw new Error(`Slide ${slideNumber} is not valid PresentationML.`);
  }
 
  const elements = [];
  let fallbackId = 0;
  for (const match of xml.matchAll(/<p:(sp|graphicFrame|pic)\b[\s\S]*?<\/p:\1>/g)) {
    fallbackId += 1;
    const tagName = match[1];
    const elementXml = match[0];
    const nonVisual = elementXml.match(/<p:cNvPr\b[^>]*>/)?.[0] || "";
    const objectId = readAttribute(nonVisual, "id") || `unknown-${fallbackId}`;
    const name = readAttribute(nonVisual, "name") || `${tagName} ${objectId}`;
    const paragraphs = [];
    let paragraphIndex = 0;
    for (const paragraphMatch of elementXml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const paragraphXml = paragraphMatch[0];
      const text = textFromXml(paragraphXml);
      if (!text.trim()) continue;
      const words = wordCount(text);
      const editSafety = assessParagraphEditSafety(paragraphXml);
      const emphasisSafety = assessParagraphEmphasisSafety(paragraphXml);
      paragraphs.push({
        index: paragraphIndex,
        text,
        wordCount: words,
        boldWordCount: boldWordCount(paragraphXml),
        hasHyperlink: /<a:hlinkClick\b/.test(paragraphXml),
        isBullet: /<a:bu(?:Char|AutoNum|Blip)\b/.test(paragraphXml),
        safeToAutoApply: editSafety.safe,
        safetyReason: editSafety.reason,
        safeToEmphasize: emphasisSafety.safe,
        emphasisSafetyReason: emphasisSafety.reason,
      });
      paragraphIndex += 1;
    }
    const relationshipId = readAttribute(elementXml.match(/<a:blip\b[^>]*>/)?.[0] || "", "r:embed") ||
      readAttribute(elementXml.match(/<a:blip\b[^>]*>/)?.[0] || "", "r:link");
    elements.push({
      objectId,
      name,
      type: elementType(elementXml, tagName),
      text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
      paragraphs,
      relationshipId: relationshipId || null,
      hasHyperlink: paragraphs.some((paragraph) => paragraph.hasHyperlink),
    });
  }
 
  return {
    slide: Number(slideNumber),
    elements,
    counts: {
      images: elements.filter((element) => element.type === "image").length,
      tables: elements.filter((element) => element.type === "table").length,
      charts: elements.filter((element) => element.type === "chart").length,
      hyperlinks: elements.reduce(
        (sum, element) => sum + element.paragraphs.filter((paragraph) => paragraph.hasHyperlink).length,
        0,
      ),
      words: elements.reduce((sum, element) => sum + wordCount(element.text), 0),
    },
  };
}
 
function findingId(slide, element, paragraph, rule) {
  return `slide-${slide}-element-${element.objectId}-paragraph-${paragraph?.index ?? "all"}-rule-${rule}`;
}
 
export function buildLocalFindings(slides) {
  const findings = [];
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.type === "title" && wordCount(element.text) > 10) {
        findings.push({
          id: findingId(slide.slide, element, null, 2),
          slide: slide.slide,
          objectId: element.objectId,
          elementName: element.name,
          elementType: element.type,
          originalText: element.text,
          proposedText: null,
          placeholderText: PLACEHOLDER_TEXT,
          rule: 2,
          explanation: "The title exceeds the rule-of-thumb length. Shortening it requires understanding the slide's actual takeaway, so no rewrite was attempted.",
          actionable: false,
          source: "local-analysis",
        });
      }
 
      for (const paragraph of element.paragraphs) {
        if (element.type !== "title" && paragraph.wordCount > 12) {
          findings.push({
            id: findingId(slide.slide, element, paragraph, 3),
            slide: slide.slide,
            objectId: element.objectId,
            elementName: element.name,
            elementType: element.type,
            originalText: paragraph.text,
            proposedText: null,
            placeholderText: PLACEHOLDER_TEXT,
            rule: 3,
            explanation: "This passage may be difficult to scan. Deciding what is repeated or nonessential is a meaning-based judgment, so every word was preserved.",
            actionable: false,
            source: "local-analysis",
          });
        }
        if (paragraph.wordCount > 0 && paragraph.boldWordCount / paragraph.wordCount > 0.2) {
          findings.push({
            id: findingId(slide.slide, element, paragraph, 4),
            slide: slide.slide,
            objectId: element.objectId,
            elementName: element.name,
            elementType: element.type,
            originalText: paragraph.text,
            proposedText: null,
            placeholderText: PLACEHOLDER_TEXT,
            rule: 4,
            explanation: "More than about 20% of this statement is bold. Choosing which words deserve emphasis requires semantic judgment, so formatting was not changed.",
            actionable: false,
            source: "local-analysis",
          });
        }
      }
    }
 
    if (slide.counts.charts) {
      findings.push({
        id: `slide-${slide.slide}-chart-rule-8`,
        slide: slide.slide,
        objectId: null,
        elementName: "Chart",
        elementType: "chart",
        originalText: "Chart content and styling preserved exactly.",
        proposedText: null,
        placeholderText: PLACEHOLDER_TEXT,
        rule: 8,
        explanation: "A chart conclusion and emphasized series require content judgment. Lucid Slides does not alter chart data or styling in local mode.",
        actionable: false,
        source: "local-analysis",
      });
    }
 
    const bulletCount = slide.elements.reduce(
      (sum, element) => sum + element.paragraphs.filter((paragraph) => paragraph.isBullet).length,
      0,
    );
    if (bulletCount >= 3) {
      findings.push({
        id: `slide-${slide.slide}-animation-rules-7-11`,
        slide: slide.slide,
        objectId: null,
        elementName: "Slide animation sequence",
        elementType: "animation",
        originalText: `${bulletCount} bullet paragraphs detected; all animation data is preserved.`,
        proposedText: null,
        placeholderText: "Manual PowerPoint review required — browser-safe animation authoring is not supported.",
        rule: 7,
        explanation: "Progressive reveal and appear/fade animation authoring are not implemented because reliable browser-side PowerPoint animation mutation is unavailable.",
        actionable: false,
        source: "local-analysis",
      });
    }
  }
  return findings;
}
 
async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
 
function assertSafePackageNames(names) {
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error("The presentation contains an unsafe package path.");
    }
  }
}
 
function countMatching(names, pattern) {
  return names.filter((name) => pattern.test(name)).length;
}
 
export async function analyzePptx(arrayBuffer, onProgress, zipLibrary = globalThis.JSZip) {
  if (!zipLibrary?.loadAsync) throw new Error("The safe PowerPoint reader could not be loaded.");
  const sourceBytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer.slice()
    : new Uint8Array(arrayBuffer.slice(0));
  const sourceHash = await sha256(sourceBytes);
  onProgress?.("Validating the presentation package…");
  const zip = await zipLibrary.loadAsync(sourceBytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  assertSafePackageNames(names);
  for (const part of REQUIRED_PARTS) {
    if (!zip.file(part)) throw new Error(`Missing required PowerPoint package part: ${part}`);
  }
 
  const slideFiles = names
    .map((name) => ({ name, match: name.match(SLIDE_PATH) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (!slideFiles.length) throw new Error("No slides were found in this PowerPoint file.");
 
  const slides = [];
  const rawSlideHashes = {};
  for (const entry of slideFiles) {
    const slideNumber = Number(entry.match[1]);
    onProgress?.(`Analyzing slide ${slideNumber} without modifying it…`);
    const rawBytes = await zip.file(entry.name).async("uint8array");
    const xml = new TextDecoder().decode(rawBytes);
    rawSlideHashes[entry.name] = await sha256(rawBytes);
    slides.push(analyzeSlideXml(xml, slideNumber));
  }
 
  onProgress?.("Confirming that the source bytes are unchanged…");
  const finalHash = await sha256(sourceBytes);
  if (finalHash !== sourceHash) throw new Error("Safety validation failed: source bytes changed during analysis.");
 
  const inventory = {
    packageEntries: names.length,
    slides: slideFiles.length,
    media: countMatching(names, /^ppt\/media\//),
    slideRelationships: countMatching(names, /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/),
    notes: countMatching(names, /^ppt\/notesSlides\/notesSlide\d+\.xml$/),
    charts: countMatching(names, /^ppt\/charts\/chart\d+\.xml$/),
    tables: slides.reduce((sum, slide) => sum + slide.counts.tables, 0),
    hyperlinks: slides.reduce((sum, slide) => sum + slide.counts.hyperlinks, 0),
    imagesReferenced: slides.reduce((sum, slide) => sum + slide.counts.images, 0),
    words: slides.reduce((sum, slide) => sum + slide.counts.words, 0),
  };
 
  return {
    mode: "analysis-only",
    sourceHash,
    sourceBytes: sourceBytes.byteLength,
    packageValid: true,
    sourceUnchanged: true,
    outputPptxCreated: false,
    rawSlideHashes,
    inventory,
    slides,
    findings: buildLocalFindings(slides),
    limitations: [
      "No PowerPoint content, formatting, relationships, media, notes, charts, tables, hyperlinks, or structure was changed during analysis.",
      "A new copy can contain only explicitly approved rewrites or restrained emphasis in formatting-safe paragraphs.",
      "Rules 7 and 11 require manual animation authoring in PowerPoint-compatible software.",
    ],
  };
}
 
export function createAnalysisSnapshot(analysis) {
  return {
    sourceHash: analysis.sourceHash,
    slides: analysis.slides.slice(0, 80).map((slide) => ({
      slide: slide.slide,
      elements: slide.elements.slice(0, 120).map((element) => ({
        objectId: element.objectId,
        name: element.name.slice(0, 160),
        type: element.type,
        text: element.text.slice(0, 6000),
        paragraphs: element.paragraphs.slice(0, 300).map((paragraph) => ({
          text: paragraph.text.slice(0, 1200),
          safeToAutoApply: paragraph.safeToAutoApply,
          safetyReason: paragraph.safetyReason.slice(0, 240),
          safeToEmphasize: paragraph.safeToEmphasize,
          emphasisSafetyReason: paragraph.emphasisSafetyReason.slice(0, 240),
        })),
      })),
    })),
  };
}
 
export function validateAiProposals(snapshot, proposals) {
  const lookup = new Map();
  for (const slide of snapshot.slides || []) {
    for (const element of slide.elements || []) lookup.set(`${slide.slide}:${element.objectId}`, element);
  }
  if (!Array.isArray(proposals)) return [];
  const validated = [];
  const seenParagraphs = new Set();
  for (const proposal of proposals.slice(0, 200)) {
    const slide = Number(proposal.slide);
    const objectId = String(proposal.objectId || "");
    const element = lookup.get(`${slide}:${objectId}`);
    const originalText = String(proposal.originalText || "");
    const action = proposal.action === "emphasize" ? "emphasize" : "rewrite";
    const proposedText = String(proposal.proposedText || "").trim();
    const explanation = String(proposal.explanation || "").trim();
    const rule = Number(proposal.rule);
    const paragraph = element?.paragraphs?.find((candidate) => candidate.text === originalText);
    const paragraphKey = `${slide}:${objectId}:${originalText}`;
    if (!element || !paragraph || !originalText) continue;
    if (!explanation || explanation.length > 1000 || !Number.isInteger(rule) || rule < 1 || rule > 12) continue;
    if (seenParagraphs.has(paragraphKey)) continue;
    let boldRanges = null;
    let actionable = Boolean(paragraph.safeToAutoApply);
    let safetyReason = paragraph.safetyReason || "This proposal requires a manual PowerPoint edit.";
    if (action === "rewrite") {
      if (!proposedText || proposedText === originalText || proposedText.length > 1200) continue;
    } else {
      if (element.type === "title" || proposedText !== originalText) continue;
      boldRanges = normalizeBoldRanges(originalText, proposal.boldRanges);
      if (!boldRanges) continue;
      actionable = Boolean(paragraph.safeToEmphasize);
      safetyReason = paragraph.emphasisSafetyReason || "This emphasis requires a manual PowerPoint edit.";
    }
    seenParagraphs.add(paragraphKey);
    validated.push({
      id: `ai-${action}-slide-${slide}-element-${objectId}-rule-${rule}-${validated.length + 1}`,
      action,
      slide,
      objectId,
      elementName: element.name,
      elementType: element.type,
      originalText,
      proposedText,
      boldRanges,
      rule,
      explanation,
      actionable,
      source: "ai-analysis",
      decision: actionable ? "pending" : "manual-only",
      safetyReason,
    });
  }
  return validated;
}
 
function normalizeBoldRanges(text, ranges) {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 3) return null;
  const normalized = ranges.map((range) => ({
    start: Number(range?.start),
    end: Number(range?.end),
    text: String(range?.text || ""),
  })).sort((a, b) => a.start - b.start);
  for (let index = 0; index < normalized.length; index += 1) {
    const range = normalized[index];
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > text.length) return null;
    if (text.slice(range.start, range.end) !== range.text || !range.text.trim() || range.text.split(/\s+/).length > 8) return null;
    if (index > 0 && range.start < normalized[index - 1].end) return null;
  }
  const selected = normalized.reduce((sum, range) => sum + range.end - range.start, 0);
  if (selected >= text.trim().length || selected / text.length > 0.4) return null;
  return normalized;
}
 
function replaceUniformParagraphText(paragraphXml, newText) {
  if (!assessParagraphEditSafety(paragraphXml).safe) return null;
  const runs = [...paragraphXml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/g)];
  if (!runs.length) return null;
  let result = paragraphXml;
  let first = true;
  for (const run of runs) {
    const runXml = run[0];
    const tMatch = runXml.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/);
    if (!tMatch) continue;
    const replacementText = first ? escapeXmlText(newText) : "";
    const openingTag = tMatch[0].match(/^<a:t\b[^>]*>/)?.[0] || "<a:t>";
    let safeOpeningTag = openingTag;
    if (first && (/^\s|\s$/.test(newText)) && !/\bxml:space=/.test(safeOpeningTag)) {
      safeOpeningTag = safeOpeningTag.replace(/>$/, ' xml:space="preserve">');
    }
    const newRunXml = runXml.replace(tMatch[0], `${safeOpeningTag}${replacementText}</a:t>`);
    result = result.replace(runXml, newRunXml);
    first = false;
  }
  return result;
}
 
function replaceRunText(runXml, text) {
  const textMatch = runXml.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/);
  if (!textMatch) return null;
  let openingTag = textMatch[0].match(/^<a:t\b[^>]*>/)?.[0] || "<a:t>";
  if ((/^\s|\s$/.test(text)) && !/\bxml:space=/.test(openingTag)) {
    openingTag = openingTag.replace(/>$/, ' xml:space="preserve">');
  }
  return runXml.replace(textMatch[0], `${openingTag}${escapeXmlText(text)}</a:t>`);
}
 
function addBoldToRun(runXml) {
  const properties = runXml.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0];
  if (!properties) return runXml.replace(/^<a:r\b[^>]*>/, (opening) => `${opening}<a:rPr b="1"/>`);
  if (/\bb="[^"]*"/.test(properties)) {
    return runXml.replace(properties, properties.replace(/\bb="[^"]*"/, 'b="1"'));
  }
  return runXml.replace(properties, properties.replace(/^<a:rPr\b/, '<a:rPr b="1"'));
}
 
function replaceUniformParagraphEmphasis(paragraphXml, ranges) {
  if (!assessParagraphEmphasisSafety(paragraphXml).safe) return null;
  const run = paragraphXml.match(/<a:r\b[\s\S]*?<\/a:r>/)?.[0];
  const originalText = textFromXml(run || "");
  const normalized = normalizeBoldRanges(originalText, ranges);
  if (!run || !normalized) return null;
  const segments = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start > cursor) segments.push({ text: originalText.slice(cursor, range.start), bold: false });
    segments.push({ text: originalText.slice(range.start, range.end), bold: true });
    cursor = range.end;
  }
  if (cursor < originalText.length) segments.push({ text: originalText.slice(cursor), bold: false });
  const replacement = segments.map((segment) => {
    const updated = replaceRunText(run, segment.text);
    return segment.bold ? addBoldToRun(updated) : updated;
  }).join("");
  const result = paragraphXml.replace(run, replacement);
  return textFromXml(result) === originalText ? result : null;
}
 
export function selectApprovedProposals(proposals) {
  if (!Array.isArray(proposals)) return [];
  return proposals.filter((proposal) => proposal?.actionable !== false && proposal?.decision === "approved");
}
 
export function approveAllSafeProposals(proposals) {
  if (!Array.isArray(proposals)) return 0;
  let approvedCount = 0;
  for (const proposal of proposals) {
    if (proposal?.actionable !== true) continue;
    proposal.decision = "approved";
    approvedCount += 1;
  }
  return approvedCount;
}
 
function escapeXmlText(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
 
/* Applies validated AI proposals to a fresh copy of the presentation and returns
 * a downloadable Blob. The original file/bytes passed in are never mutated —
 * a new in-memory zip package is built from them. Only exact, single-paragraph
 * text matches are edited; anything that cannot be matched safely is skipped
 * rather than guessed at. */
export async function applyProposalsToPptx(arrayBuffer, proposals, zipLibrary = globalThis.JSZip) {
  if (!zipLibrary?.loadAsync) throw new Error("The PowerPoint writer could not be loaded.");
  if (!Array.isArray(proposals) || !proposals.length) {
    return { blob: null, appliedCount: 0, skippedCount: 0, results: [] };
  }
 
  const sourceBytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer.slice()
    : new Uint8Array(arrayBuffer.slice(0));
  const approved = selectApprovedProposals(proposals);
  const results = proposals
    .filter((proposal) => !approved.includes(proposal))
    .map((proposal) => ({ id: proposal.id || null, status: "skipped", reason: "not-approved" }));
  if (!approved.length) {
    return { blob: null, appliedCount: 0, skippedCount: proposals.length, results };
  }
 
  const zip = await zipLibrary.loadAsync(sourceBytes);
  const bySlide = new Map();
  for (const proposal of approved) {
    if (!bySlide.has(proposal.slide)) bySlide.set(proposal.slide, []);
    bySlide.get(proposal.slide).push(proposal);
  }
 
  let appliedCount = 0;
  let skippedCount = proposals.length - approved.length;
 
  for (const [slideNumber, edits] of bySlide) {
    const path = `ppt/slides/slide${slideNumber}.xml`;
    const file = zip.file(path);
    if (!file) {
      skippedCount += edits.length;
      results.push(...edits.map((edit) => ({ id: edit.id || null, status: "skipped", reason: "slide-not-found" })));
      continue;
    }
    let xml = await file.async("string");
 
    for (const edit of edits) {
      const shapeMatches = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)];
      let shapeXml = null;
      for (const match of shapeMatches) {
        const nonVisual = match[0].match(/<p:cNvPr\b[^>]*>/)?.[0] || "";
        const id = readAttribute(nonVisual, "id");
        if (id === String(edit.objectId)) {
          shapeXml = match[0];
          break;
        }
      }
      if (!shapeXml) {
        skippedCount += 1;
        results.push({ id: edit.id || null, status: "skipped", reason: "shape-not-found" });
        continue;
      }
 
      const paragraphs = [...shapeXml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)];
      let applied = false;
      for (const paragraphMatch of paragraphs) {
        const paragraphXml = paragraphMatch[0];
        if (textFromXml(paragraphXml) !== edit.originalText) continue;
        const isEmphasis = edit.action === "emphasize";
        const safety = isEmphasis
          ? assessParagraphEmphasisSafety(paragraphXml)
          : assessParagraphEditSafety(paragraphXml);
        if (!safety.safe) {
          results.push({ id: edit.id || null, status: "skipped", reason: "protected-formatting", message: safety.reason });
          break;
        }
        const newParagraphXml = isEmphasis
          ? replaceUniformParagraphEmphasis(paragraphXml, edit.boldRanges)
          : replaceUniformParagraphText(paragraphXml, edit.proposedText);
        if (!newParagraphXml) continue;
        const newShapeXml = shapeXml.replace(paragraphXml, newParagraphXml);
        xml = xml.replace(shapeXml, newShapeXml);
        shapeXml = newShapeXml;
        applied = true;
        results.push({
          id: edit.id || null,
          status: "applied",
          reason: isEmphasis ? "approved-semantic-emphasis" : "approved-uniform-formatting",
        });
        break;
      }
      if (applied) appliedCount += 1;
      else {
        skippedCount += 1;
        if (!results.some((result) => result.id === (edit.id || null) && result.status === "skipped")) {
          results.push({ id: edit.id || null, status: "skipped", reason: "exact-paragraph-not-found" });
        }
      }
    }
 
    zip.file(path, xml);
  }
 
  if (!appliedCount) return { blob: null, appliedCount: 0, skippedCount, results };
 
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  return { blob, appliedCount, skippedCount, results };
}
 
export { PLACEHOLDER_TEXT };
 
