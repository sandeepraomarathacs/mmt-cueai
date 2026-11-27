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
# Live-mic turn control (token-aware, silence-turn based)
SPEECH_RMS_THRESHOLD = float(os.getenv("SPEECH_RMS_THRESHOLD", "0.012"))
SPEECH_MIN_RATIO = float(os.getenv("SPEECH_MIN_RATIO", "0.08"))
AUDIO_WINDOW_SEC = int(os.getenv("AUDIO_WINDOW_SEC", "14"))
KEEP_AUDIO_SEC = int(os.getenv("KEEP_AUDIO_SEC", "3"))
# After an answer locks, wait for this much trailing silence before arming next question.
ARM_SILENCE_SEC = float(os.getenv("ARM_SILENCE_SEC", "1.1"))
# A new interviewer turn must contain at least this much speech, then end in silence.
UTTERANCE_MIN_SPEECH_SEC = float(os.getenv("UTTERANCE_MIN_SPEECH_SEC", "1.4"))
UTTERANCE_END_SILENCE_SEC = float(os.getenv("UTTERANCE_END_SILENCE_SEC", "0.75"))
# Optional auto answers from completed utterances (manual answer_now always works).
AUTO_ANSWER = os.getenv("AUTO_ANSWER", "true").strip().lower() in {"1", "true", "yes"}

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


def frame_rms_series(audio: np.ndarray, frame_ms: int = 30) -> np.ndarray:
    frame = max(1, int(SAMPLE_RATE * frame_ms / 1000))
    if audio.size < frame:
        rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64))) if audio.size else 0.0
        return np.array([rms], dtype=np.float64)
    n = audio.size // frame
    frames = audio[: n * frame].reshape(n, frame)
    return np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))


def speech_stats(audio: np.ndarray, frame_ms: int = 30) -> Tuple[float, float]:
    """Return (rms, speech_frame_ratio) for cheap local VAD."""
    if audio.size == 0:
        return 0.0, 0.0
    series = frame_rms_series(audio, frame_ms=frame_ms)
    rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64)))
    ratio = float(np.mean(series >= SPEECH_RMS_THRESHOLD)) if series.size else 0.0
    return rms, ratio


def has_enough_speech(audio: np.ndarray) -> bool:
    rms, ratio = speech_stats(audio)
    return rms >= SPEECH_RMS_THRESHOLD and ratio >= SPEECH_MIN_RATIO


def trailing_silence_sec(audio: np.ndarray, frame_ms: int = 30) -> float:
    series = frame_rms_series(audio, frame_ms=frame_ms)
    if series.size == 0:
        return 0.0
    silence = series < SPEECH_RMS_THRESHOLD
    count = 0
    for flag in silence[::-1]:
        if not flag:
            break
        count += 1
    return count * (frame_ms / 1000.0)


def latest_completed_utterance(
    audio: np.ndarray,
    *,
    min_speech_sec: float,
    end_silence_sec: float,
    frame_ms: int = 30,
) -> Optional[np.ndarray]:
    """
    Return the latest speech segment that already ended with silence.
    Used to detect 'interviewer finished asking'.
    """
    series = frame_rms_series(audio, frame_ms=frame_ms)
    if series.size == 0:
        return None
    speech = series >= SPEECH_RMS_THRESHOLD
    frame = max(1, int(SAMPLE_RATE * frame_ms / 1000))
    min_speech_frames = max(1, int(min_speech_sec * 1000 / frame_ms))
    end_silence_frames = max(1, int(end_silence_sec * 1000 / frame_ms))

    # Walk backward: require trailing silence, then a speech run.
    i = len(speech) - 1
    silence_run = 0
    while i >= 0 and not speech[i]:
        silence_run += 1
        i -= 1
    if silence_run < end_silence_frames:
        return None
    end_speech = i
    while i >= 0 and speech[i]:
        i -= 1
    start_speech = i + 1
    speech_frames = end_speech - start_speech + 1
    if speech_frames < min_speech_frames:
        return None
    start_sample = start_speech * frame
    end_sample = min(audio.size, (end_speech + 1) * frame)
    segment = audio[start_sample:end_sample]
    return segment if segment.size else None


