// Hebrew speech-to-text worker.
//
// Runs ivrit-ai/whisper-large-v3-turbo-onnx (a Hebrew fine-tune of Whisper
// large-v3-turbo) via transformers.js. WebGPU is the happy path; we fall back
// to WASM where WebGPU is unavailable (noticeably slower on the large model).
//
// The main thread sends VAD-gated speech segments (Float32Array @ 16 kHz) and
// gets back transcribed Hebrew text per segment.
import { pipeline, env } from "@huggingface/transformers";

const MODEL_ID = "ivrit-ai/whisper-large-v3-turbo-onnx";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let loadPromise = null;
let device = null;

async function webgpuAvailable() {
  if (typeof navigator === "undefined" || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    device = (await webgpuAvailable()) ? "webgpu" : "wasm";
    // Keep the download/VRAM modest — large-v3-turbo is big and the target
    // hardware is modest. q4f16 on WebGPU (~370MB encoder + ~190MB decoder);
    // fp16 isn't reliable on WASM, so use 8-bit weights there.
    const dtype =
      device === "webgpu"
        ? { encoder_model: "q4f16", decoder_model_merged: "q4f16" }
        : { encoder_model: "q8", decoder_model_merged: "q8" };

    postMessage({ type: "device", device });

    transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
      device,
      dtype,
      progress_callback: (p) => {
        if (p.status === "progress") {
          postMessage({
            type: "progress",
            file: p.file,
            loaded: p.loaded,
            total: p.total,
            progress: p.progress,
          });
        } else if (p.status === "ready" || p.status === "done") {
          postMessage({ type: "progress_status", status: p.status, file: p.file });
        }
      },
    });

    postMessage({ type: "ready", device });
    return transcriber;
  })();
  return loadPromise;
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    load().catch((err) => {
      postMessage({ type: "error", message: err?.message || String(err) });
    });
    return;
  }

  if (msg.type === "transcribe") {
    const { id, audio } = msg;
    try {
      const asr = await load();
      const out = await asr(audio, {
        language: "he",
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        condition_on_previous_text: false,
      });
      const text = (Array.isArray(out) ? out[0]?.text : out?.text) || "";
      postMessage({ type: "result", id, text: text.trim() });
    } catch (err) {
      postMessage({ type: "transcribe_error", id, message: err?.message || String(err) });
    }
  }
};
