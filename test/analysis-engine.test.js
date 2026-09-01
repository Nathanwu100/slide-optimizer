import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  analyzePptx,
  analyzeSlideXml,
  applyProposalsToPptx,
  createAnalysisSnapshot,
  isParagraphEditable,
  rewriteParagraphXml,
  validateAiProposals,
} from "../simplify-engine.js";
import { makeFixturePptx, loadJsZip } from "./helpers.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("slide inspection preserves exact text and inventories existing elements", () => {
  const xml = `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="7" name="Body"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>First </a:t></a:r><a:r><a:rPr/><a:t>formatted words.</a:t></a:r><a:hlinkClick r:id="rId8"/></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="8" name="Meaningful logo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic>
  </p:spTree></p:cSld></p:sld>`;
  const slide = analyzeSlideXml(xml, 1);
  assert.equal(slide.elements[0].text, "First formatted words.");
  assert.equal(slide.elements[0].paragraphs[0].hasHyperlink, true);
  assert.equal(slide.elements[0].paragraphs[0].editable, true);
  assert.equal(slide.elements[1].name, "Meaningful logo");
  assert.equal(slide.elements[1].relationshipId, "rId3");
  assert.equal(slide.counts.images, 1);
});

test("only generated-field paragraphs are excluded from rewriting", () => {
  assert.equal(isParagraphEditable(`<a:p><a:r><a:t>Editable text</a:t></a:r></a:p>`), true);
  assert.equal(isParagraphEditable(`<a:p><a:fld id="1" type="slidenum"><a:t>1</a:t></a:fld></a:p>`), false);
});

test("text buried after extreme blank spacing is not treated as a visible editable line", () => {
  const blanks = "<a:p><a:endParaRPr/></a:p>".repeat(25);
  const xml = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="11" name="Buried caption"/></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>Visible citation</a:t></a:r></a:p>${blanks}
      <a:p><a:r><a:t>This long caption is pushed beyond the visible slide by blank paragraphs.</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const slide = analyzeSlideXml(xml, 11);
  assert.equal(slide.elements[0].paragraphs[0].editable, true);
  assert.equal(slide.elements[0].paragraphs[1].hiddenBySpacing, true);
  assert.equal(slide.elements[0].paragraphs[1].editable, false);
  assert.equal(slide.counts.hiddenParagraphs, 1);
});

test("analysis preserves source bytes and package inventory", async () => {
  const { JSZip, bytes } = await makeFixturePptx();
  const beforeHash = digest(bytes);
  const analysis = await analyzePptx(bytes, null, JSZip);
  assert.equal(digest(bytes), beforeHash);
  assert.equal(analysis.packageValid, true);
  assert.equal(analysis.sourceUnchanged, true);
  assert.equal(analysis.inventory.slides, 1);
  assert.equal(analysis.inventory.media, 1);
  assert.equal(analysis.inventory.slideRelationships, 1);
  assert.equal(analysis.inventory.notes, 1);
  assert.equal(analysis.inventory.charts, 1);
  assert.equal(analysis.inventory.tables, 1);
  assert.equal(analysis.inventory.hyperlinks, 1);
});

test("AI proposals must reference an exact existing paragraph", async () => {
  const { JSZip, bytes } = await makeFixturePptx();
  const snapshot = createAnalysisSnapshot(await analyzePptx(bytes, null, JSZip));
  const proposals = validateAiProposals(snapshot, [
    {
      slide: 1,
      objectId: "7",
      originalText: "The retina processes visual information before sending signals to the brain.",
      lines: [{ text: "Retina processes visual information", boldRanges: [{ start: 17, end: 35, text: "visual information" }] }],
      rule: 3,
      explanation: "Shortens the sentence.",
    },
    { slide: 1, objectId: "99", originalText: "Invented", lines: [{ text: "Bad", boldRanges: [] }], rule: 3, explanation: "Invalid." },
  ]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].objectId, "7");
});