def answer_fingerprint(answer: str, limit: int = 420) -> str:
    clean = re.sub(r"\s+", " ", (answer or "").strip())
    return clean[:limit]


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
    Auth: ?api_key=... or Header X-API-Key / Authorization: Bearer
    Protocol:
      client -> {"type":"start",...}
      client -> binary PCM16 frames
      client -> {"type":"process"}           # auto silence-turn check (cheap)
      client -> {"type":"answer_now"}|"refresh"  # force answer from recent audio
      client -> {"type":"unlock"} | {"type":"stop"}

    Turn model (best for single-mic interviews):
      listening  -> first completed utterance / answer_now => answer + lock
      locked     -> ignore until trailing silence (candidate finished speaking)
      armed      -> next completed utterance / answer_now => new answer + lock
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
    # listening | locked | armed | processing
    turn_state = "listening"
    locked_answer: Optional[str] = None
    last_question: Optional[str] = None
    log.info("ws connected")

    def trim_buffer(keep_sec: int = KEEP_AUDIO_SEC) -> None:
        keep = SAMPLE_RATE * 2 * max(1, keep_sec)
        if len(buffer) > keep:
            del buffer[:-keep]

    def window_audio() -> np.ndarray:
        max_bytes = SAMPLE_RATE * 2 * max(6, AUDIO_WINDOW_SEC)
        chunk = bytes(buffer[-max_bytes:]) if len(buffer) > max_bytes else bytes(buffer)
        return pcm16_bytes_to_float(chunk)

    def reset_after_lock() -> None:
        """Drop old audio so candidate speech / prior question cannot poison next turn."""
        buffer.clear()

    async def send_turn_status(
        *,
        state: str,
        reason: str,
        answer_stable: bool = False,
        message: Optional[str] = None,
    ) -> None:
        await ws.send_json(
            {
                "type": "turn_status",
                "state": state,
                "reason": reason,
                "answer_stable": answer_stable,
                "has_answer": bool(locked_answer),
                "message": message or "",
            }
        )

    async def emit_answer(answer: str, *, final: bool, reason: str) -> None:
        nonlocal turn_state, locked_answer
        locked_answer = answer.strip()
        turn_state = "locked"
        reset_after_lock()
        payload = make_answer(locked_answer, mode, transcript=last_question)
        payload.update(
            {
                "type": "answer",
                "final": final,
                "locked": True,
                "state": "locked",
                "reason": reason,
            }
        )
        await ws.send_json(payload)
        await send_turn_status(
            state="locked",
            reason=reason,
            answer_stable=True,
            message="answer ready — speak it, then wait for next question",
        )

    async def generate_live_answer(wav: bytes) -> str:
        system = system_prompt(mode, language, context)
        prompt = (
            "This is a live interview/call audio window.\n"
            "Focus on the interviewer's latest question only.\n"
            "Ignore candidate speech that is reading/paraphrasing a previous answer.\n"
            "Provide a concise real-time answer the candidate can speak now.\n"
        )
        if locked_answer:
            prompt += (
                "\nPrevious answer fingerprint (do not repeat unless question unchanged):\n"
                f"{answer_fingerprint(locked_answer, 220)}\n"
            )
        return await gemini_generate(
            prompt=prompt,
            system=system,
            audio_bytes=wav,
            audio_mime="audio/wav",
            temperature=0.35,
            max_output_tokens=900,
        )

    async def run_generate(*, final: bool, reason: str, audio: Optional[np.ndarray] = None) -> None:
        nonlocal turn_state
        use = audio if audio is not None else window_audio()
        if use.size < SAMPLE_RATE // 2:
            await send_turn_status(
                state=turn_state,
                reason="not_enough_audio",
                answer_stable=bool(locked_answer),
                message="not enough audio yet — keep mic on",
            )
            return
        if not has_enough_speech(use) and reason != "manual_answer_now":
            # Manual answer_now still tries — interviewer audio might be quieter.
            await send_turn_status(
                state=turn_state,
                reason="silence",
                answer_stable=bool(locked_answer),
                message="waiting for speech",
            )
            return

        turn_state = "processing"
        await send_turn_status(
            state="processing",
            reason="generating",
            answer_stable=False,
            message="generating answer…",
        )
        wav = audio_to_wav_bytes(use)
        answer = await generate_live_answer(wav)
        if not answer:
            turn_state = "armed" if locked_answer else "listening"
            await send_turn_status(
                state=turn_state,
                reason="empty_answer",
                answer_stable=bool(locked_answer),
                message="no answer produced — press Answer now after the question",
            )
            return
        await emit_answer(answer, final=final, reason=reason)

    async def process_buffer(final: bool = False, force: bool = False) -> None:
        """
        force/answer_now: always generate from current window.
        auto process: silence-turn detection only (no LLM gate).
        """
        nonlocal processing, turn_state
        if processing:
            await ws.send_json({"type": "info", "message": "already processing"})
            return

        processing = True
        try:
            audio = window_audio()

            # Manual / forced answer — most reliable path.
            if force or final:
                await run_generate(
                    final=final,
                    reason="manual_answer_now" if force else "final",
                    audio=audio,
                )
                return

            # ---- AUTO path (local VAD only; no Gemini classify) ----
            if turn_state == "locked":
                # Wait until candidate finishes speaking (trailing silence).
                silence = trailing_silence_sec(audio)
                if silence >= ARM_SILENCE_SEC:
                    reset_after_lock()
                    turn_state = "armed"
                    await send_turn_status(
                        state="armed",
                        reason="armed",
                        answer_stable=True,
                        message="ready — listening for next question",
                    )
                else:
                    await send_turn_status(
                        state="locked",
                        reason="candidate_window",
                        answer_stable=True,
                        message="answer locked — speak freely",
                    )
                return

            # listening or armed: wait for a completed utterance, then answer once.
            if not AUTO_ANSWER:
                await send_turn_status(
                    state=turn_state,
                    reason="auto_off",
                    answer_stable=bool(locked_answer),
                    message="auto off — press Answer now when question ends",
                )
                return

            utterance = latest_completed_utterance(
                audio,
                min_speech_sec=UTTERANCE_MIN_SPEECH_SEC,
                end_silence_sec=UTTERANCE_END_SILENCE_SEC,
            )
            if utterance is None:
                await send_turn_status(
                    state=turn_state,
                    reason="listening",
                    answer_stable=bool(locked_answer),
                    message=(
                        "listening for question…"
                        if turn_state == "listening"
                        else "armed — waiting for next question to finish"
                    ),
                )
                trim_buffer(KEEP_AUDIO_SEC + 2)
                return

            await run_generate(
                final=False,
                reason="utterance" if turn_state == "listening" else "next_utterance",
                audio=utterance,
            )
        except Exception:
            log.exception("ws process failed")
            await ws.send_json({"type": "error", "message": "processing failed"})
        finally:
            processing = False

    try:
        await ws.send_json(
            {
                "type": "ready",
                "features": ["turn_lock", "vad", "silence_turn", "answer_now"],
                "auto_answer": AUTO_ANSWER,
            }
        )
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
                turn_state = "listening"
                locked_answer = None
                last_question = None
                await ws.send_json({"type": "started", "mode": mode, "state": "listening"})
            elif msg_type == "context":
                context = data.get("context") or context
                await ws.send_json({"type": "ok"})
            elif msg_type == "process":
                await process_buffer(final=False, force=False)
            elif msg_type in {"answer_now", "refresh"}:
                # Reliable manual capture — does not require stopping the mic.
                await process_buffer(final=False, force=True)
            elif msg_type == "unlock":
                turn_state = "armed" if locked_answer else "listening"
                reset_after_lock()
                await send_turn_status(
                    state=turn_state,
                    reason="manual_unlock",
                    answer_stable=bool(locked_answer),
                    message="unlocked — listening for next question",
                )
            elif msg_type == "stop":
                # Keep current answer; don't spend tokens on stop unless no answer yet.
                if locked_answer is None and len(buffer) >= SAMPLE_RATE:
                    await process_buffer(final=True, force=True)
                await ws.send_json({"type": "stopped", "state": turn_state})
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
