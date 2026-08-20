// Apply the saved dark/light theme to the Help page.
// External file (not inline) because MV3's CSP blocks inline scripts.
chrome.storage.local.get("qa_testlog_theme").then((r) => {
  document.body.setAttribute("data-theme", r.qa_testlog_theme || "light");
});
