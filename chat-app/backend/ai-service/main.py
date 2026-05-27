"""
AI Service — FastAPI server (port 8000)
Provides local-only AI endpoints for the chat application.
All models run locally. No paid APIs. No crypto material accepted.

Endpoints:
  POST /translate       — Translate text via Ollama
  POST /nsfw-check      — Check text toxicity (Detoxify) and image safety (NudeNet)
  POST /privacy-check   — Detect PII via Microsoft Presidio
  POST /summarize       — Summarize messages via Ollama
  POST /calendar-extract — Extract calendar events via Ollama
  POST /transcribe      — Transcribe audio via Faster-Whisper
"""

import os
import json
import tempfile
import logging
import re
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Logging ──────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [AI-SERVICE] %(message)s")
logger = logging.getLogger("ai-service")

# ── Lazy-loaded model singletons ─────────────────────────────────────
_detoxify_model = None
_nudenet_classifier = None
_presidio_analyzer = None
_whisper_model = None

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium")


def get_detoxify():
    global _detoxify_model
    if _detoxify_model is None:
        try:
            from detoxify import Detoxify
            _detoxify_model = Detoxify("original")
            logger.info("Detoxify model loaded")
        except Exception as e:
            logger.warning(f"Detoxify not available: {e}")
    return _detoxify_model


def get_nudenet():
    global _nudenet_classifier
    if _nudenet_classifier is None:
        try:
            from nudenet import NudeDetector
            _nudenet_classifier = NudeDetector()
            logger.info("NudeNet model loaded")
        except Exception as e:
            logger.warning(f"NudeNet not available: {e}")
    return _nudenet_classifier


def get_presidio():
    global _presidio_analyzer
    if _presidio_analyzer is None:
        try:
            from presidio_analyzer import AnalyzerEngine
            _presidio_analyzer = AnalyzerEngine()
            logger.info("Presidio analyzer loaded")
        except Exception as e:
            logger.warning(f"Presidio not available: {e}")
    return _presidio_analyzer


def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        try:
            from faster_whisper import WhisperModel
            _whisper_model = WhisperModel(
                WHISPER_MODEL_SIZE,
                device="cpu",
                compute_type="int8"
            )
            logger.info(f"Faster-Whisper ({WHISPER_MODEL_SIZE}) loaded")
        except Exception as e:
            logger.warning(f"Faster-Whisper not available: {e}")
    return _whisper_model


def ollama_generate(prompt: str, system_prompt: str = "") -> str:
    """Call local Ollama API for text generation."""
    import httpx
    try:
        payload = {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }
        if system_prompt:
            payload["system"] = system_prompt

        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json=payload,
            timeout=30.0
        )
        resp.raise_for_status()
        return resp.json().get("response", "").strip()
    except Exception as e:
        logger.error(f"Ollama generation failed: {e}")
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {e}")


# ── Pydantic Models ─────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    text: str
    targetLanguage: str = "en"
    sourceLanguage: Optional[str] = None


class NSFWTextRequest(BaseModel):
    text: str


class PrivacyCheckRequest(BaseModel):
    text: str


class SummarizeRequest(BaseModel):
    messages: List[str]


class CalendarExtractRequest(BaseModel):
    text: str


# ── Application ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("AI Service starting up on port 8000")
    yield
    logger.info("AI Service shutting down")


