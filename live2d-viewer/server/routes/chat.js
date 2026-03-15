import { Router } from 'express'
import { sendToAvatar } from '../index.js'

const router = Router()

const LLM_URL = process.env.LLM_URL || 'http://localhost:11434'
const LLM_API_KEY = process.env.LLM_API_KEY || ''
const TTS_URL = process.env.TTS_URL || 'http://localhost:8880'
const TTS_VOICE = process.env.TTS_VOICE || 'af_sarah'
const TTS_MODEL = process.env.TTS_MODEL || 'kokoro'
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a friendly avatar assistant. Keep responses concise — 1-3 sentences. Never use emojis. Never use asterisks or markdown formatting. Speak naturally as plain text only.'

// In-memory conversation history per avatar (simple, not persisted)
const conversations = new Map()

function getHistory(avatarId) {
  if (!conversations.has(avatarId)) {
    conversations.set(avatarId, [{ role: 'system', content: SYSTEM_PROMPT }])
  }
  return conversations.get(avatarId)
}

/**
 * POST /:id/message
 * { "text": "Hello!" }
 *
 * → calls LLM → calls Kokoro TTS → extracts lipsync → sends to avatar
 * → returns { reply, audioUrl }
 */
router.post('/:id/message', async (req, res) => {
  const { id } = req.params
  const { text } = req.body

  if (!text) return res.status(400).json({ error: 'text is required' })

  try {
    // 1. Call LLM (OpenAI-compatible API)
    const history = getHistory(id)
    history.push({ role: 'user', content: text })

    // Keep history manageable (last 20 messages + system prompt)
    if (history.length > 21) {
      history.splice(1, history.length - 21)
    }

    const llmHeaders = { 'Content-Type': 'application/json' }
    if (LLM_API_KEY) llmHeaders['Authorization'] = `Bearer ${LLM_API_KEY}`

    const llmRes = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: llmHeaders,
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'qwen3:1.7b',
        messages: history,
        max_tokens: 256,
        temperature: 0.7,
      }),
    })

    if (!llmRes.ok) {
      const errText = await llmRes.text()
      throw new Error(`LLM error ${llmRes.status}: ${errText}`)
    }

    const llmData = await llmRes.json()
    let reply = llmData.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.'
    // Strip emojis, asterisks, and markdown formatting
    reply = reply
      .replace(/[\u{1F000}-\u{1FFFF}|\u{2600}-\u{27FF}|\u{FE00}-\u{FEFF}|\u{1F900}-\u{1F9FF}|\u{200D}|\u{20E3}|\u{E0020}-\u{E007F}|\u{2702}-\u{27B0}|\u{FE0F}]/gu, '')
      .replace(/\*+/g, '')
      .replace(/[_~`#>]/g, '')
      .trim()

    history.push({ role: 'assistant', content: reply })

    // 2. Call Kokoro TTS (OpenAI-compatible TTS API)
    const ttsRes = await fetch(`${TTS_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: reply,
        voice: TTS_VOICE,
        response_format: 'wav',
        speed: 1.0,
      }),
    })

    if (!ttsRes.ok) {
      // TTS failed — still return text reply, just no audio
      console.warn(`[Chat] TTS error ${ttsRes.status}`)
      return res.json({ reply, audio: null })
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer())

    // 3. Extract lipsync amplitudes
    const { extractAmplitudes } = await import('../adapters/audio-amplitude.js')
    const amplitudes = await extractAmplitudes(audioBuffer, 30)

    // 4. Send lipsync sequence to avatar via WebSocket
    sendToAvatar(id, {
      type: 'lipsync-sequence',
      amplitudes,
      fps: 30,
    })

    // 5. Return audio as base64 + text reply
    const audioBase64 = audioBuffer.toString('base64')
    res.json({
      reply,
      audio: {
        data: audioBase64,
        format: 'wav',
        duration_ms: Math.round((amplitudes.length / 30) * 1000),
      },
    })
  } catch (err) {
    console.error('[Chat] Error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// POST /:id/clear — reset conversation history
router.post('/:id/clear', (req, res) => {
  conversations.delete(req.params.id)
  res.json({ cleared: true })
})

export default router
