// popup.js — session state, capture flow, persistence, and Word export.

const STORAGE_KEY = "qa_testlog_session";
const BACKUP_KEY = "qa_testlog_session_backup";
const ADO_KEY = "qa_testlog_ado";
const HISTORY_KEY = "qa_testlog_pushhistory";

let session = null;      // { meta:{...}, steps:[...] }


// ---- Element refs ----
const $ = (id) => document.getElementById(id);
const setupView = $("setupView");
const captureView = $("captureView");

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", async () => {
  await applyStoredTheme();
  await applyStoredImgQuality();
  await loadStdSteps();
  await loadSession();
  wireEvents();
  window.addEventListener("focus", loadSession);
});

const THEME_KEY = "qa_testlog_theme";
const IMGQ_KEY = "qa_testlog_imgquality";   // "standard" | "high"
const QBR_KEY = "qa_testlog_qbr_settings";  // field-mapping settings for the QBR panel
const QBR_SECRET = "qbr9821";               // type this exactly into any textbox to open the QBR panel
const STDSTEPS_KEY = "qa_testlog_stdsteps";   // reusable default steps
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

async function applyStoredTheme() {
  const stored = await chrome.storage.local.get(THEME_KEY);
  const theme = stored[THEME_KEY] || "light";
  document.body.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeBtn");
  if (btn) btn.innerHTML = theme === "dark" ? SUN_SVG : MOON_SVG;
}
async function toggleTheme() {
  const next = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", next);
  $("themeBtn").innerHTML = next === "dark" ? SUN_SVG : MOON_SVG;
  await chrome.storage.local.set({ [THEME_KEY]: next });
}

// ---------- Image quality (Standard = faster/smaller, High = sharper/larger) ----------
function applyImgQualityBtn(mode) {
  const btn = $("imgQualityBtn");
  if (!btn) return;
  btn.title = mode === "high" ? "Image quality: High (sharper, larger files)" : "Image quality: Standard (faster, smaller files)";
  btn.classList.toggle("active", mode === "high");
}
async function applyStoredImgQuality() {
  const stored = await chrome.storage.local.get(IMGQ_KEY);
  applyImgQualityBtn(stored[IMGQ_KEY] || "standard");
}
async function toggleImgQuality() {
  const stored = await chrome.storage.local.get(IMGQ_KEY);
  const next = (stored[IMGQ_KEY] || "standard") === "high" ? "standard" : "high";
  applyImgQualityBtn(next);
  await chrome.storage.local.set({ [IMGQ_KEY]: next });
}

async function loadSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored[STORAGE_KEY];
  if (s && s.steps) {
    session = migrateSession(s);
    showCaptureView();
  } else {
    session = null;
    showSetupView();
    await offerRestoreIfBackup();   // recovery path for accidental clears
  }
}

// If there's no live session but a recovery snapshot exists, offer to restore it.
async function offerRestoreIfBackup() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_BACKUP" });
    if (!res || !res.ok || !res.exists) return;
    const when = res.savedAt ? new Date(res.savedAt).toLocaleString() : "earlier";
    const banner = $("restoreBanner");
    if (!banner) return;
    banner.querySelector(".restore-text").textContent =
      `A previous session (${res.steps} step${res.steps === 1 ? "" : "s"}, saved ${when}) can be restored.`;
    banner.classList.remove("hidden");
  } catch { /* ignore */ }
}

async function restoreBackup() {
  const res = await chrome.runtime.sendMessage({ type: "RESTORE_BACKUP" });
  if (res && res.ok) {
    $("restoreBanner").classList.add("hidden");
    await loadSession();
  } else {
    alert("Could not restore: " + (res?.error || "unknown error"));
  }
}

// Bring older flat sessions up to the scenario-aware model.
function migrateSession(s) {
  if (!s.scenarios) {
    const sc = { id: genId(), testId: s.meta?.testId || "(untitled)", title: s.meta?.title || "(no title)" };
    s.scenarios = [sc];
    s.activeScenarioId = sc.id;
    s.steps = (s.steps || []).map((st) => ({ ...st, scenarioId: sc.id }));
    if (s.meta) { s.meta.docTitle = s.meta.docTitle || "Test Execution Log"; }
  }
  return s;
}

function wireEvents() {
  $("startBtn").addEventListener("click", guarded("startBtn", "Starting…", startSession));
  const rb = $("restoreBtn"); if (rb) rb.addEventListener("click", restoreBackup);
  const rd = $("restoreDismiss"); if (rd) rd.addEventListener("click", () => $("restoreBanner").classList.add("hidden"));
  const pinHelp = $("pinHelp");
  if (pinHelp) pinHelp.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  });
  $("annotateBtn").addEventListener("click", annotateOnPage);
  $("refreshBtn").addEventListener("click", loadSession);
  $("exportBtn").addEventListener("click", guarded("exportBtn", "Building…", exportDocx));
  $("clearBtn").addEventListener("click", clearAll);
  $("themeBtn").addEventListener("click", toggleTheme);
  $("imgQualityBtn").addEventListener("click", toggleImgQuality);
  const st = $("sessionTitles");
  if (st) st.addEventListener("click", editSessionMeta);
  $("endBtn").addEventListener("click", clearAll);

  // Add screenshot from file + gallery
  $("addFileBtn").addEventListener("click", () => $("fileInput").click());
  $("stdStepsBtn").addEventListener("click", openStdSteps);
  $("stdStepsClose").addEventListener("click", () => $("stdStepsPanel").classList.add("hidden"));
  $("stdAddBtn").addEventListener("click", addStdStep);
  $("stdFilter").addEventListener("input", renderStdSteps);
  $("fileInput").addEventListener("change", onFilePicked);
  // Clipboard paste: Ctrl+V an image (e.g. from Snipping Tool) anywhere in the popup.
  document.addEventListener("paste", onPaste);
  $("addFileCancel").addEventListener("click", () => { $("addFilePanel").classList.add("hidden"); $("fileInput").value = ""; });
  $("addFileSave").addEventListener("click", guarded("addFileSave", "Adding…", saveFileStep));
  $("addFileScenario").addEventListener("change", populatePositionDropdown);
  $("galleryBtn").addEventListener("click", openGallery);
  $("historyBtn").addEventListener("click", openHistory);
  $("helpBtn").addEventListener("click", openHelp);
  $("tasksBtn").addEventListener("click", openTasksPanel);
  $("tasksCancel").addEventListener("click", () => $("tasksPanel").classList.add("hidden"));
  $("openBulkFind").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("bulkfind.html") });
  });
  $("closeBtn").addEventListener("click", () => { $("closeStatus").textContent = ""; $("closePanel").classList.remove("hidden"); });
  $("closeCancel").addEventListener("click", () => $("closePanel").classList.add("hidden"));
  $("closePreviewBtn").addEventListener("click", previewCloseBatch);
  $("closeGo").addEventListener("click", closeItemsBatch);
  $("tasksCreate").addEventListener("click", createTasks);
  const helpLink = $("helpLink");
  if (helpLink) helpLink.addEventListener("click", (e) => { e.preventDefault(); openHelp(); });
  $("editCancel").addEventListener("click", () => { editingStepId = null; $("editStepPanel").classList.add("hidden"); });
  $("editSave").addEventListener("click", saveEditStep);
  $("editScCancel").addEventListener("click", () => { editingScenarioId = null; $("editScenarioPanel").classList.add("hidden"); });
  $("editScSave").addEventListener("click", saveScenarioEdit);
  $("editMetaCancel").addEventListener("click", () => $("editMetaPanel").classList.add("hidden"));
  $("editMetaSave").addEventListener("click", saveMetaEdit);
  $("editStatus").addEventListener("change", () => {
    $("editActualWrap").classList.toggle("hidden", $("editStatus").value !== "Fail");
  });

  // ADO settings
  $("adoSettingsBtn").addEventListener("click", toggleAdoPanel);
  $("adoSaveBtn").addEventListener("click", guarded("adoSaveBtn", "Saving…", saveAdoSettings));
  $("adoTestBtn").addEventListener("click", guarded("adoTestBtn", "Testing…", testAdoConnection));
  $("adoDiscoverBtn").addEventListener("click", guarded("adoDiscoverBtn", "Discovering…", discoverAdoFields));
  $("adoClearBtn").addEventListener("click", clearAdoSettings);

  // QBR secret panel — type QBR_SECRET exactly into any textbox to open it.
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    if (el.id === "qbrReleaseField" || el.id === "qbrStatusField" || el.id === "qbrReleasedValue" || el.id === "qbrCompletedState" ||
        el.id === "qbrStoryType" || el.id === "qbrBugType" || el.id === "qbrTaskType" || el.id === "qbrTestCaseType" || el.id === "qbrYear") return;
    if (el.value === QBR_SECRET) {
      el.value = "";
      openQbrPanel();
    }
  });
  $("qbrCloseBtn").addEventListener("click", () => $("qbrPanel").classList.add("hidden"));
  $("qbrFetchBtn").addEventListener("click", guarded("qbrFetchBtn", "Fetching…", fetchQbrData));
  $("qbrExportBtn").addEventListener("click", exportQbrCsv);
  ["qbrReleaseField", "qbrStatusField", "qbrReleasedValue", "qbrCompletedState", "qbrStoryType", "qbrBugType", "qbrTaskType", "qbrTestCaseType"].forEach((id) => {
    $(id).addEventListener("change", saveQbrFieldSettings);
  });


  // Push to ADO
  $("pushBtn").addEventListener("click", openPushPanel);
  $("pushCancelBtn").addEventListener("click", () => $("pushPanel").classList.add("hidden"));
  $("pushMode").addEventListener("change", () => {
    const mode = $("pushMode").value;
    const existing = mode === "existing";
    const isBug = mode === "new";
    const isTestCase = mode === "testcase";
    $("pushWorkItemWrap").classList.toggle("hidden", !existing);
    $("pushSignoffWrap").classList.toggle("hidden", !existing);
    // Step filter & bug fields apply only to "new Bug".
    const stepsWrap = $("pushSteps").closest("label");
    if (stepsWrap) stepsWrap.classList.toggle("hidden", !isBug);
    $("pushAssignedWrap").classList.toggle("hidden", !isBug);
    $("pushExtraWrap").classList.toggle("hidden", !isBug);
    // Parent linking applies to Bug and Test Case (both can link under a parent as Child).
    $("pushParentWrap").classList.toggle("hidden", existing);
    // Current-iteration toggle applies to Bug only (test case uses area default).
    $("pushIterWrap").classList.toggle("hidden", !isBug);
    // Test Case defaults to all-scenarios; other modes to a single scenario.
    applyScenarioDefault();
  });
  $("pushGoBtn").addEventListener("click", doPush);
  const sop = $("pushSignoffPreset");
  if (sop) sop.addEventListener("change", updateSignoffPreview);
  const closeChk = $("pushCloseChildren");
  if (closeChk) closeChk.addEventListener("change", () => {
    $("pushCloseOpts").classList.toggle("hidden", !closeChk.checked);
  });
  $("pushScenario").addEventListener("change", () => {
    if ($("pushScenario").value === "__all__" && $("pushMode").value !== "testcase") {
      $("pushMode").value = "testcase";
      $("pushMode").dispatchEvent(new Event("change"));
    }
  });
}