app = FastAPI(title="Chat AI Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health Check ─────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "ai-service"}


# ── 1. Translation ──────────────────────────────────────────────────
@app.post("/translate")
async def translate(req: TranslateRequest):
    """Translate text using local Ollama LLM."""
    logger.info(f"Translation request: target={req.targetLanguage}")
    prompt = (
        f"Translate the following text to {req.targetLanguage}. "
        f"Return ONLY the translated text, nothing else.\n\n"
        f"Text: {req.text}"
    )
    translated = ollama_generate(
        prompt,
        system_prompt="You are a translation assistant. Output only the translated text."
    )
    return {"translatedText": translated, "targetLanguage": req.targetLanguage}


# ── 2. NSFW Check — Text ────────────────────────────────────────────
@app.post("/nsfw-check")
async def nsfw_check_text(req: NSFWTextRequest):
    """Check text for toxic/NSFW content using Detoxify."""
    logger.info("NSFW text check request")
    model = get_detoxify()
    if model is None:
        return {"flagged": False, "scores": {}, "filteredText": req.text, "error": "Detoxify not available"}

    results = model.predict(req.text)
    # Determine if any category exceeds threshold
    threshold = 0.5
    flagged = False
    scores = {}
    for category, score in results.items():
        s = float(score)
        scores[category] = round(s, 4)
        if s > threshold:
            flagged = True

    # If flagged, censor toxic words (simple approach: replace each word that
    # individually scores high)
    filtered_text = req.text
    if flagged:
        words = req.text.split()
        censored_words = []
        for word in words:
            word_result = model.predict(word)
            word_flagged = any(float(v) > threshold for v in word_result.values())
            if word_flagged:
                censored_words.append("*" * len(word))
            else:
                censored_words.append(word)
        filtered_text = " ".join(censored_words)

    return {
        "flagged": flagged,
        "scores": scores,
        "filteredText": filtered_text,
    }


# ── 2b. NSFW Check — Image ──────────────────────────────────────────
@app.post("/nsfw-check-image")
async def nsfw_check_image(file: UploadFile = File(...)):
    """Check image for NSFW content using NudeNet."""
    logger.info(f"NSFW image check request: {file.filename}")
    detector = get_nudenet()
    if detector is None:
        return {"safe": True, "detections": [], "error": "NudeNet not available"}

    # Save to temp file for NudeNet
    suffix = os.path.splitext(file.filename or ".jpg")[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        detections = detector.detect(tmp_path)
        unsafe_classes = {
            "FEMALE_BREAST_EXPOSED",
            "FEMALE_GENITALIA_EXPOSED",
            "MALE_GENITALIA_EXPOSED",
            "BUTTOCKS_EXPOSED",
            "ANUS_EXPOSED",
        }
        is_unsafe = any(
            d.get("class") in unsafe_classes and d.get("score", 0) > 0.5
            for d in detections
        )
        return {
            "safe": not is_unsafe,
            "detections": [
                {"class": d.get("class"), "score": round(d.get("score", 0), 4)}
                for d in detections
                if d.get("class") in unsafe_classes
            ],
        }
    finally:
        os.unlink(tmp_path)


# ── 3. Privacy Check ────────────────────────────────────────────────
@app.post("/privacy-check")
async def privacy_check(req: PrivacyCheckRequest):
    """Detect PII in text using Microsoft Presidio."""
    logger.info("Privacy check request")
    analyzer = get_presidio()
    if analyzer is None:
        return {"hasPII": False, "entities": [], "error": "Presidio not available"}

    results = analyzer.analyze(
        text=req.text,
        language="en",
        entities=[
            "CREDIT_CARD", "CRYPTO", "DATE_TIME", "EMAIL_ADDRESS",
            "IBAN_CODE", "IP_ADDRESS", "NRP", "LOCATION",
            "PERSON", "PHONE_NUMBER", "MEDICAL_LICENSE",
            "URL", "US_BANK_NUMBER", "US_DRIVER_LICENSE",
            "US_ITIN", "US_PASSPORT", "US_SSN"
        ]
    )

    entities = [
        {
            "type": r.entity_type,
            "start": r.start,
            "end": r.end,
            "score": round(r.score, 4),
            "text": req.text[r.start:r.end]
        }
        for r in results
        if r.score > 0.5
    ]

    return {
        "hasPII": len(entities) > 0,
        "entities": entities,
    }


# ── 4. Summarize ────────────────────────────────────────────────────
@app.post("/summarize")
async def summarize(req: SummarizeRequest):
    """Summarize a list of messages using local Ollama LLM."""
    logger.info(f"Summarize request: {len(req.messages)} messages")
    if not req.messages:
        return {"summary": ""}

    combined = "\n".join(f"- {msg}" for msg in req.messages[-50:])  # Cap at 50 messages
    prompt = (
        f"Summarize this chat conversation in ONE concise paragraph. "
        f"Focus on key topics, decisions, and action items.\n\n"
        f"Messages:\n{combined}"
    )
    summary = ollama_generate(
        prompt,
        system_prompt="You are a concise summarizer. Output only the summary paragraph."
    )
    return {"summary": summary}


# ── 5. Calendar Extract ─────────────────────────────────────────────
@app.post("/calendar-extract")
async def calendar_extract(req: CalendarExtractRequest):
    """Extract calendar events from text using Ollama."""
    logger.info("Calendar extraction request")
    prompt = (
        f"Extract any meeting, event, appointment, or time-bound commitment from the text below. "
        f"Return a JSON array of objects with keys: date (YYYY-MM-DD), time (HH:MM, 24hr), event (description). "
        f"If no events found, return an empty array [].\n\n"
        f"Text: {req.text}\n\n"
        f"Output ONLY valid JSON. No markdown, no explanation."
    )
    raw = ollama_generate(
        prompt,
        system_prompt="You are a structured data extractor. Output ONLY valid JSON arrays."
    )

    # Try to parse JSON
    try:
        # Strip potential markdown code fences
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        events = json.loads(cleaned)
        if not isinstance(events, list):
            events = [events]
    except json.JSONDecodeError:
        events = []

    return {"events": events}


# ── 6. Transcribe ───────────────────────────────────────────────────
@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Transcribe audio using Faster-Whisper."""
    logger.info(f"Transcription request: {file.filename}")
    model = get_whisper()
    if model is None:
        return {"text": "", "error": "Faster-Whisper not available"}

    suffix = os.path.splitext(file.filename or ".wav")[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(tmp_path, beam_size=5)
        text = " ".join(seg.text.strip() for seg in segments)
        return {
            "text": text,
            "language": info.language,
            "duration": round(info.duration, 2),
        }
    finally:
        os.unlink(tmp_path)


# ── Run ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
