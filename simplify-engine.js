/* Lucid Slides — PPTX analysis and simplification engine.
 *
 * Contract:
 * - The original file/bytes passed in are never mutated in place; every edit is
 *   written into a fresh in-memory copy of the package.
 * - Every paragraph that contains real text runs is editable. There is no
 *   "safe/unsafe" split: mixed formatting, multiple runs, hyperlinks and manual
 *   line breaks are all rewritten, using the paragraph's dominant run as the
 *   style template so the original typeface, size and colour are carried over.
 * - Only generated-field paragraphs (slide numbers, dates) are left alone,
 *   because rewriting them is meaningless rather than unsafe.
 */

import { RULE_TITLES } from "./lib/rules.js";

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;
const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"];
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/* ------------------------------------------------------------------ *
 * XML helpers
 * ------------------------------------------------------------------ */

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

function escapeXmlText(value = "") {
  return String(value)
    .replace(CONTROL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function splice(source, start, end, replacement) {
  return source.slice(0, start) + replacement + source.slice(end);
}

/* Finds the end index of the element opened at `startIndex`, counting nested
 * opens of the same tag. Returns -1 when the document is malformed. */
function balancedEnd(xml, tag, startIndex) {
  const pattern = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, "g");
  pattern.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = pattern.exec(xml))) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth <= 0) return pattern.lastIndex;
    } else if (match[1] !== "/") {
      depth += 1;
    } else if (depth === 0) {
      return pattern.lastIndex; // self-closing element at the top level
    }
  }
  return -1;
}

/* Walks the shape tree and returns every drawable element with its absolute
 * offsets. Group shapes are descended into, so grouped text boxes — very common
 * in Google Slides exports — are found instead of silently skipped. */
function scanElements(xml, offset = 0, out = []) {
  const opener = /<p:(sp|pic|graphicFrame|grpSp)\b/g;
  let match;
  while ((match = opener.exec(xml))) {
    const kind = match[1];
    const end = balancedEnd(xml, `p:${kind}`, match.index);
    if (end < 0) continue;
    if (kind === "grpSp") {
      // Recurse over the group's *contents*, past its own opening tag, or the
      // same group would be rediscovered forever.
      const openTagEnd = xml.indexOf(">", match.index) + 1;
      if (openTagEnd > 0 && openTagEnd < end) {
        scanElements(xml.slice(openTagEnd, end), offset + openTagEnd, out);
      }
    } else {
      out.push({ kind, start: offset + match.index, end: offset + end, xml: xml.slice(match.index, end) });
    }
    opener.lastIndex = end;
  }
  return out;
}

function paragraphMatches(xml) {
  return [...xml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    xml: match[0],
  }));
}

function textRuns(paragraphXml) {
  const runs = [];
  for (const match of paragraphXml.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)) {
    if (!/<a:t\b/.test(match[0])) continue;
    runs.push({
      start: match.index,
      end: match.index + match[0].length,
      xml: match[0],
      text: textFromXml(match[0]),
    });
  }
  return runs;
}

function isFieldParagraph(paragraphXml = "") {
  return /<a:fld\b/.test(paragraphXml);
}

/* A paragraph is editable when it holds at least one real text run and is not a
 * generated field (slide number, date, footer placeholder). */
export function isParagraphEditable(paragraphXml = "") {
  if (isFieldParagraph(paragraphXml)) return false;
  return textRuns(paragraphXml).length > 0;
}

function boldWordCount(paragraphXml = "") {
  let count = 0;
  for (const run of textRuns(paragraphXml)) {
    const properties = run.xml.match(/<a:rPr\b[^>]*>/)?.[0] || "";
    if (/\bb="(?:1|true)"/.test(properties)) count += wordCount(run.text);
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Run rewriting — the part that keeps the original font
 * ------------------------------------------------------------------ */

function runPropertiesXml(runXml = "") {
  return runXml.match(/<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] || "";
}

function runIsBold(runXml = "") {
  return /\bb="(?:1|true)"/.test(runPropertiesXml(runXml));
}

function setRunBold(runXml, bold) {
  const properties = runPropertiesXml(runXml);
  if (!properties) {
    if (!bold) return runXml;
    return runXml.replace(/^<a:r\b[^>]*>/, (opening) => `${opening}<a:rPr lang="en-US" b="1"/>`);
  }
  const value = bold ? "1" : "0";
  const updated = /\bb="[^"]*"/.test(properties)
    ? properties.replace(/\bb="[^"]*"/, `b="${value}"`)
    : properties.replace(/^<a:rPr\b/, `<a:rPr b="${value}"`);
  const start = runXml.indexOf(properties);
  return splice(runXml, start, start + properties.length, updated);
}

function runWithText(runXml, text) {
  const match = runXml.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/);
  if (!match) return null;
  let opening = match[0].match(/^<a:t\b[^>]*>/)?.[0] || "<a:t>";
  if (/^\s|\s$/.test(text) && !/\bxml:space=/.test(opening)) {
    opening = opening.replace(/>$/, ' xml:space="preserve">');
  }
  const start = runXml.indexOf(match[0]);
  return splice(runXml, start, start + match[0].length, `${opening}${escapeXmlText(text)}</a:t>`);
}

