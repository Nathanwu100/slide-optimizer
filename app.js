import {
  DRIVE_FILE_SCOPE,
  GOOGLE_SLIDES_MIME,
  buildJudgmentRequests,
  buildMechanicalRequests,
  extractPresentationSnapshot,
} from "./optimizer-core.js";

const connectButton = document.getElementById("connectButton");
const progressPanel = document.getElementById("progressPanel");
const progressHeading = document.getElementById("progressHeading");
const progressList = document.getElementById("progressList");
const selectedDeck = document.getElementById("selectedDeck");
const errorBox = document.getElementById("errorBox");
const resultPanel = document.getElementById("resultPanel");
const resultSummary = document.getElementById("resultSummary");
const resultLink = document.getElementById("resultLink");
const reportList = document.getElementById("reportList");

let config;
let accessToken = "";
let tokenClient;
let pickerReady = false;
let busy = false;

const progressSteps = [
  "Creating a separate Google Slides copy",
  "Reading slide structure and text",
  "Applying mechanical focus rules",
  "Planning judgment-based edits securely",
  "Applying titles, emphasis, cleanup, and splits",
  "Preparing your Google Slides link",
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function googleFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return readJson(response);
}

function resetUi() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
  resultPanel.setAttribute("aria-hidden", "true");
  reportList.replaceChildren();
}

function showError(message, copyLink = "") {
  errorBox.replaceChildren();
  errorBox.append(document.createTextNode(message));
  if (copyLink) {
    const link = document.createElement("a");
    link.href = copyLink;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = " Open the untouched copy.";
    errorBox.append(link);
  }
  errorBox.style.display = "block";
}

function renderProgress(activeIndex, heading) {
  progressPanel.setAttribute("aria-hidden", "false");
  progressHeading.textContent = heading;
  progressList.replaceChildren();
  progressSteps.forEach((label, index) => {
    const item = document.createElement("li");
    item.textContent = label;
    if (index < activeIndex) item.className = "done";
    if (index === activeIndex) item.className = "active";
    progressList.appendChild(item);
  });
}

function showSelectedDeck(file) {
  selectedDeck.hidden = false;
  const name = document.createElement("strong");
  name.textContent = file.name;
  const note = document.createElement("span");
  note.textContent = "Selected from Google Drive";
  selectedDeck.replaceChildren(name, note);
}

function batchUpdate(presentationId, requests) {
  if (!requests.length) return Promise.resolve({ replies: [] });
  return googleFetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

function getPresentation(presentationId) {
  return googleFetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function getThumbnailUrls(presentationId, slides) {
  const entries = await mapWithConcurrency(slides.slice(0, 40), 5, async (slide) => {
    try {
      const params = new URLSearchParams({
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": "MEDIUM",
      });
      const data = await googleFetch(
        `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(slide.objectId)}/thumbnail?${params}`,
      );
      return [slide.objectId, data.contentUrl || ""];
    } catch (error) {
      console.warn(`Could not load preview for slide ${slide.objectId}`, error);
      return [slide.objectId, ""];
    }
  });
  return new Map(entries.filter(([, url]) => url));
}

async function getAiPlan(presentation, thumbnailUrls) {
  const response = await fetch("/api/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Lucid-Request": "1" },
    body: JSON.stringify({ presentation: extractPresentationSnapshot(presentation, thumbnailUrls) }),
  });
  return readJson(response);
}

