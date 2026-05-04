"""
OllamaProxyMonitor に追加するエンドポイントのサンプル (FastAPI想定)。
既存のProxyコードに組み込むこと。

監視ツール側はこの2つの API を叩いて状態を取得する。
"""
from __future__ import annotations
import asyncio
import time
from typing import Any

import httpx
from fastapi import APIRouter

router = APIRouter(prefix="/api")

# Proxy が管理しているバックエンド一覧 (既存のルーティング設定から取る)
# このリストの形は既存実装に合わせて調整してください
BACKENDS = [
    {"id": "rtx2080",  "name": "Ollama @ RTX 2080",   "url": "http://192.168.1.20:11434"},
    {"id": "rtx5090",  "name": "Ollama @ RTX 5090",   "url": "http://192.168.1.21:11434"},
    {"id": "macbook",  "name": "Ollama @ MacBook M5", "url": "http://192.168.1.30:11434"},
]

# 簡易キャッシュ: 監視ツールから5秒ごとにポーリングされても、
# バックエンドへの問い合わせは10秒に1回に間引く
_cache: dict[str, Any] = {"ts": 0, "data": []}
CACHE_TTL = 10


async def _check_backend(b: dict) -> dict:
    """各 Ollama バックエンドの /api/tags を叩いてモデル一覧と応答時間を取得"""
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{b['url'].rstrip('/')}/api/tags")
        elapsed = (time.perf_counter() - start) * 1000
        if r.status_code == 200:
            tags = r.json().get("models", [])
            models = [m.get("name", "") for m in tags]
            return {
                **b,
                "status": "up",
                "latency_ms": round(elapsed, 1),
                "models": models,
                "error": None,
            }
        return {
            **b,
            "status": "degraded",
            "latency_ms": round(elapsed, 1),
            "models": [],
            "error": f"HTTP {r.status_code}",
        }
    except Exception as e:
        return {
            **b,
            "status": "down",
            "latency_ms": None,
            "models": [],
            "error": str(e),
        }


async def get_backend_states() -> list[dict]:
    now = time.time()
    if now - _cache["ts"] < CACHE_TTL and _cache["data"]:
        return _cache["data"]
    results = await asyncio.gather(*[_check_backend(b) for b in BACKENDS])
    _cache["ts"] = now
    _cache["data"] = results
    return results


@router.get("/health")
async def health():
    """Proxy 自体の死活確認 (軽量)"""
    return {"status": "ok", "ts": int(time.time())}


@router.get("/backends")
async def backends():
    """全バックエンドの状態"""
    states = await get_backend_states()
    return {
        "backends": states,
        "ts": int(time.time()),
    }
