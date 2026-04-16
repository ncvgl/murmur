import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

let translator = null;
let currentLang = null;
let loading = null;

async function loadModel(lang) {
  if (currentLang === lang && translator) return translator;
  if (loading && loading.lang === lang) return loading.promise;
  const modelId = `Xenova/opus-mt-en-${lang}`;
  postMessage({ type: "loading", lang });
  const promise = pipeline("translation", modelId)
    .then((t) => {
      translator = t;
      currentLang = lang;
      loading = null;
      postMessage({ type: "ready", lang });
      return t;
    })
    .catch((err) => {
      loading = null;
      postMessage({ type: "error", lang, message: err?.message || String(err) });
      throw err;
    });
  loading = { lang, promise };
  return promise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    loadModel(msg.lang).catch(() => {});
    return;
  }
  if (msg.type === "translate") {
    const { id, text, lang, epoch } = msg;
    try {
      const t = await loadModel(lang);
      const out = await t(text);
      const translated = Array.isArray(out) ? out[0]?.translation_text : out?.translation_text;
      postMessage({ type: "translation", id, epoch, text: translated || "" });
    } catch (err) {
      postMessage({ type: "translation_error", id, epoch, message: err?.message || String(err) });
    }
  }
};
