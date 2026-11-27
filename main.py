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
# Live-mic turn control (token-aware)
GATE_MODEL = os.getenv("GEMINI_GATE_MODEL", GEMINI_MODEL).strip() or GEMINI_MODEL
SPEECH_RMS_THRESHOLD = float(os.getenv("SPEECH_RMS_THRESHOLD", "0.012"))
SPEECH_MIN_RATIO = float(os.getenv("SPEECH_MIN_RATIO", "0.08"))
LOCK_COOLDOWN_SEC = float(os.getenv("LOCK_COOLDOWN_SEC", "4.0"))
NEW_QUESTION_CONFIDENCE = float(os.getenv("NEW_QUESTION_CONFIDENCE", "0.62"))
AUDIO_WINDOW_SEC = int(os.getenv("AUDIO_WINDOW_SEC", "14"))
KEEP_AUDIO_SEC = int(os.getenv("KEEP_AUDIO_SEC", "4"))

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


def _normalize_words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def text_overlap_ratio(a: str, b: str) -> float:
    wa = set(_normalize_words(a))
    wb = set(_normalize_words(b))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / max(1, min(len(wa), len(wb)))


def answer_fingerprint(answer: str, limit: int = 420) -> str:
    clean = re.sub(r"\s+", " ", (answer or "").strip())
    return clean[:limit]


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


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


