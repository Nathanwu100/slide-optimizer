import {
  analyzePptx,
  createAnalysisSnapshot,
  validateAiProposals,
  applyProposalsToPptx,
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
const pptxDownload = document.getElementById("pptxDownload");
const reportDownload = document.getElementById("reportDownload");
 
for (const [id, el] of Object.entries({
  dropzone, fileInput, processingBox, errorBox, resultBox2: resultBox,
  resultTitle, resultSummary, modeNotice, inventoryList, pptxDownload, reportDownload,
})) {
  if (!el) console.error(`Lucid Slides: #${id} is missing from this page — index.html and app.js are probably not the same version. File uploads will not work until this is fixed.`);
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
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = "";
  if (currentPptxUrl) URL.revokeObjectURL(currentPptxUrl);
  currentPptxUrl = "";
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
 
function updateReportDownload(appliedCount, skippedCount) {
  if (!currentResult) return;
  const report = {
    generatedAt: new Date().toISOString(),
    fileName: currentResult.fileName,
    sourceHash: currentResult.analysis.sourceHash,
    outputPptxCreated: Boolean(appliedCount),
    changesApplied: appliedCount || 0,
    changesSkipped: skippedCount || 0,
    inventory: currentResult.analysis.inventory,
  };
  if (currentReportUrl) URL.revokeObjectURL(currentReportUrl);
  currentReportUrl = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  reportDownload.href = currentReportUrl;
  reportDownload.download = currentResult.fileName.replace(/\.pptx$/i, "") + " — Lucid Slides summary.json";
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
      notice: "AI-generated proposals were validated against exact slide and element IDs. Nothing was applied.",
    };
  } catch (error) {
    return {
      proposals: [],
      notice: `AI analysis was unavailable (${error.message}). Showing local findings only; no text was generated or changed.`,
    };
  }
}
 
async function handleFile(file) {
  try {
    resetPanels();
  } catch (error) {
    console.error("Lucid Slides: failed to reset the page before reading a file — index.html and app.js may not be the same version.", error);
    return;
  }
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pptx")) {
    showError("Choose a .pptx file. Lucid Slides reads it locally for analysis and does not create a modified presentation.");
    return;
  }
 
  try {
    logLine(`Reading ${file.name} locally…`);
    const arrayBuffer = await file.arrayBuffer();
    const analysis = await analyzePptx(arrayBuffer, logLine);
    logLine("Requesting simplification suggestions…");
    const ai = await requestAiProposals(analysis);
    currentResult = { fileName: file.name, analysis };
 
    let appliedCount = 0;
    let skippedCount = 0;
    if (ai.proposals.length) {
      logLine("Applying simplifications to a new copy of your presentation…");
      const outcome = await applyProposalsToPptx(arrayBuffer, ai.proposals);
      appliedCount = outcome.appliedCount;
      skippedCount = outcome.skippedCount;
      if (outcome.blob) {
        if (currentPptxUrl) URL.revokeObjectURL(currentPptxUrl);
        currentPptxUrl = URL.createObjectURL(outcome.blob);
        pptxDownload.href = currentPptxUrl;
        pptxDownload.download = file.name.replace(/\.pptx$/i, "") + " (simplified).pptx";
        pptxDownload.style.display = "inline-block";
      }
    }
 
    if (appliedCount) {
      resultTitle.textContent = "Your simplified presentation is ready.";
      resultSummary.textContent = `${analysis.inventory.slides} slides and ${analysis.inventory.words.toLocaleString()} words were reviewed. ${appliedCount} change${appliedCount === 1 ? "" : "s"} applied to a new copy — your original file was left untouched.`;
      modeNotice.textContent = "Download the simplified copy below. Your original .pptx is never modified.";
    } else {
      resultTitle.textContent = "Analysis complete — no changes were needed or available.";
      resultSummary.textContent = `${analysis.inventory.slides} slides and ${analysis.inventory.words.toLocaleString()} words were inspected. Your presentation was not modified.`;
      modeNotice.textContent = ai.notice;
    }
    appendInventory("slides reviewed", analysis.inventory.slides);
    appendInventory("media files preserved", analysis.inventory.media);
    appendInventory("slide relationship parts preserved", analysis.inventory.slideRelationships);
    appendInventory("notes parts preserved", analysis.inventory.notes);
    appendInventory("charts preserved", analysis.inventory.charts);
    appendInventory("tables detected and preserved", analysis.inventory.tables);
    appendInventory("hyperlinked paragraphs detected and preserved", analysis.inventory.hyperlinks);
    updateReportDownload(appliedCount, skippedCount);
 
    processingBox.style.display = "none";
    resultBox.style.display = "block";
    resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    processingBox.style.display = "none";
    showError(`Lucid Slides could not safely analyze that file: ${error.message}`);
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
 
