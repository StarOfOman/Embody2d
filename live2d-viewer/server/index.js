import 'dotenv/config'
import express from 'express'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import { createServer } from 'http'
import { v4 as uuidv4 } from 'uuid'
import avatarRoutes from './routes/avatar.js'
import environmentRoutes from './routes/environment.js'
import customizeRoutes from './routes/customize.js'
import chatRoutes from './routes/chat.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const server = createServer(app)
const wss = new WebSocketServer({ server })

export const avatarClients = new Map()

wss.on('connection', (ws, req) => {
  const avatarId = new URL(req.url, 'http://x').searchParams.get('id') || uuidv4()
  avatarClients.set(avatarId, ws)
  console.log(`[WS] Connected: ${avatarId} (total: ${avatarClients.size})`)
  ws.on('close', () => {
    avatarClients.delete(avatarId)
    console.log(`[WS] Disconnected: ${avatarId}`)
  })
})

export function sendToAvatar(id, command) {
  const ws = avatarClients.get(id)
  if (ws?.readyState === 1) { ws.send(JSON.stringify(command)); return true }
  return false
}

export function broadcast(command) {
  let n = 0
  avatarClients.forEach((ws) => {
    if (ws.readyState === 1) { ws.send(JSON.stringify(command)); n++ }
  })
  return n
}

// ── Routes ──────────────────────────────────────────────────────────────
app.use('/avatar', avatarRoutes)
app.use('/environment', environmentRoutes)
app.use('/customize', customizeRoutes)
app.use('/chat', chatRoutes)

// Health — mirrors :9090/health pattern from Unreal_Vtuber
app.get('/health', (_, res) => res.json({
  status: 'ok',
  avatars_connected: avatarClients.size,
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
}))

app.get('/avatars', (_, res) => res.json({ avatars: [...avatarClients.keys()] }))

app.post('/broadcast', (req, res) => res.json({ sent: broadcast(req.body) }))

const PORT = process.env.PORT || 4000
server.listen(PORT, () => console.log(`[API] Running on http://localhost:${PORT}`))
