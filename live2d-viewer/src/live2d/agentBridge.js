/**
 * Connects to the agent API server via WebSocket.
 * Receives commands and applies them to the Live2D model.
 * Returns a disconnect function.
 */
export function connectAgentBridge(model, avatarId, { onEnvUpdate, onLoadModel } = {}) {
  const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000'
  let ws

  // Lipsync state
  let mouthValue = 0
  let isSpeaking = false
  let lipsyncTimeouts = []

  const internal = model.internalModel
  const core = internal?.coreModel
  const motionManager = internal?.motionManager

  // Save original startMotion / startRandomMotion so we can block them during speech
  let origStartMotion = null
  let origStartRandomMotion = null

  if (motionManager) {
    origStartMotion = motionManager.startMotion.bind(motionManager)
    origStartRandomMotion = motionManager.startRandomMotion.bind(motionManager)

    // Block all new motions while speaking
    motionManager.startMotion = function (...args) {
      if (isSpeaking) return Promise.resolve(false)
      return origStartMotion(...args)
    }
    motionManager.startRandomMotion = function (...args) {
      if (isSpeaking) return Promise.resolve(false)
      return origStartRandomMotion(...args)
    }
  }

  // After each frame update, force our lipsync mouth value
  if (internal) {
    const origUpdate = internal.update.bind(internal)
    // Get the real (unpatched) setter from the prototype
    const realSet = core
      ? Object.getPrototypeOf(core).setParameterValueById.bind(core)
      : null

    internal.update = function (dt, now) {
      origUpdate(dt, now)

      if (isSpeaking && realSet) {
        realSet('ParamMouthOpenY', mouthValue)
        try { realSet('PARAM_MOUTH_OPEN_Y', mouthValue) } catch {}
        try { realSet('ParamA', mouthValue) } catch {}
      }
    }
  }

  function startSpeaking() {
    isSpeaking = true
    // Stop any currently playing motion so it doesn't keep writing params
    if (motionManager) {
      // Stop all motion layers
      try {
        for (let i = 0; i < 8; i++) {
          motionManager.stopAllMotions?.()
        }
      } catch {}
    }
  }

  function stopSpeaking() {
    mouthValue = 0
    isSpeaking = false
  }

  function clearLipsyncTimeouts() {
    lipsyncTimeouts.forEach(t => clearTimeout(t))
    lipsyncTimeouts = []
  }

  function connect() {
    ws = new WebSocket(`${WS_URL}?id=${avatarId}`)

    ws.onmessage = async ({ data }) => {
      const cmd = JSON.parse(data)

      switch (cmd.type) {
        case 'expression':    model.expression(cmd.value); break
        case 'motion':        model.motion(cmd.group, cmd.index ?? 0); break
        case 'parameter':     core?.setParameterValueById(cmd.parameterId, cmd.value); break

        case 'lipsync':
          mouthValue = cmd.amplitude
          if (cmd.amplitude > 0 && !isSpeaking) startSpeaking()
          if (cmd.amplitude === 0 && isSpeaking) stopSpeaking()
          break

        case 'lipsync-sequence': {
          const { amplitudes, fps = 30 } = cmd
          const interval = 1000 / fps

          clearLipsyncTimeouts()
          startSpeaking()
          mouthValue = amplitudes[0] || 0

          amplitudes.forEach((amp, i) => {
            const t = setTimeout(() => { mouthValue = amp }, i * interval)
            lipsyncTimeouts.push(t)
          })

          const endT = setTimeout(() => {
            stopSpeaking()
          }, amplitudes.length * interval)
          lipsyncTimeouts.push(endT)
          break
        }

        case 'load-model':    onLoadModel?.(cmd.modelPath); break

        case 'env-background':
        case 'env-overlay':
        case 'env-reset':
          onEnvUpdate?.(cmd)
          break

        case 'avatar-scale':    model.scale.set(cmd.value); break
        case 'avatar-position': model.x = cmd.x; model.y = cmd.y; break
        case 'avatar-tint':     model.tint = parseInt(cmd.hex.replace('#', ''), 16); break
        case 'avatar-alpha':    model.alpha = Math.max(0, Math.min(1, cmd.value)); break

        default: console.warn('[AgentBridge] Unknown command:', cmd.type)
      }
    }

    ws.onopen = () => console.log(`[AgentBridge] Connected as ${avatarId}`)
    ws.onclose = () => {
      console.warn('[AgentBridge] Disconnected — retrying in 3s')
      setTimeout(connect, 3000)
    }
    ws.onerror = () => {}
  }

  connect()

  return () => {
    clearLipsyncTimeouts()
    stopSpeaking()
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }
}
