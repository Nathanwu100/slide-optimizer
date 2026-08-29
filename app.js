import {
  analyzePptx,
  applyProposalsToPptx,
  approveAllSafeProposals,
  createAnalysisSnapshot,
  selectApprovedProposals,
  validateAiProposals,
} from "./simplify-engine.js";

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
const approveAllButton = document.getElementById("approveAllButton");
const applyApprovedButton = document.getElementById("applyApprovedButton");
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
  approveAllButton,
  applyApprovedButton,
  pptxDownload,
  reportDownload,
})) {
  if (!element) console.error(`Lucid Slides: #${id} is missing. The page and application files may not match.`);
}

let currentReportUrl = "";
let currentPptxUrl = "";
let currentResult = null;

function clearGeneratedCopy() {
  if (currentPptxUrl) URL.revokeObjectURL(currentPptxUrl);
  currentPptxUrl = "";
  pptxDownload.removeAttribute("href");
  pptxDownload.style.display = "none";
  if (currentResult) currentResult.generation = null;
}

function resetPanels() {
  processingBox.style.display = "none";
  processingBox.replaceChildren();
  errorBox.style.display = "none";
  errorBox.textContent = "";
  resultBox.style.display = "none";
  inventoryList.replaceChildren();
  proposalContainer.replaceChildren();
  approveAllButton.style.display = "none";
  approveAllButton.disabled = true;
  applyApprovedButton.style.display = "none";
  applyApprovedButton.disabled = true;
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = "";
  clearGeneratedCopy();
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

function updateReportDownload() {
  if (!currentResult) return;
  const generation = currentResult.generation || {};
  const report = {
    generatedAt: new Date().toISOString(),
    fileName: currentResult.fileName,
    sourceHash: currentResult.analysis.sourceHash,
    sourceUnchanged: currentResult.analysis.sourceUnchanged,
    outputPptxCreated: Boolean(generation.appliedCount),
    changesApplied: generation.appliedCount || 0,
    changesSkipped: generation.skippedCount || 0,
    inventory: currentResult.analysis.inventory,
    proposals: currentResult.items.map((item) => ({
      id: item.id,
      slide: item.slide,
      objectId: item.objectId,
      elementName: item.elementName,
      originalText: item.originalText,
      proposedText: item.proposedText || item.placeholderText,
      rule: item.rule,
      explanation: item.explanation,
      source: item.source,
      decision: item.decision || "not-actionable",
      applicationStatus: item.applicationStatus || "not-applied",
      safetyReason: item.safetyReason || null,
    })),
    limitations: currentResult.analysis.limitations,
  };
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  reportDownload.href = currentReportUrl;
  reportDownload.download = currentResult.fileName.replace(/\.pptx$/i, "") + " — Lucid Slides summary.json";
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

function updateApplyButton() {
  if (!currentResult) return;
  const actionable = currentResult.items.filter((item) => item.actionable);
  const approved = selectApprovedProposals(actionable);
  approveAllButton.style.display = actionable.length ? "inline-block" : "none";
  approveAllButton.disabled = approved.length === actionable.length;
  approveAllButton.textContent = approved.length === actionable.length
    ? `All ${actionable.length} safe suggestion${actionable.length === 1 ? " is" : "s are"} approved`
    : `Approve all ${actionable.length} safe suggestion${actionable.length === 1 ? "" : "s"}`;
  applyApprovedButton.style.display = actionable.length ? "inline-block" : "none";
  applyApprovedButton.disabled = approved.length === 0;
  applyApprovedButton.textContent = approved.length
    ? `Create copy with ${approved.length} approved change${approved.length === 1 ? "" : "s"}`
    : "Approve at least one change to create a copy";
}

function invalidateOutputAfterDecisionChange() {
  if (!currentResult?.generation) return;
  clearGeneratedCopy();
  for (const item of currentResult.items) delete item.applicationStatus;
  resultTitle.textContent = "Review the suggestions before creating a copy.";
  resultSummary.textContent = "A previous download was cleared because the approval decisions changed.";
}

function renderItems(items) {
  proposalContainer.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-findings";
    empty.textContent = "No useful changes were proposed. Your presentation was left unchanged.";
    proposalContainer.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "proposal-card";
    card.dataset.proposalId = item.id;
    if (item.decision) card.dataset.decision = item.decision;

    const heading = document.createElement("h4");
    heading.textContent = `Slide ${item.slide} · ${item.elementName || `Element ${item.objectId || "unknown"}`}`;
    const meta = document.createElement("p");
    meta.className = "proposal-meta";
    meta.textContent = `Rule ${item.rule} · ${item.source === "ai-analysis" ? "AI suggestion" : "local review finding"}`;

    card.append(
      heading,
      meta,
      makeTextBlock("Original", item.originalText, "proposal-text original-text"),
      makeTextBlock(
        "Proposed",
        item.proposedText || item.placeholderText,
        `proposal-text proposed-text${item.actionable ? "" : " placeholder-proposal"}`,
      ),
      makeTextBlock("Why", item.explanation, "proposal-explanation"),
    );

    const controls = document.createElement("div");
    controls.className = "proposal-controls";
    if (item.actionable) {
      for (const decision of ["approved", "rejected"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = decision === "approved" ? "Approve" : "Reject";
        button.className = decision === "approved" ? "approve-btn" : "reject-btn";
        if (item.decision === decision) button.setAttribute("aria-pressed", "true");
        button.addEventListener("click", () => {
          invalidateOutputAfterDecisionChange();
          item.decision = decision;
          card.dataset.decision = decision;
          controls.querySelectorAll("button").forEach((control) => control.removeAttribute("aria-pressed"));
          button.setAttribute("aria-pressed", "true");
          updateApplyButton();
          updateReportDownload();
        });
        controls.appendChild(button);
      }
    } else {
      const note = document.createElement("span");
      note.className = "not-actionable";
      note.textContent = item.source === "ai-analysis"
        ? `Manual edit only: ${item.safetyReason}`
        : "No automatic edit is available for this local finding.";
      controls.appendChild(note);
    }

    if (item.applicationStatus) {
      const status = document.createElement("span");
      status.className = `application-status ${item.applicationStatus}`;
      status.textContent = item.applicationStatus === "applied" ? "Applied to new copy" : "Skipped for safety";
      controls.appendChild(status);
    }
    card.appendChild(controls);
    proposalContainer.appendChild(card);
  }
}

async function requestAiProposals(analysis) {
  const snapshot = createAnalysisSnapshot(analysis);
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lucid-Request": "analysis-v1" },
      body: JSON.stringify({ presentation: snapshot }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 503 && data.mode === "analysis-only") {
      return { proposals: [], notice: data.message || "AI analysis is not configured." };
    }
    if (!response.ok) throw new Error(data.error || `Backend request failed (${response.status})`);
    return {
      proposals: validateAiProposals(snapshot, data.proposals),
      notice: data.message || (data.proposals?.length
        ? "AI suggestions are ready for review. Nothing has been applied."
        : "AI analysis completed without any meaningful suggestions. Nothing was changed."),
    };
  } catch (error) {
    return {
      proposals: [],
      notice: `AI analysis was unavailable (${error.message}). Showing local findings only; nothing was changed.`,
    };
  }
}

async function applyApprovedChanges() {
  if (!currentResult) return;
  const approved = selectApprovedProposals(currentResult.items);
  if (!approved.length) return;

  applyApprovedButton.disabled = true;
  clearGeneratedCopy();
  processingBox.replaceChildren();
  logLine("Creating a new copy with only the approved, formatting-safe changes…");
  try {
    const outcome = await applyProposalsToPptx(currentResult.sourceBytes, approved);
    currentResult.generation = outcome;
    const resultById = new Map(outcome.results.map((result) => [result.id, result]));
    for (const item of currentResult.items) {
      const application = resultById.get(item.id);
      if (application) item.applicationStatus = application.status;
    }

    if (outcome.blob && outcome.appliedCount) {
      currentPptxUrl = URL.createObjectURL(outcome.blob);
      pptxDownload.href = currentPptxUrl;
      pptxDownload.download = currentResult.fileName.replace(/\.pptx$/i, "") + " (simplified).pptx";
      pptxDownload.style.display = "inline-block";
      resultTitle.textContent = "Your reviewed copy is ready.";
      resultSummary.textContent = `${outcome.appliedCount} approved change${outcome.appliedCount === 1 ? " was" : "s were"} applied. ${outcome.skippedCount ? `${outcome.skippedCount} change${outcome.skippedCount === 1 ? " was" : "s were"} skipped for safety. ` : ""}Your original file is unchanged.`;
      modeNotice.textContent = "Download and inspect the new copy. The original presentation was never modified.";
    } else {
      resultTitle.textContent = "No safe automatic changes could be applied.";
      resultSummary.textContent = "The approved suggestions require manual PowerPoint editing, so no replacement file was generated.";
      modeNotice.textContent = "Your original presentation remains unchanged.";
    }
    renderItems(currentResult.items);
    updateReportDownload();
  } catch (error) {
    showError(`Lucid Slides could not safely create a copy: ${error.message}`);
  } finally {
    processingBox.style.display = "none";
    updateApplyButton();
  }
}

async function handleFile(file) {
  resetPanels();
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pptx")) {
    showError("Choose a .pptx file. Lucid Slides never modifies your original presentation.");
    return;
  }

  try {
    logLine(`Reading ${file.name} locally…`);
    const arrayBuffer = await file.arrayBuffer();
    const analysis = await analyzePptx(arrayBuffer, logLine);
    logLine("Requesting optional meaning-based suggestions…");
    const ai = await requestAiProposals(analysis);
    const items = [...ai.proposals, ...analysis.findings];
    currentResult = {
      fileName: file.name,
      sourceBytes: arrayBuffer.slice(0),
      analysis,
      items,
      generation: null,
    };

    resultTitle.textContent = ai.proposals.length
      ? "Review the suggestions before creating a copy."
      : "Analysis complete — your presentation was not modified.";
    resultSummary.textContent = `${analysis.inventory.slides} slides and ${analysis.inventory.words.toLocaleString()} words were inspected. ${ai.proposals.length ? `${ai.proposals.length} AI suggestion${ai.proposals.length === 1 ? " is" : "s are"} available.` : "No automatic changes are available."}`;
    modeNotice.textContent = ai.notice;
    appendInventory("slides reviewed", analysis.inventory.slides);
    appendInventory("media files preserved", analysis.inventory.media);
    appendInventory("slide relationship parts preserved", analysis.inventory.slideRelationships);
    appendInventory("notes parts preserved", analysis.inventory.notes);
    appendInventory("charts preserved", analysis.inventory.charts);
    appendInventory("tables detected and preserved", analysis.inventory.tables);
    appendInventory("hyperlinked paragraphs detected and preserved", analysis.inventory.hyperlinks);
    renderItems(items);
    updateApplyButton();
    updateReportDownload();

    processingBox.style.display = "none";
    resultBox.style.display = "block";
    resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    processingBox.style.display = "none";
    showError(`Lucid Slides could not safely analyze that file: ${error.message}`);
  }
}

approveAllButton.addEventListener("click", () => {
  if (!currentResult) return;
  invalidateOutputAfterDecisionChange();
  approveAllSafeProposals(currentResult.items);
  renderItems(currentResult.items);
  updateApplyButton();
  updateReportDownload();
});
applyApprovedButton.addEventListener("click", applyApprovedChanges);
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
