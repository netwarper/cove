# Local Whisper transcription (fully private, opt-in)

Daymark can transcribe recordings **entirely on your own machine** by
talking to a local Whisper server you run yourself. Nothing is installed for you
and nothing is sent to any cloud — the audio never leaves your computer.

The app just needs an **OpenAI-compatible `/audio/transcriptions` endpoint**.
Any of the options below expose one. Pick whichever suits your setup, start it,
then in the app go to **⚙️ Settings → Meeting transcription → 🖥 Use local
Whisper** and **Save**.

> The app sends short audio chunks to the endpoint you configure and stores the
> returned text with your note. If you leave the endpoint blank, recording still
> works — only transcription is off.

---

## Option A — `whisper.cpp` server (light, C++, great on Apple Silicon)

[`whisper.cpp`](https://github.com/ggerganov/whisper.cpp) ships a built-in HTTP
server that already speaks the OpenAI shape.

```bash
# build once
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
# download a model (base.en is a good, fast default; use small/medium for accuracy)
./models/download-ggml-model.sh base.en
# run the server on port 8080
./build/bin/whisper-server -m models/ggml-base.en.bin --port 8080
```

Endpoint: `http://127.0.0.1:8080/inference` **or** the OpenAI-compatible
`http://127.0.0.1:8080/v1/audio/transcriptions` (newer builds). The app's
**Use local Whisper** button fills in the latter.

## Option B — `faster-whisper` server (Python, GPU-friendly)

[`faster-whisper-server`](https://github.com/fedirz/faster-whisper-server)
exposes an OpenAI-compatible API and runs well on CPU or NVIDIA GPU.

```bash
pip install faster-whisper-server
faster-whisper-server --host 127.0.0.1 --port 8080
```

Endpoint: `http://127.0.0.1:8080/v1/audio/transcriptions`.

## Option C — `whisper-asr-webservice` (Docker, batteries included)

```bash
docker run -d -p 8080:9000 -e ASR_ENGINE=faster_whisper \
  onerahmet/openai-whisper-asr-webservice:latest
```

This one uses `/asr` rather than the OpenAI path; point the endpoint at
`http://127.0.0.1:8080/asr` — the app parses the `{ "text": … }` it returns.

---

## Configuring the app

1. **⚙️ Settings → Meeting transcription**.
2. Click **🖥 Use local Whisper** (fills `http://127.0.0.1:8080/v1/audio/transcriptions`),
   or paste your server's endpoint.
3. Leave **API key** blank (local servers don't need one).
4. Set **Model** if your server expects a specific name (e.g. `base.en`, `small`,
   `whisper-1`).
5. **Save**, then record a meeting — the transcript appears below your notes.

## Notes

- **Privacy:** with a `127.0.0.1` / `localhost` endpoint the app shows no
  external-transfer warning, because the audio stays on your machine. A non-local
  endpoint is flagged — that's your cue that audio would leave the device.
- **Zero dependencies preserved:** the app itself installs nothing for Whisper;
  the server is a separate program you choose to run. If it isn't running, the
  app simply records without transcribing.
- **CSP-safe:** the browser only ever talks to the app's own server, which
  proxies to your Whisper endpoint — so a `http://` local server works even
  though the app is served over `http`/`https` with a strict Content-Security-Policy.
