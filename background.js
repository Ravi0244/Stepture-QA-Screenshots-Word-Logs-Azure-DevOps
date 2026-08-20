// background.js — service worker
// Handles: injecting the on-page overlay, capturing page+annotations,
// downscaling, and appending steps to the stored session.

// SECURITY: content.js is injected into whatever page is active when capturing
// (host_permissions includes <all_urls> so it can annotate/screenshot any page
// under test). By default, chrome.storage.local is readable by content scripts
// on ANY page. content.js never needs the ADO PAT or anything else in storage —
// so lock storage.local to extension-only contexts (background + popup) and
// close that door entirely. Must be re-set on every service worker startup,
// since it isn't persisted by Chrome.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

const STORAGE_KEY = "qa_testlog_session";
const BACKUP_KEY = "qa_testlog_session_backup";   // silent auto-snapshot for recovery
const ADO_KEY = "qa_testlog_ado";   // { org, project, pat }
const IMGQ_KEY = "qa_testlog_imgquality"; // "standard" | "high" — set from the popup toggle
const IMG_PRESETS = {
  standard: { maxWidth: 1600, quality: 0.92 }, // faster, smaller files — good default
  high:     { maxWidth: 1920, quality: 0.95 }  // sharper, larger files — use for fine-detail UI work
};
async function getImgPreset() {
  const stored = await chrome.storage.local.get(IMGQ_KEY);
  return IMG_PRESETS[stored[IMGQ_KEY]] || IMG_PRESETS.standard;
}

