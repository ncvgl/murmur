import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// SSL toggled off via VITE_NO_SSL for local automated testing (http://localhost
// is still a secure context, so mic + WebGPU work). Defaults to HTTPS.
const useSsl = !process.env.VITE_NO_SSL;

export default defineConfig({
  plugins: useSsl ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    // @ricky0123/vad-web is CJS and does require("onnxruntime-web/wasm"), so
    // both must be pre-bundled together for the require to resolve. transformers.js
    // is ESM and ships its own onnxruntime, so it stays excluded.
    include: ["@ricky0123/vad-web", "onnxruntime-web"],
    exclude: ["@huggingface/transformers"],
  },
});
