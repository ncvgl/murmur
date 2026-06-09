// English transcription engine — Moonshine (in-browser, ~63 MB, English only).
// Moonshine handles VAD + streaming internally and emits partial + committed
// text, so this is a thin wrapper that maps its callbacks onto the shared sink.
import * as Moonshine from "@moonshine-ai/moonshine-js";

// `sink` is the shared rendering API provided by main.js. See main.js for the
// method contract (status/ready/error/speechStart/partial/commit/...).
export function createEngine(sink) {
  let micStream = null;

  // Base Transcriber (not MicrophoneTranscriber) so we can supply a stream with
  // echoCancellation: false — lets the mic acoustically pick up the remote
  // speaker's voice from laptop speakers. Without this, the browser filters it.
  const transcriber = new Moonshine.Transcriber(
    "model/base",
    {
      onModelLoadStarted() {
        const cached = localStorage.getItem("murmur.en.modelCached") === "1";
        sink.status(cached ? "Loading model..." : "Downloading model (~63 MB)... Takes 1min");
      },
      onModelLoaded() {
        localStorage.setItem("murmur.en.modelCached", "1");
        sink.status("Model ready.");
      },
      onTranscribeStarted() {
        sink.ready("");
      },
      onTranscribeStopped() {},
      onError(error) {
        sink.error(String(error));
      },
      onSpeechStart() {
        sink.speechStart();
      },
      onSpeechEnd() {},
      onTranscriptionCommitted(text) {
        sink.commit(text);
      },
      onTranscriptionUpdated(text) {
        sink.partial(text);
      },
    },
    true
  );

  return {
    async start() {
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
    },
    async stop() {
      transcriber.stop();
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
    },
    // Moonshine commits synchronously, so there's never a queue to drain.
    get pending() {
      return 0;
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {},
  };
}