// ---------- Views ----------
function showSetupView() {
  setupView.classList.remove("hidden");
  captureView.classList.add("hidden");
}
function showCaptureView() {
  setupView.classList.add("hidden");
  captureView.classList.remove("hidden");
  renderSession();
}

// ---------- Session lifecycle ----------
async function startSession() {
  const meta = {
    docTitle: $("docTitle").value.trim() || "Test Execution Log",
    tester: $("tester").value.trim() || "—",
    environment: $("environment").value.trim() || "—",
    started: new Date().toISOString()
  };
  const firstScenario = {
    id: genId(),
    testId: $("testId").value.trim() || "(untitled)",
    title: $("testTitle").value.trim() || "(no title)"
  };
  session = {
    meta,
    scenarios: [firstScenario],
    activeScenarioId: firstScenario.id,
    steps: []
  };
  await persist();
  showCaptureView();
}

function genId() {
  return "sc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Prevents a button from firing its async handler twice if double-clicked.
// Disables the button (with optional busy text) until the work finishes.
function guarded(btnId, busyText, fn) {
  return async (...args) => {
    const btn = $(btnId);
    if (btn && btn.disabled) return;          // already running
    const original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; if (busyText) btn.textContent = busyText; }
    try {
      await fn(...args);
    } finally {
      if (btn) { btn.disabled = false; if (busyText) btn.textContent = original; }
    }
  };
}

async function clearAll() {
  if (session && session.steps.length && !confirm("Discard this session and all captured steps?")) return;
  session = null;
  await chrome.storage.local.remove(STORAGE_KEY);
  ["docTitle", "testId", "testTitle", "tester", "environment"].forEach((id) => ($(id).value = ""));
  showSetupView();
  await offerRestoreIfBackup();   // let the user undo an accidental clear
}

async function persist() {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
  // Keep the recovery snapshot current for popup-side changes too (add-from-file,
  // edits, deletes, scenario changes) — not just on-page captures. Same format as
  // the background's snapshotSession. Best-effort; never block the main save.
  try {
    await chrome.storage.local.set({
      [BACKUP_KEY]: { session, savedAt: new Date().toISOString() }
    });
  } catch { /* ignore */ }
}

// ---------- Annotate on page ----------
async function annotateOnPage() {
  const errEl = $("captureError");
  errEl.classList.add("hidden");
  const btn = $("annotateBtn");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "INJECT_OVERLAY" });
    if (!res || !res.ok) throw new Error(res?.error || "Could not open the annotation toolbar.");
    // Close the popup so the user works on the page; steps are added there.
    window.close();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "✎ Annotate &amp; Capture on Page";
  }
}

// ---------- Push history ----------
async function recordPush(entry) {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = stored[HISTORY_KEY] || [];
  list.unshift({ ...entry, at: new Date().toISOString() }); // newest first
  // Keep the most recent 100.
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, 100) });
}

async function openHistory() {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
}

function openHelp() {
  chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
}

async function openTasksPanel() {
  const stored = await chrome.storage.local.get(ADO_KEY);
  if (!stored[ADO_KEY]) { $("status").textContent = "Configure Azure DevOps first (⚙ ADO)."; return; }
  $("tasksTitles").value = (stored[ADO_KEY].defTasks || "");
  $("tasksStatus").textContent = "";
  // Pick up any selection handed off from the full-tab finder.
  const handoff = await chrome.storage.local.get("qa_testlog_bulk_selection");
  const sel = handoff["qa_testlog_bulk_selection"];
  if (sel && sel.ids && sel.ids.length) {
    $("tasksParentId").value = sel.ids.join(", ");
    $("tasksStatus").innerHTML = `✓ ${sel.ids.length} item(s) from the finder prefilled. Add task titles, then Create tasks.`;
    await chrome.storage.local.remove("qa_testlog_bulk_selection"); // consume it once
  } else {
    $("tasksParentId").value = "";
  }
  $("tasksPanel").classList.remove("hidden");
}

async function createTasks() {
  const rawIds = $("tasksParentId").value.trim();
  const parentIds = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
  const titles = $("tasksTitles").value.split("\n").map((t) => t.trim()).filter(Boolean);
  const st = $("tasksStatus");
  if (!parentIds.length) { st.textContent = "Enter at least one parent story ID."; return; }
  if (!titles.length) { st.textContent = "Add at least one task title."; return; }
  $("tasksCreate").disabled = true;

  const results = [];   // { parentId, ok, created?, error? }
  for (let i = 0; i < parentIds.length; i++) {
    const parentId = parentIds[i];
    st.textContent = `Creating tasks under #${parentId} (${i + 1}/${parentIds.length})…`;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "ADO_CREATE_TASKS",
        parentId, titles,
        options: { useCurrentIteration: $("tasksUseCurrentIter").checked }
      });
      if (!res || !res.ok) { results.push({ parentId, ok: false, error: res?.error || "failed" }); continue; }
      results.push({ parentId, ok: true, created: res.created });
      for (const t of res.created) {
        await recordPush({ kind: "Task", scenario: t.title, workItemId: t.id, workItemUrl: t.url, parentId });
      }
    } catch (e) {
      results.push({ parentId, ok: false, error: e.message });
    }
  }

  // Build a per-story summary.
  const okOnes = results.filter((r) => r.ok);
  const failOnes = results.filter((r) => !r.ok);
  const totalTasks = okOnes.reduce((n, r) => n + r.created.length, 0);
  let html = "";
  if (okOnes.length) {
    html += `✓ Created ${totalTasks} task${totalTasks === 1 ? "" : "s"} across ${okOnes.length} stor${okOnes.length === 1 ? "y" : "ies"}:<br>`;
    html += okOnes.map((r) =>
      `#${r.parentId}: ` + r.created.map((t) => `<a href="${t.url}" target="_blank">#${t.id}</a>`).join(", ")
    ).join("<br>");
  }
  if (failOnes.length) {
    html += `${okOnes.length ? "<br>" : ""}<span style="color:var(--fail)">✗ Failed: ` +
      failOnes.map((r) => `#${r.parentId} (${escapeHtml(r.error)})`).join(", ") + "</span>";
  }
  st.innerHTML = html;
  $("tasksCreate").disabled = false;
}

