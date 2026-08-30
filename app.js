import {
  analyzePptx,
  applyProposalsToPptx,
  createAnalysisSnapshot,
  validateAiProposals,
} from "./simplify-engine.js";
import { RULE_TITLES } from "./lib/rules.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const processingBox = document.getElementById("processingBox");
const errorBox = document.getElementById("errorBox");
const resultBox = document.getElementById("resultBox2");
const resultTitle = document.getElementById("resultTitle");
const resultSummary = document.getElementById("resultSummary");
const modeNotice = document.getElementById("modeNotice");
const inventoryList = document.getElementById("inventoryList");
const proposalContainer = document.getElementById("proposalContainer");
const pptxDownload = document.getElementById("pptxDownload");
const reportDownload = document.getElementById("reportDownload");

for (const [id, element] of Object.entries({
  dropzone,
  fileInput,
  processingBox,
  errorBox,
  resultBox2: resultBox,
  resultTitle,
  resultSummary,
  modeNotice,
  inventoryList,
  proposalContainer,
  pptxDownload,
  reportDownload,
})) {
  if (!element) console.error(`Lucid Slides: #${id} is missing. The page and application files may not match.`);
}

let currentReportUrl = "";
let currentPptxUrl = "";
let currentResult = null;

function resetPanels() {
  processingBox.style.display = "none";
  processingBox.replaceChildren();
  errorBox.style.display = "none";
  errorBox.textContent = "";
  resultBox.style.display = "none";
  inventoryList.replaceChildren();
  proposalContainer.replaceChildren();
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = "";
  if (currentPptxUrl) URL.revokeObjectURL(currentPptxUrl);
  currentPptxUrl = "";
  pptxDownload.removeAttribute("href");
  pptxDownload.style.display = "none";
  currentResult = null;
}

function logLine(message) {
  processingBox.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = message;
  processingBox.appendChild(line);
}

function showError(message) {
  errorBox.style.display = "block";
  errorBox.textContent = message;
}

function appendInventory(label, value) {
  const item = document.createElement("li");
  const strong = document.createElement("strong");
  strong.textContent = `${value} `;
  item.append(strong, document.createTextNode(label));
  inventoryList.appendChild(item);
}

function makeTextBlock(label, text, className) {
  const block = document.createElement("div");
  block.className = className;
  const heading = document.createElement("strong");
  heading.textContent = label;
  const value = document.createElement("p");
  value.textContent = text || "None";
  block.append(heading, value);
  return block;
}

function renderLine(node, line) {
  let cursor = 0;
  for (const range of line.boldRanges || []) {
    node.appendChild(document.createTextNode(line.text.slice(cursor, range.start)));
    const emphasized = document.createElement("span");
    emphasized.className = "semantic-emphasis";
    emphasized.textContent = line.text.slice(range.start, range.end);
    node.appendChild(emphasized);
    cursor = range.end;
  }
  node.appendChild(document.createTextNode(line.text.slice(cursor)));
}

/* Renders the new wording exactly as it lands in the slide: bolded phrases
 * bold, and a split paragraph shown as the bullet list it becomes. */
function makeSimplifiedBlock(item) {
  const block = document.createElement("div");
  block.className = "proposal-text proposed-text";
  const heading = document.createElement("strong");
  heading.textContent = "Simplified";
  const lines = item.lines || [{ text: item.proposedText, boldRanges: item.boldRanges }];

  if (lines.length > 1) {
    const list = document.createElement("ul");
    for (const line of lines) {
      const entry = document.createElement("li");
      renderLine(entry, line);
      list.appendChild(entry);
    }
    block.append(heading, list);
    return block;
  }

  const value = document.createElement("p");
  renderLine(value, lines[0]);
  block.append(heading, value);
  return block;
}

function renderChanges(items, manualNotes) {
  proposalContainer.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-findings";
    empty.textContent = "No lines needed simplifying, so your presentation was left as it is.";
    proposalContainer.appendChild(empty);
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "proposal-card";
    card.dataset.proposalId = item.id;
    card.dataset.decision = item.applicationStatus === "applied" ? "approved" : "rejected";

    const heading = document.createElement("h4");
    heading.textContent = `Slide ${item.slide} · ${item.elementName || `Element ${item.objectId}`}`;
    const meta = document.createElement("p");
    meta.className = "proposal-meta";
    meta.textContent = `Rule ${item.rule} — ${item.ruleTitle || RULE_TITLES[item.rule] || ""}`;

    card.append(
      heading,
      meta,
      makeTextBlock("Original", item.originalText, "proposal-text original-text"),
      makeSimplifiedBlock(item),
      makeTextBlock("Why", item.explanation, "proposal-explanation"),
    );

    if (item.applicationStatus && item.applicationStatus !== "applied") {
      const status = document.createElement("span");
      status.className = "application-status skipped";
      status.textContent = "Could not be written into this slide";
      card.appendChild(status);
    }
    proposalContainer.appendChild(card);
  }

  for (const note of manualNotes || []) {
    const card = document.createElement("article");
    card.className = "proposal-card";
    const heading = document.createElement("h4");
    heading.textContent = `Slide ${note.slide} · manual step`;
    const meta = document.createElement("p");
    meta.className = "proposal-meta";
    meta.textContent = `Rule ${note.rule} — ${RULE_TITLES[note.rule] || ""}`;
    const body = document.createElement("p");
    body.textContent = note.note;
    card.append(heading, meta, body);
    proposalContainer.appendChild(card);
  }
}