// Show the welcome / "pin me" page once, on first install.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "INJECT_OVERLAY":
      injectOverlay().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "CAPTURE_PAGE":
      captureAndProcess(sender.tab).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADD_STEP":
      addStep(msg.step).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "GET_SHOTS":
      // Fetch image data for a list of step ids (on-demand, so the popup/gallery
      // only load images they actually need to show).
      (async () => {
        const keys = (msg.ids || []).map((id) => `shot_${id}`);
        const data = keys.length ? await chrome.storage.local.get(keys) : {};
        const shots = {};
        (msg.ids || []).forEach((id) => { shots[id] = data[`shot_${id}`] || null; });
        sendResponse({ ok: true, shots });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "GET_BACKUP":
      // Report whether a recoverable snapshot exists (and is non-empty), used to
      // offer "restore" when the live session is missing.
      (async () => {
        const stored = await chrome.storage.local.get(BACKUP_KEY);
        const b = stored[BACKUP_KEY];
        if (b && b.session && b.session.steps && b.session.steps.length) {
          sendResponse({ ok: true, exists: true, savedAt: b.savedAt, steps: b.session.steps.length });
        } else {
          sendResponse({ ok: true, exists: false });
        }
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "RESTORE_BACKUP":
      (async () => {
        const stored = await chrome.storage.local.get(BACKUP_KEY);
        const b = stored[BACKUP_KEY];
        if (!b || !b.session) { sendResponse({ ok: false, error: "No backup to restore." }); return; }
        await chrome.storage.local.set({ [STORAGE_KEY]: b.session });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "NEW_SCENARIO":
      newScenario(msg.testId, msg.title).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "GET_ACTIVE_SCENARIO":
      getActiveScenario().then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_TEST":
      adoTestConnection(msg.settings).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_PUSH":
      adoPushScenario(msg.scenarioId, msg.options).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_DISCOVER":
      adoDiscoverFields(msg.workItemType).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_TEST_MENTION":
      (async () => {
        const s = await getAdoSettings();
        const diag = {};
        const ident = await adoResolveIdentity(s, msg.email, diag);
        if (ident) sendResponse({ ok: true, ...ident, diag });
        else sendResponse({ ok: false, error: "No ADO user matched.", diag });
      })();
      return true;

    case "ADO_FIND_WORKITEMS":
      (async () => {
        const s = await getAdoSettings();
        const items = await adoFindWorkItems(s, msg.opts || {});
        sendResponse({ ok: true, items });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "QBR_FETCH":
      (async () => {
        const s = await getAdoSettings();
        const data = await adoFetchQbr(s, msg.opts || {});
        sendResponse({ ok: true, data });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_BULK_CREATE_TASKS":
      // Create the same task set under each selected parent. Per-parent reporting.
      (async () => {
        const s = await getAdoSettings();
        const perParent = [];
        for (const parentId of (msg.parentIds || [])) {
          try {
            const r = await adoCreateTasks(s, parentId, msg.titles, msg.options || {});
            perParent.push({ parentId, ok: true, created: r.created });
          } catch (e) {
            perParent.push({ parentId, ok: false, error: e.message });
          }
        }
        sendResponse({ ok: true, perParent });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_CREATE_TASKS":
      (async () => {
        const s = await getAdoSettings();
        const r = await adoCreateTasks(s, msg.parentId, msg.titles, msg.options || {});
        sendResponse({ ok: true, ...r });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_CLOSE_PREVIEW":
      // Read-only: report what WOULD be closed under each parent, without changing anything.
      (async () => {
        const s = await getAdoSettings();
        const perStory = [];
        for (const parentId of (msg.parentIds || [])) {
          try {
            const r = await adoFindClosableChildren(s, parentId, msg.closeTasksPrefix || "", !!msg.closeTestCases);
            perStory.push({ parentId, ok: true, toClose: r.toClose, alreadyClosed: r.alreadyClosed });
          } catch (e) {
            perStory.push({ parentId, ok: false, error: e.message });
          }
        }
        sendResponse({ ok: true, perStory });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_CLOSE_BATCH":
      // Close tasks + test cases under multiple parent stories in one call.
      (async () => {
        const s = await getAdoSettings();
        const perStory = [];
        for (const parentId of (msg.parentIds || [])) {
          try {
            const r = await adoCloseChildren(s, parentId, msg.closeTasksPrefix || "", !!msg.closeTestCases);
            perStory.push({ parentId, ok: true, closed: r.closed, skipped: r.skipped });
          } catch (e) {
            perStory.push({ parentId, ok: false, error: e.message });
          }
        }
        sendResponse({ ok: true, perStory });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ADO_PUSH_RECORDING":
      adoPushRecording(msg.options).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
  }
});

async function injectOverlay() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || "")) {
    throw new Error("Open a normal website tab to annotate (browser pages can't be captured).");
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  return { ok: true };
}

async function captureAndProcess(tab) {
  let target = tab;
  if (!target) {
    [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const url = target?.url || "";
  // Capture as JPEG rather than PNG: on large/high-DPI pages (e.g. Salesforce)
  // PNG capture is noticeably slower and produces a much larger data URL to move
  // and process. JPEG is faster end-to-end and fine for QA screenshots.
  let rawDataUrl;
  try {
    rawDataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "jpeg", quality: 90 });
  } catch (e) {
    // Fallback to PNG if JPEG capture isn't available for some reason.
    rawDataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "png" });
  }
  const preset = await getImgPreset();
  const processed = await downscale(rawDataUrl, preset);
  return {
    dataUrl: processed.dataUrl,
    width: processed.width,
    height: processed.height,
    pageUrl: url,
    timestamp: new Date().toISOString()
  };
}

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Silent auto-snapshot: keep a copy of the latest session (metadata) so an
// accidental Clear All or corruption can be recovered. Images live under their
// own shot_ keys and are not touched by this.
async function snapshotSession(session) {
  try {
    await chrome.storage.local.set({
      [BACKUP_KEY]: { session, savedAt: new Date().toISOString() }
    });
  } catch { /* best-effort; never block the main flow */ }
}

async function addStep(step) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const session = stored[STORAGE_KEY];
  if (!session || !session.steps) throw new Error("No active session.");
  if (!session.activeScenarioId) throw new Error("No active scenario.");
  step.id = genId("st_");
  step.scenarioId = session.activeScenarioId;
  // Store the (large) image under its own key so adding a step doesn't rewrite
  // every image in the session. The step metadata keeps only a reference.
  try {
    if (step.dataUrl) {
      await chrome.storage.local.set({ [`shot_${step.id}`]: step.dataUrl });
      step.hasShot = true;
      delete step.dataUrl;   // keep the session object small
    }
    session.steps.push(step);
    await chrome.storage.local.set({ [STORAGE_KEY]: session });
    await snapshotSession(session);   // keep a recovery copy
  } catch (e) {
    // Most likely cause historically was the storage quota; with unlimitedStorage
    // this should not happen, but surface it clearly instead of failing silently.
    throw new Error("Could not save the step (storage error: " + (e.message || e) + ").");
  }
  const scenarioCount = session.steps.filter((s) => s.scenarioId === session.activeScenarioId).length;
  return { count: session.steps.length, scenarioCount };
}

async function newScenario(testId, title) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const session = stored[STORAGE_KEY];
  if (!session || !session.scenarios) throw new Error("No active session.");
  const sc = { id: genId("sc_"), testId: testId || "(untitled)", title: title || "(no title)" };
  session.scenarios.push(sc);
  session.activeScenarioId = sc.id;
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
  return { scenario: sc };
}

async function getActiveScenario() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const session = stored[STORAGE_KEY];
  if (!session || !session.scenarios) return { scenario: null };
  const sc = session.scenarios.find((x) => x.id === session.activeScenarioId) || null;
  return { scenario: sc, index: sc ? session.scenarios.findIndex((x) => x.id === sc.id) + 1 : 0 };
}

async function downscale(dataUrl, preset) {
  const { maxWidth, quality } = preset || IMG_PRESETS.standard;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  let { width, height } = bitmap;
  if (width > maxWidth) {
    height = Math.round((maxWidth / width) * height);
    width = maxWidth;
  }
  const canvas = new OffscreenCanvas(width, height);
  const c = canvas.getContext("2d");
  c.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const outDataUrl = await blobToDataUrl(outBlob);
  return { dataUrl: outDataUrl, width, height };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Encode failed."));
    r.readAsDataURL(blob);
  });
}

// ===================== Azure DevOps integration =====================
// All ADO calls run here in the service worker to avoid page CORS issues.

// Query work items by state/type/scope using WIQL, then check which already have
// child Tasks. Returns [{ id, title, type, state, assignedTo, hasTasks }].
async function adoFindWorkItems(s, opts) {
  const types = (opts.types || []).filter(Boolean);
  const states = (opts.states || []).filter(Boolean);
  if (!types.length) throw new Error("Pick at least one work item type.");
  if (!states.length) throw new Error("Pick at least one state.");

  // Build WIQL. Escape single quotes in values.
  const esc = (v) => String(v).replace(/'/g, "''");
  const typeClause = "[System.WorkItemType] IN (" + types.map((t) => `'${esc(t)}'`).join(", ") + ")";
  const stateClause = "[System.State] IN (" + states.map((t) => `'${esc(t)}'`).join(", ") + ")";
  const clauses = [typeClause, stateClause];
  if (opts.scope === "mine") {
    clauses.push("[System.AssignedTo] = @Me");
  } else if (opts.scope === "area" && opts.areaPath) {
    // Users may type a double backslash (\\) out of habit; ADO wants a single one.
    const areaClean = opts.areaPath.replace(/\\\\/g, "\\");
    clauses.push(`[System.AreaPath] UNDER '${esc(areaClean)}'`);
  }
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.Id] DESC`;

  const qUrl = `${adoBase(s)}/wit/wiql?api-version=7.1`;
  const qRes = await fetch(qUrl, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json" },
    body: JSON.stringify({ query: wiql })
  });
  if (!qRes.ok) {
    const t = await qRes.text().catch(() => "");
    throw new Error(`Query failed (HTTP ${qRes.status}). Check that the state names match your project exactly. ${shorten(t)}`);
  }
  const qData = await qRes.json();
  const ids = (qData.workItems || []).map((w) => w.id);
  if (!ids.length) return [];

  // Batch-fetch details (+ relations to detect existing child tasks).
  // ADO caps batch size ~200; chunk to be safe.
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const url = `${adoBase(s)}/wit/workitemsbatch?api-version=7.1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: chunk,
        // NOTE: the batch API rejects `fields` and `$expand` together (HTTP 400).
        // We need relations to detect existing child tasks, so use $expand alone;
        // it returns all fields, and we read the ones we need below.
        $expand: "relations"
      })
    });
    if (!res.ok) throw new Error(`Could not read work item details (HTTP ${res.status}).`);
    const data = await res.json();
    for (const wi of (data.value || [])) {
      const rels = wi.relations || [];
      const hasTasks = rels.some((r) => r.rel === "System.LinkTypes.Hierarchy-Forward");
      const assigned = wi.fields["System.AssignedTo"];
      const iterPath = wi.fields["System.IterationPath"] || "";
      const iterShort = iterPath ? iterPath.split("\\").pop() : "";
      // Custom project field for item status (distinct from System.State).
      const itemStatus = wi.fields["Custom.ItemStatus"] || "";
      // Web URL to open the work item directly in ADO (browser edit view).
      const webUrl = `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_workitems/edit/${wi.id}`;
      out.push({
        id: wi.id,
        url: webUrl,
        title: wi.fields["System.Title"] || "",
        type: wi.fields["System.WorkItemType"] || "",
        state: wi.fields["System.State"] || "",
        itemStatus: itemStatus,
        assignedTo: assigned ? (assigned.displayName || "") : "(unassigned)",
        iteration: iterShort,
        iterationFull: iterPath,
        hasChildren: hasTasks
      });
    }
  }
  return out;
}

// ===================== QBR sprint-wise reporting =====================
// "Released" = itemStatus field equals opts.releasedValue (case-insensitive, trimmed).
// "Release count" = distinct non-empty values of the release# field seen among
// released items whose iteration falls inside the requested quarter.
//
// Two different query strategies are used because Test Cases in ADO are almost
// never assigned an Iteration Path (they live under Test Plans/Suites, not sprints),
// while User Stories/Bugs/Support Tickets etc. normally are:
//   - "Scheduled" types (story/bug/support...) → queried per-iteration by IterationPath.
//   - Test Case type → queried once for the whole quarter by the release# date field,
//     then bucketed into whichever sprint's date window that release date falls in.
// Velocity/points are summed for ANY released item that carries a points value
// (Story Points, falling back to Effort), regardless of work item type.
async function adoFetchQbr(s, opts) {
  if (!s.team) throw new Error("Set a Team in ADO settings first (needed to look up iterations).");
  const releaseField = (opts.releaseField || "Custom.Release#").trim();
  const statusField = (opts.statusField || "Custom.ItemStatus").trim();       // release-only gate
  const releasedValue = (opts.releasedValue || "K) In Production").trim().toLowerCase();
  const completedState = (opts.completedState || "Closed").trim();             // sprint-totals gate (System.State)
  const storyType = (opts.storyType || "User Story").trim();
  const bugType = (opts.bugType || "Defect").trim();
  const taskType = (opts.taskType || "Task").trim();
  const testCaseType = (opts.testCaseType || "Test Case").trim();
  const qStart = new Date(opts.quarterStart);
  const qEnd = new Date(opts.quarterEnd);
  if (isNaN(qStart) || isNaN(qEnd)) throw new Error("Invalid quarter date range.");

  const esc = (v) => String(v).replace(/'/g, "''");
  const getPoints = (f) => {
    const sp = f["Microsoft.VSTS.Scheduling.StoryPoints"];
    if (sp !== undefined && sp !== null && sp !== "") return Number(sp) || 0;
    const eff = f["Microsoft.VSTS.Scheduling.Effort"];
    if (eff !== undefined && eff !== null && eff !== "") return Number(eff) || 0;
    return 0;
  };
  // Item Status only determines whether this item counts toward Releases (both the per-sprint
  // column and the quarter total) — it never gates Stories/Defects/Test Cases/Points.
  const checkRelease = (f, acc, releaseValuesSeen) => {
    const status = String(f[statusField] || "").trim().toLowerCase();
    if (status === releasedValue) {
      const relVal = f[releaseField];
      if (relVal) {
        releaseValuesSeen.add(String(relVal));
        if (acc) acc.releaseValues.add(String(relVal));
      }
    }
  };

  // Scope to this team's own Area Path (same "Project\Team" default used elsewhere in ADO
  // settings), matched EXACTLY (=) — not "Under" — mirroring the real reporting query.
  const areaPath = effectiveAreaPath(s, s);
  if (!areaPath) throw new Error("Could not resolve an Area Path. Set Team (and/or a Default Area Path override) in ADO settings.");

  // 1. All iterations for the team, then keep only ones overlapping the quarter.
  const iterUrl = `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/${encodeURIComponent(s.team)}/_apis/work/teamsettings/iterations?api-version=7.1`;
  const iterRes = await fetch(iterUrl, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
  if (!iterRes.ok) throw new Error(`Could not read team iterations (HTTP ${iterRes.status}). Check Team name in ADO settings.`);
  const iterJson = await iterRes.json();
  const allIters = (iterJson.value || []).filter((it) => it.attributes && it.attributes.startDate && it.attributes.finishDate);
  const iters = allIters
    .filter((it) => {
      const st = new Date(it.attributes.startDate);
      const fn = new Date(it.attributes.finishDate);
      return st <= qEnd && fn >= qStart;
    })
    .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate));

  const releaseValuesSeen = new Set();
  const iterMap = new Map(); // path -> accumulator
  for (const it of iters) {
    iterMap.set(it.path, { name: it.name, path: it.path, startDate: it.attributes.startDate, finishDate: it.attributes.finishDate, velocity: 0, storyPoints: 0, storyCount: 0, defectCount: 0, testCaseCount: 0, areaPaths: new Set(), releaseValues: new Set() });
  }

  const areaClause = ` AND [System.AreaPath] = '${esc(areaPath)}'`;
  const stateClause = ` AND [System.State] = '${esc(completedState)}'`;

  // ---- Story Points / Stories / Defects: "everything except Task and Test Case", State = Closed ----
  // Mirrors the real ADO query: Work Item Type Not In (Task, Test Case), State = Closed, exact Area Path.
  const notInClause = `[System.WorkItemType] NOT IN ('${esc(taskType)}', '${esc(testCaseType)}')`;
  for (const it of iters) {
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${esc(it.path)}'${areaClause} AND ${notInClause}${stateClause} ORDER BY [System.Id]`;
    const ids = await runWiql(s, wiql, it.name);
    const acc = iterMap.get(it.path);
    for (const wi of await batchFetchWorkItems(s, ids, it.name)) {
      const f = wi.fields || {};
      const wiType = f["System.WorkItemType"] || "";
      checkRelease(f, acc, releaseValuesSeen);
      const itemAreaPath = f["System.AreaPath"];
      if (itemAreaPath) acc.areaPaths.add(itemAreaPath);

      const pts = getPoints(f);
      acc.velocity += pts; // total points across every non-Task/non-Test-Case Closed item
      if (wiType === bugType) {
        acc.defectCount++;
      } else if (wiType === storyType) {
        acc.storyCount++;
        acc.storyPoints += pts; // pure User Story points only
      }
      // Anything that's neither Defect nor User Story (e.g. Support Ticket) still contributes
      // to Velocity above, but isn't counted as a Story or a Defect.
    }
  }

  // ---- Test Cases: same Iteration/Area pattern, but NOT gated by State — Test Cases are
  // counted regardless of their status, unlike Stories/Defects. ----
  for (const it of iters) {
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${esc(it.path)}'${areaClause} AND [System.WorkItemType] = '${esc(testCaseType)}' ORDER BY [System.Id]`;
    const ids = await runWiql(s, wiql, it.name + " (Test Cases)");
    const acc = iterMap.get(it.path);
    for (const wi of await batchFetchWorkItems(s, ids, it.name + " (Test Cases)")) {
      const f = wi.fields || {};
      checkRelease(f, acc, releaseValuesSeen);
      const itemAreaPath = f["System.AreaPath"];
      if (itemAreaPath) acc.areaPaths.add(itemAreaPath);
      acc.testCaseCount++;
    }
  }

  const iterationResults = Array.from(iterMap.values()).map((it) => ({
    name: it.name,
    path: it.path,
    startDate: it.startDate,
    finishDate: it.finishDate,
    velocity: it.velocity,
    storyPoints: it.storyPoints,
    storyCount: it.storyCount,
    defectCount: it.defectCount,
    testCaseCount: it.testCaseCount,
    releaseCount: it.releaseValues.size,
    releaseValues: Array.from(it.releaseValues),
    areaPaths: Array.from(it.areaPaths)
  }));
  const totals = iterationResults.reduce((acc, it) => {
    acc.velocity += it.velocity;
    acc.storyPoints += it.storyPoints;
    acc.storyCount += it.storyCount;
    acc.defectCount += it.defectCount;
    acc.testCaseCount += it.testCaseCount;
    return acc;
  }, { velocity: 0, storyPoints: 0, storyCount: 0, defectCount: 0, testCaseCount: 0 });

  // If no Test Cases were found, run diagnostic queries to isolate why: drop Iteration (keep Area),
  // drop Area (keep Iteration) — whichever comes back non-zero tells us which filter is excluding them.
  let testCaseDiag = null;
  if (totals.testCaseCount === 0 && testCaseType && iters.length) {
    testCaseDiag = { areaOnlyCount: null, iterationOnlyCount: null };
    try {
      const w = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${esc(testCaseType)}'${areaClause} ORDER BY [System.Id]`;
      testCaseDiag.areaOnlyCount = (await runWiql(s, w, "Test Case diag (area only)")).length;
    } catch (e) { testCaseDiag.areaOnlyError = e.message; }
    try {
      const iterClause = iters.map((it) => `[System.IterationPath] = '${esc(it.path)}'`).join(" OR ");
      const w = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${esc(testCaseType)}' AND (${iterClause}) ORDER BY [System.Id]`;
      testCaseDiag.iterationOnlyCount = (await runWiql(s, w, "Test Case diag (iteration only)")).length;
    } catch (e) { testCaseDiag.iterationOnlyError = e.message; }
  }

  return {
    iterationCount: iters.length,
    releaseCount: releaseValuesSeen.size,
    releaseValues: Array.from(releaseValuesSeen),
    totals,
    iterations: iterationResults,
    testCaseDiag
  };
}

async function runWiql(s, wiql, label) {
  const qUrl = `${adoBase(s)}/wit/wiql?api-version=7.1`;
  const qRes = await fetch(qUrl, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json" },
    body: JSON.stringify({ query: wiql })
  });
  if (!qRes.ok) {
    const t = await qRes.text().catch(() => "");
    throw new Error(`Query failed for "${label}" (HTTP ${qRes.status}). ${shorten(t)}`);
  }
  const qData = await qRes.json();
  return (qData.workItems || []).map((w) => w.id);
}

