"""
CueAI — Python processing service
Voice / text / screen → Gemini → real-time answers
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import scipy.io.wavfile as wavfile
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from security import (
    ApiKeyAndRateLimitMiddleware,
    RateLimiter,
    RedactUvicornAccessFilter,
    authorize_websocket,
)

load_dotenv(override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("cueai")
logging.getLogger("uvicorn.access").addFilter(RedactUvicornAccessFilter())

# ================= CONFIG =================
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8001"))
APP_ENV = os.getenv("APP_ENV", "production").strip().lower()
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
API_SECRET_KEY = os.getenv("API_SECRET_KEY", "").strip()
REQUIRE_API_KEY = os.getenv("REQUIRE_API_KEY", "true").strip().lower() in {"1", "true", "yes"}
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "60"))
LARAVEL_API_URL = os.getenv("LARAVEL_API_URL", "http://127.0.0.1:8000").rstrip("/")
RPM_LIMIT = int(os.getenv("RPM_LIMIT", "10"))
SAMPLE_RATE = 16000
# Push-to-talk mic: record while ON, answer once on STOP
SPEECH_RMS_THRESHOLD = float(os.getenv("SPEECH_RMS_THRESHOLD", "0.008"))
SPEECH_MIN_RATIO = float(os.getenv("SPEECH_MIN_RATIO", "0.05"))
# Max recording length kept in memory (~10 minutes PCM16 mono)
MAX_RECORD_SEC = int(os.getenv("MAX_RECORD_SEC", "600"))

if REQUIRE_API_KEY and not API_SECRET_KEY:
    raise RuntimeError("API_SECRET_KEY is required when REQUIRE_API_KEY=true")

if not ALLOWED_ORIGINS:
    # Empty → deny browser CORS (server-to-server Laravel calls do not need CORS)
    ALLOWED_ORIGINS = []

gemini_client: Optional[genai.Client] = None
if GEMINI_API_KEY:
    gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    log.info("Gemini ready — model=%s env=%s", GEMINI_MODEL, APP_ENV)
else:
    log.warning("GEMINI_API_KEY missing — AI endpoints will fail until set")

GLOBAL_SEMAPHORE = asyncio.Semaphore(max(1, RPM_LIMIT))
rate_limiter = RateLimiter(max_requests=RATE_LIMIT_PER_MINUTE, window_seconds=60)

app = FastAPI(
    title="CueAI",
    version="1.0.0",
    docs_url=None if APP_ENV == "production" else "/docs",
    redoc_url=None if APP_ENV == "production" else "/redoc",
    openapi_url=None if APP_ENV == "production" else "/openapi.json",
)

# CORS: only explicit origins. Laravel→Python is server-side (no CORS needed).
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key", "Accept"],
)

app.add_middleware(
    ApiKeyAndRateLimitMiddleware,
    api_secret=API_SECRET_KEY,
    require_api_key=REQUIRE_API_KEY,
    rate_limiter=rate_limiter,
    trusted_proxy=True,
)


# ================= MODELS =================
class TextAskRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)
    session_id: Optional[int] = None
    mode: str = "interview"
    context: Optional[str] = Field(default=None, max_length=8000)
    language: str = "English"


# ================= HELPERS =================
def require_gemini() -> genai.Client:
    if not gemini_client:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not configured")
    return gemini_client


def system_prompt(mode: str, language: str, context: Optional[str] = None) -> str:
    mode = (mode or "interview").lower()
    base = {
        "interview": (
            "You are a real-time AI interview assistant. Detect the interviewer's latest question "
            "and give concise, accurate spoken-style answers the candidate can use live. "
            "Ignore the candidate reading/speaking a prior answer. Prefer short bullet points and "
            "clear structure. For coding questions, give approach first, then clean code, then complexity."
        ),
        "sales": (
            "You are a real-time AI sales-call assistant. Suggest sharp replies, discovery "
            "questions, objection handlers, and next steps. Keep answers concise and usable live."
        ),
        "meeting": (
            "You are a real-time meeting assistant. Capture decisions, action items, and "
            "suggested replies. Be brief and practical."
        ),
        "regular": (
            "You are a real-time conversation assistant. Answer clearly and helpfully. "
            "Keep responses short enough to use while speaking."
        ),
    }.get(mode, "You are a real-time AI conversation assistant. Be concise and accurate.")

    parts = [base, f"Respond in {language}."]
    if context:
        parts.append(f"Session context / documents:\n{context[:8000]}")
    parts.append(
        "If input is audio or a screen image, first understand what is being asked, "
        "then answer. If no clear question is present, summarize useful talking points. "
        "Do not invent a new answer when the audio is only the candidate speaking an existing reply."
    )
    return "\n\n".join(parts)


def audio_to_wav_bytes(audio: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    wavfile.write(buf, rate, pcm)
    return buf.getvalue()


def audio_to_gemini_bytes(audio: np.ndarray, rate: int = SAMPLE_RATE) -> Tuple[bytes, str]:
    """Prefer FLAC (smaller/faster than WAV) like hnr-doctor path."""
    if audio.size == 0:
        return b"", "audio/wav"
    try:
        import soundfile as sf

        buf = io.BytesIO()
        sf.write(buf, np.clip(audio, -1.0, 1.0).astype(np.float32), rate, format="FLAC")
        data = buf.getvalue()
        if data:
            return data, "audio/flac"
    except Exception:
        log.warning("FLAC compress failed; using WAV")
    return audio_to_wav_bytes(audio, rate), "audio/wav"


def pcm16_bytes_to_float(pcm: bytes) -> np.ndarray:
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def speech_stats(audio: np.ndarray, frame_ms: int = 30) -> Tuple[float, float]:
    """Return (rms, speech_frame_ratio) for cheap local VAD."""
    if audio.size == 0:
        return 0.0, 0.0
    rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64)))
    frame = max(1, int(SAMPLE_RATE * frame_ms / 1000))
    if audio.size < frame:
        return rms, 1.0 if rms >= SPEECH_RMS_THRESHOLD else 0.0
    n = audio.size // frame
    if n <= 0:
        return rms, 0.0
    frames = audio[: n * frame].reshape(n, frame)
    frame_rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))
    ratio = float(np.mean(frame_rms >= SPEECH_RMS_THRESHOLD))
    return rms, ratio


def has_enough_speech(audio: np.ndarray) -> bool:
    rms, ratio = speech_stats(audio)
    return rms >= SPEECH_RMS_THRESHOLD and ratio >= SPEECH_MIN_RATIO


async def gemini_generate(
    *,
    prompt: str,
    system: str,
    audio_bytes: Optional[bytes] = None,
    audio_mime: str = "audio/wav",
    image_bytes: Optional[bytes] = None,
    image_mime: str = "image/png",
    model: Optional[str] = None,
    temperature: float = 0.4,
    max_output_tokens: Optional[int] = None,
    response_mime_type: Optional[str] = None,
) -> str:
    client = require_gemini()
    contents: List[Any] = []

    if audio_bytes:
        contents.append(types.Part.from_bytes(data=audio_bytes, mime_type=audio_mime))
    if image_bytes:
        contents.append(types.Part.from_bytes(data=image_bytes, mime_type=image_mime))
    contents.append(prompt)

    cfg_kwargs: Dict[str, Any] = {
        "system_instruction": system,
        "temperature": temperature,
    }
    if max_output_tokens is not None:
        cfg_kwargs["max_output_tokens"] = max_output_tokens
    if response_mime_type:
        cfg_kwargs["response_mime_type"] = response_mime_type

    use_model = model or GEMINI_MODEL

    async with GLOBAL_SEMAPHORE:
        def _call():
            return client.models.generate_content(
                model=use_model,
                contents=contents,
                config=types.GenerateContentConfig(**cfg_kwargs),
            )

        response = await asyncio.to_thread(_call)

    text = getattr(response, "text", None) or ""
    if not text and getattr(response, "candidates", None):
        try:
            text = response.candidates[0].content.parts[0].text
        except Exception:
            text = ""
    return (text or "").strip()


def make_answer(answer: str, mode: str, transcript: Optional[str] = None) -> dict:
    return {
        "answer": answer,
        "transcript": transcript,
        "model": GEMINI_MODEL,
        "mode": mode,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }


# ================= ROUTES =================
@app.get("/health")
async def health():
    # Public, minimal — no secrets / no prompt data
    return {
        "status": "ok",
        "service": "cueai",
        "gemini": bool(gemini_client),
        "time": datetime.utcnow().isoformat() + "Z",
    }


@app.post("/ask/text")
async def ask_text(body: TextAskRequest):
    # Do not log body.text / context (sensitive)
    log.info("ask/text mode=%s chars=%s", body.mode, len(body.text))
    system = system_prompt(body.mode, body.language, body.context)
    answer = await gemini_generate(
        prompt=f"User / conversation text:\n{body.text}\n\nProvide the best live answer now.",
        system=system,
    )
    return make_answer(answer, body.mode, transcript=body.text)


@app.post("/ask/audio")
async def ask_audio(
    file: UploadFile = File(...),
    mode: str = Form("interview"),
    language: str = Form("English"),
    context: Optional[str] = Form(None),
    session_id: Optional[int] = Form(None),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio too large")

    log.info("ask/audio mode=%s bytes=%s", mode, len(raw))
    mime = file.content_type or "audio/wav"
    system = system_prompt(mode, language, context)
    answer = await gemini_generate(
        prompt=(
            "Transcribe this audio if needed, detect any question or prompt, "
            "then provide the best live assistant answer."
        ),
        system=system,
        audio_bytes=raw,
        audio_mime=mime,
    )
    return make_answer(answer, mode)


@app.post("/ask/screen")
async def ask_screen(
    file: UploadFile = File(...),
    prompt: str = Form("What is on the screen? If there is a question or coding problem, solve it."),
    mode: str = Form("interview"),
    language: str = Form("English"),
    context: Optional[str] = Form(None),
    session_id: Optional[int] = Form(None),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large")

    log.info("ask/screen mode=%s bytes=%s", mode, len(raw))
    mime = file.content_type or "image/png"
    system = system_prompt(mode, language, context)
    answer = await gemini_generate(
        prompt=prompt[:4000],
        system=system,
        image_bytes=raw,
        image_mime=mime,
    )
    return make_answer(answer, mode)


@app.websocket("/ws/audio")
async def websocket_audio(ws: WebSocket):
    """
    Push-to-talk (hnr-doctor style):
      mic START  -> only buffer audio (no Gemini)
      mic STOP   -> process full recording once -> answer
    Protocol:
      start | binary PCM16 | stop
    """
    if not await authorize_websocket(ws, API_SECRET_KEY, REQUIRE_API_KEY):
        log.warning("ws unauthorized")
        return

    await ws.accept()
    mode = "interview"
    language = "English"
    context: Optional[str] = None
    buffer = bytearray()
    processing = False
    log.info("ws connected")

    async def answer_from_recording() -> None:
        nonlocal processing, buffer
        if processing:
            await ws.send_json({"type": "info", "message": "already processing"})
            return
        if len(buffer) < SAMPLE_RATE // 2:
            await ws.send_json(
                {
                    "type": "turn_status",
                    "state": "ready",
                    "reason": "empty",
                    "message": "no audio captured",
                }
            )
            return

        processing = True
        try:
            audio = pcm16_bytes_to_float(bytes(buffer))
            if not has_enough_speech(audio):
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "ready",
                        "reason": "silence",
                        "message": "no clear speech — try again",
                    }
                )
                return

            await ws.send_json(
                {
                    "type": "turn_status",
                    "state": "processing",
                    "reason": "generating",
                    "message": "thinking…",
                }
            )

            system = system_prompt(mode, language, context)
            prompt = (
                "This recording is one interview/call segment captured while the mic was on.\n"
                "Find the main question or prompt from the other person and give a concise "
                "spoken-style answer the candidate can use.\n"
                "Prefer the latest clear question if there are multiple.\n"
                "Ignore filler, silence, and side talk that is not a question."
            )
            audio_bytes, audio_mime = audio_to_gemini_bytes(audio)
            answer = await gemini_generate(
                prompt=prompt,
                system=system,
                audio_bytes=audio_bytes,
                audio_mime=audio_mime,
                temperature=0.3,
                max_output_tokens=900,
            )
            answer = (answer or "").strip()
            if not answer:
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "ready",
                        "reason": "empty_answer",
                        "message": "no answer produced",
                    }
                )
                return

            payload = make_answer(answer, mode)
            payload.update(
                {
                    "type": "answer",
                    "final": True,
                    "locked": True,
                    "state": "ready",
                    "reason": "mic_stop",
                }
            )
            await ws.send_json(payload)
            buffer.clear()
        except Exception:
            log.exception("ws stop process failed")
            await ws.send_json({"type": "error", "message": "processing failed"})
        finally:
            processing = False

    try:
        await ws.send_json({"type": "ready", "features": ["push_to_talk", "flac"]})
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                buffer.extend(message["bytes"])
                max_buf = SAMPLE_RATE * 2 * max(60, MAX_RECORD_SEC)
                if len(buffer) > max_buf:
                    del buffer[:-max_buf]
                continue

            text = message.get("text")
            if not text:
                continue

            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "invalid json"})
                continue

            msg_type = data.get("type")
            if msg_type == "start":
                mode = data.get("mode") or mode
                language = data.get("language") or language
                context = data.get("context") or context
                buffer.clear()
                await ws.send_json({"type": "started", "mode": mode, "state": "recording"})
            elif msg_type == "context":
                context = data.get("context") or context
                await ws.send_json({"type": "ok"})
            elif msg_type in {"process", "refresh", "answer_now", "unlock"}:
                # Mid-recording process disabled — answer only on stop.
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "recording",
                        "reason": "record_only",
                        "message": "recording… stop mic for answer",
                    }
                )
            elif msg_type == "stop":
                await answer_from_recording()
                await ws.send_json({"type": "stopped", "state": "ready"})
                break
            else:
                await ws.send_json({"type": "error", "message": f"unknown type {msg_type}"})
    except WebSocketDisconnect:
        log.info("ws disconnected")
    except Exception:
        log.exception("ws error")
        try:
            await ws.send_json({"type": "error", "message": "websocket error"})
        except Exception:
            pass


if __name__ == "__main__":
    # reload=False in production-like runs
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=APP_ENV != "production",
        access_log=True,
    )
