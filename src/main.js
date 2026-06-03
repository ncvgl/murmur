import { MicVAD } from "@ricky0123/vad-web";

const btn = document.getElementById("btn");
const status = document.getElementById("status");
const output = document.getElementById("output");
const timerEl = document.getElementById("timer");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

let recording = false;
let startTime = null;
let timerInterval = null;
let speechStartTs = null;
let committedLines = [];
let nextSentenceId = 1;

// Silero VAD instance (created lazily on first Start).
let vad = null;
let vadReady = false;

// Whisper transcription worker.
let worker = null;
let modelReady = false;
let device = null;

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

function isNearBottom() {
  return output.scrollHeight - output.scrollTop - output.clientHeight < 40;
}

// ---- Transcription worker ----------------------------------------------

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./transcription-worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "device") {
      device = msg.device;
    } else if (msg.type === "progress") {
      if (modelReady) return;
      const pct = typeof msg.progress === "number" ? Math.round(msg.progress) : null;
      status.textContent = pct != null
        ? `Downloading Hebrew model… ${pct}%`
        : "Downloading Hebrew model…";
    } else if (msg.type === "ready") {
      modelReady = true;
      const where = msg.device === "webgpu" ? "GPU" : "CPU (slower)";
      status.textContent = recording ? `Listening… (${where})` : `Model ready (${where}).`;
    } else if (msg.type === "result") {
      fillLine(msg.id, msg.text);
    } else if (msg.type === "transcribe_error") {
      failLine(msg.id, msg.message);
    } else if (msg.type === "error") {
      status.textContent = `Model error: ${msg.message}`;
    }
  };
  worker.postMessage({ type: "load" });
  return worker;
}

// ---- Transcript rendering ----------------------------------------------

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
  content.dir = "rtl";
  content.textContent = text;
  line.appendChild(ts);
  line.appendChild(content);
  return line;
}

// A speech segment ended: drop a pending placeholder line and ask the worker
// to transcribe it. The text is filled in when the result comes back.
function addPendingLine() {
  const tsStart = speechStartTs || getTimestamp();
  const tsEnd = getTimestamp();
  const id = nextSentenceId++;
  committedLines.push({ id, text: "", tsStart, tsEnd });
  const stick = isNearBottom();
  const line = makeLine("…", `${tsStart} - ${tsEnd}`, false, id);
  line.querySelector(".text").classList.add("pending");
  output.appendChild(line);
  if (stick) output.scrollTop = output.scrollHeight;
  speechStartTs = null;
  return id;
}

function fillLine(id, text) {
  const entry = committedLines.find((l) => l.id === id);
  const lineEl = output.querySelector(`[data-id="${id}"]`);
  if (!text || !text.trim()) {
    // Nothing recognised — drop the empty placeholder.
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
}

function failLine(id, message) {
  console.error("[transcribe]", message);
  const entry = committedLines.find((l) => l.id === id);
  if (entry) entry.text = "(transcription failed)";
  const cell = output.querySelector(`[data-id="${id}"] .text`);
  if (cell) {
    cell.textContent = "(transcription failed)";
    cell.classList.remove("pending");
  }
}

function showPartial() {
  if (document.getElementById("partial")) return;
  const stick = isNearBottom();
  const line = makeLine("🎙 …", speechStartTs || getTimestamp(), true, null);
  output.appendChild(line);
  if (stick) output.scrollTop = output.scrollHeight;
}

function removePartial() {
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
}

// ---- VAD setup ----------------------------------------------------------

async function ensureVad() {
  if (vad) return vad;
  vad = await MicVAD.new({
    model: "v5",
    // Load the VAD worklet/model and onnxruntime-web WASM from a version-pinned
    // CDN. Vite's dev server won't let onnxruntime-web import() its wasm .mjs out
    // of /public, and the app already pulls the Whisper model over the network,
    // so a CDN for these small assets is the simplest path that works in dev + prod.
    baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/",
    onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/",
    // Our own stream so we can disable echo cancellation — lets the mic
    // acoustically pick up a remote speaker from the laptop speakers.
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    onSpeechStart: () => {
      speechStartTs = getTimestamp();
      showPartial();
    },
    onVADMisfire: () => {
      removePartial();
    },
    onSpeechEnd: (audio) => {
      removePartial();
      const id = addPendingLine();
      // Transfer the audio buffer to the worker (zero-copy).
      ensureWorker().postMessage({ type: "transcribe", id, audio }, [audio.buffer]);
    },
  });
  vadReady = true;
  return vad;
}

// ---- Controls -----------------------------------------------------------

status.textContent = "Ready.";
btn.disabled = false;

btn.addEventListener("click", async () => {
  if (!recording) {
    recording = true;
    btn.textContent = "Loading…";
    btn.disabled = true;
    try {
      // Kick off the (large) model download in parallel with VAD init.
      ensureWorker();
      if (!modelReady) status.textContent = "Downloading Hebrew model…";
      await ensureVad();
      await vad.start();
      startTimer();
      btn.disabled = false;
      btn.textContent = "Stop Meeting";
      btn.classList.add("recording");
      if (modelReady) {
        status.textContent = `Listening… (${device === "webgpu" ? "GPU" : "CPU (slower)"})`;
      }
    } catch (err) {
      console.error("[start]", err);
      status.textContent = `Error: ${err.message || err}`;
      btn.disabled = false;
      btn.textContent = "Start Meeting";
      btn.classList.remove("recording");
      recording = false;
    }
  } else {
    if (vad) await vad.pause();
    recording = false;
    stopTimer();
    removePartial();
    btn.textContent = "Start Meeting";
    btn.classList.remove("recording");
    status.textContent = `Stopped at ${timerEl.textContent}.`;
  }
});

// ---- Copy / Download ----------------------------------------------------

function getTranscriptText() {
  return committedLines
    .filter((l) => l.text)
    .map((l) => `[${l.tsStart} - ${l.tsEnd}] ${l.text}`)
    .join("\n");
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