async function batchFetchWorkItems(s, ids, label) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const url = `${adoBase(s)}/wit/workitemsbatch?api-version=7.1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chunk, $expand: "all" })
    });
    if (!res.ok) throw new Error(`Could not read work item details for "${label}" (HTTP ${res.status}).`);
    const data = await res.json();
    out.push(...(data.value || []));
  }
  return out;
}

async function getAdoSettings(override) {
  if (override) return override;
  const stored = await chrome.storage.local.get(ADO_KEY);
  const s = stored[ADO_KEY];
  if (!s || !s.org || !s.project || !s.pat) throw new Error("Azure DevOps is not configured. Add org, project, and PAT in settings.");
  return s;
}

function adoAuthHeader(pat) {
  // PAT auth = Basic base64(":" + pat)
  return "Basic " + btoa(":" + pat);
}

function adoBase(s) {
  return `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_apis`;
}

async function adoTestConnection(settings) {
  const s = await getAdoSettings(settings);
  // Validate inputs early with specific guidance.
  if (/^https?:\/\//i.test(s.org) || s.org.includes("/")) {
    throw new Error(`Organization should be just the name (e.g. "contoso"), not a URL. You entered: "${s.org}"`);
  }
  if (/\s/.test(s.pat)) {
    throw new Error("The PAT contains a space or line break — re-copy it cleanly (a stray newline is common when pasting).");
  }

  const headers = { Authorization: adoAuthHeader(s.pat), Accept: "application/json" };

  // Stage 1: org-level call (no project) — isolates auth from project-name issues.
  const orgUrl = `https://dev.azure.com/${encodeURIComponent(s.org)}/_apis/projects?api-version=7.1&$top=1`;
  let res;
  try {
    res = await fetch(orgUrl, { headers, redirect: "manual" });
  } catch (e) {
    throw new Error(`Network error reaching dev.azure.com: ${e.message}. This can be a CORS/host-permission issue — make sure you reinstalled the extension after the permission change.`);
  }

  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error("PAT rejected (redirected to sign-in). Likely: wrong org name, expired PAT, or your org blocks PATs (Org Settings → Policies → 'Allow creation of PATs'/third-party access).");
  }
  if (res.status === 401 || res.status === 203) {
    throw new Error(`Auth failed at org level (HTTP ${res.status}). Org name "${s.org}" may be wrong, the PAT may be expired, or org policy blocks PAT access. The scope itself looks fine.`);
  }
  if (res.status === 404) {
    throw new Error(`Organization "${s.org}" not found (HTTP 404). Check the exact name from your dev.azure.com/<org> URL.`);
  }
  const octype = res.headers.get("content-type") || "";
  if (!res.ok || !octype.includes("application/json")) {
    const body = await res.text().catch(() => "");
    throw new Error(`Org check failed (HTTP ${res.status}, type ${octype || "unknown"}). ${shorten(body)}`);
  }

  // Stage 2: confirm the specific project exists / is accessible.
  const projUrl = `https://dev.azure.com/${encodeURIComponent(s.org)}/_apis/projects/${encodeURIComponent(s.project)}?api-version=7.1`;
  const pres = await fetch(projUrl, { headers, redirect: "manual" });
  if (pres.status === 404) {
    throw new Error(`Authenticated OK, but project "${s.project}" was not found. Check the exact project name (case-sensitive).`);
  }
  if (!pres.ok) {
    throw new Error(`Authenticated OK, but project check returned HTTP ${pres.status}.`);
  }
  return { message: `Connection OK — org "${s.org}", project "${s.project}" reachable.` };
}