function readCloseInputs() {
  const parentIds = $("closeParentIds").value.trim().split(",").map((s) => s.trim()).filter(Boolean);
  return {
    parentIds,
    closeTasks: $("closeTasksChk").checked,
    closeTestCases: $("closeTestCasesChk").checked,
    prefix: $("closePrefixInput").value.trim()
  };
}

async function previewCloseBatch() {
  const { parentIds, closeTasks, closeTestCases, prefix } = readCloseInputs();
  const st = $("closeStatus");
  const box = $("closePreview");
  if (!parentIds.length) { st.textContent = "Enter at least one parent story ID."; return; }
  if (!closeTasks && !closeTestCases) { st.textContent = "Select tasks, test cases, or both."; return; }
  $("closePreviewBtn").disabled = true;
  st.textContent = `Checking ${parentIds.length} stor${parentIds.length === 1 ? "y" : "ies"}…`;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "ADO_CLOSE_PREVIEW",
      parentIds, closeTasksPrefix: closeTasks ? prefix : "", closeTestCases
    });
    if (!res || !res.ok) { st.textContent = "✗ " + (res?.error || "failed"); return; }
    let totalWillClose = 0;
    const blocks = res.perStory.map((r) => {
      if (!r.ok) return `<div class="cp-story"><b>#${r.parentId}</b> <span style="color:var(--fail)">✗ ${escapeHtml(r.error)}</span></div>`;
      totalWillClose += r.toClose.length;
      const items = r.toClose.length
        ? r.toClose.map((c) => `<div class="cp-item">• ${escapeHtml(c.type)} #${c.id} — ${escapeHtml(c.title)}</div>`).join("")
        : `<div class="cp-item" style="opacity:.6">nothing to close</div>`;
      const already = r.alreadyClosed.length ? `<div class="cp-item" style="opacity:.6">(${r.alreadyClosed.length} already closed, will skip)</div>` : "";
      return `<div class="cp-story"><b>#${r.parentId}</b> — will close ${r.toClose.length}${items}${already}</div>`;
    });
    box.innerHTML = `<div class="cp-head">Preview — ${totalWillClose} item${totalWillClose === 1 ? "" : "s"} would be closed. Nothing has changed yet.</div>` + blocks.join("");
    box.classList.remove("hidden");
    st.textContent = "";
  } catch (e) {
    st.textContent = "✗ " + e.message;
  } finally {
    $("closePreviewBtn").disabled = false;
  }
}

async function closeItemsBatch() {
  const { parentIds, closeTasks, closeTestCases, prefix } = readCloseInputs();
  const st = $("closeStatus");
  if (!parentIds.length) { st.textContent = "Enter at least one parent story ID."; return; }
  if (!closeTasks && !closeTestCases) { st.textContent = "Select tasks, test cases, or both to close."; return; }

  const what = [closeTasks ? `tasks starting with "${prefix}"` : null, closeTestCases ? "all test cases" : null].filter(Boolean).join(" and ");
  if (!confirm(`Close ${what} under ${parentIds.length} stor${parentIds.length === 1 ? "y" : "ies"} (${parentIds.join(", ")})?\n\nTip: use Preview first to see exactly what will close. Already-closed items are skipped.`)) return;

  $("closeGo").disabled = true;
  st.textContent = `Closing items under ${parentIds.length} stor${parentIds.length === 1 ? "y" : "ies"}…`;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "ADO_CLOSE_BATCH",
      parentIds,
      closeTasksPrefix: closeTasks ? prefix : "",
      closeTestCases
    });
    if (!res || !res.ok) { st.textContent = "✗ " + (res?.error || "failed"); return; }
    $("closePreview").classList.add("hidden");
    let totalClosed = 0, totalSkipped = 0;
    const lines = res.perStory.map((r) => {
      if (!r.ok) return `#${r.parentId}: <span style="color:var(--fail)">✗ ${escapeHtml(r.error)}</span>`;
      totalClosed += r.closed.length; totalSkipped += r.skipped.length;
      const c = r.closed.length, sk = r.skipped.length;
      return `#${r.parentId}: closed ${c}${sk ? `, skipped ${sk}` : ""}`;
    });
    st.innerHTML = `✓ Done — closed ${totalClosed} item${totalClosed === 1 ? "" : "s"}` +
      (totalSkipped ? `, skipped ${totalSkipped}` : "") + ` across ${res.perStory.length} stor${res.perStory.length === 1 ? "y" : "ies"}:<br>` +
      lines.join("<br>");
    for (const r of res.perStory) {
      if (r.ok && r.closed.length) {
        await recordPush({ kind: `Closed ${r.closed.length} child item${r.closed.length === 1 ? "" : "s"}`, scenario: "", workItemId: r.parentId, workItemUrl: "", parentId: r.parentId });
      }
    }
  } catch (e) {
    st.textContent = "✗ " + e.message;
  } finally {
    $("closeGo").disabled = false;
  }
}

// ---------- Edit step ----------
let editingStepId = null;

function openEditStep(stepId) {
  const step = session.steps.find((s) => s.id === stepId);
  if (!step) return;
  editingStepId = stepId;
  $("editCaption").value = step.caption || "";
  $("editExpected").value = step.expected || "";
  $("editStatus").value = step.status || "Pass";
  $("editActual").value = step.actual || "";
  $("editActualWrap").classList.toggle("hidden", step.status !== "Fail");
  $("editStepPanel").classList.remove("hidden");
}

async function saveEditStep() {
  const step = session.steps.find((s) => s.id === editingStepId);
  if (!step) { $("editStepPanel").classList.add("hidden"); return; }
  step.caption = $("editCaption").value.trim() || "(no description)";
  step.expected = $("editExpected").value.trim();
  step.status = $("editStatus").value;
  step.actual = step.status === "Fail" ? $("editActual").value.trim() : "";
  await persist();
  editingStepId = null;
  $("editStepPanel").classList.add("hidden");
  renderSession();
}

async function deleteStep(stepId) {
  session.steps = session.steps.filter((s) => s.id !== stepId);
  await chrome.storage.local.remove(`shot_${stepId}`); // free the image blob
  await persist();
  renderSession();
}

let editingScenarioId = null;
function renameScenario(scenarioId) {
  const sc = session.scenarios.find((s) => s.id === scenarioId);
  if (!sc) return;
  editingScenarioId = scenarioId;
  $("editScId").value = sc.testId || "";
  $("editScTitle").value = sc.title || "";
  $("editScenarioPanel").classList.remove("hidden");
  $("editScId").focus();
}
async function saveScenarioEdit() {
  const sc = session.scenarios.find((s) => s.id === editingScenarioId);
  if (!sc) { $("editScenarioPanel").classList.add("hidden"); return; }
  sc.testId = $("editScId").value.trim() || sc.testId;
  sc.title = $("editScTitle").value.trim() || sc.title;
  await persist();
  editingScenarioId = null;
  $("editScenarioPanel").classList.add("hidden");
  renderSession();
}

// ---------- Standard (default) steps ----------
let stdSteps = [];

