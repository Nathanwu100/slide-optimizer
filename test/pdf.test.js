import assert from "node:assert/strict";
import test from "node:test";
import { buildMissedDetailsPdf } from "../lib/pdf.js";

function extractTjStrings(pdfBytes) {
  const text = Buffer.from(pdfBytes).toString("latin1");
  const matches = [...text.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)];
  return matches.map((match) => match[1].replace(/\\([\\()])/g, "$1"));
}

test("PDF has a valid xref table pointing to each object", () => {
  const bytes = buildMissedDetailsPdf(
    [{ slide: 1, elementName: "Body", rule: 3, ruleTitle: "Short lines", originalText: "Original wording.", simplifiedText: "Short." }],
    { fileName: "Deck.pptx", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const text = Buffer.from(bytes).toString("latin1");
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text.trimEnd(), /%%EOF$/);

  let objectNumber = 1;
  for (const match of text.matchAll(/(\d{10}) 00000 n \n/g)) {
    const offset = Number(match[1]);
    const expected = `${objectNumber} 0 obj`;
    assert.equal(text.slice(offset, offset + expected.length), expected);
    objectNumber++;
  }
  assert.ok(objectNumber > 1, "expected at least one object entry in the xref table");
});

test("every applied change is written out in full, not just a diff of what changed", () => {
  const original = "Our Q3 revenue grew 14.2% year-over-year, driven by a 22% rise in enterprise renewals.";
  const bytes = buildMissedDetailsPdf(
    [{ slide: 4, elementName: "Body", rule: 3, ruleTitle: "Short lines", originalText: original, simplifiedText: "Q3 revenue grew 14%." }],
    { fileName: "Deck.pptx", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const joined = extractTjStrings(bytes).join(" ");
  for (const word of ["14.2%", "year-over-year,", "22%", "enterprise", "renewals."]) {
    assert.ok(joined.includes(word), `expected the full original wording to include "${word}"`);
  }
});

test("accented Latin-1 characters and smart punctuation survive, unrepresentable ones become '?' with a warning", () => {
  const bytes = buildMissedDetailsPdf(
    [{ slide: 1, elementName: "Title", rule: 2, ruleTitle: "Short, concrete titles", originalText: "café “renewable” énergie 中文 😀", simplifiedText: "Renewable energy" }],
    { fileName: "Deck.pptx", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const joined = extractTjStrings(bytes).join(" ");
  assert.ok(joined.includes("café"));
  assert.ok(joined.includes("énergie"));
  assert.ok(joined.includes("renewable"));
  // Curly quotes are stored as their single-byte WinAnsiEncoding codes (0x93/0x94),
  // which this latin1-decoded string exposes as U+0093/U+0094, not the original glyphs.
  const quoteIndex = joined.indexOf("renewable");
  assert.equal(joined.charCodeAt(quoteIndex - 1), 0x93, "expected a WinAnsi left curly quote before 'renewable'");
  assert.equal(joined.charCodeAt(quoteIndex + "renewable".length), 0x94, "expected a WinAnsi right curly quote after 'renewable'");
  assert.ok(joined.includes("??"), "unrepresentable characters should become '?'");
  assert.ok(joined.includes("could not be represented"), "a warning note should be added when characters are substituted");
});

test("no rewritten lines produces a document that says so, without erroring", () => {
  const bytes = buildMissedDetailsPdf([], { fileName: "Deck.pptx", generatedAt: "2026-01-01T00:00:00.000Z" });
  const joined = extractTjStrings(bytes).join(" ");
  assert.ok(joined.includes("No lines were rewritten"));
});

test("long original text wraps across multiple lines instead of overflowing the page", () => {
  const longText = "word ".repeat(60).trim();
  const bytes = buildMissedDetailsPdf(
    [{ slide: 1, elementName: "Body", rule: 3, ruleTitle: "Short lines", originalText: longText, simplifiedText: "Short." }],
    { fileName: "Deck.pptx", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const lines = extractTjStrings(bytes);
  for (const line of lines) assert.ok(line.length <= 84, `line exceeded page width: "${line}"`);
});