// Upload one screenshot, return its attachment URL.
async function adoUploadAttachment(s, fileName, dataUrl) {
  const bytes = dataUrlToBytes(dataUrl);
  const url = `${adoBase(s)}/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/octet-stream" },
    body: bytes
  });
  if (!res.ok) throw new Error(`Attachment upload failed (HTTP ${res.status}).`);
  const json = await res.json();
  return json.url; // used as the AttachedFile relation
}

// Build HTML repro steps. If imageUrls are supplied, each step shows its
// screenshot inline (ADO renders <img src="{attachmentUrl}"> in Repro Steps).
function buildReproHtml(scenario, steps, imageUrls) {
  const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = `<div><b>${esc(scenario.testId)} — ${esc(scenario.title)}</b></div><ol>`;
  steps.forEach((st, i) => {
    html += `<li><b>${esc(st.caption)}</b> [${esc(st.status)}]`;
    if (st.status === "Fail" && (st.expected || st.actual)) {
      html += `<br/><i>Expected:</i> ${esc(st.expected)}<br/><i>Actual:</i> ${esc(st.actual)}`;
    }
    html += `<br/><span style="color:#666">${esc(st.pageUrl)} · ${esc(new Date(st.timestamp).toLocaleString())}</span>`;
    if (imageUrls && imageUrls[i]) {
      html += `<br/><img src="${esc(imageUrls[i])}" style="max-width:800px;border:1px solid #ccc;" alt="Step ${i + 1}"/>`;
    }
    html += `</li>`;
  });
  html += `</ol>`;
  return html;
}

// Look up the team's current iteration path. Returns null if unavailable.
async function adoGetCurrentIteration(s) {
  if (!s.team) return null;
  const url = `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/${encodeURIComponent(s.team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;
  const res = await fetch(url, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
  if (!res.ok) return null;
  const json = await res.json();
  const it = (json.value || [])[0];
  return it ? it.path : null;  // e.g. "MyProject\\Release 1\\Sprint 5"
}

// Create a new Bug work item; returns {id, url}.
async function adoCreateBug(s, scenario, steps, attachmentRelations, imageUrls, extras) {
  const title = `${scenario.testId} — ${scenario.title}`;
  const ops = [
    { op: "add", path: "/fields/System.Title", value: title.slice(0, 255) },
    { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: buildReproHtml(scenario, steps, imageUrls) }
  ];
  // Merge saved defaults with per-push values; per-push wins. Dedupe by field path.
  const adoStored = await chrome.storage.local.get(ADO_KEY);
  const defaults = adoStored[ADO_KEY] || {};
  const fieldMap = new Map(); // path -> value

  // Defaults first (lower priority)
  if (defaults.defAssigned) fieldMap.set("/fields/System.AssignedTo", defaults.defAssigned);
  if (defaults.defFields) {
    parseExtraFields(defaults.defFields).forEach(({ name, value }) => fieldMap.set(`/fields/${name}`, value));
  }
  // Per-push overrides
  if (extras && extras.assignedTo) fieldMap.set("/fields/System.AssignedTo", extras.assignedTo);
  if (extras && extras.extraFields) {
    parseExtraFields(extras.extraFields).forEach(({ name, value }) => fieldMap.set(`/fields/${name}`, value));
  }
  for (const [path, value] of fieldMap) {
    ops.push({ op: "add", path, value });
  }

  // Area path from saved default (set via the proper path field).
  const areaP1 = effectiveAreaPath(s, defaults);
  if (areaP1 && !fieldMap.has("/fields/System.AreaPath")) {
    ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaP1 });
  }

  // Current iteration: look up the team's active sprint and set IterationPath.
  if (extras && extras.useCurrentIteration && !fieldMap.has("/fields/System.IterationPath")) {
    const iterPath = await adoGetCurrentIteration(s);
    if (iterPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterPath });
  }

  // Link as Child of a parent work item (parent relation = Hierarchy-Reverse).
  if (extras && extras.parentId) {
    const parentUrl = `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_apis/wit/workItems/${encodeURIComponent(extras.parentId)}`;
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl } });
  }

  attachmentRelations.forEach((rel) => ops.push(rel));
  const url = `${adoBase(s)}/wit/workitems/$Bug?api-version=7.1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Bug creation failed (HTTP ${res.status}). ${shorten(txt)}`);
  }
  const json = await res.json();
  return { id: json.id, url: json._links?.html?.href || `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${json.id}` };
}

