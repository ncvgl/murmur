// Hebrew transcription engine — Silero VAD gates the mic and feeds each speech
// segment to a Whisper worker (ivrit-ai/whisper-large-v3-turbo-onnx).
//
// Unlike Moonshine, Whisper is batch (one result per segment) with no partials.
// To avoid long waits on non-stop speech, we accumulate the VAD's 16 kHz frames
// ourselves and flush in two cases:
//   1. The VAD reports speech end (a pause of >= REDEMPTION_MS).
//   2. A segment has run MAX_SEGMENT_SEC without a pause (force-flush).
import { MicVAD } from "@ricky0123/vad-web";

const SAMPLE_RATE = 16000;
// Commit a chunk after this much silence. vad-web's default 1400ms feels laggy;
// 1000ms still commits within ~1s of a real pause while merging sub-second gaps
// into one chunk (fewer chunks = less work).
const REDEMPTION_MS = 1000;
// Force-flush a segment that has run this long without a pause. 30s is the sweet
// spot: it exactly fills Whisper's 30s encoder window, so there's no wasted
// padding compute and the audio still fits in a single encoder pass.
const MAX_SEGMENT_SEC = 30;
const MAX_SEGMENT_SAMPLES = MAX_SEGMENT_SEC * SAMPLE_RATE;
// Frames kept before speech is detected, so the first word isn't clipped.
const PREROLL_SAMPLES = 0.5 * SAMPLE_RATE;
// Don't bother transcribing a flush shorter than this.
const MIN_FLUSH_SAMPLES = 0.2 * SAMPLE_RATE;
// Emergency cap on segments queued for transcription. Inference is serialized
// in the worker, so a queued segment is just raw audio (~1.9 MB per 30s) — the
// backlog drains after Stop, so we keep it generous: 120 segments ≈ an hour of
// backlogged speech ≈ 230 MB. Only past that are segments dropped (with a
// visible marker) as a memory backstop.
const MAX_PENDING_SEGMENTS = 120;
// Tell the user transcription is lagging once this many segments are queued.
const BACKLOG_WARN_SEGMENTS = 3;