function updateReportDownload() {
  if (!currentResult) return;
  const report = {
    generatedAt: new Date().toISOString(),
    fileName: currentResult.fileName,
    sourceHash: currentResult.analysis.sourceHash,
    changesApplied: currentResult.generation?.appliedCount || 0,
    changesSkipped: currentResult.generation?.skippedCount || 0,
    inventory: currentResult.analysis.inventory,
    changes: currentResult.items.map((item) => ({
      slide: item.slide,
      objectId: item.objectId,
      elementName: item.elementName,
      rule: item.rule,
      ruleTitle: item.ruleTitle,
      originalText: item.originalText,
      simplifiedLines: (item.lines || []).map((line) => line.text),
      emphasized: (item.lines || []).flatMap((line) => (line.boldRanges || []).map((range) => range.text)),
      explanation: item.explanation,
      status: item.applicationStatus || "not-applied",
    })),
    manualSteps: currentResult.analysis.manualNotes,
  };
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  reportDownload.href = currentReportUrl;
  reportDownload.download = `${currentResult.fileName.replace(/\.pptx$/i, "")} — Lucid Slides summary.json`;
}

async function requestSimplifications(analysis) {
  const snapshot = createAnalysisSnapshot(analysis);
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Lucid-Request": "analysis-v1" },
    body: JSON.stringify({ presentation: snapshot }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The simplifier is unavailable (HTTP ${response.status}).`);
  return {
    edits: validateAiProposals(snapshot, data.proposals),
    message: data.message || "",
    warnings: data.warnings || [],
  };
}

async function handleFile(file) {
  resetPanels();
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pptx")) {
    showError("Choose a .pptx file. Your original presentation is never modified.");
    return;
  }

  try {
    logLine(`Reading ${file.name}…`);
    const arrayBuffer = await file.arrayBuffer();
    const analysis = await analyzePptx(arrayBuffer, logLine);

    logLine(`Simplifying ${analysis.inventory.editableParagraphs} lines across ${analysis.inventory.slides} slides…`);
    const { edits, message, warnings } = await requestSimplifications(analysis);

    logLine(edits.length ? `Applying ${edits.length} changes…` : "Nothing needed changing.");
    const generation = await applyProposalsToPptx(arrayBuffer, edits);
    const statusById = new Map(generation.results.map((result) => [result.id, result.status]));
    for (const edit of edits) edit.applicationStatus = statusById.get(edit.id) || "skipped";

    currentResult = { fileName: file.name, analysis, items: edits, generation };

    if (generation.blob && generation.appliedCount) {
      currentPptxUrl = URL.createObjectURL(generation.blob);
      pptxDownload.href = currentPptxUrl;
      pptxDownload.download = `${file.name.replace(/\.pptx$/i, "")} (simplified).pptx`;
      pptxDownload.style.display = "inline-block";
      resultTitle.textContent = "Your simplified presentation is ready.";
      resultSummary.textContent = `${generation.appliedCount} line${generation.appliedCount === 1 ? " was" : "s were"} rewritten across ${analysis.inventory.slides} slides. Fonts, colours, images, charts and layout are unchanged, and your original file is untouched.`;
    } else {
      resultTitle.textContent = "Nothing was changed.";
      resultSummary.textContent = `${analysis.inventory.slides} slides and ${analysis.inventory.words.toLocaleString()} words were reviewed, but no line needed rewriting.`;
    }

    modeNotice.textContent = warnings.length ? `${message} ${warnings.join(" ")}` : message;
    appendInventory("slides reviewed", analysis.inventory.slides);
    appendInventory("lines rewritten", generation.appliedCount);
    appendInventory("images preserved", analysis.inventory.media);
    appendInventory("charts preserved", analysis.inventory.charts);
    appendInventory("tables preserved", analysis.inventory.tables);
    appendInventory("hyperlinks preserved", analysis.inventory.hyperlinks);

    renderChanges(edits, analysis.manualNotes);
    updateReportDownload();

    processingBox.style.display = "none";
    resultBox.style.display = "block";
    resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    processingBox.style.display = "none";
    showError(`Lucid Slides could not simplify that file: ${error.message}`);
  }
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
}
dropzone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