// Upload a screen recording (.webm) and attach to existing item or a new Bug.
async function adoPushRecording(options) {
  const s = await getAdoSettings();
  if (!options.recBase64) throw new Error("No recording data.");
  const fileName = options.recFileName || "recording.webm";

  // Upload the video (simple upload; fine under ~130MB).
  const videoUrl = await adoUploadFileB64(s, fileName, options.recBase64);
  const rel = { op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: videoUrl, attributes: { comment: "QA screen recording" } } };

  if (options.mode === "existing") {
    if (!options.workItemId) throw new Error("Enter a work item ID.");
    const note = "QA screen recording attached.";
    const result = await adoAttachDocToExisting(s, options.workItemId, rel, note);
    return { workItemId: result.id, workItemUrl: result.url };
  }

  // New Bug: minimal bug carrying the recording, applying saved defaults + optional parent.
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const session = stored[STORAGE_KEY];
  const docTitle = session?.meta?.docTitle || "QA Recording";
  const result = await adoCreateBugFromRecording(s, docTitle, rel, options.parentId);
  return { workItemId: result.id, workItemUrl: result.url };
}

// Create a Bug whose evidence is a screen recording (no per-step repro).
async function adoCreateBugFromRecording(s, titleText, videoRelation, parentId) {
  const ops = [
    { op: "add", path: "/fields/System.Title", value: String(titleText).slice(0, 255) },
    { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: "<div>See attached screen recording.</div>" }
  ];
  // Apply saved defaults (assigned, custom fields, area, current iteration) the same way as adoCreateBug.
  const adoStored = await chrome.storage.local.get(ADO_KEY);
  const defaults = adoStored[ADO_KEY] || {};
  const fieldMap = new Map();
  if (defaults.defAssigned) fieldMap.set("/fields/System.AssignedTo", defaults.defAssigned);
  if (defaults.defFields) parseExtraFields(defaults.defFields).forEach(({ name, value }) => fieldMap.set(`/fields/${name}`, value));
  for (const [path, value] of fieldMap) ops.push({ op: "add", path, value });
  { const ap = effectiveAreaPath(s, defaults); if (ap && !fieldMap.has("/fields/System.AreaPath")) ops.push({ op: "add", path: "/fields/System.AreaPath", value: ap }); }

  if (parentId) {
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: adoWorkItemUrl(s, parentId) } });
  }
  ops.push(videoRelation);

  const url = `${adoBase(s)}/wit/workitems/$Bug?api-version=7.1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops)
  });
  if (!res.ok) { const txt = await res.text(); throw new Error(`Bug creation failed (HTTP ${res.status}). ${shorten(txt)}`); }
  const json = await res.json();
  return { id: json.id, url: json._links?.html?.href || `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${json.id}` };
}

// Upload a base64 file (e.g. .docx) as an attachment; return its URL.
async function adoUploadFileB64(s, fileName, base64) {
  if (!base64 || base64.length < 10) throw new Error("Document is empty — nothing to upload.");
  let bytes;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    throw new Error("Could not decode the document data: " + e.message);
  }
  // ADO's attachment endpoint only accepts application/octet-stream; it infers
  // the real type from the filename extension. Sending the Word MIME type 400s.
  const url = `https://dev.azure.com/${encodeURIComponent(s.org)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/octet-stream" },
    body: bytes
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Document upload failed (HTTP ${res.status}). ${shorten(txt)} [${bytes.length} bytes, name "${fileName}"]`);
  }
  const json = await res.json();
  return json.url;
}

// Attach a single document (and a history note) to an existing work item.
async function adoAttachDocToExisting(s, workItemId, docRelation, noteText, signoff) {
  const ops = [];
  // Discussion comment (System.History renders as a comment in the work item).
  if (noteText) ops.push({ op: "add", path: "/fields/System.History", value: noteText });
  if (docRelation) ops.push(docRelation);
  // Optional sign-off: set State and/or apply field changes.
  if (signoff && signoff.state) {
    ops.push({ op: "add", path: "/fields/System.State", value: signoff.state });
  }
  if (signoff && signoff.fields) {
    parseExtraFields(signoff.fields).forEach(({ name, value }) => {
      ops.push({ op: "add", path: `/fields/${name}`, value });
    });
  }
  if (!ops.length) throw new Error("Nothing to update.");

  const url = `${adoBase(s)}/wit/workitems/${encodeURIComponent(workItemId)}?api-version=7.1`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops)
  });
  if (res.status === 404) throw new Error(`Work item ${workItemId} not found in this project.`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Update failed (HTTP ${res.status}). ${shorten(txt)}`);
  }
  const json = await res.json();
  return { id: json.id, url: json._links?.html?.href || `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${json.id}` };
}