async def classify_live_turn(
    *,
    wav: bytes,
    locked_answer: Optional[str],
    last_question: Optional[str],
    language: str,
) -> Dict[str, Any]:
    """Cheap gate: decide whether to keep lock or generate a new answer."""
    locked_snip = answer_fingerprint(locked_answer or "", 360)
    last_q = (last_question or "").strip()[:240]
    prompt = (
        "You are a turn classifier for a live interview assistant.\n"
        "Audio may contain the interviewer and/or the candidate.\n"
        "Classify the LATEST speech turn.\n\n"
        f"Respond in JSON only. Language hint: {language}.\n"
        "Schema:\n"
        '{'
        '"action":"new_question"|"candidate_answer"|"noise"|"same_question",'
        '"confidence":0.0,'
        '"question":"short interviewer question if any",'
        '"heard":"very short transcript of latest speech"'
        "}\n\n"
        "Rules:\n"
        "- new_question: interviewer asks a new/different question that needs a fresh answer.\n"
        "- same_question: same question as before / follow-up that does not need a new answer card.\n"
        "- candidate_answer: candidate is speaking, reading, or paraphrasing the locked answer.\n"
        "- noise: silence, filler, crosstalk, or unclear speech.\n"
        f"Locked answer snippet:\n{locked_snip or '(none)'}\n"
        f"Previous question:\n{last_q or '(none)'}\n"
    )
    gate_system = (
        "Classify live interview audio turns. Be conservative about new_question. "
        "If speech overlaps the locked answer, choose candidate_answer. "
        "Return JSON only."
    )
    try:
        raw = await gemini_generate(
            prompt=prompt,
            system=gate_system,
            audio_bytes=wav,
            audio_mime="audio/wav",
            model=GATE_MODEL,
            temperature=0.1,
            max_output_tokens=160,
            response_mime_type="application/json",
        )
    except Exception:
        # Some models reject response_mime_type — retry plain text JSON.
        log.warning("gate json-mime failed; retrying plain")
        raw = await gemini_generate(
            prompt=prompt,
            system=gate_system,
            audio_bytes=wav,
            audio_mime="audio/wav",
            model=GATE_MODEL,
            temperature=0.1,
            max_output_tokens=160,
        )
    data = extract_json_object(raw) or {}
    action = str(data.get("action") or "noise").strip().lower()
    if action not in {"new_question", "candidate_answer", "noise", "same_question"}:
        action = "noise"
    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    heard = str(data.get("heard") or "").strip()
    question = str(data.get("question") or "").strip()

    # Local overlap backup: if heard text is close to locked answer, force candidate_answer.
    if locked_snip and heard and text_overlap_ratio(heard, locked_snip) >= 0.45:
        action = "candidate_answer"
        confidence = max(confidence, 0.75)

    if (
        action == "new_question"
        and last_q
        and question
        and text_overlap_ratio(question, last_q) >= 0.72
        and confidence < 0.9
    ):
        action = "same_question"

    return {
        "action": action,
        "confidence": confidence,
        "question": question,
        "heard": heard,
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
      client -> {"type":"start","mode":"interview","language":"English","context":"..."}
      client -> binary PCM16 frames
      client -> {"type":"process"} | {"type":"unlock"} | {"type":"refresh"} | {"type":"stop"}
    Server:
      {"type":"answer", ... , "locked": true, "state":"locked"}
      {"type":"turn_status","state":"locked|listening|waiting","reason":"...","answer_stable":true}
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
    turn_state = "listening"  # listening | locked | waiting
    locked_answer: Optional[str] = None
    last_question: Optional[str] = None
    locked_at = 0.0
    log.info("ws connected")

    def trim_buffer(keep_sec: int = KEEP_AUDIO_SEC) -> None:
        keep = SAMPLE_RATE * 2 * max(1, keep_sec)
        if len(buffer) > keep:
            del buffer[:-keep]

    def window_audio() -> np.ndarray:
        max_bytes = SAMPLE_RATE * 2 * max(6, AUDIO_WINDOW_SEC)
        chunk = bytes(buffer[-max_bytes:]) if len(buffer) > max_bytes else bytes(buffer)
        return pcm16_bytes_to_float(chunk)

    async def send_turn_status(
        *,
        state: str,
        reason: str,
        answer_stable: bool = False,
        message: Optional[str] = None,
        confidence: Optional[float] = None,
    ) -> None:
        payload: Dict[str, Any] = {
            "type": "turn_status",
            "state": state,
            "reason": reason,
            "answer_stable": answer_stable,
            "has_answer": bool(locked_answer),
        }
        if message:
            payload["message"] = message
        if confidence is not None:
            payload["confidence"] = confidence
        await ws.send_json(payload)

    async def emit_answer(answer: str, *, final: bool, reason: str, question: Optional[str] = None) -> None:
        nonlocal turn_state, locked_answer, last_question, locked_at
        locked_answer = answer.strip()
        if question:
            last_question = question.strip()[:320]
        turn_state = "locked"
        locked_at = time.monotonic()
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

    async def generate_live_answer(wav: bytes, question_hint: Optional[str] = None) -> str:
        system = system_prompt(mode, language, context)
        hint = (question_hint or "").strip()
        prompt = (
            "This is a live interview/call audio window.\n"
            "Focus on the interviewer's latest question only.\n"
            "Ignore candidate speech that is reading/paraphrasing a previous answer.\n"
            "Provide a concise real-time answer the candidate can speak now.\n"
        )
        if hint:
            prompt += f"\nDetected question hint:\n{hint}\n"
        if locked_answer:
            prompt += (
                "\nDo not repeat the previous answer unless the question is the same.\n"
                f"Previous locked answer fingerprint:\n{answer_fingerprint(locked_answer, 220)}\n"
            )
        return await gemini_generate(
            prompt=prompt,
            system=system,
            audio_bytes=wav,
            audio_mime="audio/wav",
            temperature=0.35,
            max_output_tokens=900,
        )

    async def process_buffer(final: bool = False, force: bool = False) -> None:
        nonlocal processing, turn_state, locked_answer, last_question, locked_at
        if processing:
            await ws.send_json({"type": "info", "message": "already processing"})
            return
        if len(buffer) < SAMPLE_RATE:  # < ~0.5s
            await ws.send_json({"type": "info", "message": "not enough audio yet"})
            return

        processing = True
        try:
            audio = window_audio()
            if not force and not has_enough_speech(audio):
                await send_turn_status(
                    state=turn_state if locked_answer else "listening",
                    reason="silence",
                    answer_stable=bool(locked_answer),
                    message="waiting for speech",
                )
                if not final:
                    trim_buffer()
                return

            wav = audio_to_wav_bytes(audio)

            # First answer (or forced refresh): generate once, then lock.
            if force or locked_answer is None:
                await send_turn_status(
                    state="processing",
                    reason="generating",
                    answer_stable=False,
                    message="generating answer",
                )
                answer = await generate_live_answer(wav)
                if not answer:
                    await send_turn_status(
                        state="listening",
                        reason="empty_answer",
                        answer_stable=False,
                        message="no answer produced",
                    )
                else:
                    await emit_answer(answer, final=final, reason="new_answer")
                if not final:
                    trim_buffer()
                return

            # Locked: cheap gate only — skip full answer unless new interviewer turn.
            if (time.monotonic() - locked_at) < LOCK_COOLDOWN_SEC and not final:
                await send_turn_status(
                    state="locked",
                    reason="cooldown",
                    answer_stable=True,
                    message="answer locked (cooldown)",
                )
                trim_buffer()
                return

            await send_turn_status(
                state="locked",
                reason="classifying",
                answer_stable=True,
                message="checking speaker turn",
            )
            gate = await classify_live_turn(
                wav=wav,
                locked_answer=locked_answer,
                last_question=last_question,
                language=language,
            )
            action = gate["action"]
            confidence = float(gate["confidence"])
            question = gate.get("question") or None

            if action in {"candidate_answer", "noise", "same_question"} or (
                action == "new_question" and confidence < NEW_QUESTION_CONFIDENCE
            ):
                reason = action if action != "new_question" else "low_confidence"
                turn_state = "locked" if action != "noise" else ("waiting" if locked_answer else "listening")
                await send_turn_status(
                    state="locked" if locked_answer else "listening",
                    reason=reason,
                    answer_stable=True,
                    message="keeping current answer",
                    confidence=confidence,
                )
                if not final:
                    trim_buffer()
                return

            # New interviewer question with enough confidence → unlock + regenerate once.
            turn_state = "listening"
            await send_turn_status(
                state="processing",
                reason="new_question",
                answer_stable=False,
                message="new question detected",
                confidence=confidence,
            )
            answer = await generate_live_answer(wav, question_hint=question)
            if not answer:
                # Keep previous stable answer if regeneration fails.
                turn_state = "locked"
                await send_turn_status(
                    state="locked",
                    reason="regen_failed",
                    answer_stable=True,
                    message="kept previous answer",
                    confidence=confidence,
                )
            else:
                await emit_answer(
                    answer,
                    final=final,
                    reason="new_question",
                    question=question,
                )
            if not final:
                trim_buffer()
        except Exception:
            log.exception("ws process failed")
            await ws.send_json({"type": "error", "message": "processing failed"})
        finally:
            processing = False

    try:
        await ws.send_json({"type": "ready", "features": ["turn_lock", "vad", "gate"]})
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                buffer.extend(message["bytes"])
                # Cap memory (~45s PCM16 mono)
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
                locked_at = 0.0
                await ws.send_json({"type": "started", "mode": mode, "state": "listening"})
            elif msg_type == "context":
                context = data.get("context") or context
                await ws.send_json({"type": "ok"})
            elif msg_type == "process":
                await process_buffer(final=False, force=False)
            elif msg_type == "unlock":
                turn_state = "listening"
                locked_answer = None
                last_question = None
                locked_at = 0.0
                await send_turn_status(
                    state="listening",
                    reason="manual_unlock",
                    answer_stable=False,
                    message="unlocked — waiting for next question",
                )
            elif msg_type == "refresh":
                # Force a new answer from current audio window.
                await process_buffer(final=False, force=True)
            elif msg_type == "stop":
                # On stop: do not burn tokens regenerating if already locked.
                if locked_answer is None:
                    await process_buffer(final=True, force=True)
                else:
                    await send_turn_status(
                        state="locked",
                        reason="stopped",
                        answer_stable=True,
                        message="session mic stopped",
                    )
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
