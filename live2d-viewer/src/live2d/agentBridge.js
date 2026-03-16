/**
 * Connects to the agent API server via WebSocket.
 * Receives commands and applies them to the Live2D model.
 * Returns a disconnect function.
 */
export function connectAgentBridge(model, avatarId, { onEnvUpdate, onLoadModel } = {}) {
  const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000'
  let ws

  let mouthValue = 0
  let isSpeaking = false
  let lipsyncTimeouts = []

  const internal = model.internalModel
  const core = internal?.coreModel
  const motionManager = internal?.motionManager

  // Mouth param IDs that motions should NOT control during TTS
  const MOUTH_IDS = new Set([
    'ParamMouthOpenY', 'ParamMouthForm', 'PARAM_MOUTH_OPEN_Y', 'PARAM_MOUTH_FORM', 'ParamA',
  ])

  // Patch every loaded motion's JSON to strip mouth curves when TTS is active.
  // We do this by wrapping the motion manager's _startMotion to modify motion data.
  // But motions are already loaded — so we patch the doUpdateParameters method instead.
  //
  // The key insight: CubismMotion.doUpdateParameters reads from this._json.Curves.
  // We can't easily intercept that. Instead, we use a different approach:
  //
  // We override the motion manager's update to save/restore mouth params around it.
  // The trick is calling saveParameters/loadParameters on the core model.
  if (motionManager && core) {
    const origMMUpdate = motionManager.update.bind(motionManager)

    motionManager.update = function (coreModel, now) {
      if (!isSpeaking) {
        return origMMUpdate(coreModel, now)
      }

      // Save current mouth param values before motion writes
      const saved = {}
      MOUTH_IDS.forEach(id => {
        try {
          saved[id] = core.getParameterValueById(id)
        } catch {}
      })

      // Let motion run (it will overwrite mouth params)
      const result = origMMUpdate(coreModel, now)

      // Restore mouth params to what they were before motion wrote to them
      // Then set our lipsync value
      MOUTH_IDS.forEach(id => {
        try {
          if (id.includes('Open') || id === 'ParamA' || id === 'PARAM_MOUTH_OPEN_Y') {
            core.setParameterValueById(id, mouthValue)
          } else {
            // Restore non-open mouth params (like MouthForm) to pre-motion value
            if (saved[id] !== undefined) core.setParameterValueById(id, saved[id])
          }
        } catch {}
      })

      return result
    }
  }

  // Also override expression manager — expressions also write to mouth params
  const exprManager = motionManager?.expressionManager
  if (exprManager && core) {
    const origExprUpdate = exprManager.update.bind(exprManager)
    exprManager.update = function (coreModel, now) {
      if (!isSpeaking) return origExprUpdate(coreModel, now)

      const saved = {}
      MOUTH_IDS.forEach(id => {
        try { saved[id] = core.getParameterValueById(id) } catch {}
      })

      const result = origExprUpdate(coreModel, now)

      MOUTH_IDS.forEach(id => {
        try {
          if (id.includes('Open') || id === 'ParamA' || id === 'PARAM_MOUTH_OPEN_Y') {
            core.setParameterValueById(id, mouthValue)
          } else if (saved[id] !== undefined) {
            core.setParameterValueById(id, saved[id])
          }
        } catch {}
      })

      return result
    }
  }

  function startSpeaking() {
    isSpeaking = true
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
          mouthValue = amplitudes[0] || 0

          amplitudes.forEach((amp, i) => {
            const t = setTimeout(() => { mouthValue = amp }, i * interval)
            lipsyncTimeouts.push(t)
          })

          const endT = setTimeout(() => {
            mouthValue = 0
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

  return {
    disconnect: () => {
      clearLipsyncTimeouts()
      stopSpeaking()
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    },
    startSpeaking,
    stopSpeaking,
    setMouthValue: (v) => { mouthValue = v },
  }
}