// Build the Microsoft.VSTS.TCM.Steps XML for a Test Case.
// Each step has an action and (optionally) an expected result. Step index starts at 2.
function buildTestStepsXml(steps) {
  const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  // Skip steps with no real action text (blank or the "(no description)" placeholder).
  const real = (steps || []).filter((st) => {
    const cap = String(st.caption || "").trim().toLowerCase();
    return cap && cap !== "(no description)";
  });
  let inner = "";
  real.forEach((st, i) => {
    const id = i + 2; // ADO convention: step ids start at 2, sequential over the kept steps
    const action = esc(st.caption);
    let expected;
    if (st.expected) expected = esc(st.expected);
    else if (st.status === "Fail") expected = esc(st.actual || "Defect observed");
    else expected = esc("Behaves as expected");
    inner += `<step id="${id}" type="ValidateStep">` +
      `<parameterizedString isformatted="true">${action}</parameterizedString>` +
      `<parameterizedString isformatted="true">${expected}</parameterizedString>` +
      `<description/></step>`;
  });
  return `<steps id="0" last="${real.length + 1}">${inner}</steps>`;
}

// Fetch the children of a parent work item, filter by type/title, and set State=Closed.
// closeTasksPrefix: only Tasks whose title starts with this (e.g. "QA"); "" = skip tasks.
// closeTestCases: close all Test Cases under the parent.
// Shared: fetch children of a parent and classify which ones match the close
// criteria. Returns { toClose:[{id,type,title}], alreadyClosed:[{...}] }.
// This does NOT change anything — used by both preview and the real close.
async function adoFindClosableChildren(s, parentId, closeTasksPrefix, closeTestCases) {
  if (!parentId) throw new Error("No parent story ID.");
  const pUrl = `${adoBase(s)}/wit/workitems/${encodeURIComponent(parentId)}?$expand=relations&api-version=7.1`;
  const pRes = await fetch(pUrl, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
  if (!pRes.ok) throw new Error(`Could not read parent #${parentId} (HTTP ${pRes.status}).`);
  const parent = await pRes.json();
  const childUrls = (parent.relations || [])
    .filter((r) => r.rel === "System.LinkTypes.Hierarchy-Forward")
    .map((r) => r.url);
  if (!childUrls.length) return { toClose: [], alreadyClosed: [] };

  const ids = childUrls.map((u) => u.split("/").pop()).filter(Boolean);
  const fields = "System.WorkItemType,System.Title,System.State";
  const listUrl = `${adoBase(s)}/wit/workitems?ids=${ids.join(",")}&fields=${encodeURIComponent(fields)}&api-version=7.1`;
  const lRes = await fetch(listUrl, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
  if (!lRes.ok) throw new Error(`Could not read child items (HTTP ${lRes.status}).`);
  const children = (await lRes.json()).value || [];

  const toClose = [], alreadyClosed = [];
  for (const c of children) {
    const type = c.fields["System.WorkItemType"];
    const title = c.fields["System.Title"] || "";
    const state = c.fields["System.State"] || "";
    let match = false;
    if (type === "Task" && closeTasksPrefix && title.toLowerCase().startsWith(closeTasksPrefix.toLowerCase())) match = true;
    if (type === "Test Case" && closeTestCases) match = true;
    if (!match) continue;
    if (state === "Closed") alreadyClosed.push({ id: c.id, type, title });
    else toClose.push({ id: c.id, type, title });
  }
  return { toClose, alreadyClosed };
}

// Returns { closed:[{id,type,title}], skipped:[{id,type,title,reason}] }.
async function adoCloseChildren(s, parentId, closeTasksPrefix, closeTestCases) {
  const { toClose, alreadyClosed } = await adoFindClosableChildren(s, parentId, closeTasksPrefix, closeTestCases);
  const closed = [];
  const skipped = alreadyClosed.map((c) => ({ ...c, reason: "already closed" }));
  for (const c of toClose) {
    const upUrl = `${adoBase(s)}/wit/workitems/${c.id}?api-version=7.1`;
    const upRes = await fetch(upUrl, {
      method: "PATCH",
      headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "add", path: "/fields/System.State", value: "Closed" }])
    });
    if (upRes.ok) closed.push({ id: c.id, type: c.type, title: c.title });
    else {
      const txt = await upRes.text().catch(() => "");
      skipped.push({ id: c.id, type: c.type, title: c.title, reason: `HTTP ${upRes.status} ${shorten(txt)}` });
    }
  }
  return { closed, skipped };
}

// Create multiple Task work items as children of a parent story.
async function adoCreateTasks(s, parentId, titles, opts) {
  if (!parentId) throw new Error("Enter the parent story ID.");
  const clean = (titles || []).map((t) => String(t).trim()).filter(Boolean);
  if (!clean.length) throw new Error("Add at least one task title.");

  let parentPriority = null;
  try {
    const pUrl = `${adoBase(s)}/wit/workitems/${encodeURIComponent(parentId)}?fields=Microsoft.VSTS.Common.Priority&api-version=7.1`;
    const pRes = await fetch(pUrl, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
    if (pRes.ok) {
      const pj = await pRes.json();
      parentPriority = pj.fields && pj.fields["Microsoft.VSTS.Common.Priority"];
    }
  } catch { /* best-effort */ }

  let iterationPath = null;
  if (opts && opts.useCurrentIteration) {
    iterationPath = await adoGetCurrentIteration(s);
  }
  const defaults = (await chrome.storage.local.get(ADO_KEY))[ADO_KEY] || {};

  const created = [];
  for (const title of clean) {
    const ops = [
      { op: "add", path: "/fields/System.Title", value: title.slice(0, 255) },
      { op: "add", path: "/fields/System.State", value: "New" },
      { op: "add", path: "/fields/Microsoft.VSTS.Common.Activity", value: "Testing" }
    ];
    { const ap = effectiveAreaPath(s, defaults); if (ap) ops.push({ op: "add", path: "/fields/System.AreaPath", value: ap }); }
    if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (defaults.defAssigned) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: defaults.defAssigned });
    if (parentPriority != null) ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: parentPriority });
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: adoWorkItemUrl(s, parentId) } });

    const url = `${adoBase(s)}/wit/workitems/$Task?api-version=7.1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(ops)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Task "${title}" failed (HTTP ${res.status}). ${shorten(txt)} [${created.length} created before this]`);
    }
    const json = await res.json();
    created.push({ id: json.id, url: json._links?.html?.href || `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${json.id}`, title });
  }
  return { created };
}