export function createEngine(sink) {
  let worker = null;
  let vad = null;
  let modelReady = false;
  let deviceLabel = "";
  let backlogWarned = false;
  let segId = 0;
  const idMap = new Map(); // worker segment id -> shared sink line id
  let drainResolvers = []; // resolved once idMap empties (see drain())

  // Once every queued segment has resolved/failed, wake anyone awaiting drain().
  function checkDrained() {
    if (idMap.size === 0 && drainResolvers.length) {
      const resolvers = drainResolvers;
      drainResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  // Surface a lagging queue while still listening; clear the warning once the
  // worker catches back up. (During drain-after-stop, main.js owns the status.)
  function updateBacklogStatus() {
    if (!modelReady || !vad) return;
    if (idMap.size >= BACKLOG_WARN_SEGMENTS) {
      backlogWarned = true;
      sink.status(`Listening… (transcription is ${idMap.size} segments behind)`);
    } else if (backlogWarned) {
      backlogWarned = false;
      sink.ready(deviceLabel);
    }
  }

  // Label every pending line with its place in the queue, in idMap insertion
  // order (= transcription order): the head is being transcribed, the rest wait.
  function updateQueueIndicators() {
    let pos = 0;
    for (const lineId of idMap.values()) {
      sink.updatePending(lineId, pos === 0 ? "… transcribing" : `… #${pos + 1} in queue`);
      pos++;
    }
  }

  // Audio accumulation driven by onFrameProcessed.
  let speaking = false;
  let frames = []; // Float32Array[] for the current (sub)segment
  let segSamples = 0;
  let preRoll = []; // rolling buffer of recent frames before speech starts
  let preRollSamples = 0;

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("../transcription-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        if (modelReady) return;
        const pct = typeof msg.progress === "number" ? Math.round(msg.progress) : null;
        sink.status(pct != null ? `Downloading Hebrew model… ${pct}%` : "Downloading Hebrew model…");
      } else if (msg.type === "ready") {
        modelReady = true;
        deviceLabel = msg.device === "webgpu" ? "GPU" : "CPU (slower)";
        sink.ready(deviceLabel);
      } else if (msg.type === "result") {
        const lineId = idMap.get(msg.id);
        if (lineId != null) sink.resolvePending(lineId, msg.text);
        idMap.delete(msg.id);
        updateQueueIndicators();
        updateBacklogStatus();
        checkDrained();
      } else if (msg.type === "transcribe_error") {
        const lineId = idMap.get(msg.id);
        if (lineId != null) sink.failPending(lineId, msg.message);
        idMap.delete(msg.id);
        updateQueueIndicators();
        updateBacklogStatus();
        checkDrained();
      } else if (msg.type === "error") {
        // Fatal worker error: nothing more will resolve, so don't leave a
        // drain() awaiter hanging forever.
        idMap.clear();
        checkDrained();
        sink.error(msg.message);
      }
    };
    worker.postMessage({ type: "load" });
    return worker;
  }

  // Concatenate the accumulated frames and send them to Whisper as one segment.
  function flush() {
    const total = segSamples;
    const buffered = frames;
    frames = [];
    segSamples = 0;
    if (total < MIN_FLUSH_SAMPLES) return;
    if (idMap.size >= MAX_PENDING_SEGMENTS) {
      // Queue is at the safety cap — drop this segment instead of letting the
      // backlog (and its memory) grow for the rest of the call. Leave a visible
      // marker so the gap shows in the transcript rather than vanishing.
      const lineId = sink.beginPending();
      sink.resolvePending(lineId, "(skipped — transcription overloaded)");
      return;
    }
    const audio = new Float32Array(total);
    let offset = 0;
    for (const f of buffered) {
      audio.set(f, offset);
      offset += f.length;
    }
    const lineId = sink.beginPending();
    const wid = ++segId;
    idMap.set(wid, lineId);
    ensureWorker().postMessage({ type: "transcribe", id: wid, audio }, [audio.buffer]);
    updateQueueIndicators();
    updateBacklogStatus();
  }

  return {
    async start() {
      // Kick off the (large) model download in parallel with VAD init.
      ensureWorker();
      if (!modelReady) sink.status("Downloading Hebrew model…");
      vad = await MicVAD.new({
        model: "v5",
        redemptionMs: REDEMPTION_MS,
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
        // Every 16 kHz frame, speech or not. We keep a rolling pre-roll and, once
        // speaking, accumulate into the current segment with a max-length flush.
        onFrameProcessed: (_probs, frame) => {
          const f = frame.slice ? frame.slice(0) : new Float32Array(frame);
          preRoll.push(f);
          preRollSamples += f.length;
          while (preRoll.length > 1 && preRollSamples - preRoll[0].length >= PREROLL_SAMPLES) {
            preRollSamples -= preRoll.shift().length;
          }
          if (speaking) {
            frames.push(f);
            segSamples += f.length;
            if (segSamples >= MAX_SEGMENT_SAMPLES) flush();
          }
        },
        onSpeechStart: () => {
          speaking = true;
          // Seed with the pre-roll so the first word isn't clipped.
          frames = preRoll.slice();
          segSamples = preRollSamples;
          sink.speechStart();
          sink.partial("🎙 …");
        },
        onVADMisfire: () => {
          speaking = false;
          frames = [];
          segSamples = 0;
          sink.clearPartial();
        },
        onSpeechEnd: () => {
          // Ignore vad-web's own segment audio — we flush our own accumulation so
          // it lines up with any mid-segment force-flushes.
          speaking = false;
          sink.clearPartial();
          flush();
        },
      });
      await vad.start();
    },
    // Stop capturing audio. The trailing in-progress segment is flushed into
    // the transcription queue (so the last words aren't lost) but queued
    // segments are left to finish — await drain() for those.
    async stop() {
      if (vad) {
        await vad.pause();
        vad = null;
      }
      if (speaking) flush(); // queue the trailing segment before discarding
      speaking = false;
      frames = [];
      segSamples = 0;
      preRoll = [];
      preRollSamples = 0;
    },
    // How many segments are still being transcribed.
    get pending() {
      return idMap.size;
    },
    // Resolves once every queued segment has been transcribed (or failed).
    drain() {
      if (idMap.size === 0) return Promise.resolve();
      return new Promise((resolve) => drainResolvers.push(resolve));
    },
    // Tear down the worker (frees the loaded model).
    dispose() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    },
  };
}