async function optimizeSelectedPresentation(file) {
  let copy;
  busy = true;
  connectButton.disabled = true;
  resetUi();
  showSelectedDeck(file);
  try {
    renderProgress(0, "Protecting your original presentation…");
    copy = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
      {
        method: "POST",
        body: JSON.stringify({ name: `${file.name} — Lucid Slides optimized` }),
      },
    );

    renderProgress(1, "Reading the new copy…");
    let presentation = await getPresentation(copy.id);

    renderProgress(2, "Applying concise-text and selective-bold rules…");
    const mechanical = buildMechanicalRequests(presentation);
    await batchUpdate(copy.id, mechanical.requests);

    renderProgress(3, "Planning meaning-aware edits…");
    presentation = await getPresentation(copy.id);
    const thumbnailUrls = await getThumbnailUrls(copy.id, presentation.slides || []);
    const plan = await getAiPlan(presentation, thumbnailUrls);

    renderProgress(4, "Applying the validated edit plan…");
    const judgment = buildJudgmentRequests(presentation, plan);
    await batchUpdate(copy.id, judgment.requests);

    renderProgress(5, "Finishing your optimized Google Slides copy…");
    const finalLink = copy.webViewLink || `https://docs.google.com/presentation/d/${copy.id}/edit`;
    const allReportItems = [...mechanical.report, ...judgment.report];
    resultSummary.textContent = `Lucid Slides created a separate copy and applied ${mechanical.requests.length + judgment.requests.length} validated Google Slides API updates. Your original was not changed.`;
    resultLink.href = finalLink;
    reportList.replaceChildren();
    for (const item of allReportItems.slice(0, 80)) {
      const li = document.createElement("li");
      li.textContent = `Slide ${item.slide}: ${item.message}`;
      reportList.appendChild(li);
    }
    const animationItem = document.createElement("li");
    animationItem.textContent = "Manual review: add progressive appear/fade builds where useful; the Google Slides API does not expose animations.";
    reportList.appendChild(animationItem);
    const chartItem = document.createElement("li");
    chartItem.textContent = "Manual review: restyle chart data series when needed; drive.file access intentionally does not grant the broader Sheets permissions required to edit chart internals.";
    reportList.appendChild(chartItem);
    progressPanel.setAttribute("aria-hidden", "true");
    resultPanel.setAttribute("aria-hidden", "false");
    resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    console.error(error);
    progressPanel.setAttribute("aria-hidden", "true");
    const copyLink = copy?.id ? (copy.webViewLink || `https://docs.google.com/presentation/d/${copy.id}/edit`) : "";
    showError(`Lucid Slides could not finish: ${error.message}`, copyLink);
  } finally {
    busy = false;
    connectButton.disabled = false;
  }
}

function requestAccessToken() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) return reject(new Error(response.error_description || response.error));
      accessToken = response.access_token;
      resolve(accessToken);
    };
    tokenClient.error_callback = (error) => reject(new Error(error.message || error.type || "Google authorization failed"));
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

function showPicker() {
  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.PRESENTATIONS)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false)
      .setMode(google.picker.DocsViewMode.LIST);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.googleApiKey)
      .setAppId(config.googleAppId)
      .setOrigin(window.location.origin)
      .setCallback((data) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.CANCEL) return resolve(null);
        if (action !== google.picker.Action.PICKED) return;
        const documentData = data[google.picker.Response.DOCUMENTS]?.[0];
        if (!documentData) return reject(new Error("Google Picker did not return a presentation."));
        const mimeType = documentData[google.picker.Document.MIME_TYPE];
        if (mimeType !== GOOGLE_SLIDES_MIME) return reject(new Error("Please choose a native Google Slides presentation."));
        resolve({
          id: documentData[google.picker.Document.ID],
          name: documentData[google.picker.Document.NAME] || "Google Slides presentation",
        });
      })
      .build();
    picker.setVisible(true);
  });
}

async function initialize() {
  try {
    config = await readJson(await fetch("/api/config", { headers: { Accept: "application/json" } }));
    await Promise.all([
      loadScript("https://accounts.google.com/gsi/client"),
      loadScript("https://apis.google.com/js/api.js"),
    ]);
    await new Promise((resolve, reject) => gapi.load("picker", {
      callback: resolve,
      onerror: () => reject(new Error("Google Picker could not initialize")),
      timeout: 10_000,
      ontimeout: () => reject(new Error("Google Picker initialization timed out")),
    }));
    pickerReady = true;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: config.googleClientId,
      scope: DRIVE_FILE_SCOPE,
      callback: () => {},
    });
    connectButton.disabled = false;
  } catch (error) {
    console.error(error);
    showError(`Lucid Slides is not configured yet: ${error.message}`);
  }
}

connectButton.addEventListener("click", async () => {
  if (busy || !pickerReady) return;
  resetUi();
  try {
    await requestAccessToken();
    const file = await showPicker();
    if (file) await optimizeSelectedPresentation(file);
  } catch (error) {
    console.error(error);
    showError(error.message || "Google authorization or file selection failed.");
  }
});

initialize();