/* The run carrying the most visible text decides the paragraph's style.
 * Using the *first* run instead (the old behaviour) is what changed fonts:
 * a leading space or a stray one-character run would donate its typeface to
 * the whole rewritten line. */
function dominantRun(runs) {
  let best = runs[0];
  for (const run of runs) {
    if (run.text.trim().length > best.text.trim().length) best = run;
  }
  return best;
}

export function normalizeBoldRanges(text, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return [];
  const kept = [];
  for (const range of [...ranges].sort((a, b) => Number(a?.start) - Number(b?.start))) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > text.length) continue;
    if (typeof range?.text === "string" && range.text && text.slice(start, end) !== range.text) continue;
    if (!text.slice(start, end).trim()) continue;
    if (kept.length && start < kept[kept.length - 1].end) continue;
    kept.push({ start, end, text: text.slice(start, end) });
  }
  if (!kept.length) return [];
  const selected = kept.reduce((sum, range) => sum + range.end - range.start, 0);
  if (selected >= text.trim().length) return [];
  return kept;
}

/* Rewrites a paragraph's wording, optionally bolding phrases inside the new
 * text. Every original run property of the dominant run — typeface, size,
 * colour, spacing, hyperlink — is carried onto each new run. Leftover runs and
 * manual line breaks between the first and last text run are removed, so no
 * empty runs are left behind. */
