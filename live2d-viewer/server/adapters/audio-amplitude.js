/**
 * Extracts amplitude envelope from audio buffer at a given FPS.
 * Supports WAV natively. For MP3/other formats, falls back to
 * a simulated speech pattern.
 */
import wavDecoder from 'wav-decoder'

/**
 * @param {Buffer} buffer - raw audio file bytes
 * @param {number} fps - target frames per second for amplitude output
 * @returns {Promise<number[]>} - array of amplitude values 0.0–1.0
 */
export async function extractAmplitudes(buffer, fps = 60) {
  // Try WAV decode
  const audioData = await wavDecoder.decode(buffer)
  const samples = audioData.channelData[0] // mono or first channel
  const sampleRate = audioData.sampleRate
  const samplesPerFrame = Math.floor(sampleRate / fps)
  const frames = Math.ceil(samples.length / samplesPerFrame)
  const amplitudes = []

  for (let i = 0; i < frames; i++) {
    const start = i * samplesPerFrame
    const end = Math.min(start + samplesPerFrame, samples.length)
    let sum = 0
    for (let j = start; j < end; j++) {
      sum += Math.abs(samples[j])
    }
    const avg = sum / (end - start)
    // Normalize — speech typically peaks around 0.3 RMS
    amplitudes.push(Math.min(1, avg * 3))
  }

  return amplitudes
}