test("paragraph rewriting can create concise bullets and exact emphasis", () => {
  const source = `<a:p><a:r><a:rPr lang="en-US"/><a:t>A long paragraph to rewrite</a:t></a:r><a:endParaRPr/></a:p>`;
  const rewritten = rewriteParagraphXml(source, [
    { text: "First key idea", boldRanges: [{ start: 6, end: 14, text: "key idea" }] },
    { text: "Second idea", boldRanges: [] },
  ]);
  assert.ok(rewritten);
  assert.match(rewritten, /<a:buChar char="•"\/>/);
  assert.match(rewritten, /<a:rPr b="1" lang="en-US"\/><a:t>key idea<\/a:t>/);
  assert.equal((rewritten.match(/<a:p\b/g) || []).length, 2);
});

test("validated edits create a copy while protected package parts remain byte-identical", async () => {
  const { JSZip, bytes } = await makeFixturePptx();
  const sourceHash = digest(bytes);
  const beforeZip = await JSZip.loadAsync(bytes);
  const protectedParts = [
    "ppt/slides/_rels/slide1.xml.rels",
    "ppt/media/image1.png",
    "ppt/notesSlides/notesSlide1.xml",
    "ppt/charts/chart1.xml",
  ];
  const protectedHashes = new Map(await Promise.all(
    protectedParts.map(async (name) => [name, digest(await beforeZip.file(name).async("uint8array"))]),
  ));
  const snapshot = createAnalysisSnapshot(await analyzePptx(bytes, null, JSZip));
  const [edit] = validateAiProposals(snapshot, [{
    slide: 1,
    objectId: "7",
    originalText: "The retina processes visual information before sending signals to the brain.",
    lines: [{ text: "Retina processes visual information", boldRanges: [{ start: 17, end: 35, text: "visual information" }] }],
    rule: 3,
    explanation: "Keeps the main idea.",
  }]);

  const outcome = await applyProposalsToPptx(bytes, [edit], JSZip);
  assert.equal(outcome.appliedCount, 1);
  assert.equal(outcome.skippedCount, 0);
  assert.equal(digest(bytes), sourceHash, "source bytes changed");

  const outputZip = await JSZip.loadAsync(new Uint8Array(await outcome.blob.arrayBuffer()));
  const outputSlide = await outputZip.file("ppt/slides/slide1.xml").async("string");
  assert.match(outputSlide, /<a:rPr b="1" lang="en-US"\/><a:t>visual information<\/a:t>/);
  assert.doesNotMatch(outputSlide, /before sending signals/);
  for (const [name, hash] of protectedHashes) {
    assert.equal(digest(await outputZip.file(name).async("uint8array")), hash, `${name} changed`);
  }
});

test("missing source paragraphs are skipped instead of modifying another object", async () => {
  const { JSZip, bytes } = await makeFixturePptx();
  const outcome = await applyProposalsToPptx(bytes, [{
    id: "missing",
    slide: 1,
    objectId: "7",
    originalText: "Text that is not in the deck",
    lines: [{ text: "Replacement", boldRanges: [] }],
  }], JSZip);
  assert.equal(outcome.appliedCount, 0);
  assert.equal(outcome.skippedCount, 1);
  assert.equal(outcome.blob, null);
});

test("supplied deck remains byte-identical during analysis", { skip: !process.env.LUCID_TEST_PPTX }, async () => {
  const bytes = new Uint8Array(await readFile(process.env.LUCID_TEST_PPTX));
  const JSZip = await loadJsZip();
  const beforeHash = digest(bytes);
  const analysis = await analyzePptx(bytes, null, JSZip);
  assert.equal(analysis.inventory.slides, 22);
  assert.equal(analysis.inventory.words, 1577);
  assert.equal(analysis.inventory.hiddenParagraphs, 1);
  const slideElevenSnapshot = createAnalysisSnapshot(analysis).slides.find((slide) => slide.slide === 11);
  assert.ok(slideElevenSnapshot);
  assert.equal(slideElevenSnapshot.elements.flatMap((element) => element.paragraphs).some((paragraph) => paragraph.text.includes("process of dark adaptation")), false);
  assert.equal(digest(bytes), beforeHash);
  assert.equal(analysis.sourceUnchanged, true);
});