async function loadStdSteps() {
  const stored = await chrome.storage.local.get(STDSTEPS_KEY);
  stdSteps = stored[STDSTEPS_KEY] || [];
}
async function saveStdSteps() {
  await chrome.storage.local.set({ [STDSTEPS_KEY]: stdSteps });
}
function openStdSteps() {
  renderStdSteps();
  $("stdStepsPanel").classList.remove("hidden");
}
function renderStdSteps() {
  const list = $("stdStepsList");
  const filter = ($("stdFilter").value || "").toLowerCase();
  list.innerHTML = "";
  if (!stdSteps.length) {
    list.innerHTML = `<p class="hint" style="opacity:.7">No presets yet. Add one below.</p>`;
    return;
  }
  // Filter, then group by category, then sort within each group.
  const visible = stdSteps
    .map((st, idx) => ({ st, idx }))
    .filter(({ st }) => {
      if (!filter) return true;
      return (st.desc + " " + (st.expected || "") + " " + (st.category || "")).toLowerCase().includes(filter);
    });
  if (!visible.length) {
    list.innerHTML = `<p class="hint" style="opacity:.7">No presets match "${escapeHtml(filter)}".</p>`;
    return;
  }
  const groups = {};
  visible.forEach((item) => {
    const cat = (item.st.category || "").trim() || "Uncategorized";
    (groups[cat] = groups[cat] || []).push(item);
  });
  Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach((cat) => {
    const header = document.createElement("div");
    header.className = "std-cat-head";
    header.textContent = cat;
    list.appendChild(header);
    groups[cat].sort((a, b) => a.st.desc.localeCompare(b.st.desc)).forEach(({ st, idx }) => {
      const row = document.createElement("div");
      row.className = "std-row";
      row.innerHTML = `
        <div class="std-meta">
          <div class="std-desc">${escapeHtml(st.desc)}</div>
          <div class="std-sub">${st.expected ? escapeHtml(st.expected) + " · " : ""}<span class="st ${st.status}">${st.status}</span></div>
        </div>
        <button class="std-edit" title="Edit">✎</button>
        <button class="std-del" title="Delete">✕</button>`;
      row.querySelector(".std-del").addEventListener("click", async () => {
        stdSteps.splice(idx, 1); await saveStdSteps(); renderStdSteps();
      });
      row.querySelector(".std-edit").addEventListener("click", async () => {
        const c = prompt("Category:", st.category || ""); if (c === null) return;
        const d = prompt("Description:", st.desc); if (d === null) return;
        const e = prompt("Expected result:", st.expected || ""); if (e === null) return;
        st.category = c.trim(); st.desc = d.trim() || st.desc; st.expected = e.trim();
        await saveStdSteps(); renderStdSteps();
      });
      list.appendChild(row);
    });
  });
}
async function addStdStep() {
  const desc = $("stdNewDesc").value.trim();
  if (!desc) { $("stdNewDesc").focus(); return; }
  stdSteps.push({
    category: $("stdNewCategory").value.trim(),
    desc,
    expected: $("stdNewExpected").value.trim(),
    status: $("stdNewStatus").value
  });
  await saveStdSteps();
  $("stdNewCategory").value = ""; $("stdNewDesc").value = ""; $("stdNewExpected").value = ""; $("stdNewStatus").value = "Pass";
  renderStdSteps();
}

function editSessionMeta() {
  if (!session) return;
  $("editMetaDoc").value = session.meta.docTitle || "";
  $("editMetaTester").value = session.meta.tester || "";
  $("editMetaEnv").value = session.meta.environment || "";
  $("editMetaPanel").classList.remove("hidden");
  $("editMetaDoc").focus();
}
async function saveMetaEdit() {
  if (!session) { $("editMetaPanel").classList.add("hidden"); return; }
  session.meta.docTitle = $("editMetaDoc").value.trim() || session.meta.docTitle;
  session.meta.tester = $("editMetaTester").value.trim() || session.meta.tester;
  session.meta.environment = $("editMetaEnv").value.trim() || session.meta.environment;
  await persist();
  $("editMetaPanel").classList.add("hidden");
  renderSession();
}

async function deleteScenario(scenarioId) {
  const sc = session.scenarios.find((s) => s.id === scenarioId);
  if (!sc) return;
  const stepCount = session.steps.filter((s) => s.scenarioId === scenarioId).length;
  if (session.scenarios.length <= 1) {
    alert("You can't delete the only scenario. Use “Clear All” to reset the session instead.");
    return;
  }
  const msg = stepCount > 0
    ? `Delete scenario “${sc.testId} — ${sc.title}” and its ${stepCount} step${stepCount === 1 ? "" : "s"}? This can't be undone.`
    : `Delete empty scenario “${sc.testId} — ${sc.title}”?`;
  if (!confirm(msg)) return;
  // Remove the scenario and any steps under it.
  const removedStepIds = session.steps.filter((s) => s.scenarioId === scenarioId).map((s) => s.id);
  session.scenarios = session.scenarios.filter((s) => s.id !== scenarioId);
  session.steps = session.steps.filter((s) => s.scenarioId !== scenarioId);
  if (removedStepIds.length) {
    await chrome.storage.local.remove(removedStepIds.map((id) => `shot_${id}`)); // free image blobs
  }
  // If the active scenario was deleted, point to the last remaining one.
  if (session.activeScenarioId === scenarioId) {
    session.activeScenarioId = session.scenarios[session.scenarios.length - 1].id;
  }
  await persist();
  renderSession();
}

// ---------- Add screenshot from file ----------
let pendingFile = null;

// Paste an image straight from the clipboard (Snipping Tool → Ctrl+V).
async function onPaste(e) {
  if (!session) return; // only during an active session
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      try {
        pendingFile = await readAndDownscaleImage(blob);
      } catch (err) {
        $("captureError").textContent = "Could not read pasted image: " + err.message;
        $("captureError").classList.remove("hidden");
        return;
      }
      openAddFilePanel();
      return;
    }
  }
}

// Shared: populate and show the add-file panel from pendingFile.
function openAddFilePanel() {
  $("addFilePreview").src = pendingFile.dataUrl;
  const sel = $("addFileScenario");
  sel.innerHTML = "";
  session.scenarios.forEach((sc) => {
    const o = document.createElement("option");
    o.value = sc.id;
    o.textContent = `${sc.testId} — ${sc.title}`;
    sel.appendChild(o);
  });
  sel.value = session.activeScenarioId;
  populatePositionDropdown();
  $("addFileCaption").value = "";
  $("addFileExpected").value = "";
  $("addFileStatus").value = "Pass";
  $("addFilePanel").classList.remove("hidden");
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    pendingFile = await readAndDownscaleImage(file);
  } catch (err) {
    $("captureError").textContent = "Could not read image: " + err.message;
    $("captureError").classList.remove("hidden");
    return;
  }
  openAddFilePanel();
}

function populatePositionDropdown() {
  const scId = $("addFileScenario").value;
  const steps = session.steps.filter((s) => s.scenarioId === scId);
  const sel = $("addFilePosition");
  sel.innerHTML = "";
  for (let i = 0; i <= steps.length; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    if (i === steps.length) o.textContent = steps.length === 0 ? "First step" : `End (after step ${steps.length})`;
    else o.textContent = `Before step ${i + 1}`;
    sel.appendChild(o);
  }
  sel.value = String(steps.length);
}

async function saveFileStep() {
  if (!pendingFile) return;
  const scId = $("addFileScenario").value;
  const pos = parseInt($("addFilePosition").value, 10);
  const stepId = "st_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const newStep = {
    id: stepId,
    scenarioId: scId,
    caption: $("addFileCaption").value.trim() || "(added from file)",
    status: $("addFileStatus").value,
    expected: $("addFileExpected").value.trim(), actual: "",
    hasShot: true,
    width: pendingFile.width,
    height: pendingFile.height,
    pageUrl: "(imported file)",
    timestamp: new Date().toISOString()
  };
  // Store the image in its own key (matches how captured steps are stored),
  // so the gallery, popup, and export all find it via shot_{id}.
  await chrome.storage.local.set({ [`shot_${stepId}`]: pendingFile.dataUrl });
  const scenarioSteps = session.steps.filter((s) => s.scenarioId === scId);
  let globalIndex;
  if (pos >= scenarioSteps.length) {
    const last = scenarioSteps[scenarioSteps.length - 1];
    globalIndex = last ? session.steps.indexOf(last) + 1 : session.steps.length;
  } else {
    globalIndex = session.steps.indexOf(scenarioSteps[pos]);
  }
  session.steps.splice(globalIndex, 0, newStep);
  await persist();
  $("addFilePanel").classList.add("hidden");
  $("fileInput").value = "";
  pendingFile = null;
  renderSession();
}

function readAndDownscaleImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const MAX = 1280;
        if (width > MAX) { height = Math.round((MAX / width) * height); width = MAX; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), width, height });
      };
      img.onerror = () => reject(new Error("invalid image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function openGallery() {
  chrome.tabs.create({ url: chrome.runtime.getURL("gallery.html") });
}

// ---------- Render ----------
function renderSession() {
  const active = session.scenarios.find((sc) => sc.id === session.activeScenarioId) || session.scenarios[0];
  $("sessionLabel").textContent = session.meta.docTitle;
  $("sessionMeta").textContent = `${session.meta.tester} · ${session.meta.environment} · active: ${active ? active.testId : "—"}`;

  const total = session.steps.length;
  const pass = session.steps.filter((s) => s.status === "Pass").length;
  const fail = total - pass;
  const summary = $("summary");
  summary.querySelector(".total").textContent = `${total} step${total === 1 ? "" : "s"}`;
  summary.querySelector(".pass").textContent = `${pass} pass`;
  summary.querySelector(".fail").textContent = `${fail} fail`;

  const list = $("stepList");
  list.innerHTML = "";

  // Group by scenario, preserving scenario order; number steps per scenario.
  session.scenarios.forEach((sc) => {
    const steps = session.steps.filter((s) => s.scenarioId === sc.id);
    const group = document.createElement("div");
    group.className = "scenario-group";
    const head = document.createElement("div");
    head.className = "scenario-head";
    head.innerHTML = `<span class="sc-name">${escapeHtml(sc.testId)} — ${escapeHtml(sc.title)} <span class="sc-count">(${steps.length})</span></span>
      <button class="sc-edit" title="Rename this scenario">✎</button>
      <button class="sc-del" title="Delete this scenario">✕</button>`;
    head.querySelector(".sc-edit").addEventListener("click", () => renameScenario(sc.id));
    head.querySelector(".sc-del").addEventListener("click", () => deleteScenario(sc.id));
    group.appendChild(head);

    // Show newest steps first, but keep their real (capture-order) step numbers.
    steps.map((s, i) => ({ s, n: i + 1 })).reverse().forEach(({ s, n }) => {
      const row = document.createElement("div");
      row.className = "step-item";
      row.innerHTML = `
        <img class="shot-lazy" data-step-id="${s.id}" alt="step ${n}" />
        <div class="meta">
          <div class="cap">${n}. ${escapeHtml(s.caption)}</div>
          <div class="sub">${formatTime(s.timestamp)}</div>
        </div>
        <span class="st ${s.status}">${s.status}</span>
        <button class="edit" title="Edit">✎</button>
        <button class="del" title="Delete">✕</button>`;
      row.querySelector(".del").addEventListener("click", () => deleteStep(s.id));
      row.querySelector(".edit").addEventListener("click", () => openEditStep(s.id));
      group.appendChild(row);
    });
    list.appendChild(group);
  });

  $("exportBtn").disabled = total === 0;
  observeLazyShots();
}

// Lazy-load step thumbnails: only fetch a screenshot's image data when its row
// scrolls into view, so the popup stays fast no matter how many steps exist.
let shotObserver = null;
function observeLazyShots() {
  if (shotObserver) shotObserver.disconnect();
  const imgs = document.querySelectorAll("img.shot-lazy:not([data-loaded])");
  if (!imgs.length) return;
  shotObserver = new IntersectionObserver((entries) => {
    const toLoad = [];
    entries.forEach((e) => {
      if (e.isIntersecting) {
        toLoad.push(e.target);
        shotObserver.unobserve(e.target);
      }
    });
    if (toLoad.length) loadShotsFor(toLoad);
  }, { root: $("stepList"), rootMargin: "200px" });
  imgs.forEach((img) => shotObserver.observe(img));
}

async function loadShotsFor(imgEls) {
  const ids = imgEls.map((el) => el.dataset.stepId);
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_SHOTS", ids });
    if (res && res.ok) {
      imgEls.forEach((el) => {
        const src = res.shots[el.dataset.stepId];
        if (src) { el.src = src; el.setAttribute("data-loaded", "1"); }
      });
    }
  } catch (e) { /* leave placeholder */ }
}

// ---------- Azure DevOps: settings ----------
async function toggleAdoPanel() {
  const panel = $("adoPanel");
  const hidden = panel.classList.contains("hidden");
  if (hidden) {
    const stored = await chrome.storage.local.get(ADO_KEY);
    const s = stored[ADO_KEY] || {};
    $("adoOrg").value = s.org || "";
    $("adoProject").value = s.project || "";
    $("adoPat").value = s.pat || "";
    $("adoTeam").value = s.team || "";
    $("adoAreaPath").value = s.areaPath || "";
    $("adoDefAssigned").value = s.defAssigned || "";
    $("adoDefFields").value = s.defFields || "";
    $("adoSignoffPresets").value = s.signoffPresets || "";
    $("adoDefTasks").value = s.defTasks || "";
  }
  panel.classList.toggle("hidden");
}

async function saveAdoSettings() {
  const prev = (await chrome.storage.local.get(ADO_KEY))[ADO_KEY] || {};
  const s = {
    org: $("adoOrg").value.trim(),
    project: $("adoProject").value.trim(),
    pat: $("adoPat").value.trim(),
    team: $("adoTeam").value.trim(),
    areaPath: $("adoAreaPath").value.trim(),
    defAssigned: $("adoDefAssigned").value.trim(),
    defFields: $("adoDefFields").value.trim(),
    signoffPresets: $("adoSignoffPresets").value.trim(),
    defTasks: $("adoDefTasks").value.trim()
  };
  const st = $("adoSettingsStatus");
  if (!s.org || !s.project || !s.pat) { st.textContent = "Org, Project, and PAT are required."; return; }
  await chrome.storage.local.set({ [ADO_KEY]: s });
  st.textContent = "Saved ✓";
}

async function testAdoConnection() {
  const st = $("adoSettingsStatus");
  st.textContent = "Testing…";
  const settings = {
    org: $("adoOrg").value.trim(),
    project: $("adoProject").value.trim(),
    pat: $("adoPat").value.trim()
  };
  const res = await chrome.runtime.sendMessage({ type: "ADO_TEST", settings });
  st.textContent = res && res.ok ? "✓ " + res.message : "✗ " + (res?.error || "failed");
}

async function discoverAdoFields() {
  const st = $("adoSettingsStatus");
  const out = $("adoDiscoverOut");
  const wtype = $("adoDiscoverType").value;
  st.textContent = `Discovering ${wtype} fields…`;
  const res = await chrome.runtime.sendMessage({ type: "ADO_DISCOVER", workItemType: wtype });
  if (!res || !res.ok) { st.textContent = "✗ " + (res?.error || "failed"); return; }
  st.textContent = `${wtype}: ${res.required.length} required · ${res.all.length} total fields.`;
  const fmt = (f) => `${f.required ? "★ " : "  "}${f.label}\n      ${f.name}=`;
  const out_text =
    `Fields for ${wtype}.  ★ = required.\n` +
    `Copy the reference name (before the =) into your defaults or sign-off preset.\n\n` +
    res.all.map(fmt).join("\n");
  out.textContent = out_text;
  out.classList.remove("hidden");
}

async function clearAdoSettings() {
  await chrome.storage.local.remove(ADO_KEY);
  $("adoOrg").value = ""; $("adoProject").value = ""; $("adoPat").value = "";
  $("adoSettingsStatus").textContent = "Cleared.";
}

// ---------- QBR sprint report (hidden panel) ----------
let lastQbrData = null; // kept for CSV export

function quarterDateRange(quarter, year) {
  const q = Number(quarter), y = Number(year);
  const startMonth = (q - 1) * 3; // 0-indexed: Q1->0(Jan), Q2->3(Apr), Q3->6(Jul), Q4->9(Oct)
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, startMonth + 3, 0, 23, 59, 59)); // last day of 3rd month
  return { start: start.toISOString(), end: end.toISOString() };
}

