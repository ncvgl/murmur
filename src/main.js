import * as Moonshine from "@moonshine-ai/moonshine-js";

const btn = document.getElementById("btn");
const status = document.getElementById("status");
const output = document.getElementById("output");
const timerEl = document.getElementById("timer");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const trToggle = document.getElementById("trToggle");
const trLang = document.getElementById("trLang");

let recording = false;
let startTime = null;
let timerInterval = null;
let speechStartTs = null;
let lastPartialTime = 0;
let committedLines = [];
let nextSentenceId = 1;

// Translation state
let trWorker = null;
let trEnabled = false;
let trLangCode = trLang.value;
let trEpoch = 0;

document.body.classList.add("no-translation");

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

function ensureWorker() {
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
  if (!trEnabled) return;
  ensureWorker().postMessage({
    type: "translate",
    id,
    text,
    lang: trLangCode,
    epoch: trEpoch,
  });
}

function commitText(text) {
  if (!text.trim()) return;
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
  const tsStart = speechStartTs || getTimestamp();
  const tsEnd = getTimestamp();
  const id = nextSentenceId++;
  const entry = { id, text: text.trim(), tsStart, tsEnd, translation: "" };
  committedLines.push(entry);
  const stick = isNearBottom();
  const line = makeLine(text.trim(), `${tsStart} - ${tsEnd}`, false, id, trEnabled);
  output.appendChild(line);
  if (stick) output.scrollTop = output.scrollHeight;
  speechStartTs = null;
  submitTranslation(id, entry.text);
}

function updatePartial(text) {
  if (!text.trim()) return;
  const now = Date.now();
  if (now - lastPartialTime < 1000) return;
  lastPartialTime = now;
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
  const stick = isNearBottom();
  const line = makeLine(text.trim(), speechStartTs || getTimestamp(), true, null, false);
  output.appendChild(line);
  if (stick) output.scrollTop = output.scrollHeight;
}

function makeLine(text, timestamp, isPartial, id, showTranslation) {
  const line = document.createElement("div");
  line.className = isPartial ? "line partial" : "line";
  if (isPartial) line.id = "partial";
  if (id != null) line.dataset.id = String(id);
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = timestamp;
  const content = document.createElement("span");
  content.className = "text";
  content.textContent = text;
  line.appendChild(ts);
  line.appendChild(content);
  if (!isPartial) {
    const translated = document.createElement("span");
    translated.className = showTranslation ? "translated pending" : "translated";
    translated.textContent = showTranslation ? "…" : "";
    line.appendChild(translated);
  }
  return line;
}

// Base Transcriber (not MicrophoneTranscriber) so we can supply a stream with
// echoCancellation: false — lets the mic acoustically pick up the remote
// speaker's voice from laptop speakers. Without this, the browser filters it.
const transcriber = new Moonshine.Transcriber(
  "model/base",
  {
    onModelLoadStarted() {
      const cached = localStorage.getItem("murmur.modelCached") === "1";
      status.textContent = cached
        ? "Loading model..."
        : "Downloading model (~63 MB)... Takes 1min";
    },
    onModelLoaded() {
      localStorage.setItem("murmur.modelCached", "1");
      status.textContent = "Model ready.";
    },
    onTranscribeStarted() {
      status.textContent = "Listening...";
      btn.disabled = false;
      btn.textContent = "Stop Meeting";
      btn.classList.add("recording");
      startTimer();
    },
    onTranscribeStopped() {
      // handled in click handler
    },
    onError(error) {
      console.error("[error]", error);
      status.textContent = `Error: ${error}`;
      btn.disabled = false;
      btn.textContent = "Start Meeting";
      recording = false;
    },
    onSpeechStart() {
      speechStartTs = getTimestamp();
    },
    onSpeechEnd() {},
    onTranscriptionCommitted(text) {
      commitText(text);
    },
    onTranscriptionUpdated(text) {
      updatePartial(text);
    },
  },
  true
);

status.textContent = "Ready.";
btn.disabled = false;

let micStream = null;

btn.addEventListener("click", async () => {
  if (!recording) {
    recording = true;
    btn.textContent = "Loading...";
    btn.disabled = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      transcriber.attachStream(micStream);
      transcriber.start();
    } catch (err) {
      console.error("[mic]", err);
      status.textContent = `Mic error: ${err.message || err}`;
      btn.disabled = false;
      btn.textContent = "Start Meeting";
      recording = false;
    }
  } else {
    transcriber.stop();
    recording = false;
    stopTimer();
    btn.textContent = "Start Meeting";
    btn.classList.remove("recording");
    status.textContent = `Stopped at ${timerEl.textContent}.`;
    const partial = document.getElementById("partial");
    if (partial) partial.remove();
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }
});

// Translation UI
trToggle.addEventListener("change", () => {
  trEnabled = trToggle.checked;
  trLang.disabled = !trEnabled;
  document.body.classList.toggle("no-translation", !trEnabled);
  if (trEnabled) {
    ensureWorker().postMessage({ type: "init", lang: trLangCode });
  }
});

trLang.addEventListener("change", () => {
  trLangCode = trLang.value;
  trEpoch++;
  if (trEnabled) {
    ensureWorker().postMessage({ type: "init", lang: trLangCode });
  }
});

// Copy / Download
function getTranscriptText() {
  const source = committedLines
    .map((l) => `[${l.tsStart} - ${l.tsEnd}] ${l.text}`)
    .join("\n");
  const hasTranslations = committedLines.some((l) => l.translation);
  if (!hasTranslations) return source;
  const translated = committedLines
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
