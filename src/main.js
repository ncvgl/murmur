// Shell: picks a transcription engine (English/Moonshine or Hebrew/Whisper+VAD),
// lazy-loads only the chosen one, and owns all shared UI — transcript rendering,
// timer, copy/download, and (English only) translation.

const startEn = document.getElementById("startEn");
const startHe = document.getElementById("startHe");
const stopBtn = document.getElementById("stopBtn");
const status = document.getElementById("status");
const output = document.getElementById("output");
const timerEl = document.getElementById("timer");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const trToggle = document.getElementById("trToggle");
const trLang = document.getElementById("trLang");

let recording = false;
let finishing = false; // stopped listening, still draining the transcription queue
let currentMode = null; // 'en' | 'he'
let engine = null;

let startTime = null;
let timerInterval = null;
let speechStartTs = null;
let lastPartialTime = 0;
let committedLines = [];
let nextSentenceId = 1;

// Translation state (English path only)
let trWorker = null;
let trEnabled = false;
let trLangCode = trLang.value;
let trEpoch = 0;

// ---- Timer --------------------------------------------------------------

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function getTimestamp() {
  if (!startTime) return "00:00";
  return formatTime(Date.now() - startTime);
}

function startTimer() {
  clearInterval(timerInterval);
  startTime = Date.now();
  timerEl.classList.add("active");
  timerEl.textContent = "00:00";
  timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - startTime);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerEl.classList.remove("active");
}

// ---- Transcript rendering ----------------------------------------------

function isNearBottom() {
  return output.scrollHeight - output.scrollTop - output.clientHeight < 40;
}

function makeLine(text, timestamp, isPartial, id) {
  const line = document.createElement("div");
  line.className = isPartial ? "line partial" : "line";
  if (isPartial) line.id = "partial";
  if (id != null) line.dataset.id = String(id);
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = timestamp;
  const content = document.createElement("span");
  content.className = "text";
  content.dir = currentMode === "he" ? "rtl" : "ltr";
  content.textContent = text;
  line.appendChild(ts);
  line.appendChild(content);
  // Translation column exists only on the English path.
  if (!isPartial && currentMode === "en") {
    const translated = document.createElement("span");
    translated.className = trEnabled ? "translated pending" : "translated";
    translated.textContent = trEnabled ? "…" : "";
    line.appendChild(translated);
  }
  return line;
}

function removePartial() {
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
}

function clearTranscript() {
  output.innerHTML = "";
  committedLines = [];
  nextSentenceId = 1;
  speechStartTs = null;
}

// ---- Shared sink: the API engines call ---------------------------------

