/**
 * Health Adapter — port 9090
 *
 * Mirrors the Unreal_Vtuber orchestrator-health response format
 * so the payments backend and orchestrator tooling see this Live2D
 * instance as a compatible node.
 */
import express from 'express'
import { createServer } from 'http'

const app = express()
app.use(express.json())

const PORT = parseInt(process.env.ORCHESTRATOR_HEALTH_PORT || '9090')
const LIVE2D_API = process.env.LIVE2D_API_URL || 'http://localhost:4000'
const MONITORED_SERVICES = (process.env.MONITORED_SERVICES ||
  'vtuber-live2d-frontend,vtuber-live2d-api,vtuber-live2d-streamer').split(',').map(s => s.trim())
const MIN_UPTIME = parseFloat(process.env.MIN_UPTIME_REQUIRED || '80.0')

const startTime = Date.now()
const checkHistory = new Map()

// Initialize check history
MONITORED_SERVICES.forEach(name => {
  checkHistory.set(name, { up: 0, total: 0 })
})

// Poll services every 30s
setInterval(async () => {
  for (const name of MONITORED_SERVICES) {
    const h = checkHistory.get(name)
    h.total++
    try {
      const target = serviceHealthUrl(name)
      if (target) {
        const res = await fetch(target, { signal: AbortSignal.timeout(5000) })
        if (res.ok) h.up++
      } else {
        h.up++ // No URL means we assume it's up (local service)
      }
    } catch {
      // down
    }
  }
}, 30000)

// First check immediately
setTimeout(async () => {
  for (const name of MONITORED_SERVICES) {
    const h = checkHistory.get(name)
    h.total++
    try {
      const target = serviceHealthUrl(name)
      if (target) {
        const res = await fetch(target, { signal: AbortSignal.timeout(5000) })
        if (res.ok) h.up++
      } else {
        h.up++
      }
    } catch {}
  }
}, 1000)

function serviceHealthUrl(name) {
  if (name.includes('api')) return `${LIVE2D_API}/health`
  if (name.includes('frontend')) return 'http://localhost:3000'
  if (name.includes('streamer')) return null // no HTTP health for FFmpeg
  if (name.includes('script-runner')) return 'http://localhost:9877/health'
  return null
}

// ── GET /health ─────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const services = {}
  const runningServices = []
  const missingServices = []
  let totalUptime = 0

  for (const name of MONITORED_SERVICES) {
    const h = checkHistory.get(name)
    const uptime = h.total > 0 ? (h.up / h.total) * 100 : 100
    const running = h.total === 0 || h.up > 0
    totalUptime += uptime

    services[name] = {
      status: running ? 'running' : 'stopped',
      running,
      uptime_percentage: Math.round(uptime * 100) / 100,
      checks_count: h.total,
      health: running ? 'healthy' : 'unhealthy',
    }

    if (running) runningServices.push(name)
    else missingServices.push(name)
  }

  const overallUptime = MONITORED_SERVICES.length > 0
    ? totalUptime / MONITORED_SERVICES.length
    : 100

  res.json({
    timestamp: new Date().toISOString(),
    services,
    monitored_count: MONITORED_SERVICES.length,
    summary: {
      overall_uptime: Math.round(overallUptime * 100) / 100,
      calculated_uptime: Math.round(overallUptime * 100) / 100,
      services_up: runningServices.length,
      services_down: missingServices.length,
      total_services: MONITORED_SERVICES.length,
      eligible_for_payment: overallUptime >= MIN_UPTIME,
      min_uptime_required: MIN_UPTIME,
      missing_services: missingServices,
      running_services: runningServices,
      status_message: missingServices.length === 0
        ? 'All required services online'
        : `Missing: ${missingServices.join(', ')}`,
    },
  })
})

// ── GET /meta ───────────────────────────────────────────────────
app.get('/meta', (_, res) => res.json({
  type: 'live2d',
  engine: 'pixi-live2d-display',
  started: new Date(startTime).toISOString(),
  uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
}))

// ── Start ────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`[Health] Adapter running on :${PORT}`)
})
