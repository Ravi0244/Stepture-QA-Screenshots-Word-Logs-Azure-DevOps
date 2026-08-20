// gallery.js — full-tab screenshot gallery with view, delete, reorder.
const STORAGE_KEY = "qa_testlog_session";
let session = null;

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get("qa_testlog_theme").then(r=>document.body.setAttribute("data-theme",r.qa_testlog_theme||"light"));
  load();
  document.getElementById("refreshBtn").addEventListener("click", load);
  const lb = document.getElementById("lightbox");
  lb.addEventListener("click", () => (lb.style.display = "none"));
});

let shots = {};   // stepId -> dataUrl, loaded from shot_ keys

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  session = stored[STORAGE_KEY] || null;
  shots = {};
  if (session && session.steps && session.steps.length) {
    // Images are stored separately (one key per step) for performance.
    // Batch-fetch them all in one call.
    const keys = session.steps.map((s) => `shot_${s.id}`);
    const blobs = await chrome.storage.local.get(keys);
    session.steps.forEach((s) => {
      const d = blobs[`shot_${s.id}`];
      if (d) shots[s.id] = d;
      else if (s.dataUrl) shots[s.id] = s.dataUrl;   // fallback for any legacy step
    });
  }
  render();
}

async function persist() {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

function render() {
  const content = document.getElementById("content");
  if (!session || !session.steps || !session.steps.length) {
    document.getElementById("docTitle").textContent = "Screenshots";
    document.getElementById("sub").textContent = "";
    content.innerHTML = '<p class="empty">No screenshots captured yet. Capture some steps, then refresh this tab.</p>';
    return;
  }
  document.getElementById("docTitle").textContent = session.meta?.docTitle || "Screenshots";
  const total = session.steps.length;
  document.getElementById("sub").textContent =
    `${session.scenarios.length} scenario${session.scenarios.length === 1 ? "" : "s"} · ${total} screenshot${total === 1 ? "" : "s"}`;

  content.innerHTML = "";
  session.scenarios.forEach((sc) => {
    const steps = session.steps.filter((s) => s.scenarioId === sc.id);
    const wrap = document.createElement("div");
    wrap.className = "scenario";
    const h2 = document.createElement("h2");
    h2.textContent = `${sc.testId} — ${sc.title}  (${steps.length})`;
    wrap.appendChild(h2);

    if (!steps.length) {
      const e = document.createElement("p");
      e.className = "empty";
      e.textContent = "No steps in this scenario.";
      wrap.appendChild(e);
    } else {
      const grid = document.createElement("div");
      grid.className = "grid";
      steps.forEach((s, i) => grid.appendChild(card(s, i, steps.length)));
      wrap.appendChild(grid);
    }
    content.appendChild(wrap);
  });
}

function card(step, idx, count) {
  const c = document.createElement("div");
  c.className = "card";

  const img = document.createElement("img");
  const src = shots[step.id] || step.dataUrl || "";
  if (src) {
    img.src = src;
    img.addEventListener("click", () => enlarge(src));
  } else {
    img.alt = "Screenshot unavailable";
  }
  c.appendChild(img);

  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = `
    <span class="st ${step.status}">${step.status}</span>
    <div class="cap">${idx + 1}. ${escapeHtml(step.caption)}</div>
    <div class="meta">${escapeHtml(step.pageUrl || "")}<br/>${formatTime(step.timestamp)}</div>
  `;

  const controls = document.createElement("div");
  controls.className = "controls";
  const up = btn("↑", idx === 0, () => move(step.id, -1));
  const down = btn("↓", idx === count - 1, () => move(step.id, +1));
  const del = btn("Delete", false, () => del_(step.id));
  del.classList.add("del");
  controls.append(up, down, del);
  body.appendChild(controls);

  c.appendChild(body);
  return c;
}

function btn(label, disabled, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  if (disabled) b.style.opacity = "0.4";
  else b.addEventListener("click", onClick);
  return b;
}

function enlarge(src) {
  document.getElementById("lightboxImg").src = src;
  document.getElementById("lightbox").style.display = "flex";
}

// Reorder within the same scenario by swapping with the neighbor in that scenario.
async function move(stepId, dir) {
  const step = session.steps.find((s) => s.id === stepId);
  if (!step) return;
  const sameScenario = session.steps.filter((s) => s.scenarioId === step.scenarioId);
  const posInScenario = sameScenario.indexOf(step);
  const target = sameScenario[posInScenario + dir];
  if (!target) return;
  // Swap their positions in the global steps array.
  const gi = session.steps.indexOf(step);
  const gj = session.steps.indexOf(target);
  session.steps[gi] = target;
  session.steps[gj] = step;
  await persist();
  render();
}

async function del_(stepId) {
  if (!confirm("Delete this screenshot?")) return;
  session.steps = session.steps.filter((s) => s.id !== stepId);
  await chrome.storage.local.remove(`shot_${stepId}`);   // free the image blob
  delete shots[stepId];
  await persist();
  render();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}