async function openQbrPanel() {
  const stored = (await chrome.storage.local.get(QBR_KEY))[QBR_KEY] || {};
  $("qbrReleaseField").value = stored.releaseField || "Custom.Release#";
  $("qbrStatusField").value = stored.statusField || "Custom.ItemStatus";
  $("qbrReleasedValue").value = stored.releasedValue || "K) In Production";
  $("qbrCompletedState").value = stored.completedState || "Closed";
  $("qbrStoryType").value = stored.storyType || "User Story";
  $("qbrBugType").value = stored.bugType || "Defect";
  $("qbrTaskType").value = stored.taskType || "Task";
  $("qbrTestCaseType").value = stored.testCaseType || "Test Case";
  if (!$("qbrYear").value) $("qbrYear").value = new Date().getFullYear();
  $("qbrResults").innerHTML = "";
  $("qbrStatus").textContent = "";
  $("qbrExportBtn").disabled = true;
  $("qbrPanel").classList.remove("hidden");
}

async function saveQbrFieldSettings() {
  const s = {
    releaseField: $("qbrReleaseField").value.trim(),
    statusField: $("qbrStatusField").value.trim(),
    releasedValue: $("qbrReleasedValue").value.trim(),
    completedState: $("qbrCompletedState").value.trim(),
    storyType: $("qbrStoryType").value.trim(),
    bugType: $("qbrBugType").value.trim(),
    taskType: $("qbrTaskType").value.trim(),
    testCaseType: $("qbrTestCaseType").value.trim()
  };
  await chrome.storage.local.set({ [QBR_KEY]: s });
}

async function fetchQbrData() {
  const st = $("qbrStatus");
  st.textContent = "Fetching from Azure DevOps…";
  $("qbrResults").innerHTML = "";
  $("qbrExportBtn").disabled = true;

  const quarter = $("qbrQuarter").value;
  const year = $("qbrYear").value;
  if (!year) { st.textContent = "Enter a year."; return; }
  const { start, end } = quarterDateRange(quarter, year);

  const opts = {
    quarterStart: start,
    quarterEnd: end,
    releaseField: $("qbrReleaseField").value.trim(),
    statusField: $("qbrStatusField").value.trim(),
    releasedValue: $("qbrReleasedValue").value.trim(),
    completedState: $("qbrCompletedState").value.trim(),
    storyType: $("qbrStoryType").value.trim(),
    bugType: $("qbrBugType").value.trim(),
    taskType: $("qbrTaskType").value.trim(),
    testCaseType: $("qbrTestCaseType").value.trim()
  };
  await saveQbrFieldSettings();

  const res = await chrome.runtime.sendMessage({ type: "QBR_FETCH", opts });
  if (!res || !res.ok) {
    st.textContent = "✗ " + (res?.error || "Failed to fetch.");
    return;
  }
  lastQbrData = res.data;
  st.textContent = `✓ Q${quarter} ${year} — ${res.data.iterationCount} iteration(s) found.`;
  renderQbrResults(res.data, quarter, year);
  $("qbrExportBtn").disabled = false;
}

function renderQbrResults(data, quarter, year) {
  const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  let html = `<div class="summary" style="margin:10px 0;">
    <span class="pill total">${data.iterationCount} iterations</span>
    <span class="pill">${data.releaseCount} releases</span>
    <span class="pill pass">${data.totals.velocity} velocity</span>
    <span class="pill pass">${data.totals.storyPoints} story pts</span>
    <span class="pill">${data.totals.storyCount} stories</span>
    <span class="pill fail">${data.totals.defectCount} defects</span>
    <span class="pill">${data.totals.testCaseCount} test cases</span>
  </div>`;
  html += `<table class="qbr-table" style="width:100%;font-size:12px;border-collapse:collapse;">
    <thead><tr>
      <th style="text-align:left;">Sprint</th><th>Dates</th><th style="text-align:left;">Iteration Path</th><th style="text-align:left;">Area Path</th><th>Velocity</th><th>Story Points</th><th>Stories</th><th>Defects</th><th>Test Cases</th><th>Releases</th>
    </tr></thead><tbody>`;
  for (const it of data.iterations) {
    const s = it.startDate ? it.startDate.slice(0, 10) : "";
    const f = it.finishDate ? it.finishDate.slice(0, 10) : "";
    const areaPaths = (it.areaPaths || []).join(", ");
    const releaseTitle = (it.releaseValues || []).join(", ");
    html += `<tr>
      <td>${esc(it.name)}</td>
      <td>${s} → ${f}</td>
      <td style="font-size:11px;color:var(--muted,#888);">${esc(it.path)}</td>
      <td style="font-size:11px;color:var(--muted,#888);">${esc(areaPaths)}</td>
      <td style="text-align:center;">${it.velocity}</td>
      <td style="text-align:center;">${it.storyPoints}</td>
      <td style="text-align:center;">${it.storyCount}</td>
      <td style="text-align:center;">${it.defectCount}</td>
      <td style="text-align:center;">${it.testCaseCount}</td>
      <td style="text-align:center;" title="${esc(releaseTitle)}">${it.releaseCount}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  html += `<p class="hint">Velocity = total points from every Closed item except Task/Test Case (Defects included). Story Points = points from Closed User Story items only. Stories = exact "User Story" type only; anything else (e.g. Support Ticket) still counts toward Velocity but not Stories or Defects. Test Cases aren't gated by State — all Test Cases in the sprint/area are counted regardless of status. All scoped to exact Iteration Path + exact Area Path.</p>`;
  if (data.testCaseDiag) {
    const d = data.testCaseDiag;
    html += `<div class="hint" style="border:1px solid var(--fail-dot,#c00);padding:6px 8px;border-radius:4px;margin-top:6px;">
      <strong>Test Cases came back as 0 — diagnostic:</strong><br/>
      Matching Area Path only (any iteration): ${d.areaOnlyError ? "error: " + esc(d.areaOnlyError) : d.areaOnlyCount}<br/>
      Matching Iteration Path only (any area): ${d.iterationOnlyError ? "error: " + esc(d.iterationOnlyError) : d.iterationOnlyCount}<br/>
      ${d.areaOnlyCount > 0 && d.iterationOnlyCount === 0
        ? "→ Test Cases exist in your Area, but none have their Iteration Path set to this exact sprint. They're likely scheduled at a coarser level (e.g. Release, not Sprint)."
        : d.iterationOnlyCount > 0 && d.areaOnlyCount === 0
        ? "→ Test Cases exist in this sprint, but under a different Area Path than " + esc(areaPathUsedLabel(data)) + ". Check the Area Path field mapping."
        : (d.areaOnlyCount === 0 && d.iterationOnlyCount === 0)
        ? "→ No Test Cases match Area or Iteration individually either — check the Test Case type name and that Test Cases in this project use Area/Iteration Path at all."
        : ""}
    </div>`;
  }
  if (data.releaseValues.length) {
    html += `<p class="hint">Release# values seen: ${data.releaseValues.map(esc).join(", ")}</p>`;
  }
  $("qbrResults").innerHTML = html;
}

function areaPathUsedLabel(data) {
  return (data.iterations && data.iterations[0] && data.iterations[0].areaPaths && data.iterations[0].areaPaths[0]) || "the configured Area Path";
}

function exportQbrCsv() {
  if (!lastQbrData) return;
  const rows = [["Sprint", "Start", "Finish", "Iteration Path", "Area Path", "Velocity", "Story Points", "Stories", "Defects", "Test Cases", "Releases", "Release# values"]];
  for (const it of lastQbrData.iterations) {
    rows.push([
      it.name,
      it.startDate?.slice(0, 10) || "",
      it.finishDate?.slice(0, 10) || "",
      it.path || "",
      (it.areaPaths || []).join("; "),
      it.velocity, it.storyPoints, it.storyCount, it.defectCount, it.testCaseCount,
      it.releaseCount, (it.releaseValues || []).join("; ")
    ]);
  }
  rows.push([]);
  rows.push(["Totals", "", "", "", "", lastQbrData.totals.velocity, lastQbrData.totals.storyPoints, lastQbrData.totals.storyCount, lastQbrData.totals.defectCount, lastQbrData.totals.testCaseCount, lastQbrData.releaseCount]);
  rows.push(["Iterations", lastQbrData.iterationCount]);
  rows.push(["Releases", lastQbrData.releaseCount]);
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qbr_${$("qbrQuarter").value ? "Q" + $("qbrQuarter").value : ""}_${$("qbrYear").value || ""}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Sign-off presets ----------
// Parse the presets textarea: "Name | State | Field=Value;Field2=Value | Comment" per line.
function parseSignoffPresets(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      return {
        name: parts[0] || "(unnamed)",
        state: parts[1] || "",
        fields: (parts[2] || "").replace(/;/g, ","), // normalize to comma-separated for parseExtraFields
        comment: parts[3] || ""
      };
    });
}

