// Hebrew transcription engine — Silero VAD gates the mic and feeds each speech
// segment to a Whisper worker (ivrit-ai/whisper-large-v3-turbo-onnx).
//
// Unlike Moonshine, Whisper is batch (one result per segment) with no partials,
// so each segment becomes a pending line that resolves when the worker replies.
import { MicVAD } from "@ricky0123/vad-web";

export function createEngine(sink) {
  let worker = null;
  let vad = null;
  let modelReady = false;
  let segId = 0;
  const idMap = new Map(); // worker segment id -> shared sink line id

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

  return {
    async start() {
      // Kick off the (large) model download in parallel with VAD init.
      ensureWorker();
      if (!modelReady) sink.status("Downloading Hebrew model…");
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
          sink.speechStart();
          sink.partial("🎙 …");
        },
        onVADMisfire: () => {
          sink.clearPartial();
        },
        onSpeechEnd: (audio) => {
          sink.clearPartial();
          const lineId = sink.beginPending();
          const wid = ++segId;
          idMap.set(wid, lineId);
          // Transfer the audio buffer to the worker (zero-copy).
          ensureWorker().postMessage({ type: "transcribe", id: wid, audio }, [audio.buffer]);
        },
      });
      await vad.start();
    },
    async stop() {
      if (vad) {
        await vad.pause();
        vad = null;
      }
    },
  };
}
