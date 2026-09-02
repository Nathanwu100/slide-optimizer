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
    // No lang, no typeface, nothing but bold — anything else here would
    // override a font the run was inheriting from its placeholder.
    return runXml.replace(/^<a:r\b[^>]*>/, (opening) => `${opening}<a:rPr b="1"/>`);
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

/* Builds the runs for one line of text, splitting it so the emphasised phrases
 * sit in their own runs.
 *
 * When the source line is already entirely bold — coloured headings and callout
 * text usually are — bolding a phrase inside it is invisible. In that case the
 * emphasis is carried by *removing* bold from everything else, which is what
 * rule 4 asks for anyway: only the key words stay heavy. */
function buildLineRuns(donorXml, text, boldRanges, donorIsBold) {
  const ranges = normalizeBoldRanges(text, boldRanges);
  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), bold: false });
    segments.push({ text: text.slice(range.start, range.end), bold: true });
    cursor = range.end;
  }
  if (cursor < text.length || !segments.length) segments.push({ text: text.slice(cursor), bold: false });

  let failed = false;
  const built = segments
    .filter((segment) => segment.text.length)
    .map((segment) => {
      const withText = runWithText(donorXml, segment.text);
      if (!withText) {
        failed = true;
        return "";
      }
      if (segment.bold) return setRunBold(withText, true);
      if (donorIsBold && ranges.length) return setRunBold(withText, false);
      return withText;
    })
    .join("");
  return failed ? null : built;
}

// buFontTx means "the bullet uses the paragraph's own text font". Naming a
// typeface here — Arial, or anything else — injects a font the deck never had.
const BULLET_CHILDREN = '<a:buFontTx/><a:buChar char="•"/>';
// Children of <a:pPr> are schema-ordered; bullet properties must land before
// any of these, or PowerPoint offers to "repair" the file.
const PPR_TAIL_TAGS = /<a:tabLst\b|<a:defRPr\b|<a:extLst\b/;

function paragraphPropertiesMatch(paragraphXml) {
  const match = paragraphXml.match(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/);
  return match ? { xml: match[0], start: match.index, end: match.index + match[0].length } : null;
}

/* Gives a paragraph a bullet, used only when one long paragraph is split into
 * several lines. A paragraph that already has a bullet is left exactly as it is. */
function withBullet(paragraphXml) {
  if (/<a:bu(?:Char|AutoNum|Blip)\b/.test(paragraphXml)) return paragraphXml;
  const properties = paragraphPropertiesMatch(paragraphXml);
  if (!properties) {
    return paragraphXml.replace(
      /^<a:p\b[^>]*>/,
      (opening) => `${opening}<a:pPr marL="285750" indent="-285750">${BULLET_CHILDREN}</a:pPr>`,
    );
  }

  let block = properties.xml.replace(/<a:buNone\s*\/>/g, "");
  if (block.endsWith("/>")) {
    block = `${block.slice(0, -2)}>${BULLET_CHILDREN}</a:pPr>`;
  } else {
    const tail = block.search(PPR_TAIL_TAGS);
    const insertAt = tail >= 0 ? tail : block.lastIndexOf("</a:pPr>");
    block = splice(block, insertAt, insertAt, BULLET_CHILDREN);
  }
  if (!/^<a:pPr[^>]*\bmarL=/.test(block)) {
    block = block.replace(/^<a:pPr\b/, '<a:pPr marL="285750" indent="-285750"');
  }
  return splice(paragraphXml, properties.start, properties.end, block);
}

/* Rewrites a paragraph as one or more lines.
 *
 * `lines` is [{ text, boldRanges }]. One entry replaces the paragraph in place.
 * Several entries split it into that many paragraphs — each a clone of the
 * original, so indentation, spacing and list level are preserved — and a bullet
 * is added when the original had none, so a wall of prose becomes a real list.
 *
 * Every new run carries the complete run properties of the paragraph's dominant
 * run: typeface, size, colour, spacing and hyperlink all survive untouched. */
