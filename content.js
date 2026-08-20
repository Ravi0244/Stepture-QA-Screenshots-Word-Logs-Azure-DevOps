// content.js — on-page annotation overlay for QA Test Log Recorder.
// Injected on demand. Draws an overlay canvas above the page so the tester
// can annotate at full screen width, then triggers a capture of page+overlay.

(() => {
  if (window.__qaTestLogInjected) return;        // guard against double-inject
  window.__qaTestLogInjected = true;

  const NS = "qa-testlog";
  let active = false;          // is annotate (draw) mode on
  let tool = "box";
  let color = "#e11d48";
  let shapes = [];             // {tool,color,x1,y1,x2,y2} in viewport px
  let drawing = false, cur = null;

  // ---- Build UI ----
  const canvas = document.createElement("canvas");
  canvas.id = `${NS}-canvas`;
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", zIndex: "2147483646",
    pointerEvents: "none", display: "none"
  });

  const bar = document.createElement("div");
  bar.id = `${NS}-bar`;
  bar.innerHTML = `
    <span class="${NS}-brand" title="Stepture"><span class="${NS}-brandmark"></span></span>
    <span class="${NS}-scenario" id="${NS}-scenario" title="Current scenario">…</span>
    <span class="${NS}-sep"></span>

    <div class="${NS}-group">
      <button data-tool="arrow" class="${NS}-tool" title="Arrow (Alt+1)"><span class="${NS}-ic">↗</span><span class="${NS}-lbl">Arrow</span></button>
      <button data-tool="box" class="${NS}-tool ${NS}-on" title="Box (Alt+2)"><span class="${NS}-ic">▭</span><span class="${NS}-lbl">Box</span></button>
      <button data-tool="highlight" class="${NS}-tool" title="Highlighter (Alt+3)"><span class="${NS}-ic">🖍</span><span class="${NS}-lbl">Highlight</span></button>
      <button data-tool="text" class="${NS}-tool" title="Text label (Alt+4)"><span class="${NS}-ic">T</span><span class="${NS}-lbl">Text</span></button>
      <button data-tool="redact" class="${NS}-tool" title="Redact (Alt+5)"><span class="${NS}-ic">▮</span><span class="${NS}-lbl">Redact</span></button>
      <label class="${NS}-tool ${NS}-coltool" title="Color"><input type="color" id="${NS}-color" value="#e11d48" /><span class="${NS}-lbl">Color</span></label>
      <button id="${NS}-undo" class="${NS}-tool" title="Undo last"><span class="${NS}-ic">↶</span><span class="${NS}-lbl">Undo</span></button>
    </div>

    <span class="${NS}-sep"></span>

    <div class="${NS}-group">
      <button id="${NS}-draw" class="${NS}-tool ${NS}-toggle" title="Toggle annotate (Alt+A)"><span class="${NS}-ic">✎</span><span class="${NS}-lbl" id="${NS}-drawlbl">Annotate</span></button>
      <button id="${NS}-capture" class="${NS}-tool ${NS}-cap" title="Capture (Alt+S)"><span class="${NS}-ic">📸</span><span class="${NS}-lbl">Capture</span></button>
      <button id="${NS}-capturedelay" class="${NS}-tool" title="Capture after a delay"><span class="${NS}-ic">⏱</span><span class="${NS}-lbl">Delay</span></button>
      <select id="${NS}-delaysel" class="${NS}-delaysel" title="Delay seconds">
        <option value="3">3s</option>
        <option value="5">5s</option>
        <option value="10">10s</option>
      </select>
      <button id="${NS}-record" class="${NS}-tool" title="Record screen (Alt+R)"><span class="${NS}-ic">⏺</span><span class="${NS}-lbl">Record</span></button>
      <label class="${NS}-tool ${NS}-audiolbl" title="Include microphone audio"><span class="${NS}-ic">🎙</span><input type="checkbox" id="${NS}-audio" class="${NS}-audiochk"/><span class="${NS}-lbl">Audio</span></label>
    </div>

    <span class="${NS}-sep"></span>

    <div class="${NS}-group">
      <button id="${NS}-newsc" class="${NS}-tool" title="Start a new scenario (steps restart at 1)"><span class="${NS}-ic">＋</span><span class="${NS}-lbl">Scenario</span></button>
      <button id="${NS}-help" class="${NS}-tool" title="Keyboard shortcuts"><span class="${NS}-ic">?</span><span class="${NS}-lbl">Help</span></button>
      <button id="${NS}-close" class="${NS}-tool ${NS}-closebtn" title="Hide toolbar"><span class="${NS}-ic">✕</span></button>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #${NS}-bar {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
      justify-content: center;
      background: #1f2733; color: #fff; padding: 5px 8px; border-radius: 10px;
      font: 13px -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      box-shadow: 0 6px 22px rgba(0,0,0,.35);
      max-width: 96vw;
    }
    #${NS}-bar .${NS}-group { display: flex; gap: 3px; align-items: stretch; }
    #${NS}-bar .${NS}-sep { width: 1px; align-self: stretch; background: #3a4452; margin: 2px 5px; }
    #${NS}-bar .${NS}-brand { display: flex; align-items: center; margin-right: 2px; }
    #${NS}-bar .${NS}-brandmark {
      width: 22px; height: 22px; border-radius: 6px; background: #2563eb;
      position: relative; display: inline-block;
    }
    #${NS}-bar .${NS}-brandmark::after {
      content: ""; position: absolute; left: 6px; top: 7px; width: 10px; height: 8px;
      border: 2px solid #fff; border-radius: 2px;
    }
    #${NS}-bar .${NS}-scenario {
      max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; background: #38414f; padding: 4px 7px; border-radius: 6px; opacity: .9;
      align-self: center;
    }
    /* Icon + label buttons */
    #${NS}-bar .${NS}-tool {
      cursor: pointer; border: none; border-radius: 6px; padding: 3px 5px;
      background: #38414f; color: #fff;
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      min-width: 32px; line-height: 1;
    }
    #${NS}-bar .${NS}-tool:hover { background: #4a5563; }
    #${NS}-bar .${NS}-ic { font-size: 13px; height: 15px; display: flex; align-items: center; }
    #${NS}-bar .${NS}-lbl { font-size: 8px; opacity: .8; letter-spacing: .2px; }
    #${NS}-bar .${NS}-tool.${NS}-on { background: #2563eb; }
    #${NS}-bar .${NS}-tool.${NS}-on .${NS}-lbl { opacity: 1; }
    #${NS}-bar .${NS}-toggle.${NS}-on { background: #16a34a; }
    #${NS}-bar .${NS}-cap { background: #2563eb; }
    #${NS}-bar .${NS}-tool.${NS}-recording { background: #dc2626; }
    #${NS}-bar .${NS}-closebtn { min-width: 32px; }
    /* Color tool: swatch sits where the icon would be */
    #${NS}-bar .${NS}-coltool { position: relative; }
    #${NS}-bar .${NS}-coltool input[type=color] {
      width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
      background: none; cursor: pointer;
    }
    /* Audio checkbox hidden; the whole label toggles it visually */
    #${NS}-bar .${NS}-audiochk { position: absolute; opacity: 0; width: 0; height: 0; }
    #${NS}-bar .${NS}-delaysel {
      background: #38414f; color: #fff; border: none; border-radius: 7px;
      padding: 4px 2px; font: inherit; font-size: 11px; cursor: pointer; align-self: stretch;
    }
    #${NS}-prompt {
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; background: #fff; color: #1f2733; border-radius: 10px;
      padding: 14px; width: 420px; max-width: 92vw;
      box-shadow: 0 6px 24px rgba(0,0,0,.3);
      font: 13px -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    }
    #${NS}-prompt h3 { margin: 0 0 8px; font-size: 14px; }
    #${NS}-prompt input[type=text] {
      width: 100%; box-sizing: border-box; padding: 7px 9px; margin-bottom: 8px;
      border: 1px solid #d4d9e0; border-radius: 6px; font: inherit;
    }
    #${NS}-prompt .${NS}-preset {
      width: 100%; box-sizing: border-box; padding: 7px 9px; margin-bottom: 8px;
      border: 1px solid #c7d2fe; background:#f5f8ff; border-radius: 6px; font: inherit; color:#3538cd; cursor:pointer;
    }
    #${NS}-prompt .${NS}-st { display: flex; gap: 8px; margin-bottom: 8px; }
    #${NS}-prompt .${NS}-st button {
      flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #d4d9e0;
      background: #f5f7fa; color: #6b7785; font-weight: 600; cursor: pointer; font: inherit;
    }
    #${NS}-prompt .${NS}-st button.${NS}-pass { background: #dcfce7; color: #15803d; border-color:#15803d; }
    #${NS}-prompt .${NS}-st button.${NS}-fail { background: #fee2e2; color: #b91c1c; border-color:#b91c1c; }
    #${NS}-prompt .${NS}-row { display: flex; gap: 8px; }
    #${NS}-prompt .${NS}-row button { flex: 1; padding: 8px; border-radius: 6px; border: none; cursor: pointer; font: inherit; }
    #${NS}-prompt .${NS}-save { background: #2563eb; color: #fff; font-weight: 600; }
    #${NS}-prompt .${NS}-cancel { background: #eef1f5; color: #1f2733; }
    #${NS}-prompt .${NS}-dl { background: #e7f0ff; color: #2563eb; font-weight: 600; border: 1px solid #c7d2fe; }
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(canvas);
  document.documentElement.appendChild(bar);

  const ctx = canvas.getContext("2d");
  function sizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    redraw();
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  // ---- Toolbar wiring ----
  bar.querySelectorAll(`.${NS}-tool[data-tool]`).forEach((b) => {
    b.addEventListener("click", () => selectTool(b.dataset.tool));
  });
  let userPickedColor = false;
  function selectTool(name) {
    tool = name;
    bar.querySelectorAll(`.${NS}-tool[data-tool]`).forEach((x) => x.classList.toggle(`${NS}-on`, x.dataset.tool === name));
    // Helpful default colors: yellow for highlighter, red for drawing — unless the user chose their own.
    if (!userPickedColor) {
      const picker = bar.querySelector(`#${NS}-color`);
      const auto = name === "highlight" ? "#ffeb3b" : "#e11d48";
      color = auto; if (picker) picker.value = auto;
    }
  }
  bar.querySelector(`#${NS}-color`).addEventListener("input", (e) => { color = e.target.value; userPickedColor = true; });
  bar.querySelector(`#${NS}-undo`).addEventListener("click", () => { shapes.pop(); redraw(); });
  bar.querySelector(`#${NS}-close`).addEventListener("click", () => teardown());
  bar.querySelector(`#${NS}-help`).addEventListener("click", toggleShortcuts);

  function toggleShortcuts() {
    let pop = document.getElementById(`${NS}-shortcuts`);
    if (pop) { pop.remove(); return; }
    pop = document.createElement("div");
    pop.id = `${NS}-shortcuts`;
    pop.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">Keyboard shortcuts</div>
      <table style="border-collapse:collapse;font-size:12px;">
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+A</b></td><td>Toggle annotate</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+S</b></td><td>Capture</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+R</b></td><td>Record start/stop</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+1</b></td><td>Arrow</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+2</b></td><td>Box</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+3</b></td><td>Highlight</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+4</b></td><td>Text</td></tr>
        <tr><td style="padding:2px 10px 2px 0;"><b>Alt+5</b></td><td>Redact</td></tr>
      </table>`;
    Object.assign(pop.style, {
      position: "fixed", top: "70px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", background: "#1f2733", color: "#fff",
      padding: "12px 16px", borderRadius: "10px", boxShadow: "0 4px 16px rgba(0,0,0,.3)",
      font: "13px -apple-system, Arial, sans-serif"
    });
    document.documentElement.appendChild(pop);
    setTimeout(() => { const p = document.getElementById(`${NS}-shortcuts`); if (p) p.remove(); }, 6000);
  }
  bar.querySelector(`#${NS}-newsc`).addEventListener("click", promptNewScenario);

  // Show the current active scenario in the toolbar.
  function refreshScenarioLabel() {
    chrome.runtime.sendMessage({ type: "GET_ACTIVE_SCENARIO" }, (res) => {
      const el = bar.querySelector(`#${NS}-scenario`);
      if (res && res.ok && res.scenario) {
        el.textContent = `${res.index}. ${res.scenario.testId}`;
        el.title = `${res.scenario.testId} — ${res.scenario.title}`;
      } else {
        el.textContent = "no session";
      }
    });
  }
  refreshScenarioLabel();

  function promptNewScenario() {
    const old = document.getElementById(`${NS}-prompt`);
    if (old) old.remove();
    const p = document.createElement("div");
    p.id = `${NS}-prompt`;
    p.innerHTML = `
      <h3>New scenario</h3>
      <input type="text" id="${NS}-sc-id" placeholder="Scenario / Test ID (e.g. US130413)" />
      <input type="text" id="${NS}-sc-title" placeholder="Scenario title" />
      <div class="${NS}-row">
        <button class="${NS}-cancel" id="${NS}-sc-cancel">Cancel</button>
        <button class="${NS}-save" id="${NS}-sc-start">Start Scenario</button>
      </div>
    `;
    document.documentElement.appendChild(p);
    const idIn = p.querySelector(`#${NS}-sc-id`);
    idIn.focus();
    p.querySelector(`#${NS}-sc-cancel`).addEventListener("click", () => p.remove());
    const startBtn = p.querySelector(`#${NS}-sc-start`);
    let submitting = false;
    const doStart = () => {
      if (submitting) return;           // guard against rapid double-clicks
      submitting = true;
      startBtn.disabled = true;
      startBtn.textContent = "Starting…";
      chrome.runtime.sendMessage({
        type: "NEW_SCENARIO",
        testId: idIn.value.trim(),
        title: p.querySelector(`#${NS}-sc-title`).value.trim()
      }, (r) => {
        p.remove();
        if (r && r.ok) {
          shapes = []; redraw();
          refreshScenarioLabel();
          flash(`Started scenario: ${r.scenario.testId} (steps restart at 1)`);
        } else {
          submitting = false;
          alert("Could not start scenario: " + (r?.error || "no active session."));
        }
      });
    };
    startBtn.addEventListener("click", doStart);
    // Enter key in either field also starts (once).
    [idIn, p.querySelector(`#${NS}-sc-title`)].forEach((el) => {
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doStart(); } });
    });
  }

  const drawBtn = bar.querySelector(`#${NS}-draw`);
  drawBtn.addEventListener("click", () => setActive(!active));

  bar.querySelector(`#${NS}-capture`).addEventListener("click", onCapture);
  bar.querySelector(`#${NS}-capturedelay`).addEventListener("click", onDelayedCapture);

  // Delayed capture: show a countdown, then capture. Lets the tester open a
  // hover menu / dropdown that would close on click.
  let countdownTimer = null;
  function onDelayedCapture() {
    if (countdownTimer) return; // already counting
    const secs = parseInt(bar.querySelector(`#${NS}-delaysel`).value, 10) || 3;
    let remaining = secs;
    const overlay = document.createElement("div");
    overlay.id = `${NS}-countdown`;
    Object.assign(overlay.style, {
      position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", background: "rgba(31,39,51,0.95)", color: "#fff",
      width: "92px", height: "92px", borderRadius: "50%", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center",
      font: "600 13px -apple-system, Arial, sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,.4)",
      pointerEvents: "none"
    });
    overlay.innerHTML = `<div style="font-size:34px;line-height:1;">${remaining}</div><div style="opacity:.8;margin-top:2px;">capturing…</div>`;
    document.documentElement.appendChild(overlay);

    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        overlay.querySelector("div").textContent = remaining;
      } else {
        clearInterval(countdownTimer); countdownTimer = null;
        overlay.remove();
        onCapture(); // fires the normal capture (which hides the toolbar itself)
      }
    }, 1000);
  }
  bar.querySelector(`#${NS}-record`).addEventListener("click", onRecordToggle);
  // Audio toggle visual state
  const audioChk = bar.querySelector(`#${NS}-audio`);
  const audioLbl = audioChk.closest(`.${NS}-audiolbl`);
  audioChk.addEventListener("change", () => audioLbl.classList.toggle(`${NS}-on`, audioChk.checked));

  // ---- Keyboard shortcuts (Alt+key) ----
  function onKeyDown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    // Ignore while typing in our own prompt inputs.
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    const k = e.key.toLowerCase();
    const map = {
      a: () => setActive(!active),
      s: () => onCapture(),
      r: () => onRecordToggle(),
      "1": () => selectTool("arrow"),
      "2": () => selectTool("box"),
      "3": () => selectTool("highlight"),
      "4": () => selectTool("text"),
      "5": () => selectTool("redact")
    };
    if (map[k]) { e.preventDefault(); e.stopPropagation(); map[k](); }
  }
  window.addEventListener("keydown", onKeyDown, true);

  // ---- Screen recording ----
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStream = null;

  async function onRecordToggle() {
    const btn = bar.querySelector(`#${NS}-record`);
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop(); // triggers onstop -> handleRecordingDone
      return;
    }
    // Start recording
    const wantAudio = bar.querySelector(`#${NS}-audio`).checked;
    try {
      recordStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 12 },
        audio: false
      });
      if (wantAudio) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          mic.getAudioTracks().forEach((t) => recordStream.addTrack(t));
        } catch (e) {
          flash("Mic unavailable — recording video only.");
        }
      }
    } catch (e) {
      flash("Recording cancelled.");
      return;
    }

    recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    mediaRecorder = new MediaRecorder(recordStream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingDone;
    // If the user stops sharing via the browser's own control, end gracefully.
    recordStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    });
    mediaRecorder.start();
    // Guard: if the page is refreshed or navigated away while recording, the
    // recording lives in this page's memory and would be lost. Warn the user.
    // (A full fix that survives refresh is a separate offscreen-document rework.)
    window.addEventListener("beforeunload", recordingUnloadGuard);
    const ic = btn.querySelector(`.${NS}-ic`); const lbl = btn.querySelector(`.${NS}-lbl`);
    if (ic) ic.textContent = "⏹"; if (lbl) lbl.textContent = "Stop";
    btn.classList.add(`${NS}-recording`);
  }

  function recordingUnloadGuard(e) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      e.preventDefault();
      e.returnValue = "A screen recording is in progress. Leaving or refreshing this page will lose it. Stop the recording first to keep it.";
      return e.returnValue;
    }
  }

  function stopStreamTracks() {
    if (recordStream) { recordStream.getTracks().forEach((t) => t.stop()); recordStream = null; }
    const btn = bar.querySelector(`#${NS}-record`);
    const ic = btn.querySelector(`.${NS}-ic`); const lbl = btn.querySelector(`.${NS}-lbl`);
    if (ic) ic.textContent = "⏺"; if (lbl) lbl.textContent = "Record";
    btn.classList.remove(`${NS}-recording`);
  }

  async function handleRecordingDone() {
    window.removeEventListener("beforeunload", recordingUnloadGuard);
    stopStreamTracks();
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    recordedChunks = [];
    if (!blob.size) { flash("Empty recording discarded."); return; }
    const sizeMB = blob.size / (1024 * 1024);
    // Convert to base64 for the message hop to the background.
    const base64 = await blobToBase64(blob);
    showRecordingPrompt(base64, sizeMB);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.onerror = () => reject(new Error("encode failed"));
      r.readAsDataURL(blob);
    });
  }


  function setActive(on) {
    active = on;
    canvas.style.display = on ? "block" : "none";
    canvas.style.pointerEvents = on ? "auto" : "none";
    const lbl = bar.querySelector(`#${NS}-drawlbl`);
    if (lbl) lbl.textContent = on ? "Annotate ✓" : "Annotate";
    drawBtn.classList.toggle(`${NS}-on`, on);
  }

  // ---- Drawing ----
  canvas.addEventListener("pointerdown", (e) => {
    if (!active) return;
    if (tool === "text") {
      // In-place text editing: drop an input where clicked, type live, commit on Enter/blur.
      startTextInput(e.clientX, e.clientY);
      return;
    }
    drawing = true;
    cur = { tool, color, x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY };
  });

  let textInput = null;
  function startTextInput(x, y) {
    if (textInput) commitTextInput(); // commit any existing one first
    const fontSize = 22;
    textInput = document.createElement("input");
    textInput.type = "text";
    textInput.placeholder = "Type label…";
    Object.assign(textInput.style, {
      position: "fixed", left: x + "px", top: y + "px",
      zIndex: "2147483647",
      font: `bold ${fontSize}px -apple-system, "Segoe UI", Arial, sans-serif`,
      color: color, background: "rgba(255,255,255,0.92)",
      border: "2px dashed " + color, borderRadius: "4px",
      padding: "2px 6px", outline: "none", minWidth: "120px",
      lineHeight: fontSize + "px"
    });
    // Store the canvas-space anchor so the committed text lands exactly here.
    textInput.dataset.x = x;
    textInput.dataset.y = y;
    document.documentElement.appendChild(textInput);
    // Let pointer events reach the input (the canvas overlay would otherwise swallow
    // clicks and caret placement). Restored on commit/cancel.
    canvas.style.pointerEvents = "none";
    setTimeout(() => {
      if (!textInput) return;
      textInput.focus();
      // Attach blur only after focus settles, so the creating click doesn't
      // instantly fire blur and commit an empty label.
      textInput.addEventListener("blur", () => commitTextInput());
    }, 30);

    textInput.addEventListener("keydown", (ev) => {
      ev.stopPropagation(); // don't trigger toolbar hotkeys while typing
      if (ev.key === "Enter") { ev.preventDefault(); commitTextInput(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancelTextInput(); }
    });
  }

  function restoreCanvasPointer() {
    if (active) canvas.style.pointerEvents = "auto";
  }

  function commitTextInput() {
    if (!textInput) return;
    const val = textInput.value.trim();
    const x = parseFloat(textInput.dataset.x);
    const y = parseFloat(textInput.dataset.y);
    const inputEl = textInput;
    textInput = null;            // clear first to avoid blur re-entry
    inputEl.remove();
    restoreCanvasPointer();
    if (val) {
      // The input padding offsets the text ~2px/6px; align the canvas text to match.
      shapes.push({ tool: "text", color, x1: x + 6, y1: y + 4, text: val });
      redraw();
    }
  }

  function cancelTextInput() {
    if (!textInput) return;
    const el = textInput; textInput = null; el.remove();
    restoreCanvasPointer();
  }
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    cur.x2 = e.clientX; cur.y2 = e.clientY;
    redraw(); drawShape(cur);
  });
  window.addEventListener("pointerup", () => {
    if (!drawing) return;
    drawing = false;
    if (Math.abs(cur.x2 - cur.x1) > 4 || Math.abs(cur.y2 - cur.y1) > 4) shapes.push(cur);
    cur = null; redraw();
  });

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    shapes.forEach(drawShape);
  }
  function drawShape(s) {
    const lw = 3;
    if (s.tool === "box") {
      ctx.strokeStyle = s.color; ctx.lineWidth = lw;
      ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    } else if (s.tool === "highlight") {
      // Semi-transparent marker. 'multiply' lets underlying content show through like a real highlighter.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      ctx.restore();
    } else if (s.tool === "redact") {
      ctx.fillStyle = "#000";
      ctx.fillRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
    } else if (s.tool === "text") {
      const fontSize = 22;
      ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", Arial, sans-serif`;
      ctx.textBaseline = "top";
      // White outline for legibility on any background, then colored fill.
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineJoin = "round";
      ctx.strokeText(s.text, s.x1, s.y1);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x1, s.y1);
    } else {
      const head = 14, ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }
  }

  // ---- Capture flow ----
  // Temporarily disable pointer events + keep overlay visible so captureVisibleTab
  // grabs page + annotations together.
  let capturing = false;
  async function onCapture() {
    if (capturing) return;            // ignore rapid repeat clicks / Alt+S mashing
    capturing = true;
    if (textInput) commitTextInput(); // bake any in-progress label first
    canvas.style.pointerEvents = "none";
    bar.style.display = "none";       // hide toolbar from the screenshot
    // allow a paint frame before capture
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const finish = () => {
      bar.style.display = "flex";
      if (active) canvas.style.pointerEvents = "auto";
      capturing = false;              // always reset, even on error/timeout
    };

    // Send capture request. The retry exists for the case where the MV3 service
    // worker was asleep and the FIRST message gets dropped entirely (no response,
    // no error). A legitimately slow capture on a heavy page is NOT a failure, so
    // we use a generous timeout and only retry once, with a longer window.
    const send = (attempt) => {
      let answered = false;
      // First attempt: allow plenty of time for a large page to capture + downscale.
      // Only the wake-up retry uses a shorter window (worker is now warm).
      const timeoutMs = attempt === 1 ? 8000 : 6000;
      const timer = setTimeout(() => {
        if (answered) return;
        if (attempt < 2) { send(attempt + 1); }   // wake-up retry (worker likely was asleep)
        else { finish(); alert("Capture is taking longer than expected. The page may be very large or busy — please try again."); }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_PAGE" }, (res) => {
          if (answered) return;       // ignore a late second response
          answered = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            if (attempt < 2) { send(attempt + 1); return; }
            finish(); alert("Capture failed: " + chrome.runtime.lastError.message);
            return;
          }
          finish();
          if (!res || !res.ok) { alert("Capture failed: " + (res?.error || "unknown error")); return; }
          showPrompt(res);
        });
      } catch (e) {
        clearTimeout(timer);
        finish();
        alert("Capture failed: " + (e.message || e));
      }
    };
    send(1);
  }

  function showPrompt(capture) {
    const old = document.getElementById(`${NS}-prompt`);
    if (old) old.remove();
    let status = "Pass";
    const p = document.createElement("div");
    p.id = `${NS}-prompt`;
    p.innerHTML = `
      <h3>Add step</h3>
      <select id="${NS}-preset" class="${NS}-preset"><option value="">— Prefill from a preset —</option></select>
      <input type="text" id="${NS}-cap-input" placeholder="Action / description (e.g. Filtered by opted-in)" />
      <input type="text" id="${NS}-expected" placeholder="Expected result (used for Test Cases & failed bugs)" />
      <div class="${NS}-st">
        <button id="${NS}-pass" class="${NS}-pass">Pass</button>
        <button id="${NS}-fail">Fail</button>
      </div>
      <div id="${NS}-ea" style="display:none;">
        <input type="text" id="${NS}-actual" placeholder="Actual — what actually happened" />
      </div>
      <div class="${NS}-row">
        <button class="${NS}-cancel" id="${NS}-discard">Discard</button>
        <button class="${NS}-save" id="${NS}-add">Add Step</button>
      </div>
    `;
    document.documentElement.appendChild(p);
    const capInput = p.querySelector(`#${NS}-cap-input`);
    capInput.focus();
    const passBtn = p.querySelector(`#${NS}-pass`);
    const failBtn = p.querySelector(`#${NS}-fail`);
    const eaWrap = p.querySelector(`#${NS}-ea`);

    // Populate the preset dropdown from saved standard steps, grouped by category.
    const presetSel = p.querySelector(`#${NS}-preset`);
    chrome.storage.local.get("qa_testlog_stdsteps", (res) => {
      const presets = res["qa_testlog_stdsteps"] || [];
      if (!presets.length) { presetSel.style.display = "none"; return; }
      // Group by category, sort groups and items.
      const groups = {};
      presets.forEach((st, i) => {
        const cat = (st.category || "").trim() || "Uncategorized";
        (groups[cat] = groups[cat] || []).push({ st, i });
      });
      Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach((cat) => {
        const og = document.createElement("optgroup");
        og.label = cat;
        groups[cat].sort((a, b) => a.st.desc.localeCompare(b.st.desc)).forEach(({ st, i }) => {
          const o = document.createElement("option");
          o.value = String(i);
          o.textContent = st.desc + (st.expected ? " — " + st.expected : "");
          og.appendChild(o);
        });
        presetSel.appendChild(og);
      });
      presetSel.addEventListener("change", () => {
        const st = presets[parseInt(presetSel.value, 10)];
        if (!st) return;
        capInput.value = st.desc || "";
        p.querySelector(`#${NS}-expected`).value = st.expected || "";
        if (st.status === "Fail") { failBtn.click(); } else { passBtn.click(); }
        capInput.focus();
      });
    });
    passBtn.addEventListener("click", () => {
      status = "Pass"; passBtn.className = `${NS}-pass`; failBtn.className = "";
      eaWrap.style.display = "none";
    });
    failBtn.addEventListener("click", () => {
      status = "Fail"; failBtn.className = `${NS}-fail`; passBtn.className = "";
      eaWrap.style.display = "block";
      p.querySelector(`#${NS}-actual`).focus();
    });

    p.querySelector(`#${NS}-discard`).addEventListener("click", () => p.remove());
    const addBtn = p.querySelector(`#${NS}-add`);
    let adding = false;
    addBtn.addEventListener("click", () => {
      if (adding) return;
      adding = true;
      addBtn.disabled = true;
      chrome.runtime.sendMessage({
        type: "ADD_STEP",
        step: {
          caption: capInput.value.trim() || "(no description)",
          status,
          expected: p.querySelector(`#${NS}-expected`).value.trim(),
          actual: status === "Fail" ? p.querySelector(`#${NS}-actual`).value.trim() : "",
          dataUrl: capture.dataUrl, width: capture.width, height: capture.height,
          pageUrl: capture.pageUrl, timestamp: capture.timestamp
        }
      }, (r) => {
        p.remove();
        if (r && r.ok) {
          shapes = []; redraw();   // clear annotations for next capture
          flash(`Step ${r.scenarioCount} added to this scenario`);
        } else {
          adding = false;
          alert("Could not add step: " + (r?.error || "no active session. Open the extension and Start Session first."));
        }
      });
    });
  }

  function showRecordingPrompt(base64, sizeMB) {
    const old = document.getElementById(`${NS}-prompt`);
    if (old) old.remove();
    let mode = "existing";
    const p = document.createElement("div");
    p.id = `${NS}-prompt`;
    p.innerHTML = `
      <h3>Attach recording (${sizeMB.toFixed(1)} MB)</h3>
      <input type="text" id="${NS}-rec-name" placeholder="File name (without extension)" value="recording" />
      <div class="${NS}-st">
        <button id="${NS}-rec-existing" class="${NS}-pass">Existing work item</button>
        <button id="${NS}-rec-new">New Bug</button>
      </div>
      <input type="text" id="${NS}-rec-wi" placeholder="Work item ID (parent/target)" />
      <div class="${NS}-row">
        <button class="${NS}-cancel" id="${NS}-rec-discard">Discard</button>
        <button id="${NS}-rec-download" class="${NS}-dl">Download</button>
        <button class="${NS}-save" id="${NS}-rec-go">Attach</button>
      </div>
      <div id="${NS}-rec-status" style="font-size:12px;color:#555;margin-top:6px;"></div>
    `;
    document.documentElement.appendChild(p);
    const exBtn = p.querySelector(`#${NS}-rec-existing`);
    const newBtn = p.querySelector(`#${NS}-rec-new`);
    const wi = p.querySelector(`#${NS}-rec-wi`);
    exBtn.addEventListener("click", () => { mode = "existing"; exBtn.className = `${NS}-pass`; newBtn.className = ""; wi.placeholder = "Work item ID to attach to"; });
    newBtn.addEventListener("click", () => { mode = "new"; newBtn.className = `${NS}-pass`; exBtn.className = ""; wi.placeholder = "Parent ID (optional) — links new Bug as Child"; });

    // Download the recording locally (independent of ADO).
    p.querySelector(`#${NS}-rec-download`).addEventListener("click", () => {
      try {
        const name = (p.querySelector(`#${NS}-rec-name`).value.trim() || "recording") + ".webm";
        // base64 (data URL) -> Blob -> object URL -> anchor download
        const comma = base64.indexOf(",");
        const b64 = comma >= 0 ? base64.slice(comma + 1) : base64;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        p.querySelector(`#${NS}-rec-status`).textContent = "✓ Download started. You can also attach it to ADO, or Discard.";
      } catch (e) {
        p.querySelector(`#${NS}-rec-status`).textContent = "✗ Download failed: " + (e.message || e);
      }
    });

    p.querySelector(`#${NS}-rec-discard`).addEventListener("click", () => p.remove());
    p.querySelector(`#${NS}-rec-go`).addEventListener("click", () => {
      if (sizeMB > 128) {
        p.querySelector(`#${NS}-rec-status`).textContent = "Recording is too large (>128MB) for upload. Record a shorter clip.";
        return;
      }
      const name = (p.querySelector(`#${NS}-rec-name`).value.trim() || "recording") + ".webm";
      const wiId = wi.value.trim();
      if (mode === "existing" && !wiId) { p.querySelector(`#${NS}-rec-status`).textContent = "Enter a work item ID."; return; }
      p.querySelector(`#${NS}-rec-status`).textContent = "Uploading…";
      chrome.runtime.sendMessage({
        type: "ADO_PUSH_RECORDING",
        scenarioId: null,
        options: { mode, workItemId: mode === "existing" ? wiId : "", parentId: mode === "new" ? wiId : "", recBase64: base64, recFileName: name }
      }, (r) => {
        if (r && r.ok) { p.remove(); flash(`Recording attached to #${r.workItemId}`); }
        else { p.querySelector(`#${NS}-rec-status`).textContent = "✗ " + (r?.error || "failed"); }
      });
    });
  }

  function flash(text) {
    const f = document.createElement("div");
    Object.assign(f.style, {
      position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", background: "#16a34a", color: "#fff", padding: "8px 14px",
      borderRadius: "8px", font: "13px -apple-system, Arial, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,.3)"
    });
    f.textContent = text;
    document.documentElement.appendChild(f);
    setTimeout(() => f.remove(), 1800);
  }

  function teardown() {
    window.__qaTestLogInjected = false;
    [canvas, bar, style].forEach((el) => el && el.remove());
    const p = document.getElementById(`${NS}-prompt`);
    if (p) p.remove();
    window.removeEventListener("resize", sizeCanvas);
    window.removeEventListener("keydown", onKeyDown, true);
    const sc = document.getElementById(`${NS}-shortcuts`); if (sc) sc.remove();
    const cd = document.getElementById(`${NS}-countdown`); if (cd) cd.remove();
    if (textInput) { textInput.remove(); textInput = null; }
  }

  // Allow the popup to re-toggle / teardown
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === "TEARDOWN_OVERLAY") { teardown(); sendResponse({ ok: true }); }
    return true;
  });
})();
