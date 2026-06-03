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
// Commit a chunk after this much silence. vad-web's default is 1400ms, which
// feels laggy; ~700ms matches Moonshine and commits on natural sentence pauses.
const REDEMPTION_MS = 700;
// Force-flush a segment that has run this long without a pause, so a non-stop
// monologue still produces text instead of waiting indefinitely.
const MAX_SEGMENT_SEC = 12;
const MAX_SEGMENT_SAMPLES = MAX_SEGMENT_SEC * SAMPLE_RATE;
// Frames kept before speech is detected, so the first word isn't clipped.
const PREROLL_SAMPLES = 0.5 * SAMPLE_RATE;
// Don't bother transcribing a flush shorter than this.
const MIN_FLUSH_SAMPLES = 0.2 * SAMPLE_RATE;

export function createEngine(sink) {
  let worker = null;
  let vad = null;
  let modelReady = false;
  let segId = 0;
  const idMap = new Map(); // worker segment id -> shared sink line id

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
        sink.ready(msg.device === "webgpu" ? "GPU" : "CPU (slower)");
      } else if (msg.type === "result") {
        const lineId = idMap.get(msg.id);
        if (lineId != null) sink.resolvePending(lineId, msg.text);
        idMap.delete(msg.id);
      } else if (msg.type === "transcribe_error") {
        const lineId = idMap.get(msg.id);
        if (lineId != null) sink.failPending(lineId, msg.message);
        idMap.delete(msg.id);
      } else if (msg.type === "error") {
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
    async stop() {
      if (vad) {
        await vad.pause();
        vad = null;
      }
      speaking = false;
      frames = [];
      segSamples = 0;
      preRoll = [];
      preRollSamples = 0;
    },
  };
}