export function rewriteParagraphXml(paragraphXml, newText, boldRanges = []) {
  if (!isParagraphEditable(paragraphXml)) return null;
  const runs = textRuns(paragraphXml);
  if (!runs.length) return null;

  const donor = dominantRun(runs);
  // Bolding inside an already-bold line communicates nothing, so skip emphasis.
  const ranges = runIsBold(donor.xml) ? [] : normalizeBoldRanges(newText, boldRanges);

  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: newText.slice(cursor, range.start), bold: false });
    segments.push({ text: newText.slice(range.start, range.end), bold: true });
    cursor = range.end;
  }
  if (cursor < newText.length || !segments.length) {
    segments.push({ text: newText.slice(cursor), bold: false });
  }

  const rebuilt = segments
    .filter((segment) => segment.text.length)
    .map((segment) => {
      const withText = runWithText(donor.xml, segment.text);
      if (!withText) return "";
      return segment.bold ? setRunBold(withText, true) : withText;
    })
    .join("");
  if (!rebuilt) return null;

  const result = splice(paragraphXml, runs[0].start, runs[runs.length - 1].end, rebuilt);
  return textFromXml(result) === newText ? result : null;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function elementType(elementXml, kind) {
  if (kind === "pic") return "image";
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
  for (const found of scanElements(xml)) {
    fallbackId += 1;
    const elementXml = found.xml;
    const nonVisual = elementXml.match(/<p:cNvPr\b[^>]*>/)?.[0] || "";
    const objectId = readAttribute(nonVisual, "id") || `unknown-${fallbackId}`;
    const name = readAttribute(nonVisual, "name") || `${found.kind} ${objectId}`;
    const paragraphs = [];
    let paragraphIndex = 0;
    for (const paragraph of paragraphMatches(elementXml)) {
      const text = textFromXml(paragraph.xml);
      if (!text.trim()) continue;
      paragraphs.push({
        index: paragraphIndex,
        text,
        wordCount: wordCount(text),
        boldWordCount: boldWordCount(paragraph.xml),
        hasHyperlink: /<a:hlinkClick\b/.test(paragraph.xml),
        isBullet: /<a:bu(?:Char|AutoNum|Blip)\b/.test(paragraph.xml),
        editable: isParagraphEditable(paragraph.xml),
      });
      paragraphIndex += 1;
    }
    const blip = elementXml.match(/<a:blip\b[^>]*>/)?.[0] || "";
    elements.push({
      objectId,
      name,
      type: elementType(elementXml, found.kind),
      text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
      paragraphs,
      relationshipId: readAttribute(blip, "r:embed") || readAttribute(blip, "r:link") || null,
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
      editableParagraphs: elements.reduce(
        (sum, element) => sum + element.paragraphs.filter((paragraph) => paragraph.editable).length,
        0,
      ),
      words: elements.reduce((sum, element) => sum + wordCount(element.text), 0),
    },
  };
}

/* Notes for the rules that cannot be automated in a browser (7 and 11), plus
 * chart captions. Informational only — never shown as failed edits. */
export function buildManualNotes(slides) {
  const notes = [];
  for (const slide of slides) {
    const bulletCount = slide.elements.reduce(
      (sum, element) => sum + element.paragraphs.filter((paragraph) => paragraph.isBullet).length,
      0,
    );
    if (bulletCount >= 3) {
      notes.push({
        slide: slide.slide,
        rule: 7,
        note: `${bulletCount} bullets here would read better revealed one at a time — set that up in PowerPoint's Animation pane.`,
      });
    }
    if (slide.counts.charts) {
      notes.push({
        slide: slide.slide,
        rule: 8,
        note: "Chart data and styling were preserved. Check that its caption states the conclusion.",
      });
    }
  }
  return notes;
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
  if (!zipLibrary?.loadAsync) throw new Error("The PowerPoint reader could not be loaded.");
  const sourceBytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer.slice()
    : new Uint8Array(arrayBuffer.slice(0));
  const sourceHash = await sha256(sourceBytes);
  onProgress?.("Opening the presentation…");
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
  for (const entry of slideFiles) {
    const slideNumber = Number(entry.match[1]);
    onProgress?.(`Reading slide ${slideNumber}…`);
    const xml = new TextDecoder().decode(await zip.file(entry.name).async("uint8array"));
    slides.push(analyzeSlideXml(xml, slideNumber));
  }

  if (await sha256(sourceBytes) !== sourceHash) throw new Error("Source bytes changed during analysis.");

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
    editableParagraphs: slides.reduce((sum, slide) => sum + slide.counts.editableParagraphs, 0),
    words: slides.reduce((sum, slide) => sum + slide.counts.words, 0),
  };

  return {
    sourceHash,
    sourceBytes: sourceBytes.byteLength,
    packageValid: true,
    sourceUnchanged: true,
    inventory,
    slides,
    manualNotes: buildManualNotes(slides),
  };
}

export function createAnalysisSnapshot(analysis) {
  return {
    sourceHash: analysis.sourceHash,
    slides: analysis.slides.map((slide) => ({
      slide: slide.slide,
      elements: slide.elements
        .filter((element) => element.paragraphs.some((paragraph) => paragraph.editable))
        .map((element) => ({
          objectId: element.objectId,
          name: element.name.slice(0, 160),
          type: element.type,
          text: element.text.slice(0, 6000),
          paragraphs: element.paragraphs
            .filter((paragraph) => paragraph.editable)
            .slice(0, 300)
            .map((paragraph) => ({ text: paragraph.text.slice(0, 1200), editable: true })),
        })),
    })),
  };
}

/* Client-side revalidation of what the backend returned. Mirrors the server
 * check so a tampered response cannot introduce an edit for text that is not
 * actually in the deck. */