// Create a Test Case work item with structured steps; optional parent (Child link).
async function adoCreateTestCase(s, scenario, steps, parentId, extras) {
  const ops = [
    { op: "add", path: "/fields/System.Title", value: `${scenario.testId} — ${scenario.title}`.slice(0, 255) },
    { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: buildTestStepsXml(steps) }
  ];
  const adoStored = await chrome.storage.local.get(ADO_KEY);
  const defaults = adoStored[ADO_KEY] || {};
  if (defaults.defAssigned) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: defaults.defAssigned });
  { const ap = effectiveAreaPath(s, defaults); if (ap) ops.push({ op: "add", path: "/fields/System.AreaPath", value: ap }); }
  // Iteration: set to the team's current sprint (e.g. "YPO Salesforce\PI2\Sprint 210"),
  // looked up per-team so it's correct across different teams. Falls back gracefully.
  if (extras && extras.useCurrentIteration) {
    const iterPath = await adoGetCurrentIteration(s);
    if (iterPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterPath });
  }
  if (parentId) {
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: adoWorkItemUrl(s, parentId) } });
  }
  const url = `${adoBase(s)}/wit/workitems/$Test%20Case?api-version=7.1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: adoAuthHeader(s.pat), "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops)
  });
  if (!res.ok) { const txt = await res.text(); throw new Error(`Test Case creation failed (HTTP ${res.status}). ${shorten(txt)}`); }
  const json = await res.json();
  return { id: json.id, url: json._links?.html?.href || `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${json.id}` };
}

// Orchestrate the push.
async function adoPushScenario(scenarioId, options) {
  const s = await getAdoSettings();
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const session = stored[STORAGE_KEY];
  if (!session) throw new Error("No active session.");

  // ----- Attach whole-document Word file to an existing work item -----
  if (options.mode === "existing") {
    if (!options.workItemId) throw new Error("Enter a work item ID.");
    const so = options.signoff || {};
    const attachDoc = options.attachDoc !== false; // default true
    const totalSteps = session.steps.length;
    const scenarioCount = session.scenarios.length;

    let rel = null;
    if (attachDoc) {
      if (!options.docBase64) throw new Error("No document was provided to attach.");
      const fileName = options.docFileName || "TestLog.docx";
      const docUrl = await adoUploadFileB64(s, fileName, options.docBase64);
      const env0 = session.meta.environment || "—";
      const tester0 = session.meta.tester || "—";
      const comment = `QA Test Log (Word) · Environment: ${env0} · Tester: ${tester0}`;
      rel = { op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: docUrl, attributes: { comment } } };
    }

    const note = `QA test log attached: "${escapeHtmlSafe(session.meta.docTitle || "Test Log")}" — ${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}, ${totalSteps} step${totalSteps === 1 ? "" : "s"}.`;
    const env = session.meta.environment || "—";
    const tester = session.meta.tester || "—";

    const tokens = {
      "{env}": env, "{tester}": tester,
      "{doc}": session.meta.docTitle || "Test Log",
      "{scenarios}": String(scenarioCount), "{steps}": String(totalSteps),
      "{id}": String(options.workItemId)
    };
    const fillTemplate = (tpl) => String(tpl || "").replace(/\{env\}|\{tester\}|\{doc\}|\{scenarios\}|\{steps\}|\{id\}/g, (m) => tokens[m]);

    const noteRaw = so.applyComment && so.commentTemplate ? fillTemplate(so.commentTemplate) : (attachDoc ? note : "");
    const noteToUse = noteRaw ? await formatCommentHtml(s, noteRaw) : "";
    const signoffPayload = {
      state: so.applyState ? so.state : "",
      fields: so.applyFields ? so.fields : ""
    };
    // Only PATCH the work item if there's actually something to apply
    // (doc attach, comment, state, or fields). Otherwise we may be only closing children.
    const hasUpdate = !!rel || !!noteToUse || !!signoffPayload.state || !!signoffPayload.fields;
    let result = { id: options.workItemId, url: `https://dev.azure.com/${s.org}/${s.project}/_workitems/edit/${options.workItemId}` };
    if (hasUpdate) {
      result = await adoAttachDocToExisting(s, options.workItemId, rel, noteToUse, signoffPayload);
    }
    // Optional: close QA child tasks and/or test cases under this story.
    let closeResult = null;
    if (so.closeChildren) {
      closeResult = await adoCloseChildren(
        s, options.workItemId,
        so.closeTasksPrefix || "",      // "" skips tasks
        !!so.closeTestCases
      );
    }
    if (!hasUpdate && !so.closeChildren) {
      throw new Error("Nothing selected — tick attach, a sign-off action, or close children.");
    }
    return {
      workItemId: result.id, workItemUrl: result.url,
      appliedState: signoffPayload.state, appliedFields: signoffPayload.fields,
      closed: closeResult ? closeResult.closed : [],
      closeSkipped: closeResult ? closeResult.skipped : []
    };
  }

  // ----- Create a new Bug from one scenario (per-step screenshots) -----
  const scenario = session.scenarios.find((x) => x.id === scenarioId);
  if (!scenario) throw new Error("Scenario not found.");
  let steps = session.steps.filter((x) => x.scenarioId === scenarioId);

  // ----- Create a Test Case (text steps, no screenshots) -----
  if (options.mode === "testcase") {
    if (!steps.length) throw new Error("No steps to turn into a Test Case.");
    const result = await adoCreateTestCase(s, scenario, steps, options.parentId, {
      useCurrentIteration: options.useCurrentIteration
    });
    return { workItemId: result.id, workItemUrl: result.url, pushed: steps.length };
  }

  if (options.onlyFailed) steps = steps.filter((x) => x.status === "Fail");
  if (!steps.length) throw new Error(options.onlyFailed ? "No failed steps to push." : "No steps to push.");

  const relations = [];
  const imageUrls = [];
  // Screenshots aren't kept on the step object (addStep() moves them to their own
  // shot_<id> key and deletes step.dataUrl to keep the session small) — fetch them
  // back before uploading, same as the gallery/docx export already do.
  const shotKeys = steps.map((st) => `shot_${st.id}`);
  const shotData = shotKeys.length ? await chrome.storage.local.get(shotKeys) : {};
  for (let i = 0; i < steps.length; i++) {
    const dataUrl = steps[i].dataUrl || shotData[`shot_${steps[i].id}`];
    if (!dataUrl) throw new Error(`Step ${i + 1} ("${steps[i].caption || "untitled"}") has no screenshot saved — cannot attach it.`);
    const fname = `${scenario.testId}_step${i + 1}.jpg`.replace(/[^\w.-]+/g, "_");
    const attUrl = await adoUploadAttachment(s, fname, dataUrl);
    imageUrls.push(attUrl);
    relations.push({
      op: "add", path: "/relations/-",
      value: { rel: "AttachedFile", url: attUrl, attributes: { comment: `Step ${i + 1}: ${steps[i].caption}` } }
    });
  }
  const result = await adoCreateBug(s, scenario, steps, relations, imageUrls, {
    assignedTo: options.assignedTo,
    extraFields: options.extraFields,
    parentId: options.parentId,
    useCurrentIteration: options.useCurrentIteration
  });
  return { workItemId: result.id, workItemUrl: result.url, pushed: steps.length };
}

