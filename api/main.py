"""
main.py
FastAPI アプリ本体。
- バックグラウンドで定期チェック
- 結果と履歴を SQLite に保存
- フロントに /api/status, /api/history, /api/topology を公開
"""
from __future__ import annotations
import asyncio
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from checker import check_target

CONFIG_PATH = Path("/app/config.yaml")
DB_PATH = Path("/app/data/monitor.db")

# 最新状態をメモリにも保持 (フロント GET 用に高速)
_latest_state: dict[str, dict] = {}
_config: dict = {}


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            status TEXT NOT NULL,
            latency_ms REAL,
            detail TEXT,
            error TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_checks_target_ts ON checks(target_id, ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts)")
    conn.commit()
    conn.close()


def save_check(result: dict):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO checks (target_id, ts, status, latency_ms, detail, error) VALUES (?, ?, ?, ?, ?, ?)",
        (
            result["id"],
            int(time.time()),
            result["status"],
            result.get("latency_ms"),
            json.dumps(result.get("detail", {}), ensure_ascii=False),
            result.get("error"),
        ),
    )
    conn.commit()
    conn.close()


def cleanup_old(retention_days: int):
    cutoff = int(time.time()) - retention_days * 86400
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM checks WHERE ts < ?", (cutoff,))
    conn.commit()
    conn.close()


async def poll_loop():
    """設定された間隔ですべてのターゲットを並列チェック"""
    interval = _config.get("poll_interval_seconds", 10)
    retention = _config.get("history_retention_days", 7)
    last_cleanup = time.time()

    while True:
        try:
            targets = _config.get("targets", [])
            results = await asyncio.gather(
                *[check_target(t) for t in targets], return_exceptions=True
            )
            for t, r in zip(targets, results):
                if isinstance(r, Exception):
                    r = {
                        "id": t["id"],
                        "status": "down",
                        "latency_ms": None,
                        "detail": {},
                        "error": f"checker exception: {r}",
                    }
                # メタ情報を付与
                r["name"] = t.get("name", t["id"])
                r["type"] = t["type"]
                r["group"] = t.get("group", "default")
                r["last_checked"] = int(time.time())
                _latest_state[t["id"]] = r
                save_check(r)

            # 1時間に1回、古いレコードを掃除
            if time.time() - last_cleanup > 3600:
                cleanup_old(retention)
                last_cleanup = time.time()

        except Exception as e:
            # ループは絶対に止めない
            print(f"[poll_loop error] {e}")

        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _config
    _config = load_config()
    init_db()
    task = asyncio.create_task(poll_loop())
    yield
    task.cancel()


app = FastAPI(title="Infra Monitor", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/status")
def get_status():
    """全ターゲットの現在状態 + Proxy 経由の Ollama バックエンドを展開した形で返す"""
    nodes = []
    for tid, state in _latest_state.items():
        node = {
            "id": tid,
            "name": state["name"],
            "type": state["type"],
            "group": state["group"],
            "status": state["status"],
            "latency_ms": state.get("latency_ms"),
            "error": state.get("error"),
            "last_checked": state.get("last_checked"),
            "detail": state.get("detail", {}),
        }
        nodes.append(node)

        # Ollama Proxy のバックエンドは仮想ノードとして追加 (UI で別ノードとして描く)
        if state["type"] == "ollama_proxy":
            for b in state.get("detail", {}).get("backends", []):
                nodes.append({
                    "id": f"ollama-backend-{b.get('id', 'unknown')}",
                    "name": b.get("name", b.get("id", "unknown")),
                    "type": "ollama_backend",
                    "group": "llm-backend",
                    "status": b.get("status", "down"),
                    "latency_ms": b.get("latency_ms"),
                    "error": b.get("error"),
                    "last_checked": state.get("last_checked"),
                    "detail": {
                        "models": b.get("models", []),
                        "url": b.get("url"),
                        "parent": tid,
                    },
                })
    return {"nodes": nodes, "ts": int(time.time())}


@app.get("/api/history/{target_id}")
def get_history(target_id: str, hours: int = 1):
    """指定ターゲットの応答時間履歴 (グラフ用)"""
    if hours < 1 or hours > 24 * 7:
        raise HTTPException(400, "hours must be 1..168")
    since = int(time.time()) - hours * 3600
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT ts, status, latency_ms FROM checks WHERE target_id = ? AND ts >= ? ORDER BY ts",
        (target_id, since),
    ).fetchall()
    conn.close()
    return {
        "target_id": target_id,
        "points": [{"ts": r[0], "status": r[1], "latency_ms": r[2]} for r in rows],
    }


@app.get("/api/topology")
def get_topology():
    """設定された接続関係をフロントに返す。Proxy → backend は自動で展開"""
    edges = list(_config.get("edges", []))
    # Ollama Proxy のバックエンドへの暗黙のエッジを追加
    proxy_state = next(
        (s for s in _latest_state.values() if s["type"] == "ollama_proxy"), None
    )
    if proxy_state:
        for b in proxy_state.get("detail", {}).get("backends", []):
            edges.append({
                "from": proxy_state["id"],
                "to": f"ollama-backend-{b.get('id', 'unknown')}",
                "label": "ルーティング",
            })
    return {"edges": edges}


@app.get("/api/health")
def health():
    return {"status": "ok", "tracked": len(_latest_state)}
