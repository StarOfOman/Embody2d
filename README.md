# L2D — Live2D Avatar Pipeline

Lightweight Live2D web renderer with agent control API and multi-character support. Drop-in compatible with the [Unreal_Vtuber](https://github.com/its-DeFine/Unreal_Vtuber) orchestrator pipeline — runs as an alternative to Unreal Engine on the same GPU cluster infrastructure.

## Architecture

```
                        ┌─────────────────────────────────────────────────┐
                        │            vtuber_network (shared)              │
                        │                                                 │
┌──────────────┐  REST  │  ┌─────────────┐  WS   ┌──────────────────┐   │
│  Agent / LLM │───────►│  │  API Server │──────►│  React Frontend  │   │
│  (external)  │        │  │  :4000      │       │  PixiJS + Live2D │   │
└──────────────┘        │  └─────────────┘       │  :3000           │   │
                        │                         └────────┬─────────┘   │
┌──────────────┐  REST  │  ┌─────────────┐                │             │
│  Orchestrator│───────►│  │  Adapters   │     ┌──────────▼─────────┐   │
│  / Payments  │        │  │  :9877 run  │     │  Streamer          │   │
└──────────────┘        │  │  :9090 hlth │     │  Chrome + FFmpeg   │   │
                        │  └─────────────┘     │  → RTSP :8554      │   │
                        │                       └────────────────────┘   │
                        └─────────────────────────────────────────────────┘
```

## Characters

6 bundled Cubism 4 models with in-app character picker (click the menu button at the bottom). Scroll wheel zooms in/out.

| Character | Type | Motions | Expressions | Notes |
|---|---|---|---|---|
| **Haru** | Human (female) | 15 | — | Default character |
| **Hiyori** | Human (female) | 10 | — | Casual outfit |
| **Mark** | Human (male) | 6 | — | Business attire |
| **Natori** | Human (female) | 8 | 11 | Most expressive (angry, smile, sad, surprised, etc.) |
| **Rice** | Human (female) | 4 | — | Simple/clean design |
| **Wanko** | Animal (dog) | 12 | — | Cartoon style |

All models sourced from [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) under the [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html). Free for entities with annual revenue under ~$69K USD; SDK release license required above that threshold.

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | React | 18.x |
| Renderer | PixiJS | 6.x |
| Live2D bridge | pixi-live2d-display | 0.4.x (Cubism 4) |
| SDK Core | live2dcubismcore | Cubism 4 |
| API Server | Express + WebSocket | 5.x / ws 8.x |
| Bundler | Vite | 7.x |
| Streaming | Headless Chrome + FFmpeg | NVENC GPU-accelerated |

## Unreal_Vtuber Compatibility

This stack joins the same `vtuber_network` and exposes the same control surfaces as the Unreal pipeline:

| Port | Service | Unreal Equivalent |
|---|---|---|
| **9877** | Script Runner adapter | `vtuber-script-runner` |
| **9090** | Health monitor | `orchestrator-health` |
| **4000** | Agent API (REST + WS) | Port 7777 TCP commands |
| **3000** | Frontend renderer | Unreal game + Pixel Streaming |
| **8554** | RTSP stream output | WebRTC via signaling :8080 |

The script runner accepts the same `POST /scripts/execute` payload format — audio assets (base64 or URL), sequential commands with delays, session tracking, and callbacks. Audio is decoded and converted to lipsync amplitude values for the Live2D model.

The health endpoint returns the exact response schema the orchestrator payments backend expects, including per-service uptime percentages and payment eligibility.

## Quick Start

```bash
cd live2d-viewer
npm install

# Frontend only (dev server with hot reload)
npm run dev

# Full stack (frontend + API + adapters)
npm run dev:all

# Adapters only (script runner + health)
npm run adapters
```

Open http://localhost:3000 — click the menu button at the bottom to switch characters, scroll to zoom.

## Docker Deployment

```bash
# Create shared network (once, if not already created by Unreal stack)
docker network create vtuber_network

# Build and start all 4 containers
docker compose up --build

# Health check (Unreal_Vtuber compatible)
curl http://localhost:9090/health

# Script execution (Unreal_Vtuber compatible)
curl -X POST http://localhost:9877/scripts/execute \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test-1", "commands": [{"delay_ms": 0, "type": "tcp", "value": "EXPRESSION_smile"}]}'
```

### Docker Services

| Container | Image | Ports |
|---|---|---|
| `vtuber-live2d-frontend` | Vite build → serve | 3000 |
| `vtuber-live2d-api` | Express + WS | 4000 |
| `vtuber-live2d-adapters` | Script runner + health | 9877, 9090 |
| `vtuber-live2d-streamer` | nvidia/opengl + Chromium + FFmpeg | 8554 |

## Agent API

Native Live2D control on `:4000`:

```bash
# Expression / motion / lipsync / parameter
curl -X POST http://localhost:4000/avatar/default/expression \
  -H "Content-Type: application/json" -d '{"expression": "smile"}'

curl -X POST http://localhost:4000/avatar/default/lipsync \
  -H "Content-Type: application/json" -d '{"amplitude": 0.75}'

curl -X POST http://localhost:4000/avatar/default/parameter \
  -H "Content-Type: application/json" -d '{"parameterId": "ParamAngleX", "value": 15}'

# Environment
curl -X POST http://localhost:4000/environment/default/background \
  -H "Content-Type: application/json" -d '{"background": "#0d0d2b"}'

# Customization
curl -X POST http://localhost:4000/customize/default/scale \
  -H "Content-Type: application/json" -d '{"value": 0.45}'
```

## Script Runner Command Translation

The adapter translates Unreal TCP commands to Live2D API calls:

| TCP Command | Live2D Action |
|---|---|
| `EXPRESSION_smile` | `POST /avatar/default/expression` |
| `MOTION_idle_0` | `POST /avatar/default/motion` |
| `PARAM_ParamAngleX=15` | `POST /avatar/default/parameter` |
| Audio commands | Amplitude extraction → lipsync |

## Project Structure

```
live2d-viewer/
├── src/
│   ├── App.jsx                        # Main app — viewport + character picker
│   ├── App.css                        # UI styles (picker tray, bottom bar, zoom)
│   ├── main.jsx                       # React entry point
│   ├── index.css                      # Global CSS variables
│   └── live2d/
│       └── agentBridge.js             # WebSocket client for agent commands
├── server/
│   ├── index.js                       # Express + WS agent API (:4000)
│   ├── routes/
│   │   ├── avatar.js                  # Expression, motion, lipsync, parameter
│   │   ├── environment.js             # Background, overlay, reset
│   │   └── customize.js               # Scale, position, tint, alpha
│   └── adapters/
│       ├── start.js                   # Boots script-runner + health together
│       ├── script-runner.js           # :9877 — Unreal_Vtuber compat
│       ├── health.js                  # :9090 — Unreal_Vtuber compat
│       └── audio-amplitude.js         # WAV → lipsync amplitude extraction
├── public/
│   ├── Core/                          # Cubism 4 SDK core runtime
│   └── models/                        # Character models (6 bundled)
│       ├── Haru/                      # 15 motions
│       ├── Hiyori/                    # 10 motions
│       ├── Mark/                      # 6 motions
│       ├── Natori/                    # 8 motions, 11 expressions
│       ├── Rice/                      # 4 motions
│       └── Wanko/                     # 12 motions (dog)
├── scripts/
│   └── start-stream.sh               # Headless Chrome + FFmpeg → RTSP
├── Dockerfile.frontend                # Multi-stage Vite build → serve
├── Dockerfile.api                     # Node API with healthcheck
├── Dockerfile.adapters                # Script runner + health
├── Dockerfile.streamer                # nvidia/opengl + Chromium + FFmpeg
├── docker-compose.yml                 # 4 services, joins vtuber_network
└── .env.example                       # Full config with Unreal_Vtuber compat vars
```

## Running Alongside Unreal

Both stacks can run simultaneously on the same host and network:

```bash
# Start Unreal stack
cd Unreal_Vtuber && docker-compose -f docker-compose.unreal.yml up -d

# Start Live2D stack (different ports, same network)
cd L2D/live2d-viewer && docker compose up -d

# Both visible to orchestrator health checks
curl http://localhost:9090/health   # Live2D
curl http://localhost:9091/health   # Unreal (if configured on 9091)
```

## Adding Custom Models

Drop a Cubism 4 model folder into `public/models/` and add an entry to the `MODELS` array in `src/App.jsx`:

```js
{ id: 'my-model', name: 'My Model', path: '/models/MyModel/MyModel.model3.json' }
```

Models auto-fit to the viewport. Scroll wheel adjusts zoom. Only `.moc3` version 1–3 (Cubism 4) files are supported — Cubism 5 models (version 5+) require a newer SDK core.

## Licensing

- **Live2D SDK**: Proprietary. Free for individuals/small businesses under 10M JPY (~$69K) annual revenue. Expandable Application license required above that. See [Live2D EULA](https://www.live2d.com/en/about/terms/).
- **Bundled models**: [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) — same revenue threshold applies.
- **Application code**: This repository's source code (server, frontend, adapters) is separate from the Live2D SDK and models.

## References

- [Unreal_Vtuber](https://github.com/its-DeFine/Unreal_Vtuber) — reference orchestrator architecture
- [Cubism Web SDK](https://github.com/Live2D/CubismWebFramework)
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)
- [Live2D CubismWebSamples](https://github.com/Live2D/CubismWebSamples) — model source
- [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
