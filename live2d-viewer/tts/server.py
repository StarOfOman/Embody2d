"""
Kokoro TTS local server — OpenAI-compatible /v1/audio/speech endpoint.
Patches kokoro-onnx dtype bug for v1.0 model.

Usage:
  python tts/server.py
"""

import io
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI(title="Kokoro TTS Local")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

MODEL_DIR = Path(__file__).parent
ONNX_MODEL = MODEL_DIR / "kokoro-v1.0.onnx"
VOICES_BIN = MODEL_DIR / "voices-v1.0.bin"
SAMPLE_RATE = 24000

kokoro = None


def get_kokoro():
    global kokoro
    if kokoro is not None:
        return kokoro

    from kokoro_onnx import Kokoro

    # Monkey-patch: fix speed dtype int32→float32 for v1.0 model
    original_create = Kokoro._create_audio

    def patched_create(self, phonemes, voice, speed):
        phonemes = phonemes[:510]
        tokens = np.array(self.tokenizer.tokenize(phonemes), dtype=np.int64)
        voice_style = voice[len(tokens)]
        token_input = [[0, *tokens, 0]]

        input_names = [i.name for i in self.sess.get_inputs()]
        if "input_ids" in input_names:
            inputs = {
                "input_ids": token_input,
                "style": np.array(voice_style, dtype=np.float32),
                "speed": np.array([speed], dtype=np.float32),  # FIX: was int32
            }
        else:
            inputs = {
                "tokens": token_input,
                "style": voice_style,
                "speed": np.ones(1, dtype=np.float32) * speed,
            }

        audio = self.sess.run(None, inputs)[0]
        # Flatten from (1, N) to (N,) if needed
        if audio.ndim > 1:
            audio = audio.squeeze()
        return audio, SAMPLE_RATE

    Kokoro._create_audio = patched_create

    print("[TTS] Loading Kokoro model...")
    kokoro = Kokoro(str(ONNX_MODEL), str(VOICES_BIN))
    print("[TTS] Model loaded!")
    return kokoro


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "af_sarah"
    response_format: str = "wav"
    speed: float = 1.0


@app.post("/v1/audio/speech")
async def create_speech(req: SpeechRequest):
    tts = get_kokoro()
    samples, sample_rate = tts.create(
        req.input,
        voice=req.voice,
        speed=req.speed,
        lang="en-us",
    )

    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    buf.seek(0)

    return Response(content=buf.read(), media_type="audio/wav")


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": kokoro is not None}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8880)