let signoffPresets = [];

async function loadSignoffPresets() {
  const stored = await chrome.storage.local.get(ADO_KEY);
  const raw = (stored[ADO_KEY] || {}).signoffPresets || "";
  signoffPresets = parseSignoffPresets(raw);
  const sel = $("pushSignoffPreset");
  if (!sel) return;
  sel.innerHTML = '<option value="">— None (just attach) —</option>';
  signoffPresets.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.name;
    sel.appendChild(o);
  });
}

function updateSignoffPreview() {
  const sel = $("pushSignoffPreset");
  const preview = $("pushSignoffPreview");
  const idx = sel.value;
  if (idx === "") { preview.textContent = "No status change — attaches the Word log only."; return; }
  const p = signoffPresets[parseInt(idx, 10)];
  if (!p) { preview.textContent = ""; return; }
  const bits = [];
  if (p.state) bits.push(`State → "${p.state}"`);
  if (p.fields) bits.push(`Fields: ${p.fields}`);
  if (p.comment) bits.push("Comment from template");
  preview.textContent = bits.join(" · ") || "(preset has no actions)";
}

// ---------- Azure DevOps: push ----------
async function openPushPanel() {
  const stored = await chrome.storage.local.get(ADO_KEY);
  if (!stored[ADO_KEY]) {
    $("status").textContent = "Configure Azure DevOps first (⚙ ADO).";
    return;
  }
  const sel = $("pushScenario");
  sel.innerHTML = "";
  // Bulk option (used by Create Test Case to make one test case per scenario).
  const allOpt = document.createElement("option");
  allOpt.value = "__all__";
  allOpt.textContent = `★ All scenarios (separate test cases) — ${session.scenarios.length}`;
  sel.appendChild(allOpt);
  session.scenarios.forEach((sc) => {
    const count = session.steps.filter((s) => s.scenarioId === sc.id).length;
    const opt = document.createElement("option");
    opt.value = sc.id;
    opt.textContent = `${sc.testId} — ${sc.title} (${count})`;
    sel.appendChild(opt);
  });
  // Default the panel to "Create a new Bug", then set the scenario default for that mode.
  $("pushMode").value = "new";
  $("pushWorkItemWrap").classList.add("hidden");
  $("pushSteps").value = "all";
  $("pushStatus").textContent = "";
  applyScenarioDefault();
  await loadSignoffPresets();
  updateSignoffPreview();
  $("pushPanel").classList.remove("hidden");
}

function applyScenarioDefault() {
  const sel = $("pushScenario");
  if (!sel || !session) return;
  if ($("pushMode").value === "testcase") {
    sel.value = "__all__";
  } else {
    sel.value = session.scenarios.length ? session.scenarios[0].id : "__all__";
  }
}

async function doPush() {
  const st = $("pushStatus");
  const options = {
    mode: $("pushMode").value,
    workItemId: $("pushWorkItemId").value.trim(),
    onlyFailed: $("pushSteps").value === "failed",
    assignedTo: $("pushAssignedTo").value.trim(),
    extraFields: $("pushExtraFields").value.trim(),
    parentId: $("pushParentId").value.trim(),
    useCurrentIteration: $("pushUseCurrentIter").checked
  };
  // Sign-off (only relevant for "existing" attach mode).
  if (options.mode === "existing") {
    const idx = $("pushSignoffPreset").value;
    const p = idx !== "" ? signoffPresets[parseInt(idx, 10)] : null;
    const closeChildren = $("pushCloseChildren").checked;
    if (p || closeChildren) {
      options.signoff = {
        applyComment: p ? $("pushApplyComment").checked : false,
        applyState: p ? $("pushApplyState").checked : false,
        applyFields: p ? $("pushApplyFields").checked : false,
        commentTemplate: p ? p.comment : "",
        state: p ? p.state : "",
        fields: p ? p.fields : "",
        closeChildren,
        closeTasksPrefix: closeChildren && $("pushCloseTasks").checked ? $("pushClosePrefix").value.trim() : "",
        closeTestCases: closeChildren && $("pushCloseTestCases").checked
      };
    }
  }
  const scenarioId = $("pushScenario").value;
  if (options.mode === "existing" && !options.workItemId) { st.textContent = "Enter a work item ID."; return; }
  if (scenarioId === "__all__" && options.mode !== "testcase") {
    st.textContent = "“All scenarios” only applies to Create Test Case. Pick a single scenario for this action.";
    return;
  }

  $("pushGoBtn").disabled = true;
  try {
    // ----- Bulk: one Test Case per scenario, all under the same parent -----
    if (scenarioId === "__all__") {
      const scenarios = session.scenarios.filter((sc) => session.steps.some((s) => s.scenarioId === sc.id));
      if (!scenarios.length) throw new Error("No scenarios with steps to create test cases from.");
      const created = [];
      for (let i = 0; i < scenarios.length; i++) {
        st.textContent = `Creating Test Case ${i + 1} of ${scenarios.length}…`;
        const res = await chrome.runtime.sendMessage({
          type: "ADO_PUSH",
          scenarioId: scenarios[i].id,
          options: { ...options }
        });
        if (!res || !res.ok) throw new Error(`Scenario "${scenarios[i].testId}": ${res?.error || "failed"} (${created.length} created before this).`);
        created.push(res);
        await recordPush({
          kind: "Test Case", scenario: scenarios[i].testId + " — " + scenarios[i].title,
          workItemId: res.workItemId, workItemUrl: res.workItemUrl,
          docTitle: session.meta.docTitle, parentId: options.parentId || ""
        });
      }
      st.innerHTML = `✓ Created ${created.length} test cases: ` +
        created.map((r) => `<a href="${r.workItemUrl}" target="_blank">#${r.workItemId}</a>`).join(", ") +
        (options.parentId ? ` (all under #${options.parentId})` : "");
      return;
    }

    // For "attach to existing", build the whole-document Word file here (where
    // the docx library lives) and hand the bytes to the background to upload —
    // but only if the user wants the document attached this time.
    if (options.mode === "existing") {
      options.attachDoc = $("pushAttachDoc").checked;
      if (options.attachDoc) {
        st.textContent = "Building Word document…";
        const blob = await buildDocx(session);          // entire document, all scenarios
        const base64 = await blobToBase64(blob);
        const fileName = `${(session.meta.docTitle || "TestLog").replace(/[^\w.-]+/g, "_")}.docx`;
        options.docBase64 = base64;
        options.docFileName = fileName;
      }
    }

    const verb = options.mode === "existing" ? "Uploading to work item…"
      : options.mode === "testcase" ? "Creating Test Case…"
      : "Pushing… (uploading screenshots)";
    st.textContent = verb;
    const res = await chrome.runtime.sendMessage({
      type: "ADO_PUSH",
      scenarioId,
      options
    });
    if (!res || !res.ok) throw new Error(res?.error || "Push failed.");

    // Build an accurate history label describing what actually happened.
    let kindLabel;
    if (options.mode === "testcase") {
      kindLabel = "Test Case";
    } else if (options.mode === "existing") {
      const parts = [];
      if (options.attachDoc) parts.push("Word log attached");
      if (res.appliedState) parts.push("State updated");
      else if (options.signoff && options.signoff.applyComment) parts.push("Comment posted");
      if (res.closed && res.closed.length) parts.push(`Closed ${res.closed.length} child item${res.closed.length === 1 ? "" : "s"}`);
      kindLabel = parts.length ? parts.join(" · ") : "Sign-off";
    } else {
      kindLabel = "Bug";
    }

    const scLabel = (() => {
      // For attach/sign-off/close actions, the row isn't about a single scenario —
      // show the document title (or nothing) rather than a blank "scenario".
      if (options.mode === "existing") {
        return session.meta.docTitle && session.meta.docTitle.trim() ? session.meta.docTitle : "";
      }
      const sc = session.scenarios.find((x) => x.id === scenarioId);
      return sc ? sc.testId + " — " + sc.title : "";
    })();
    await recordPush({
      kind: kindLabel, scenario: scLabel,
      workItemId: res.workItemId, workItemUrl: res.workItemUrl,
      docTitle: session.meta.docTitle, parentId: options.parentId || options.workItemId || ""
    });
    if (options.mode === "existing") {
      const extra = res.appliedState ? ` · State set to "${res.appliedState}"` : "";
      let closeMsg = "";
      if (res.closed && res.closed.length) closeMsg = ` · Closed ${res.closed.length} child item${res.closed.length === 1 ? "" : "s"}`;
      if (res.closeSkipped && res.closeSkipped.length) closeMsg += ` (${res.closeSkipped.length} skipped)`;
      const lead = options.attachDoc ? "Attached Word log to work item" : "Updated work item";
      st.innerHTML = `✓ ${lead} ` +
        `<a href="${res.workItemUrl}" target="_blank">#${res.workItemId}</a>${extra}${closeMsg}.`;
    } else {
      st.innerHTML = `✓ Created work item ` +
        `<a href="${res.workItemUrl}" target="_blank">#${res.workItemId}</a> (${res.pushed} step${res.pushed === 1 ? "" : "s"}).`;
    }
  } catch (e) {
    st.textContent = "✗ " + e.message;
  } finally {
    $("pushGoBtn").disabled = false;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]); // strip data: prefix
    r.onerror = () => reject(new Error("Failed to encode document."));
    r.readAsDataURL(blob);
  });
}