const sink = {
  status(text) {
    status.textContent = text;
  },
  ready(label) {
    status.textContent = recording ? `Listening…${label ? ` (${label})` : ""}` : "Ready.";
  },
  error(msg) {
    console.error("[engine]", msg);
    try { engine?.stop?.(); } catch {}
    engine = null;
    recording = false;
    stopTimer();
    removePartial();
    showIdleUI();
    status.textContent = `Error: ${msg}`;
  },
  speechStart() {
    speechStartTs = getTimestamp();
  },
  // English live partial, or the Hebrew "speaking" placeholder.
  partial(text) {
    if (!text.trim()) return;
    const now = Date.now();
    if (now - lastPartialTime < 1000) return;
    lastPartialTime = now;
    removePartial();
    const stick = isNearBottom();
    const line = makeLine(text.trim(), speechStartTs || getTimestamp(), true, null);
    output.appendChild(line);
    if (stick) output.scrollTop = output.scrollHeight;
  },
  clearPartial() {
    removePartial();
  },
  // English: a fully-recognised line arrives at once.
  commit(text) {
    if (!text.trim()) return;
    removePartial();
    const tsStart = speechStartTs || getTimestamp();
    const tsEnd = getTimestamp();
    const id = nextSentenceId++;
    const entry = { id, text: text.trim(), tsStart, tsEnd, translation: "" };
    committedLines.push(entry);
    const stick = isNearBottom();
    const line = makeLine(text.trim(), `${tsStart} - ${tsEnd}`, false, id);
    output.appendChild(line);
    if (stick) output.scrollTop = output.scrollHeight;
    speechStartTs = null;
    submitTranslation(id, entry.text);
  },
  // Hebrew: a segment ended; show a placeholder line and return its id.
  beginPending() {
    const tsStart = speechStartTs || getTimestamp();
    const tsEnd = getTimestamp();
    const id = nextSentenceId++;
    committedLines.push({ id, text: "", tsStart, tsEnd, translation: "" });
    const stick = isNearBottom();
    const line = makeLine("…", `${tsStart} - ${tsEnd}`, false, id);
    line.querySelector(".text").classList.add("pending");
    output.appendChild(line);
    if (stick) output.scrollTop = output.scrollHeight;
    speechStartTs = null;
    return id;
  },
  // Hebrew: refresh a still-pending line's placeholder (e.g. queue position).
  updatePending(id, placeholder) {
    const cell = output.querySelector(`[data-id="${id}"] .text`);
    if (cell && cell.classList.contains("pending")) cell.textContent = placeholder;
  },
  resolvePending(id, text) {
    const entry = committedLines.find((l) => l.id === id);
    const lineEl = output.querySelector(`[data-id="${id}"]`);
    if (!text || !text.trim()) {
      committedLines = committedLines.filter((l) => l.id !== id);
      if (lineEl) lineEl.remove();
      return;
    }
    if (entry) entry.text = text.trim();
    if (lineEl) {
      const cell = lineEl.querySelector(".text");
      cell.textContent = text.trim();
      cell.classList.remove("pending");
    }
  },
  failPending(id, message) {
    console.error("[transcribe]", message);
    const entry = committedLines.find((l) => l.id === id);
    if (entry) entry.text = "(transcription failed)";
    const cell = output.querySelector(`[data-id="${id}"] .text`);
    if (cell) {
      cell.textContent = "(transcription failed)";
      cell.classList.remove("pending");
    }
  },
};

// ---- Translation (English only) ----------------------------------------

function ensureTrWorker() {
  if (trWorker) return trWorker;
  trWorker = new Worker(new URL("./translation-worker.js", import.meta.url), { type: "module" });
  trWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "loading") {
      status.textContent = `Loading translation model (${msg.lang})...`;
    } else if (msg.type === "ready") {
      status.textContent = recording ? "Listening..." : "Ready.";
    } else if (msg.type === "translation") {
      if (msg.epoch !== trEpoch) return;
      const line = committedLines.find((l) => l.id === msg.id);
      if (line) line.translation = msg.text;
      const cell = output.querySelector(`[data-id="${msg.id}"] .translated`);
      if (cell) {
        cell.textContent = msg.text;
        cell.classList.remove("pending");
      }
    } else if (msg.type === "translation_error") {
      const cell = output.querySelector(`[data-id="${msg.id}"] .translated`);
      if (cell) {
        cell.textContent = "(translation failed)";
        cell.classList.remove("pending");
      }
    } else if (msg.type === "error") {
      status.textContent = `Translation error: ${msg.message}`;
    }
  };
  return trWorker;
}

function submitTranslation(id, text) {
  if (currentMode !== "en" || !trEnabled) return;
  ensureTrWorker().postMessage({ type: "translate", id, text, lang: trLangCode, epoch: trEpoch });
}

function updateTranslating() {
  document.body.classList.toggle("translating", currentMode === "en" && trEnabled);
}

// ---- UI state -----------------------------------------------------------

function showRecordingUI(mode) {
  startEn.style.display = "none";
  startHe.style.display = "none";
  stopBtn.style.display = "block";
  stopBtn.disabled = false;
  stopBtn.textContent = "Stop Meeting";
  stopBtn.classList.add("recording");
  // Translation controls only make sense on the English path.
  const lockTr = mode !== "en";
  trToggle.disabled = lockTr;
  trLang.disabled = lockTr || !trEnabled;
}

// Stopped listening, but the queue is still draining. Hold the button in a
// disabled "finishing" state so nothing new is started on top.
function showFinishingUI() {
  startEn.style.display = "none";
  startHe.style.display = "none";
  stopBtn.style.display = "block";
  stopBtn.disabled = true;
  stopBtn.textContent = "Finishing transcription…";
  stopBtn.classList.remove("recording");
}

