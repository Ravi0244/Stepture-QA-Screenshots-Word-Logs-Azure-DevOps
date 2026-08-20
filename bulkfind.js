const $ = (id) => document.getElementById(id);
const HANDOFF_KEY = "qa_testlog_bulk_selection";
let items = [];

// Apply saved theme.
chrome.storage.local.get("qa_testlog_theme").then((r) => {
  document.body.setAttribute("data-theme", r.qa_testlog_theme || "light");
});

$("scope").addEventListener("change", () => {
  $("areaWrap").style.display = $("scope").value === "area" ? "block" : "none";
});

$("findBtn").addEventListener("click", find);
$("search").addEventListener("input", render);
$("selAll").addEventListener("click", () => setAll(true));
$("selNone").addEventListener("click", () => setAll(false));
$("useSelected").addEventListener("click", useSelected);

async function find() {
  const types = Array.from(document.querySelectorAll(".type:checked")).map((c) => c.value);
  const states = $("states").value.split(",").map((s) => s.trim()).filter(Boolean);
  const scope = $("scope").value;
  const areaPath = $("areaPath").value.trim();
  const st = $("status");
  if (!types.length) { st.textContent = "Pick at least one work item type."; return; }
  if (!states.length) { st.textContent = "Enter at least one state."; return; }
  if (scope === "area" && !areaPath) { st.textContent = "Enter an area path, or choose a different scope."; return; }

  $("findBtn").disabled = true;
  st.textContent = "Searching…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "ADO_FIND_WORKITEMS",
      opts: { types, states, scope, areaPath }
    });
    if (!res || !res.ok) { st.textContent = "✗ " + (res?.error || "failed"); return; }
    items = res.items || [];
    if (!items.length) {
      st.textContent = "No items found. Check that the state names match your project exactly.";
      $("resultsWrap").classList.add("hidden");
      return;
    }
    st.textContent = "";
    $("resultsWrap").classList.remove("hidden");
    render();
  } catch (e) {
    st.textContent = "✗ " + e.message;
  } finally {
    $("findBtn").disabled = false;
  }
}

function render() {
  const q = ($("search").value || "").toLowerCase();
  const box = $("results");
  const filtered = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !q || (`#${it.id} ${it.title} ${it.type} ${it.state} ${it.itemStatus} ${it.assignedTo} ${it.iteration}`).toLowerCase().includes(q));

  box.innerHTML = filtered.map(({ it, i }) => `
    <div class="row">
      <input type="checkbox" class="pick" data-i="${i}" ${it.hasChildren ? "" : "checked"} />
      <div class="main">
        <div class="title"><a href="${esc(it.url)}" target="_blank" rel="noopener" class="wi-link">#${it.id}</a> — ${esc(it.title)}</div>
        <div class="meta">
          ${esc(it.type)}
          · <span class="state-badge state-${esc((it.state || "").toLowerCase().replace(/[^a-z]/g, ""))}">${esc(it.state)}</span>
          ${it.itemStatus ? `· <span class="item-status" title="Custom.ItemStatus">📌 ${esc(it.itemStatus)}</span>` : ""}
          ${it.iteration ? `· <span class="iter" title="${esc(it.iterationFull)}">🗓 ${esc(it.iteration)}</span>` : ""}
          · ${esc(it.assignedTo)}${it.hasChildren ? ' · <span class="haschild">has child items</span>' : ""}
        </div>
      </div>
    </div>`).join("");

  $("count").textContent = `${filtered.length} of ${items.length} shown`;
  box.querySelectorAll(".pick").forEach((c) => c.addEventListener("change", updateSelCount));
  updateSelCount();
}

function setAll(v) {
  // Only affects currently-visible (filtered) rows.
  document.querySelectorAll(".pick").forEach((c) => (c.checked = v));
  updateSelCount();
}

function updateSelCount() {
  const n = document.querySelectorAll(".pick:checked").length;
  $("selCount").textContent = `${n} selected`;
}

async function useSelected() {
  // Collect selected IDs across the full item set (not just visible), using data-i.
  const picked = Array.from(document.querySelectorAll(".pick:checked"))
    .map((c) => items[parseInt(c.dataset.i, 10)].id);
  if (!picked.length) { $("status").textContent = "Nothing selected."; return; }
  // Hand off to the popup's task-creation flow via storage.
  await chrome.storage.local.set({ [HANDOFF_KEY]: { ids: picked, at: Date.now() } });
  $("status").textContent = `✓ ${picked.length} item(s) sent. Open the Stepture popup → Tasks — the IDs are prefilled. You can close this tab.`;
  $("useSelected").textContent = "Sent ✓";
  setTimeout(() => { $("useSelected").textContent = "Use selected → create tasks"; }, 4000);
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
