import * as Moonshine from "@moonshine-ai/moonshine-js";

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
let lastPartialTime = 0;
let committedLines = [];

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

function commitText(text) {
  if (!text.trim()) return;
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
  const tsStart = speechStartTs || getTimestamp();
  const tsEnd = getTimestamp();
  committedLines.push({ text: text.trim(), tsStart, tsEnd });
  const line = makeLine(text.trim(), `${tsStart} - ${tsEnd}`, false);
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
  speechStartTs = null;
}

function updatePartial(text) {
  if (!text.trim()) return;
  const now = Date.now();
  if (now - lastPartialTime < 1000) return;
  lastPartialTime = now;
  const partial = document.getElementById("partial");
  if (partial) partial.remove();
  const line = makeLine(text.trim(), speechStartTs || getTimestamp(), true);
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

function makeLine(text, timestamp, isPartial) {
  const line = document.createElement("div");
  line.className = isPartial ? "line partial" : "line";
  if (isPartial) line.id = "partial";
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = timestamp;
  const content = document.createElement("span");
  content.className = "text";
  content.textContent = text;
  line.appendChild(ts);
  line.appendChild(content);
  return line;
}

// Create transcriber once. Streaming mode (useVAD=false) for live partials.
const transcriber = new Moonshine.MicrophoneTranscriber(
  "model/base",
  {
    onModelLoadStarted() {
      status.textContent = "Downloading model (~63 MB)... Takes 1min";
    },
    onModelLoaded() {
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
  false
);

status.textContent = "Ready.";
btn.disabled = false;

btn.addEventListener("click", () => {
  if (!recording) {
    recording = true;
    btn.textContent = "Loading...";
    btn.disabled = true;
    transcriber.start();
  } else {
    transcriber.stop();
    recording = false;
    stopTimer();
    btn.textContent = "Start Meeting";
    btn.classList.remove("recording");
    status.textContent = `Stopped at ${timerEl.textContent}.`;
    const partial = document.getElementById("partial");
    if (partial) partial.remove();
  }
});

// Copy / Download
function getTranscriptText() {
  return committedLines
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