// ---------- Word export ----------
async function exportDocx() {
  if (!session || !session.steps.length) return;
  const status = $("status");
  status.textContent = "Building Word document…";

  try {
    const blob = await buildDocx(session);
    const url = URL.createObjectURL(blob);
    const safeId = (session.meta.docTitle || "TestLog").replace(/[^\w.-]+/g, "_");
    const a = document.createElement("a");
    a.href = url;
    a.download = `TestLog_${safeId}_${dateStamp()}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    status.textContent = "Exported ✓";
  } catch (e) {
    status.textContent = "Export failed: " + e.message;
  }
}

// Load the (large) docx library on demand — only when exporting — so it doesn't
// slow down every popup open. Cached after first load.
let _docxLoaded = null;
function ensureDocxLoaded() {
  if (window.docx) return Promise.resolve();
  if (_docxLoaded) return _docxLoaded;
  _docxLoaded = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "lib/docx.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the document library."));
    document.head.appendChild(s);
  });
  return _docxLoaded;
}

async function buildDocx(sess) {
  await ensureDocxLoaded();
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    ImageRun, AlignmentType
  } = docx;

  // Fetch all step images up front (they're stored separately for performance).
  const allIds = sess.steps.map((s) => s.id);
  let shotMap = {};
  if (allIds.length) {
    const res = await chrome.runtime.sendMessage({ type: "GET_SHOTS", ids: allIds });
    if (res && res.ok) shotMap = res.shots;
  }

  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const borders = { top: border, bottom: border, left: border, right: border };
  // Narrow margins (0.5") => wider content area on US Letter
  const MARGIN = 720;                       // 0.5 inch
  const CONTENT_WIDTH = 12240 - MARGIN * 2; // 10800 DXA

  const children = [];
  const imgBorder = { style: BorderStyle.SINGLE, size: 4, color: "888888" };

  // Document title + session-wide metadata
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(sess.meta.docTitle || "Test Execution Log")] }));
  const sessRows = [
    ["Tester", sess.meta.tester],
    ["Environment", sess.meta.environment],
    ["Executed", formatTime(sess.meta.started)]
  ].map(([k, v]) => new TableRow({ children: [cell(k, 2800, "F0F3F7", true), cell(v, 8000)] }));
  children.push(new Table({ width: { size: CONTENT_WIDTH, type: WidthType.DXA }, columnWidths: [2800, 8000], rows: sessRows }));
  children.push(spacer());

  // One block per scenario
  sess.scenarios.forEach((sc, sidx) => {
    const steps = sess.steps.filter((s) => s.scenarioId === sc.id);
    const sTotal = steps.length;
    const sPass = steps.filter((s) => s.status === "Pass").length;
    const sFail = sTotal - sPass;
    const sRate = sTotal ? Math.round((sPass / sTotal) * 100) : 0;

    // Scenario heading
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(`${sidx + 1}. ${sc.testId} — ${sc.title}`)]
    }));

    // Scenario summary table
    children.push(new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [2700, 2700, 2700, 2700],
      rows: [
        new TableRow({ children: ["Steps", "Passed", "Failed", "Pass Rate"].map((h) => cell(h, 2700, "F0F3F7", true, AlignmentType.CENTER)) }),
        new TableRow({ children: [
          cell(String(sTotal), 2700, null, false, AlignmentType.CENTER),
          cell(String(sPass), 2700, "DCFCE7", false, AlignmentType.CENTER),
          cell(String(sFail), 2700, sFail ? "FEE2E2" : null, false, AlignmentType.CENTER),
          cell(sRate + "%", 2700, null, false, AlignmentType.CENTER)
        ] })
      ]
    }));
    children.push(spacer());

    if (sTotal === 0) {
      children.push(new Paragraph({ children: [new TextRun({ text: "No steps captured for this scenario.", italics: true, color: "6B7785" })] }));
      children.push(spacer());
      return;
    }

    // Steps — numbered from 1 within this scenario
    steps.forEach((s, i) => {
      children.push(new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [
          new TextRun({ text: `Step ${i + 1}: `, bold: true }),
          new TextRun({ text: s.caption }),
          new TextRun({ text: `   [${s.status}]`, bold: true, color: s.status === "Pass" ? "15803D" : "B91C1C" })
        ]
      }));

      const shotData = shotMap[s.id] || s.dataUrl; // fallback for legacy in-session images
      if (shotData) {
        const bytes = dataUrlToUint8(shotData);
        const dispWidth = 720;
        const dispHeight = Math.round((dispWidth / s.width) * s.height);
        children.push(new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [CONTENT_WIDTH],
          rows: [new TableRow({ children: [new TableCell({
            borders: { top: imgBorder, bottom: imgBorder, left: imgBorder, right: imgBorder },
            width: { size: CONTENT_WIDTH, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ type: "jpg", data: bytes, transformation: { width: dispWidth, height: dispHeight } })]
            })]
          })] })]
        }));
      }

      children.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: `${truncate(s.pageUrl, 90)}  ·  ${formatTime(s.timestamp)}`, italics: true, size: 18, color: "6B7785" })]
      }));

      if (s.status === "Fail" && (s.expected || s.actual)) {
        children.push(new Table({
          width: { size: CONTENT_WIDTH, type: WidthType.DXA },
          columnWidths: [2200, 8600],
          rows: [
            new TableRow({ children: [cell("Expected", 2200, "F0F3F7", true), cell(s.expected || "—", 8600)] }),
            new TableRow({ children: [cell("Actual", 2200, "F0F3F7", true), cell(s.actual || "—", 8600)] })
          ]
        }));
      }
    });

    children.push(spacer());
  });

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Arial" }, paragraph: { spacing: { before: 120, after: 200 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: "Arial" }, paragraph: { spacing: { before: 240, after: 120 } } }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
      children
    }]
  });

  return Packer.toBlob(doc);

  // --- local helpers using closed-over docx classes ---
  function cell(text, width, fill, bold, align) {
    return new TableCell({
      borders,
      width: { size: width, type: WidthType.DXA },
      ...(fill ? { shading: { fill, type: ShadingType.CLEAR } } : {}),
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ ...(align ? { alignment: align } : {}), children: [new TextRun({ text: String(text), bold: !!bold })] })]
    });
  }
  function spacer() { return new Paragraph({ children: [new TextRun("")] }); }
}

// ---------- Utilities ----------
function dataUrlToUint8(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : (s || ""); }
