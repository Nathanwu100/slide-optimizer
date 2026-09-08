/* Generates the "possibly missed details" PDF entirely client-side, with no
 * external PDF library. The document exists as a safety net for whatever a
 * simplification pass drops, so every entry carries the FULL original
 * wording of a rewritten line — not a computed diff of only what looks
 * removed. A diff can miss a dropped qualifier, number, or caveat; the full
 * original text never can.
 *
 * Text is written using the built-in Courier/Courier-Bold fonts (no font
 * embedding needed) under WinAnsiEncoding, which covers ASCII, Latin-1
 * accented characters, and the common "smart" punctuation (curly quotes,
 * en/em dashes, ellipsis). Anything outside that set is not representable
 * without embedding a Unicode font, so it is replaced with "?" and flagged
 * with a note in the document.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FONT_SIZE = 10;
const LEADING = 14;
const CHAR_WIDTH = FONT_SIZE * 0.6; // exact for Courier
const MAX_CHARS = Math.floor((PAGE_WIDTH - 2 * MARGIN) / CHAR_WIDTH);
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);

// Unicode code points that WinAnsiEncoding maps outside the Latin-1 layout,
// i.e. Windows-1252's 0x80-0x9F block of "smart" punctuation and symbols.
const WIN1252_SPECIALS = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/* Returns a "binary string" (one JS char = one output byte, 0-255) plus
 * whether any character had to be replaced with "?". */
function sanitizeForPdf(value) {
  let hadUnknown = false;
  let out = "";
  for (const ch of String(value ?? "")) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09) {
      out += " ";
    } else if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      out += String.fromCharCode(codePoint);
    } else if (WIN1252_SPECIALS[codePoint] !== undefined) {
      out += String.fromCharCode(WIN1252_SPECIALS[codePoint]);
    } else if (codePoint >= 0x20) {
      out += "?";
      hadUnknown = true;
    }
  }
  return { text: out, hadUnknown };
}

function wrapMonospace(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function anyUnknownChars(entries, meta) {
  const combined = [meta.fileName, ...entries.flatMap((entry) => [entry.elementName, entry.ruleTitle, entry.originalText, entry.simplifiedText])].join(" ");
  return sanitizeForPdf(combined).hadUnknown;
}

function composeLines(entries, meta) {
  const lines = [];
  const push = (value, bold = false) => {
    const { text } = sanitizeForPdf(value);
    for (const wrapped of wrapMonospace(text, MAX_CHARS)) lines.push({ text: wrapped, bold });
  };
  const blank = () => lines.push({ text: "", bold: false });

  push("SimplifyYourSlides -- Possibly Missed Details", true);
  push(`Source file: ${meta.fileName}`);
  push(`Generated: ${meta.generatedAt}`);
  blank();
  push("This document preserves the complete original wording of every line Lucid");
  push("Slides rewrote in this presentation. It intentionally repeats the full");
  push("original text even where some of it survived into the simplified version,");
  push("so no number, name, qualifier, or caveat is left unaccounted for. Treat it");
  push("as a safety net, not a precise list of only what was removed.");

  if (anyUnknownChars(entries, meta)) {
    blank();
    push("Note: some characters in this presentation could not be represented in");
    push("this PDF and were replaced with \"?\". Check the original file directly");
    push("for any line containing one.");
  }
  blank();

  if (!entries.length) {
    push("No lines were rewritten in this presentation, so nothing was removed.");
    return lines;
  }

  let lastSlide = null;
  for (const entry of entries) {
    if (entry.slide !== lastSlide) {
      blank();
      push(`Slide ${entry.slide}`, true);
      lastSlide = entry.slide;
    }
    push(`${entry.elementName} -- Rule ${entry.rule}: ${entry.ruleTitle}`, true);
    push(`Original: ${entry.originalText}`);
    push(`Simplified to: ${entry.simplifiedText}`);
    blank();
  }
  return lines;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function escapePdfLiteral(binaryString) {
  return binaryString.replace(/[\\()]/g, (match) => `\\${match}`);
}

function buildPageContentStream(pageLines) {
  const parts = ["BT", `${LEADING} TL`, `${MARGIN} ${PAGE_HEIGHT - MARGIN - FONT_SIZE} Td`];
  for (const line of pageLines) {
    parts.push(`${line.bold ? "/F2" : "/F1"} ${FONT_SIZE} Tf`);
    parts.push(`(${escapePdfLiteral(line.text)}) Tj`);
    parts.push("T*");
  }
  parts.push("ET");
  return parts.join("\n");
}

function toBytes(binaryString) {
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i) & 0xff;
  return bytes;
}

/* entries: [{ slide, elementName, rule, ruleTitle, originalText, simplifiedText }]
 * meta: { fileName, generatedAt } */
export function buildMissedDetailsPdf(entries, meta) {
  const lines = composeLines(entries, meta);
  const pages = chunk(lines, LINES_PER_PAGE);
  if (!pages.length) pages.push([{ text: "", bold: false }]);

  const CATALOG = 1;
  const PAGES = 2;
  const FONT_REGULAR = 3;
  const FONT_BOLD = 4;
  let nextObjectNumber = 5;

  const objects = new Map();
  objects.set(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  objects.set(FONT_REGULAR, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  objects.set(FONT_BOLD, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");

  const pageObjectNumbers = [];
  for (const pageLines of pages) {
    const pageNumber = nextObjectNumber++;
    const contentNumber = nextObjectNumber++;
    pageObjectNumbers.push(pageNumber);

    const stream = buildPageContentStream(pageLines);
    objects.set(contentNumber, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.set(
      pageNumber,
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
        + `/Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
  }
  objects.set(PAGES, `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`);

  const totalObjects = nextObjectNumber - 1;
  let body = "%PDF-1.4\n";
  const offsets = new Array(totalObjects + 1).fill(0);
  for (let n = 1; n <= totalObjects; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjects; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;

  const trailer = `trailer\n<< /Size ${totalObjects + 1} /Root ${CATALOG} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return toBytes(body + xref + trailer);
}