export function rewriteParagraphXml(paragraphXml, lines) {
  if (!isParagraphEditable(paragraphXml)) return null;
  const runs = textRuns(paragraphXml);
  if (!runs.length) return null;

  const wanted = (Array.isArray(lines) ? lines : [lines])
    .map((line) => (typeof line === "string"
      ? { text: line.trim(), boldRanges: [] }
      : { text: String(line?.text || "").trim(), boldRanges: line?.boldRanges || [] }))
    .filter((line) => line.text);
  if (!wanted.length) return null;

  const donor = dominantRun(runs);
  const donorIsBold = runIsBold(donor.xml);
  const split = wanted.length > 1;

  const paragraphs = [];
  for (const line of wanted) {
    const rebuilt = buildLineRuns(donor.xml, line.text, line.boldRanges, donorIsBold);
    if (!rebuilt) return null;
    let paragraph = splice(paragraphXml, runs[0].start, runs[runs.length - 1].end, rebuilt);
    if (split) paragraph = withBullet(paragraph);
    paragraphs.push(paragraph);
  }

  const result = paragraphs.join("");
  return textFromXml(result) === wanted.map((line) => line.text).join("") ? result : null;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

/* Largest explicit font size in a paragraph, in hundredths of a point.
 * 0 when every run inherits its size from the layout. */
function maxRunSize(paragraphXml) {
  let largest = 0;
  for (const run of textRuns(paragraphXml)) {
    const size = Number(readAttribute(runPropertiesXml(run.xml), "sz"));
    if (Number.isFinite(size) && size > largest) largest = size;
  }
  return largest;
}

function shapeTop(elementXml) {
  const offset = elementXml.match(/<a:off\b[^>]*>/)?.[0] || "";
  const top = Number(readAttribute(offset, "y"));
  return Number.isFinite(top) ? top : Number.POSITIVE_INFINITY;
}

// Roughly the top quarter of a standard 7.5in-tall slide, in EMU.
const TOP_BAND_EMU = 1_700_000;
const HEADER_MIN_SIZE = 2000; // 20pt
const HEADER_MAX_WORDS = 14;

/* Marks which elements are headings, so they can be left completely alone.
 *
 * PowerPoint only labels a shape as a title when it sits in a title
 * placeholder. Decks exported from Google Slides — and any heading someone made
 * by hand — are plain text boxes, which is why headings were being rewritten,
 * split into bullets and emphasised like body copy. */
function markHeaders(elements) {
  const textual = elements.filter((element) => element.paragraphs.length);
  const sizes = textual.map((element) => element.fontSize).filter((size) => size > 0);
  const largest = sizes.length ? Math.max(...sizes) : 0;
  const hasSmallerText = sizes.some((size) => size < largest);

  for (const element of elements) {
    const words = wordCount(element.text);
    const namedHeader = /\b(title|header|heading|subtitle)\b/i.test(element.name);
    const looksLikeHeading = element.paragraphs.length === 1
      && words > 0
      && words <= HEADER_MAX_WORDS
      && element.fontSize >= HEADER_MIN_SIZE
      // Biggest text on the slide, and something smaller exists to contrast with.
      && element.fontSize === largest
      && hasSmallerText
      && element.top <= TOP_BAND_EMU;

    element.isHeader = element.type === "title" || namedHeader || looksLikeHeading;
  }
  return elements;
}

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
      fontSize: Math.max(0, ...paragraphMatches(elementXml).map((paragraph) => maxRunSize(paragraph.xml))),
      top: shapeTop(elementXml),
      text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
      paragraphs,
      relationshipId: readAttribute(blip, "r:embed") || readAttribute(blip, "r:link") || null,
      hasHyperlink: paragraphs.some((paragraph) => paragraph.hasHyperlink),
    });
  }

  markHeaders(elements);

  return {
    slide: Number(slideNumber),
    elements,
    counts: {
      headers: elements.filter((element) => element.isHeader && element.paragraphs.length).length,
      images: elements.filter((element) => element.type === "image").length,
      tables: elements.filter((element) => element.type === "table").length,
      charts: elements.filter((element) => element.type === "chart").length,
      hyperlinks: elements.reduce(
        (sum, element) => sum + element.paragraphs.filter((paragraph) => paragraph.hasHyperlink).length,
        0,
      ),
      editableParagraphs: elements.reduce(
        (sum, element) => sum + (element.isHeader ? 0 : element.paragraphs.filter((paragraph) => paragraph.editable).length),
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
    for (const element of slide.elements) {
      if (!element.isHeader || wordCount(element.text) <= 8) continue;
      notes.push({
        slide: slide.slide,
        rule: 2,
        note: `Heading left untouched: "${element.text}". It runs long — shorten it yourself if you want to.`,
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
    headers: slides.reduce((sum, slide) => sum + slide.counts.headers, 0),
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
        // Headings never leave the browser, so nothing can propose changing one.
        .filter((element) => !element.isHeader && element.paragraphs.some((paragraph) => paragraph.editable))
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
    const explanation = String(proposal.explanation || "").trim();
    const rule = Number(proposal.rule);
    const paragraph = element?.paragraphs?.find((candidate) => candidate.text === originalText);
    const key = `${slide}:${objectId}:${originalText}`;
    if (!element || !paragraph || !originalText) continue;
    if (!Number.isInteger(rule) || rule < 1 || rule > 12) continue;
    if (seen.has(key)) continue;

    // A proposal is one or more lines; several lines become several bullets.
    const incoming = Array.isArray(proposal.lines) && proposal.lines.length
      ? proposal.lines
      : [{ text: proposal.proposedText, boldRanges: proposal.boldRanges }];
    const lines = incoming
      .map((line) => {
        const text = String(line?.text || "").trim();
        return text ? { text, boldRanges: normalizeBoldRanges(text, line?.boldRanges) } : null;
      })
      .filter(Boolean)
      .slice(0, 5);
    if (!lines.length) continue;

    const proposedText = lines.map((line) => line.text).join("\n");
    const changesNothing = proposedText === originalText && lines.every((line) => !line.boldRanges.length);
    if (changesNothing) continue;

    seen.add(key);
    validated.push({
      id: `edit-${slide}-${objectId}-${validated.length + 1}`,
      slide,
      objectId,
      elementName: element.name,
      elementType: element.type,
      originalText,
      lines,
      proposedText,
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
      const rewritten = rewriteParagraphXml(
        located.xml,
        edit.lines || [{ text: edit.proposedText, boldRanges: edit.boldRanges }],
      );
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
