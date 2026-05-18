"""
whisper-server: faster-whisper の薄い HTTP ラッパ。

- POST /api/transcribe  multipart/form-data でファイル受信し書き起こし
- GET  /health           liveness（モデルロード状況も返す）

OllamaProxy が /api/transcribe を stream pass-through で転送してくる前提。
パスは Monitor/OllamaProxy 側と揃える（サブディレクトリで分けない）。
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("whisper-server")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")          # auto | cuda | cpu
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")
# auto: cuda なら float16、cpu なら int8。明示するなら float16/int8/int8_float16

# faster-whisper はマルチスレッド推論で確定動作しないため、1リクエストずつ処理する。
inference_lock = asyncio.Lock()
model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    log.info("loading model=%s device=%s compute_type=%s", MODEL_NAME, DEVICE, COMPUTE_TYPE)
    # WhisperModel の初期化は同期でファイルDLとロードを行う。to_thread に逃がす。
    model = await asyncio.to_thread(
        WhisperModel,
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
    )
    log.info("model loaded")
    yield


app = FastAPI(title="whisper-server", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "ok": model is not None,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "busy": inference_lock.locked(),
    }


def _do_transcribe(path: str, **kw):
    """faster-whisper.transcribe() はジェネレータを返すので、ここで全展開する。"""
    assert model is not None
    segments_iter, info = model.transcribe(path, **kw)
    segs = [
        {"start": s.start, "end": s.end, "text": s.text}
        for s in segments_iter
    ]
    return segs, info


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(None),
    vad_filter: bool = Form(True),
    word_timestamps: bool = Form(False),
    beam_size: int = Form(5),
):
    if model is None:
        raise HTTPException(503, "model not loaded yet")

    # 大きなファイルは一旦ディスクに書き出してから渡す（faster-whisper はパス受理が安定）
    suffix = Path(file.filename or "audio").suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        total = 0
        while True:
            chunk = await file.read(1 << 20)  # 1MB ずつ
            if not chunk:
                break
            tmp.write(chunk)
            total += len(chunk)

    log.info("transcribe start: %s (%d bytes) lang=%s", file.filename, total, language)

    try:
        async with inference_lock:
            segments, info = await asyncio.to_thread(
                _do_transcribe,
                tmp_path,
                language=language,
                vad_filter=vad_filter,
                word_timestamps=word_timestamps,
                beam_size=beam_size,
            )
        text = "".join(s["text"] for s in segments)
        log.info(
            "transcribe done: %s lang=%s dur=%.1fs segs=%d",
            file.filename, info.language, info.duration, len(segments),
        )
        return {
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": segments,
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
