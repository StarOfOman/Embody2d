import { useEffect, useRef, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { connectAgentBridge } from './live2d/agentBridge'
import './App.css'

window.PIXI = PIXI

const API_URL = import.meta.env.VITE_API_URL || ''

const MODELS = [
  { id: 'haru',    name: 'Haru',    path: '/models/Haru/haru_greeter_t03.model3.json', panRate: 0.30, voice: 'af_bella' },
  { id: 'hiyori',  name: 'Hiyori',  path: '/models/Hiyori/Hiyori.model3.json',         panRate: 0.30, voice: 'af_sarah' },
  { id: 'mark',    name: 'Mark',    path: '/models/Mark/Mark.model3.json',              panRate: 0.1,  voice: 'am_puck' },
  { id: 'natori',  name: 'Natori',  path: '/models/Natori/Natori.model3.json',          panRate: 0.30, voice: 'am_michael' },
  { id: 'wanko',   name: 'Wanko',   path: '/models/Wanko/Wanko.model3.json',            panRate: 0.005, voice: 'am_adam' },
]

function fitModel(model, screenW, screenH) {
  const bounds = model.getLocalBounds()
  const mw = bounds.width
  const mh = bounds.height
  if (mw <= 0 || mh <= 0) return 0.25
  const scaleX = (screenW * 0.8) / mw
  const scaleY = (screenH * 0.8) / mh
  return Math.min(scaleX, scaleY)
}

function App() {
  const containerRef = useRef(null)
  const appRef = useRef(null)
  const modelRef = useRef(null)
  const disconnectRef = useRef(null)
  const zoomRef = useRef(1)
  const baseScaleRef = useRef(0.25)
  const [activeModel, setActiveModel] = useState(MODELS[0])
  const [status, setStatus] = useState('Loading...')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [thumbnails, setThumbnails] = useState({})
  const [thumbsDone, setThumbsDone] = useState(false)

  // Chat state
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef(null)
  const audioRef = useRef(null)

  const avatarId = useRef(
    new URLSearchParams(window.location.search).get('id') || 'default'
  )

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Generate ALL thumbnails first, then allow main scene to mount
  useEffect(() => {
    let cancelled = false

    async function generateThumbnails() {
      const thumbApp = new PIXI.Application({
        width: 200, height: 200,
        backgroundAlpha: 0, antialias: true, resolution: 1,
      })

      for (const m of MODELS) {
        if (cancelled) break
        try {
          const model = await Live2DModel.from(m.path, { autoInteract: false, autoUpdate: false })
          if (model.internalModel?.motionManager) {
            model.internalModel.motionManager.settings.idleMotionGroup = undefined
          }
          model.autoUpdate = false
          model.anchor.set(0.5, 0.5)
          model.x = 100
          model.y = 100
          const fit = fitModel(model, 200, 200)
          model.scale.set(fit)
          thumbApp.stage.addChild(model)
          thumbApp.render()
          const dataUrl = thumbApp.view.toDataURL('image/png')
          if (!cancelled) setThumbnails(prev => ({ ...prev, [m.id]: dataUrl }))
          thumbApp.stage.removeChild(model)
          model.destroy()
        } catch (e) {
          console.warn(`Thumbnail failed for ${m.name}:`, e)
        }
      }

      // Fully destroy the shared thumbnail renderer before main scene takes over
      thumbApp.destroy(true, true)

      if (!cancelled) setThumbsDone(true)
    }

    generateThumbnails()
    return () => { cancelled = true }
  }, [])

  // Load the active model into the main viewport — only after thumbnails are done
  useEffect(() => {
    if (!thumbsDone) return

    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let app = null
    let rafId = null

    disconnectRef.current?.()
    disconnectRef.current = null
    zoomRef.current = 1

    setStatus(`Loading ${activeModel.name}...`)

    rafId = requestAnimationFrame(() => {
      if (cancelled) return

      const w = container.clientWidth || 800
      const h = container.clientHeight || 600

      app = new PIXI.Application({
        width: w, height: h,
        backgroundAlpha: 0, antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      })
      container.appendChild(app.view)
      appRef.current = app

      Live2DModel.from(activeModel.path, { autoInteract: false }).then((model) => {
        if (cancelled) { model.destroy(); return }

        model.anchor.set(0.5, 0.5)
        model.x = app.screen.width / 2
        model.y = app.screen.height / 2

        const base = fitModel(model, app.screen.width, app.screen.height)
        baseScaleRef.current = base
        model.scale.set(base)

        app.stage.addChild(model)
        modelRef.current = model
        setStatus(`${activeModel.name}`)

        disconnectRef.current = connectAgentBridge(model, avatarId.current, {
          onEnvUpdate: (cmd) => {
            const el = document.getElementById('env-layer')
            if (!el) return
            if (cmd.background) el.style.background = cmd.background
            if (cmd.imageUrl) el.style.backgroundImage = `url(${cmd.imageUrl})`
            if (cmd.type === 'env-reset') el.style.cssText = ''
          },
        })
      }).catch((err) => {
        if (!cancelled) setStatus(`Error: ${err.message}`)
      })
    })

    const onResize = () => {
      if (!app) return
      const w = container.clientWidth
      const h = container.clientHeight
      app.renderer.resize(w, h)
      if (modelRef.current) {
        modelRef.current.x = w / 2
        modelRef.current.y = h / 2
        const base = fitModel(modelRef.current, w, h)
        baseScaleRef.current = base
        modelRef.current.scale.set(base * zoomRef.current)
      }
    }
    window.addEventListener('resize', onResize)

    const onWheel = (e) => {
      e.preventDefault()
      const model = modelRef.current
      if (!model || !app) return
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      zoomRef.current = Math.max(1, Math.min(5, zoomRef.current * delta))
      model.scale.set(baseScaleRef.current * zoomRef.current)

      // Pan upward as we zoom in so the camera targets the face
      // At zoom 1.0 → centered, at zoom 5.0 → shifted up toward head
      const centerY = app.screen.height / 2
      const zoomFactor = zoomRef.current - 1 // 0 at default zoom
      const panUp = zoomFactor * app.screen.height * (activeModel.panRate || 0.30)
      model.y = centerY + panUp
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      container.removeEventListener('wheel', onWheel)
      if (app) app.destroy(true, true)
      appRef.current = null
      modelRef.current = null
    }
  }, [activeModel, thumbsDone])

  const selectModel = useCallback((m) => {
    setActiveModel(m)
    setPickerOpen(false)
  }, [])

  // Send chat message
  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || sending) return

    setInputText('')
    setSending(true)
    setMessages(prev => [...prev, { role: 'user', text }])

    try {
      const res = await fetch(`${API_URL}/chat/${avatarId.current}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: activeModel.voice }),
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Chat failed')

      setMessages(prev => [...prev, { role: 'assistant', text: data.reply }])

      // Play audio if available (lipsync is handled via WebSocket by the server)
      if (data.audio?.data) {
        const audioBlob = new Blob(
          [Uint8Array.from(atob(data.audio.data), c => c.charCodeAt(0))],
          { type: 'audio/wav' }
        )
        const audioUrl = URL.createObjectURL(audioBlob)
        if (audioRef.current) {
          audioRef.current.src = audioUrl
          audioRef.current.play().catch(() => {})
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', text: err.message }])
    } finally {
      setSending(false)
    }
  }, [inputText, sending])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  return (
    <div className="app">
      <div id="env-layer" className="env-layer" />
      <div className="viewport" ref={containerRef} />

      {/* Hidden audio element for TTS playback */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Bottom bar */}
      <div className={`bottom-bar ${chatOpen ? 'chat-mode' : ''}`}>
        <div className="status-name">{status}</div>
        <div className="bottom-bar-buttons">
          <button
            className={`bar-btn ${chatOpen ? 'active' : ''}`}
            onClick={() => setChatOpen(o => !o)}
            title="Chat"
          >
            {chatOpen ? '\u2715' : '\u{1F4AC}'}
          </button>
          <button
            className="bar-btn"
            onClick={() => setPickerOpen(o => !o)}
            title="Choose character"
          >
            {pickerOpen ? '\u2715' : '\u2630'}
          </button>
        </div>
      </div>

      {/* Chat panel */}
      <div className={`chat-panel ${chatOpen ? 'open' : ''}`}>
        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="chat-empty">Say something to {activeModel.name}...</div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
              <span className="chat-msg-text">{msg.text}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <div className="chat-input-row">
          <input
            type="text"
            className="chat-input"
            placeholder={`Talk to ${activeModel.name}...`}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <button
            className="chat-send"
            onClick={sendMessage}
            disabled={sending || !inputText.trim()}
          >
            {sending ? '...' : '\u2191'}
          </button>
        </div>
      </div>

      {/* Character picker tray */}
      <div className={`picker-tray ${pickerOpen ? 'open' : ''}`}>
        <div className="picker-scroll">
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`picker-card ${m.id === activeModel.id ? 'active' : ''}`}
              onClick={() => selectModel(m)}
            >
              <div className="picker-thumb">
                {thumbnails[m.id] ? (
                  <img src={thumbnails[m.id]} alt={m.name} />
                ) : (
                  <div className="thumb-loading" />
                )}
              </div>
              <span className="picker-label">{m.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