// ---- ADO helpers ----
function dataUrlToBytes(dataUrl) {
  if (!dataUrl) throw new Error("No image data to upload (screenshot missing).");
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function escapeHtmlSafe(t) {
  return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function shorten(t) {
  if (!t) return "(no error detail returned)";
  try { const j = JSON.parse(t); return (j.message || j.value?.Message || JSON.stringify(j)).slice(0, 200); }
  catch { return t.slice(0, 200); }
}

// Discover the Bug type's fields, flagging which are required, with reference names.
async function adoDiscoverFields(workItemType) {
  const s = await getAdoSettings();
  const type = workItemType || "Bug";
  const url = `${adoBase(s)}/wit/workitemtypes/${encodeURIComponent(type)}/fields?$expand=all&api-version=7.1`;
  const res = await fetch(url, {
    headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" },
    redirect: "manual"
  });
  if (res.status === 404) throw new Error(`No "${type}" work item type in this project. Check the type name (e.g. "User Story", "Bug", "Issue", "Task").`);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Field discovery failed (HTTP ${res.status}). ${shorten(txt)}`);
  }
  const json = await res.json();
  const fields = (json.value || []).map((f) => ({
    name: f.referenceName,
    label: f.name,
    required: !!(f.alwaysRequired || (f.required === true))
  }));
  fields.sort((a, b) => (b.required - a.required) || a.label.localeCompare(b.label));
  const required = fields.filter((f) => f.required);
  return { required, all: fields, type };
}

// Resolve an email to an ADO identity for @-mention. Tries the Graph Users API
// (reliable for Azure AD-backed orgs) first, then the legacy Identities API.
// Returns { id, displayName, source } or null. If `diag` is passed, fills it with debug info.
async function adoResolveIdentity(s, email, diag) {
  const lower = String(email).toLowerCase();
  const d = diag || {};
  d.steps = d.steps || [];

  // --- 1) Graph Users API (vssps) ---
  try {
    let continuationToken = null;
    let totalUsers = 0;
    for (let page = 0; page < 10; page++) {
      const base = `https://vssps.dev.azure.com/${encodeURIComponent(s.org)}/_apis/graph/users?api-version=7.1-preview.1`;
      const url = continuationToken ? `${base}&continuationToken=${encodeURIComponent(continuationToken)}` : base;
      const res = await fetch(url, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
      d.steps.push(`graph p${page}: HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) { d.authProblem = true; break; }
      if (!res.ok) break;
      const json = await res.json();
      const users = json.value || [];
      totalUsers += users.length;
      const match = users.find((u) =>
        (u.mailAddress && u.mailAddress.toLowerCase() === lower) ||
        (u.principalName && u.principalName.toLowerCase() === lower)
      );
      if (match) {
        d.matchedVia = "graph"; d.matchedName = match.displayName;
        return { id: match.originId || match.descriptor, displayName: match.displayName || email, source: "graph" };
      }
      continuationToken = res.headers.get("x-ms-continuationtoken");
      if (!continuationToken) break;
    }
    d.graphUsersSeen = totalUsers;
  } catch (e) { d.steps.push("graph error: " + e.message); }

  // --- 2) Legacy Identities API ---
  try {
    const url = `https://vssps.dev.azure.com/${encodeURIComponent(s.org)}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(email)}&queryMembership=None&api-version=7.1`;
    const res = await fetch(url, { headers: { Authorization: adoAuthHeader(s.pat), Accept: "application/json" }, redirect: "manual" });
    d.steps.push(`identities: HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) d.authProblem = true;
    if (res.ok) {
      const json = await res.json();
      const hit = (json.value || [])[0];
      if (hit && hit.id) {
        d.matchedVia = "identities"; d.matchedName = hit.providerDisplayName;
        return { id: hit.id, displayName: hit.providerDisplayName || email, source: "identities" };
      }
      d.identitiesCount = (json.value || []).length;
    }
  } catch (e) { d.steps.push("identities error: " + e.message); }

  return null;
}

// Turn a plain/template comment into ADO comment HTML:
// - newlines (and the {nl} token) become <br>
// - any email is turned into a real @-mention (or a mailto link if unresolved)
async function formatCommentHtml(s, text) {
  let t = String(text || "");
  // Normalize the explicit token to a newline first.
  t = t.replace(/\{nl\}/g, "\n");

  // Find unique emails to resolve.
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const emails = Array.from(new Set(t.match(emailRe) || []));
  const map = {};
  for (const em of emails) {
    const ident = await adoResolveIdentity(s, em);
    if (ident) {
      map[em] = `<a href="#" data-vss-mention="version:2.0,${ident.id}">@${escapeHtmlSafe(ident.displayName)}</a>`;
    } else {
      map[em] = `<a href="mailto:${em}">${escapeHtmlSafe(em)}</a>`; // fallback: clickable, no notify
    }
  }

  // Escape the surrounding text but keep our injected anchors. Do it by splitting on emails.
  let html = "";
  let lastIndex = 0;
  t.replace(emailRe, (match, offset) => {
    html += escapeHtmlSafe(t.slice(lastIndex, offset));
    html += map[match] || escapeHtmlSafe(match);
    lastIndex = offset + match.length;
    return match;
  });
  html += escapeHtmlSafe(t.slice(lastIndex));

  // Newlines -> <br> (after escaping, so they aren't escaped away).
  html = html.replace(/\n/g, "<br>");
  return html;
}

// Resolve the area path to apply: explicit override, else "Project\Team" when a
// team is configured, else none. Lets users leave Area Path blank for the common case.
function effectiveAreaPath(s, defaults) {
  if (defaults && defaults.areaPath) return defaults.areaPath;
  if (s && s.project && s.team) return `${s.project}\\${s.team}`;
  return "";
}

// Build the work item URL used in relation links.
function adoWorkItemUrl(s, id) {
  return `https://dev.azure.com/${encodeURIComponent(s.org)}/_apis/wit/workItems/${encodeURIComponent(id)}`;
}

// Parse "Field=Value, Other.Field=Value" into [{name, value}].
function parseExtraFields(raw) {
  return String(raw)
    .split(/[,\n]/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return null;
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter((x) => x && x.name);
}
