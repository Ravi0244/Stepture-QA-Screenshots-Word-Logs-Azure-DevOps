// history.js — push history viewer with copy actions.
const HISTORY_KEY = "qa_testlog_pushhistory";
let history = [];

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get("qa_testlog_theme").then(r=>document.body.setAttribute("data-theme",r.qa_testlog_theme||"light"));
  load();
  document.getElementById("refreshBtn").addEventListener("click", load);
  document.getElementById("clearBtn").addEventListener("click", clearHistory);
  document.getElementById("copyAll").addEventListener("click", copyAll);
});

async function load() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  history = stored[HISTORY_KEY] || [];
  // Guarantee newest-first regardless of insertion order.
  history.sort((a, b) => new Date(b.at) - new Date(a.at));
  render();
}

async function clearHistory() {
  if (!confirm("Clear all push history? This cannot be undone.")) return;
  await chrome.storage.local.remove(HISTORY_KEY);
  history = [];
  render();
}

function render() {
  const content = document.getElementById("content");
  document.getElementById("sub").textContent = `${history.length} push${history.length === 1 ? "" : "es"} recorded`;
  if (!history.length) {
    content.innerHTML = '<p class="empty">No pushes yet. When you push a Bug, Test Case, or attach a Word log to Azure DevOps, it will appear here.</p>';
    return;
  }
  const rows = history.map((h, i) => {
    const kindClass = (h.kind || "").replace(/\s/g, "");
    const link = h.workItemUrl
      ? `<span class="wi"><a href="${esc(h.workItemUrl)}" target="_blank">#${esc(h.workItemId)}</a></span>
         <button class="copy" data-copy="${esc(h.workItemUrl)}">copy link</button>
         <button class="copy" data-copy="${esc(String(h.workItemId))}">copy ID</button>`
      : "—";
    return `<tr>
      <td class="muted">${formatTime(h.at)}</td>
      <td class="kind ${kindClass}">${esc(h.kind || "")}</td>
      <td>${esc(h.scenario || h.docTitle || "—")}</td>
      <td>${link}</td>
      <td class="muted">${h.parentId ? "parent #" + esc(String(h.parentId)) : ""}</td>
    </tr>`;
  }).join("");

  content.innerHTML = `<table>
    <thead><tr><th>When</th><th>Type</th><th>Scenario / Document</th><th>Work item</th><th>Parent</th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  content.querySelectorAll(".copy").forEach((b) => {
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => {
        const orig = b.textContent; b.textContent = "copied!";
        setTimeout(() => (b.textContent = orig), 1200);
      });
    });
  });
}

function copyAll() {
  if (!history.length) return;
  const lines = history
    .filter((h) => h.workItemUrl)
    .map((h) => `${h.kind} #${h.workItemId} — ${h.scenario || h.docTitle || ""}: ${h.workItemUrl}`);
  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    const b = document.getElementById("copyAll");
    const orig = b.textContent; b.textContent = "Copied!";
    setTimeout(() => (b.textContent = orig), 1200);
  });
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
}
