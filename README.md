# Embody2D — Live2D Avatar Pipeline

Lightweight Live2D web renderer with local LLM chat, Kokoro TTS, and real-time lipsync. Drop-in compatible with the [Unreal_Vtuber](https://github.com/its-DeFine/Unreal_Vtuber) orchestrator pipeline — runs as an alternative to Unreal Engine on the same GPU cluster infrastructure.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      vtuber_network (shared)                         │
│                                                                      │
│  ┌──────────┐  text  ┌───────────┐  WS   ┌────────────────────┐    │
│  │  Ollama  │◄──────│ API Server│──────►│  React Frontend    │    │
│  │  :11434  │        │  :4000    │       │  PixiJS + Live2D   │    │
│  └──────────┘        └─────┬─────┘       │  :3000             │    │
│                            │              └─────────┬──────────┘    │
│  ┌──────────┐  audio │              │                │
│  │  Kokoro  │◄───────┘    ┌─────────▼──────────┐    │
│  │  TTS     │              │  Streamer          │    │
│  │  :8880   │              │  Chrome + FFmpeg   │    │
│  └──────────┘              │  → RTSP :8554      │    │
│                             └────────────────────┘    │
│  ┌──────────┐                                         │
│  │ Adapters │  ← Unreal_Vtuber orchestrator compat   │
│  │ :9877    │                                         │
│  │ :9090    │                                         │
│  └──────────┘                                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Chat + Lipsync Flow

```
User types message
  → API server (:4000)
    → Ollama LLM (:11434) generates reply text
    → Kokoro TTS (:8880) generates WAV audio from reply
    → Audio amplitude extraction → lipsync frames (30 FPS)
    → WebSocket → frontend (mouth rig locked to lipsync, idle animations paused)
    → Audio base64 → frontend plays in sync
  = Avatar speaks with synchronized lip movement
```

During speech, idle animations are fully paused — lipsync has exclusive control of the mouth rig. When speech ends, idle animations resume.

## Characters

6 bundled Cubism 4 models with in-app character picker and scroll-wheel zoom.

| Character | Type | Motions | Expressions | Notes |
|---|---|---|---|---|
| **Haru** | Human (female) | 15 | — | Default character |
| **Hiyori** | Human (female) | 10 | — | Casual outfit |
| **Mark** | Human (male) | 6 | — | Business attire |
| **Natori** | Human (female) | 8 | 11 | Most expressive (angry, smile, sad, surprised, etc.) |
| **Rice** | Human (female) | 4 | — | Simple/clean design |
| **Wanko** | Animal (dog) | 12 | — | Cartoon style |

All models sourced from [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) under the [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | React | 18.x |
| Renderer | PixiJS | 6.x |
| Live2D | pixi-live2d-display (Cubism 4) | 0.4.x |
| LLM | Ollama / llama.cpp | OpenAI-compatible API |
| TTS | Kokoro (ONNX) | 82M params, 26 voices |
| API Server | Express + WebSocket | 5.x / ws 8.x |
| Bundler | Vite | 7.x |
| Streaming | Headless Chrome + FFmpeg | NVENC GPU-accelerated |

## Quick Start (Local Dev)

### Prerequisites

- Node.js 18+
- Python 3.10+ with PyTorch (for Kokoro TTS)
- [Ollama](https://ollama.com) (for local LLM)

### 1. Install dependencies

```bash
cd live2d-viewer
npm install

# TTS dependencies
pip install kokoro-onnx soundfile fastapi uvicorn
```

### 2. Pull an LLM model

```bash
ollama pull qwen3:1.7b
```

### 3. Start all services

```bash
# Terminal 1 — Kokoro TTS (downloads ~310MB model on first run)
cd live2d-viewer/tts && python server.py

# Terminal 2 — API server
cd live2d-viewer && node server/index.js

# Terminal 3 — Frontend
cd live2d-viewer && npm run dev
```

### 4. Use it

Open http://localhost:3000

- Click the **menu button** (bottom right) to switch characters
- Click the **chat button** to open the chat panel
- **Scroll wheel** zooms in/out
- Type a message — the avatar will respond with voice and lipsync

### TTS Voices

26 voices available — set via `TTS_VOICE` env var or `.env`:

| Prefix | Accent | Gender | Examples |
|---|---|---|---|
| `af_` | American | Female | af_sarah, af_bella, af_nova, af_jessica |
| `am_` | American | Male | am_adam, am_echo, am_eric, am_michael |
| `bf_` | British | Female | bf_alice, bf_emma, bf_lily |
| `bm_` | British | Male | bm_daniel, bm_george, bm_lewis |

## Docker Deployment

```bash
# Create shared network (once)
docker network create vtuber_network

# Place your .gguf LLM model in ./models/
# Build and start all 6 containers
docker compose up --build
```

### Docker Services

| Container | Image | Ports | GPU |
|---|---|---|---|
| `vtuber-live2d-frontend` | Vite build → serve | 3000 | No |
| `vtuber-live2d-api` | Express + WS | 4000 | No |
| `vtuber-live2d-adapters` | Script runner + health | 9877, 9090 | No |
| `vtuber-live2d-streamer` | nvidia/opengl + Chromium + FFmpeg | 8554 | Yes |
| `vtuber-kokoro-tts` | Kokoro-FastAPI (GPU) | 8880 | Yes |
| `vtuber-llama-server` | llama.cpp (CUDA) | 8081 | Yes |

## Unreal_Vtuber Compatibility

This stack joins the same `vtuber_network` and exposes the same control surfaces as the Unreal pipeline:

| Port | Service | Unreal Equivalent |
|---|---|---|
| **9877** | Script Runner adapter | `vtuber-script-runner` |
| **9090** | Health monitor | `orchestrator-health` |
| **4000** | Agent API (REST + WS) | Port 7777 TCP commands |
| **3000** | Frontend renderer | Unreal game + Pixel Streaming |
| **8554** | RTSP stream output | WebRTC via signaling :8080 |
| **8880** | Kokoro TTS | (fills BYOB gap — Unreal has no TTS) |
| **8081** | LLM (llama.cpp) | Same as Unreal's `docker-compose.llama.yml` |

The script runner accepts the same `POST /scripts/execute` payload format. The health endpoint returns the exact response schema the orchestrator payments backend expects.

## Agent API

Control the avatar programmatically on `:4000`:

```bash
# Chat (LLM + TTS + lipsync)
curl -X POST http://localhost:4000/chat/default/message \
  -H "Content-Type: application/json" -d '{"text": "Hello!"}'

# Direct expression / motion / lipsync
curl -X POST http://localhost:4000/avatar/default/expression \
  -H "Content-Type: application/json" -d '{"expression": "smile"}'

curl -X POST http://localhost:4000/avatar/default/lipsync \
  -H "Content-Type: application/json" -d '{"amplitude": 0.75}'

curl -X POST http://localhost:4000/avatar/default/parameter \
  -H "Content-Type: application/json" -d '{"parameterId": "ParamAngleX", "value": 15}'

# Environment
curl -X POST http://localhost:4000/environment/default/background \
  -H "Content-Type: application/json" -d '{"background": "#0d0d2b"}'

# Clear conversation history
curl -X POST http://localhost:4000/chat/default/clear
```

## Project Structure

```
live2d-viewer/
├── src/
│   ├── App.jsx                        # Main app — viewport + chat + character picker
│   ├── App.css                        # UI styles (chat panel, picker tray, zoom)
│   ├── main.jsx                       # React entry point
│   ├── index.css                      # Global CSS variables
│   └── live2d/
│       └── agentBridge.js             # WebSocket client, lipsync engine, motion control
├── server/
│   ├── index.js                       # Express + WS agent API (:4000)
│   ├── routes/
│   │   ├── chat.js                    # LLM → TTS → lipsync orchestration
│   │   ├── avatar.js                  # Expression, motion, lipsync, parameter
│   │   ├── environment.js             # Background, overlay, reset
│   │   └── customize.js               # Scale, position, tint, alpha
│   └── adapters/
│       ├── start.js                   # Boots script-runner + health together
│       ├── script-runner.js           # :9877 — Unreal_Vtuber compat
│       ├── health.js                  # :9090 — Unreal_Vtuber compat
│       └── audio-amplitude.js         # WAV → lipsync amplitude extraction
├── tts/
│   ├── server.py                      # Kokoro TTS FastAPI server (local dev)
│   └── requirements.txt               # Python dependencies
├── public/
│   ├── Core/                          # Cubism 4 SDK core runtime
│   └── models/                        # 6 bundled character models
├── scripts/
│   └── start-stream.sh               # Headless Chrome + FFmpeg → RTSP
├── Dockerfile.frontend                # Multi-stage Vite build → serve
├── Dockerfile.api                     # Node API with healthcheck
├── Dockerfile.adapters                # Script runner + health
├── Dockerfile.streamer                # nvidia/opengl + Chromium + FFmpeg
├── docker-compose.yml                 # 6 services, joins vtuber_network
└── .env.example                       # Full config reference
```

## Running Alongside Unreal

Both stacks run simultaneously on the same host and network:

```bash
# Start Unreal stack
cd Unreal_Vtuber && docker-compose -f docker-compose.unreal.yml up -d

# Start Live2D stack (different ports, same network)
cd Embody2d/live2d-viewer && docker compose up -d

# Both visible to orchestrator health checks
curl http://localhost:9090/health   # Live2D
curl http://localhost:9091/health   # Unreal (if configured on 9091)
```

## Adding Custom Models

Drop a Cubism 4 model folder into `public/models/` and add an entry to the `MODELS` array in `src/App.jsx`:

```js
{ id: 'my-model', name: 'My Model', path: '/models/MyModel/MyModel.model3.json' }
```

Models auto-fit to the viewport. Only `.moc3` version 1-3 (Cubism 4) files are supported.

## Licensing

- **Live2D SDK**: Proprietary. Free under 10M JPY (~$69K) annual revenue. [EULA](https://www.live2d.com/en/about/terms/)
- **Bundled models**: [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
- **Kokoro TTS**: Apache 2.0
- **Application code**: This repository's source code is separate from the Live2D SDK and models.

## References

- [Unreal_Vtuber](https://github.com/its-DeFine/Unreal_Vtuber) — reference orchestrator architecture
- [Cubism Web SDK](https://github.com/Live2D/CubismWebFramework)
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)
- [Live2D CubismWebSamples](https://github.com/Live2D/CubismWebSamples) — model source
- [Kokoro TTS](https://github.com/thewh1teagle/kokoro-onnx) — local text-to-speech
- [Ollama](https://ollama.com) — local LLM runner
