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
import re
import time
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
# Simple live-mic controls
SPEECH_RMS_THRESHOLD = float(os.getenv("SPEECH_RMS_THRESHOLD", "0.012"))
SPEECH_MIN_RATIO = float(os.getenv("SPEECH_MIN_RATIO", "0.08"))
AUDIO_WINDOW_SEC = int(os.getenv("AUDIO_WINDOW_SEC", "14"))
KEEP_AUDIO_SEC = int(os.getenv("KEEP_AUDIO_SEC", "4"))
# After an answer is shown, keep it stable this many seconds (lets user speak it).
ANSWER_HOLD_SEC = float(os.getenv("ANSWER_HOLD_SEC", "18"))

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


def answer_fingerprint(answer: str, limit: int = 420) -> str:
    clean = re.sub(r"\s+", " ", (answer or "").strip())
    return clean[:limit]


def answers_similar(a: str, b: str) -> bool:
    fa = answer_fingerprint(a, 500).lower()
    fb = answer_fingerprint(b, 500).lower()
    if not fa or not fb:
        return False
    if fa == fb:
        return True
    # crude overlap on words — avoid tiny wording-only refreshes
    wa = set(re.findall(r"[a-z0-9]+", fa))
    wb = set(re.findall(r"[a-z0-9]+", fb))
    if not wa or not wb:
        return False
    return (len(wa & wb) / max(len(wa), len(wb))) >= 0.82


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
    Simple live mic:
      - continuous audio stream
      - periodic process => answer
      - after an answer, HOLD it for ANSWER_HOLD_SEC (stable while user speaks)
      - then auto-update again for the next question
    Protocol:
      start | binary PCM | process | refresh | stop
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
    current_answer: Optional[str] = None
    answered_at = 0.0
    log.info("ws connected")

    def trim_buffer(keep_sec: int = KEEP_AUDIO_SEC) -> None:
        keep = SAMPLE_RATE * 2 * max(1, keep_sec)
        if len(buffer) > keep:
            del buffer[:-keep]

    def window_audio() -> np.ndarray:
        max_bytes = SAMPLE_RATE * 2 * max(6, AUDIO_WINDOW_SEC)
        chunk = bytes(buffer[-max_bytes:]) if len(buffer) > max_bytes else bytes(buffer)
        return pcm16_bytes_to_float(chunk)

    async def process_buffer(final: bool = False, force: bool = False) -> None:
        nonlocal processing, current_answer, answered_at
        if processing:
            await ws.send_json({"type": "info", "message": "already processing"})
            return
        if len(buffer) < SAMPLE_RATE:
            await ws.send_json({"type": "info", "message": "not enough audio yet"})
            return

        # Keep current answer stable for a short hold window (user speaking time).
        if (
            not force
            and not final
            and current_answer
            and (time.monotonic() - answered_at) < ANSWER_HOLD_SEC
        ):
            remain = max(0, int(ANSWER_HOLD_SEC - (time.monotonic() - answered_at)))
            await ws.send_json(
                {
                    "type": "turn_status",
                    "state": "stable",
                    "reason": "hold",
                    "answer_stable": True,
                    "message": f"answer stable ({remain}s)",
                }
            )
            return

        processing = True
        try:
            audio = window_audio()
            if not force and not has_enough_speech(audio):
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "listening",
                        "reason": "silence",
                        "answer_stable": bool(current_answer),
                        "message": "listening…",
                    }
                )
                if not final:
                    trim_buffer()
                return

            await ws.send_json(
                {
                    "type": "turn_status",
                    "state": "processing",
                    "reason": "generating",
                    "answer_stable": False,
                    "message": "thinking…",
                }
            )

            system = system_prompt(mode, language, context)
            prompt = (
                "This is a live call audio chunk. Detect the latest interviewer question "
                "and provide a concise real-time answer the user can speak. "
                "Ignore the candidate reading/paraphrasing a previous answer."
            )
            if current_answer:
                prompt += (
                    "\nPrevious answer fingerprint:\n"
                    f"{answer_fingerprint(current_answer, 220)}\n"
                )

            wav = audio_to_wav_bytes(audio)
            answer = await gemini_generate(
                prompt=prompt,
                system=system,
                audio_bytes=wav,
                audio_mime="audio/wav",
                temperature=0.35,
                max_output_tokens=900,
            )
            answer = (answer or "").strip()
            if not answer:
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "listening",
                        "reason": "empty",
                        "answer_stable": bool(current_answer),
                        "message": "listening…",
                    }
                )
                if not final:
                    trim_buffer()
                return

            # Don't flicker UI with near-identical rewrites.
            if current_answer and answers_similar(current_answer, answer) and not force:
                answered_at = time.monotonic()
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "stable",
                        "reason": "same_answer",
                        "answer_stable": True,
                        "message": "answer stable",
                    }
                )
                if not final:
                    trim_buffer()
                return

            current_answer = answer
            answered_at = time.monotonic()
            payload = make_answer(answer, mode)
            payload.update(
                {
                    "type": "answer",
                    "final": final,
                    "locked": True,
                    "state": "stable",
                    "reason": "auto" if not force else "refresh",
                }
            )
            await ws.send_json(payload)
            if not final:
                trim_buffer()
        except Exception:
            log.exception("ws process failed")
            await ws.send_json({"type": "error", "message": "processing failed"})
        finally:
            processing = False

    try:
        await ws.send_json({"type": "ready", "features": ["hold", "vad"]})
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                buffer.extend(message["bytes"])
                max_buf = SAMPLE_RATE * 2 * 45
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
                current_answer = None
                answered_at = 0.0
                await ws.send_json({"type": "started", "mode": mode, "state": "listening"})
            elif msg_type == "context":
                context = data.get("context") or context
                await ws.send_json({"type": "ok"})
            elif msg_type == "process":
                await process_buffer(final=False, force=False)
            elif msg_type in {"refresh", "answer_now"}:
                await process_buffer(final=False, force=True)
            elif msg_type == "unlock":
                # Compatibility no-op for older clients
                answered_at = 0.0
                await ws.send_json(
                    {
                        "type": "turn_status",
                        "state": "listening",
                        "reason": "unlock",
                        "answer_stable": bool(current_answer),
                        "message": "listening…",
                    }
                )
            elif msg_type == "stop":
                if current_answer is None:
                    await process_buffer(final=True, force=True)
                await ws.send_json({"type": "stopped", "state": "stopped"})
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
