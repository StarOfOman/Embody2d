/**
 * Script Runner Adapter — port 9877
 *
 * Drop-in replacement for Unreal_Vtuber's vtuber-script-runner.
 * Accepts POST /scripts/execute with the same ScriptRequest schema,
 * translates audio commands into Live2D lipsync via WebSocket,
 * and TCP-style commands into avatar expressions/motions.
 */
import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { extractAmplitudes } from './audio-amplitude.js'

const app = express()
app.use(express.json({ limit: '50mb' }))

const PORT = parseInt(process.env.SCRIPT_RUNNER_PORT || '9877')
const API_TOKEN = process.env.RUNNER_API_TOKEN || ''
const ALLOWED_IPS = (process.env.VTUBER_ALLOWED_ADDRESSES || '127.0.0.1,::1,172.17.0.1,172.18.0.1').split(',').map(s => s.trim())
const SESSION_ROOT = process.env.VTUBER_SESSION_ROOT || '/opt/embody/sessions'
const AUDIO_HOLD_MS = parseInt(process.env.VTUBER_AUDIO_HOLD_MS || '15000')
const LIVE2D_API = process.env.LIVE2D_API_URL || 'http://localhost:4000'

// ── Session state ───────────────────────────────────────────────
const sessions = new Map()
let activeSession = null

// ── Auth middleware ──────────────────────────────────────────────
function authenticate(req, res, next) {
  // IP allowlist
  const ip = req.ip || req.connection.remoteAddress
  const ipAllowed = ALLOWED_IPS.some(a => ip.includes(a))

  // Token check
  if (API_TOKEN) {
    const token = req.headers.authorization?.replace('Bearer ', '') ||
                  req.headers['x-runner-token']
    if (token !== API_TOKEN && !ipAllowed) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }
  next()
}

app.use(authenticate)

// ── POST /scripts/execute ───────────────────────────────────────
app.post('/scripts/execute', async (req, res) => {
  const { session_id, commands, audio, callback_url } = req.body

  if (!session_id || !commands?.length) {
    return res.status(422).json({ error: 'session_id and commands required' })
  }

  if (activeSession) {
    return res.status(409).json({ error: 'Another session is active', active: activeSession })
  }

  const status = {
    session_id,
    state: 'pending',
    current_step: 0,
    total_steps: commands.length,
    error: null,
  }
  sessions.set(session_id, status)
  activeSession = session_id

  res.json(status)

  // Execute async
  executeSession(session_id, commands, audio || [], callback_url).catch((err) => {
    const s = sessions.get(session_id)
    if (s) { s.state = 'failed'; s.error = err.message }
    activeSession = null
  })
})

// ── GET /scripts/:session_id ────────────────────────────────────
app.get('/scripts/:session_id', (req, res) => {
  const s = sessions.get(req.params.session_id)
  if (!s) return res.status(404).json({ error: 'Session not found' })
  res.json(s)
})

// ── GET /health ─────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  type: 'live2d-script-runner',
  active_session: activeSession,
  uptime: process.uptime(),
}))

// ── Session execution ───────────────────────────────────────────
async function executeSession(sessionId, commands, audioAssets, callbackUrl) {
  const status = sessions.get(sessionId)
  status.state = 'running'

  // Prepare audio assets
  const audioMap = new Map()
  const sessionDir = path.join(SESSION_ROOT, sessionId, 'audio')
  await fs.mkdir(sessionDir, { recursive: true }).catch(() => {})

  for (const asset of audioAssets) {
    let buffer
    if (asset.payload_b64) {
      buffer = Buffer.from(asset.payload_b64, 'base64')
    } else if (asset.download_url) {
      const resp = await fetch(asset.download_url)
      buffer = Buffer.from(await resp.arrayBuffer())
    }
    if (buffer) {
      const filePath = path.join(sessionDir, asset.filename)
      await fs.writeFile(filePath, buffer)
      audioMap.set(asset.id, {
        path: filePath,
        buffer,
        duration_ms: asset.duration_ms || AUDIO_HOLD_MS,
      })
    }
  }

  // Execute commands sequentially
  for (let i = 0; i < commands.length; i++) {
    status.current_step = i + 1
    const cmd = commands[i]

    // Delay
    if (cmd.delay_ms > 0) {
      await sleep(cmd.delay_ms)
    }

    if (cmd.type === 'audio' && cmd.id) {
      const asset = audioMap.get(cmd.id)
      if (asset) {
        await playAudioLipsync(asset)
      }
    } else if (cmd.type === 'tcp' && cmd.value) {
      await handleTcpCommand(cmd.value)
    }
  }

  status.state = 'completed'
  activeSession = null

  // Stop lipsync
  await sendToLive2D('/avatar/default/lipsync', { amplitude: 0 })

  // Callback
  if (callbackUrl) {
    fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(status),
    }).catch(() => {})
  }

  // Cleanup session dir after 60s
  setTimeout(() => {
    fs.rm(path.join(SESSION_ROOT, sessionId), { recursive: true, force: true }).catch(() => {})
  }, 60000)
}

// ── Audio → lipsync ─────────────────────────────────────────────
async function playAudioLipsync(asset) {
  const duration = asset.duration_ms
  let amplitudes

  try {
    amplitudes = await extractAmplitudes(asset.buffer, 60)
  } catch {
    // Fallback: simulate speech pattern
    const frames = Math.ceil(duration / (1000 / 60))
    amplitudes = Array.from({ length: frames }, () => 0.2 + Math.random() * 0.6)
  }

  const frameMs = duration / amplitudes.length

  for (let i = 0; i < amplitudes.length; i++) {
    await sendToLive2D('/avatar/default/lipsync', { amplitude: amplitudes[i] })
    await sleep(frameMs)
  }

  // Close mouth
  await sendToLive2D('/avatar/default/lipsync', { amplitude: 0 })
}

// ── TCP command translation ─────────────────────────────────────
async function handleTcpCommand(value) {
  const trimmed = value.trim()

  // TTS_BYOB commands are handled as audio (already processed above)
  if (trimmed.startsWith('TTS_BYOB_')) return

  // Map common Unreal TCP commands to Live2D equivalents
  if (trimmed.startsWith('EXPRESSION_')) {
    const expr = trimmed.replace('EXPRESSION_', '').toLowerCase()
    await sendToLive2D('/avatar/default/expression', { expression: expr })
  } else if (trimmed.startsWith('MOTION_')) {
    const parts = trimmed.replace('MOTION_', '').split('_')
    await sendToLive2D('/avatar/default/motion', { group: parts[0], index: parseInt(parts[1] || '0') })
  } else if (trimmed.startsWith('PARAM_')) {
    const parts = trimmed.replace('PARAM_', '').split('=')
    if (parts.length === 2) {
      await sendToLive2D('/avatar/default/parameter', {
        parameterId: parts[0],
        value: parseFloat(parts[1]),
      })
    }
  } else {
    console.log(`[ScriptRunner] Unhandled TCP command: ${trimmed}`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────
async function sendToLive2D(path, body) {
  try {
    await fetch(`${LIVE2D_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Start ────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`[ScriptRunner] Adapter running on :${PORT}`)
})
