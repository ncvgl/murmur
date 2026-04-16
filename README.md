<p align="center">
  <img src="public/images/logo-rounded.png" width="300" alt="Murmur">
</p>

<p align="center">
  <img src="public/images/demo.gif" width="720" alt="Murmur demo">
</p>

Meeting recorders charge $240/year. This one costs $0. Forever.
<br>No installation. No backend. No API costs. No data leaving your computer.
<br>Just open <a href="https://murmur.ncvgl.com">murmur.ncvgl.com</a> on Chrome and click Start. Works on Zoom, Meet, Teams - anything.

### How it works

Moonshine v1, a state-of-the-art speech model from ex-Googlers, runs locally in your browser.
<br> It listens to your mic + speakers. Transcribes everything in real-time. Runs without internet.

### Why this matters

Companies charge up to $30/month for meeting transcription services.
<br> This costs $0 because there's no server. The AI runs on YOUR laptop using WebGPU.

### The tradeoff

90% accuracy. English only. No speaker labelling. 
<br>But honestly? ChatGPT doesn’t need a perfect transcript to generate an accurate meeting summary.

### Live translation (optional)

Flip the **translate** toggle in the header and pick a target language. Each committed English sentence is translated in real-time by [Opus-MT](https://huggingface.co/Helsinki-NLP) (Helsinki-NLP), running locally in a Web Worker via Transformers.js — still no server, still offline.

- **First-run download**: ~75 MB per language pair, cached in the browser afterwards.
- **Latency on a 2019 Intel MacBook Pro (CPU)**: typically 0.2–1s per sentence after warm-up. First sentence may take 2–3s.
- **Supported targets**: French, Spanish, German, Italian, Dutch, Portuguese, Russian, Chinese, Japanese, Arabic, Hindi, Turkish, Polish, Swedish, Greek.
- Changing the target language mid-meeting translates future sentences in the new language — previous translations are left as-is.