export function validateAiProposals(snapshot, proposals) {
  const lookup = new Map();
  for (const slide of snapshot.slides || []) {
    for (const element of slide.elements || []) lookup.set(`${slide.slide}:${element.objectId}`, element);
  }
  if (!Array.isArray(proposals)) return [];
  const validated = [];
  const seen = new Set();
  for (const proposal of proposals) {
    const slide = Number(proposal.slide);
    const objectId = String(proposal.objectId || "");
    const element = lookup.get(`${slide}:${objectId}`);
    const originalText = String(proposal.originalText || "");
    const proposedText = String(proposal.proposedText || "").trim();
    const explanation = String(proposal.explanation || "").trim();
    const rule = Number(proposal.rule);
    const paragraph = element?.paragraphs?.find((candidate) => candidate.text === originalText);
    const key = `${slide}:${objectId}:${originalText}`;
    if (!element || !paragraph || !originalText || !proposedText) continue;
    if (!Number.isInteger(rule) || rule < 1 || rule > 12) continue;
    if (seen.has(key)) continue;
    const boldRanges = normalizeBoldRanges(proposedText, proposal.boldRanges);
    if (proposedText === originalText && !boldRanges.length) continue;
    seen.add(key);
    validated.push({
      id: `edit-${slide}-${objectId}-${validated.length + 1}`,
      slide,
      objectId,
      elementName: element.name,
      elementType: element.type,
      originalText,
      proposedText,
      boldRanges,
      rule,
      ruleTitle: RULE_TITLES[rule] || `Rule ${rule}`,
      explanation,
    });
  }
  return validated;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

function locateParagraph(xml, objectId, originalText) {
  const elements = scanElements(xml);
  const target = elements.find((element) => {
    const nonVisual = element.xml.match(/<p:cNvPr\b[^>]*>/)?.[0] || "";
    return readAttribute(nonVisual, "id") === String(objectId);
  });

  if (target) {
    for (const paragraph of paragraphMatches(target.xml)) {
      if (textFromXml(paragraph.xml) !== originalText) continue;
      return { start: target.start + paragraph.start, end: target.start + paragraph.end, xml: paragraph.xml };
    }
  }

  // Shape ids can shift between an export and a re-save. Fall back to a unique
  // exact text match anywhere on the slide rather than dropping the edit.
  const candidates = [];
  for (const element of elements) {
    for (const paragraph of paragraphMatches(element.xml)) {
      if (textFromXml(paragraph.xml) !== originalText) continue;
      candidates.push({ start: element.start + paragraph.start, end: element.start + paragraph.end, xml: paragraph.xml });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/* Applies every supplied edit to a fresh copy of the presentation and returns a
 * downloadable Blob. Nothing needs approval — an edit is skipped only when its
 * paragraph can no longer be found or is a generated field. */
export async function applyProposalsToPptx(arrayBuffer, edits, zipLibrary = globalThis.JSZip) {
  if (!zipLibrary?.loadAsync) throw new Error("The PowerPoint writer could not be loaded.");
  if (!Array.isArray(edits) || !edits.length) {
    return { blob: null, appliedCount: 0, skippedCount: 0, results: [] };
  }

  const sourceBytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer.slice()
    : new Uint8Array(arrayBuffer.slice(0));
  const zip = await zipLibrary.loadAsync(sourceBytes);

  const bySlide = new Map();
  for (const edit of edits) {
    if (!bySlide.has(edit.slide)) bySlide.set(edit.slide, []);
    bySlide.get(edit.slide).push(edit);
  }

  const results = [];
  let appliedCount = 0;
  let skippedCount = 0;

  for (const [slideNumber, slideEdits] of bySlide) {
    const path = `ppt/slides/slide${slideNumber}.xml`;
    const file = zip.file(path);
    if (!file) {
      skippedCount += slideEdits.length;
      results.push(...slideEdits.map((edit) => ({ id: edit.id || null, status: "skipped", reason: "slide-not-found" })));
      continue;
    }
    let xml = await file.async("string");

    for (const edit of slideEdits) {
      const located = locateParagraph(xml, edit.objectId, edit.originalText);
      if (!located) {
        skippedCount += 1;
        results.push({ id: edit.id || null, status: "skipped", reason: "paragraph-not-found" });
        continue;
      }
      const rewritten = rewriteParagraphXml(located.xml, edit.proposedText, edit.boldRanges);
      if (!rewritten) {
        skippedCount += 1;
        results.push({ id: edit.id || null, status: "skipped", reason: "paragraph-not-rewritable" });
        continue;
      }
      xml = splice(xml, located.start, located.end, rewritten);
      appliedCount += 1;
      results.push({ id: edit.id || null, status: "applied", reason: "rewritten" });
    }

    // createFolders:false keeps JSZip from inserting `ppt/` and `ppt/slides/`
    // directory entries that the original package did not have.
    zip.file(path, xml, { createFolders: false });
  }

  if (!appliedCount) return { blob: null, appliedCount: 0, skippedCount, results };

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  return { blob, appliedCount, skippedCount, results };
}