function showIdleUI() {
  startEn.style.display = "";
  startHe.style.display = "";
  stopBtn.style.display = "none";
  stopBtn.disabled = false;
  stopBtn.classList.remove("recording");
  trToggle.disabled = false;
  trLang.disabled = !trEnabled;
}

// ---- Start / stop -------------------------------------------------------

async function startMeeting(mode) {
  if (recording || finishing) return;
  recording = true;
  currentMode = mode;
  document.body.classList.toggle("mode-he", mode === "he");
  document.body.classList.toggle("mode-en", mode === "en");
  updateTranslating();
  clearTranscript();
  showRecordingUI(mode);
  status.textContent = "Loading…";
  try {
    const { createEngine } =
      mode === "he" ? await import("./engines/hebrew.js") : await import("./engines/english.js");
    engine = createEngine(sink);
    await engine.start();
    startTimer();
  } catch (err) {
    console.error("[start]", err);
    status.textContent = `Error: ${err.message || err}`;
    recording = false;
    engine = null;
    showIdleUI();
  }
}

async function stopMeeting() {
  if (!recording) return;
  recording = false;
  // Stop listening right away; the trailing segment is queued, not dropped.
  try { await engine?.stop(); } catch (e) { console.error("[stop]", e); }
  stopTimer();
  removePartial();
  const stoppedAt = timerEl.textContent;
  // If segments are still being transcribed, hold in a "finishing" state and
  // let the queue drain calmly — no new audio piles on top.
  if ((engine?.pending ?? 0) > 0) {
    finishing = true;
    showFinishingUI();
    const showRemaining = () => {
      const n = engine?.pending ?? 0;
      const label = `Finishing transcription… (${n} segment${n === 1 ? "" : "s"} left)`;
      status.textContent = label;
      stopBtn.textContent = label;
    };
    showRemaining();
    const drainTicker = setInterval(showRemaining, 500);
    try { await engine.drain(); } catch (e) { console.error("[drain]", e); }
    clearInterval(drainTicker);
    finishing = false;
  }
  try { engine?.dispose?.(); } catch {}
  engine = null;
  showIdleUI();
  status.textContent = `Stopped at ${stoppedAt}.`;
}

startEn.addEventListener("click", () => startMeeting("en"));
startHe.addEventListener("click", () => startMeeting("he"));
stopBtn.addEventListener("click", stopMeeting);

// ---- Translation UI -----------------------------------------------------

trToggle.addEventListener("change", () => {
  trEnabled = trToggle.checked;
  trLang.disabled = !trEnabled;
  updateTranslating();
  if (trEnabled && currentMode === "en") {
    ensureTrWorker().postMessage({ type: "init", lang: trLangCode });
  }
});

trLang.addEventListener("change", () => {
  trLangCode = trLang.value;
  trEpoch++;
  if (trEnabled && currentMode === "en") {
    ensureTrWorker().postMessage({ type: "init", lang: trLangCode });
  }
});

// ---- Copy / Download ----------------------------------------------------

function getTranscriptText() {
  const source = committedLines
    .filter((l) => l.text)
    .map((l) => `[${l.tsStart} - ${l.tsEnd}] ${l.text}`)
    .join("\n");
  const hasTranslations = committedLines.some((l) => l.translation);
  if (!hasTranslations) return source;
  const translated = committedLines
    .filter((l) => l.text)
    .map((l) => `[${l.tsStart} - ${l.tsEnd}] ${l.translation || ""}`)
    .join("\n");
  return `${source}\n\n\n${translated}`;
}

function formatFilename() {
  const d = new Date();
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return `murmur_${days[d.getDay()]}_${d.getDate()}_${months[d.getMonth()]}_${d.getHours() % 12 || 12}_${d.getHours() >= 12 ? "pm" : "am"}_${String(d.getMinutes()).padStart(2, "0")}.txt`;
}

copyBtn.addEventListener("click", () => {
  const text = getTranscriptText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = "Copied";
    copyBtn.classList.add("flash");
    setTimeout(() => {
      copyBtn.textContent = "Copy";
      copyBtn.classList.remove("flash");
    }, 1500);
  });
});

downloadBtn.addEventListener("click", () => {
  const text = getTranscriptText();
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = formatFilename();
  a.click();
  URL.revokeObjectURL(url);
});

// Initial state
status.textContent = "Ready.";
trLang.disabled = !trToggle.checked;
