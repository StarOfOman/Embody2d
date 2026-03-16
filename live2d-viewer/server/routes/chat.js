import { Router } from 'express'
import { sendToAvatar } from '../index.js'

const router = Router()

const LLM_URL = process.env.LLM_URL || 'http://localhost:11434'
const LLM_API_KEY = process.env.LLM_API_KEY || ''
const TTS_URL = process.env.TTS_URL || 'http://localhost:8880'
const TTS_VOICE = process.env.TTS_VOICE || 'af_sarah'
const TTS_MODEL = process.env.TTS_MODEL || 'kokoro'
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''
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
 * Call Kokoro TTS — returns WAV buffer
 */
async function callKokoroTTS(text, voice) {
  const ttsRes = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: voice || TTS_VOICE,
      response_format: 'wav',
      speed: 1.0,
    }),
  })
  if (!ttsRes.ok) throw new Error(`Kokoro TTS error ${ttsRes.status}`)
  return Buffer.from(await ttsRes.arrayBuffer())
}

/**
 * Call ElevenLabs TTS — returns WAV buffer
 */
async function callElevenLabsTTS(text, voiceId) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set')

  // Request raw PCM so we can extract real lipsync amplitudes
  // Then wrap as WAV for browser playback
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  })

  if (!ttsRes.ok) {
    const errText = await ttsRes.text()
    throw new Error(`ElevenLabs TTS error ${ttsRes.status}: ${errText}`)
  }

  const pcmBuffer = Buffer.from(await ttsRes.arrayBuffer())
  return pcmToWav(pcmBuffer, 24000, 16, 1)
}

/**
 * Wrap raw PCM data in a WAV header
 */
function pcmToWav(pcmBuffer, sampleRate, bitsPerSample, channels) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcmBuffer.length
  const headerSize = 44
  const wav = Buffer.alloc(headerSize + dataSize)

  // RIFF header
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  // fmt chunk
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)           // chunk size
  wav.writeUInt16LE(1, 20)            // PCM format
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(byteRate, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bitsPerSample, 34)
  // data chunk
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  pcmBuffer.copy(wav, 44)

  return wav
}

/**
 * Generate natural speech lipsync amplitudes from text.
 * ElevenLabs speaks at ~2.5 words/sec. We generate per-word open/close
 * patterns with pauses at punctuation.
 */
function generateSpeechLipsync(text, fps = 30) {
  const words = text.split(/\s+/).filter(Boolean)
  const wordsPerSec = 2.5
  const estDurationSec = Math.max(words.length / wordsPerSec, 0.5)
  // Add extra buffer — ElevenLabs often runs slightly longer
  const totalDurationSec = estDurationSec * 1.15
  const numFrames = Math.round(totalDurationSec * fps)
  const amplitudes = new Array(numFrames).fill(0)
  const framesPerWord = numFrames / words.length

  for (let w = 0; w < words.length; w++) {
    const word = words[w]
    const wordStart = Math.round(w * framesPerWord)
    const wordLen = Math.round(framesPerWord)
    const isPause = /[.,;:!?]$/.test(word)

    for (let f = 0; f < wordLen; f++) {
      const frameIdx = wordStart + f
      if (frameIdx >= numFrames) break

      const t = f / wordLen
      // Open mouth during middle of word, close at edges
      let amp = Math.sin(t * Math.PI) * 0.7
      // Vary by word length — longer words open more
      amp *= 0.5 + Math.min(word.length / 8, 0.5)
      // Add slight randomness
      amp += (Math.random() - 0.5) * 0.15
      amplitudes[frameIdx] = Math.min(1, Math.max(0, amp))
    }

    // Add a pause after punctuation
    if (isPause) {
      const pauseStart = wordStart + wordLen
      const pauseFrames = Math.round(fps * 0.2)
      for (let f = 0; f < pauseFrames && pauseStart + f < numFrames; f++) {
        amplitudes[pauseStart + f] = 0
      }
    }
  }

  return amplitudes
}

router.post('/:id/message', async (req, res) => {
  const { id } = req.params
  const { text, voice, ttsProvider, elevenLabsVoiceId } = req.body

  if (!text) return res.status(400).json({ error: 'text is required' })

  try {
    // 1. Call LLM
    const history = getHistory(id)
    history.push({ role: 'user', content: text })

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
    reply = reply
      .replace(/[\u{1F000}-\u{1FFFF}|\u{2600}-\u{27FF}|\u{FE00}-\u{FEFF}|\u{1F900}-\u{1F9FF}|\u{200D}|\u{20E3}|\u{E0020}-\u{E007F}|\u{2702}-\u{27B0}|\u{FE0F}]/gu, '')
      .replace(/\*+/g, '')
      .replace(/[_~`#>]/g, '')
      .trim()

    history.push({ role: 'assistant', content: reply })

    // 2. Call TTS (ElevenLabs or Kokoro)
    let audioBuffer
    const isElevenLabs = ttsProvider === 'elevenlabs' && elevenLabsVoiceId
    try {
      if (isElevenLabs) {
        audioBuffer = await callElevenLabsTTS(reply, elevenLabsVoiceId)
        // callElevenLabsTTS now returns WAV (PCM wrapped with header)
      } else {
        audioBuffer = await callKokoroTTS(reply, voice)
      }
    } catch (ttsErr) {
      console.warn(`[Chat] TTS error: ${ttsErr.message}`)
      return res.json({ reply, audio: null })
    }

    // 3. Extract real lipsync amplitudes from WAV audio
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

// POST /:id/speak — direct TTS, no LLM (script mode)
router.post('/:id/speak', async (req, res) => {
  const { id } = req.params
  const { text, voice, ttsProvider, elevenLabsVoiceId } = req.body

  if (!text) return res.status(400).json({ error: 'text is required' })

  try {
    let audioBuffer
    const isElevenLabs = ttsProvider === 'elevenlabs' && elevenLabsVoiceId
    try {
      if (isElevenLabs) {
        audioBuffer = await callElevenLabsTTS(text, elevenLabsVoiceId)
      } else {
        audioBuffer = await callKokoroTTS(text, voice)
      }
    } catch (ttsErr) {
      console.warn(`[Speak] TTS error: ${ttsErr.message}`)
      return res.json({ ok: false, audio: null })
    }

    const { extractAmplitudes } = await import('../adapters/audio-amplitude.js')
    const amplitudes = await extractAmplitudes(audioBuffer, 30)

    sendToAvatar(id, { type: 'lipsync-sequence', amplitudes, fps: 30 })

    const audioBase64 = audioBuffer.toString('base64')
    res.json({
      ok: true,
      audio: {
        data: audioBase64,
        format: 'wav',
        duration_ms: Math.round((amplitudes.length / 30) * 1000),
      },
    })
  } catch (err) {
    console.error('[Speak] Error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

router.post('/:id/clear', (req, res) => {
  conversations.delete(req.params.id)
  res.json({ cleared: true })
})

export default router
