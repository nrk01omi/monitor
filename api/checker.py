"""
checker.py
各種ターゲットの死活チェックを行う。
type ごとに分岐して、すべて同じ形の dict を返す:
  {
    "id": str,
    "status": "up" | "down" | "degraded",
    "latency_ms": float | None,
    "detail": dict,         # type 固有情報
    "error": str | None,
  }
"""
from __future__ import annotations
import time
import socket
import asyncio
from typing import Any

import httpx
import docker
from docker.errors import NotFound, APIError

# Docker クライアントは使い回す (socket 経由)
_docker_client: docker.DockerClient | None = None


def get_docker_client() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.DockerClient(base_url="unix:///var/run/docker.sock")
    return _docker_client


async def check_docker(target: dict) -> dict:
    """Docker コンテナの状態を socket 経由で取得"""
    name = target["container_name"]
    try:
        # docker SDK は同期なので executor で
        loop = asyncio.get_event_loop()
        container = await loop.run_in_executor(
            None, lambda: get_docker_client().containers.get(name)
        )
        state = container.attrs["State"]
        status = state.get("Status", "unknown")
        running = state.get("Running", False)
        restart_count = container.attrs.get("RestartCount", 0)
        started_at = state.get("StartedAt", "")

        if not running:
            return {
                "id": target["id"],
                "status": "down",
                "latency_ms": None,
                "detail": {"docker_status": status, "restart_count": restart_count},
                "error": f"container is {status}",
            }

        # 30秒以内の再起動が複数あれば degraded
        result_status = "degraded" if restart_count > 0 and status == "restarting" else "up"
        return {
            "id": target["id"],
            "status": result_status,
            "latency_ms": None,  # docker socket は速いので測定不要
            "detail": {
                "docker_status": status,
                "restart_count": restart_count,
                "started_at": started_at,
            },
            "error": None,
        }
    except NotFound:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {},
            "error": "container not found",
        }
    except APIError as e:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {},
            "error": f"docker API error: {e}",
        }


async def check_http(target: dict) -> dict:
    """HTTP エンドポイントの GET でステータスコードと応答時間を確認"""
    url = target["url"]
    timeout = target.get("timeout_seconds", 5)
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
        elapsed = (time.perf_counter() - start) * 1000
        if 200 <= r.status_code < 400:
            return {
                "id": target["id"],
                "status": "up",
                "latency_ms": round(elapsed, 1),
                "detail": {"http_status": r.status_code},
                "error": None,
            }
        return {
            "id": target["id"],
            "status": "degraded",
            "latency_ms": round(elapsed, 1),
            "detail": {"http_status": r.status_code},
            "error": f"HTTP {r.status_code}",
        }
    except httpx.TimeoutException:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {},
            "error": "timeout",
        }
    except Exception as e:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {},
            "error": str(e),
        }


async def check_tcp(target: dict) -> dict:
    """TCP ポートが開いているかを確認 (プリンタ等)"""
    host = target["host"]
    port = target["port"]
    timeout = target.get("timeout_seconds", 3)
    start = time.perf_counter()
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        elapsed = (time.perf_counter() - start) * 1000
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {
            "id": target["id"],
            "status": "up",
            "latency_ms": round(elapsed, 1),
            "detail": {"host": host, "port": port},
            "error": None,
        }
    except (asyncio.TimeoutError, OSError) as e:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {"host": host, "port": port},
            "error": str(e) or "connection failed",
        }


async def check_ollama_proxy(target: dict) -> dict:
    """
    OllamaProxyMonitor の独自 API を叩いて、Proxy 自体と各バックエンドの状態を取得。
    detail.backends に各 Ollama エンドポイントの情報を入れる。
    """
    base = target["url"].rstrip("/")
    health_path = target.get("health_endpoint", "/api/health")
    backends_path = target.get("backends_endpoint", "/api/backends")
    timeout = target.get("timeout_seconds", 5)

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            # 並行で叩く
            health_task = client.get(f"{base}{health_path}")
            backends_task = client.get(f"{base}{backends_path}")
            health_r, backends_r = await asyncio.gather(
                health_task, backends_task, return_exceptions=True
            )
        elapsed = (time.perf_counter() - start) * 1000

        # Proxy 自体の死活
        if isinstance(health_r, Exception):
            return {
                "id": target["id"],
                "status": "down",
                "latency_ms": None,
                "detail": {"backends": []},
                "error": f"health endpoint failed: {health_r}",
            }
        if health_r.status_code >= 400:
            return {
                "id": target["id"],
                "status": "degraded",
                "latency_ms": round(elapsed, 1),
                "detail": {"backends": []},
                "error": f"health HTTP {health_r.status_code}",
            }

        # バックエンド一覧
        backends: list[dict] = []
        if not isinstance(backends_r, Exception) and backends_r.status_code < 400:
            try:
                data = backends_r.json()
                # Proxy 側で返してほしい形:
                # {"backends": [
                #    {"id": "rtx2080", "name": "Ollama @ RTX 2080", "url": "...",
                #     "status": "up", "latency_ms": 200, "models": ["llama3", ...]},
                #    ...
                # ]}
                backends = data.get("backends", [])
            except Exception:
                pass

        return {
            "id": target["id"],
            "status": "up",
            "latency_ms": round(elapsed, 1),
            "detail": {"backends": backends},
            "error": None,
        }
    except httpx.TimeoutException:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {"backends": []},
            "error": "timeout",
        }
    except Exception as e:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {"backends": []},
            "error": str(e),
        }


# ディスパッチテーブル
CHECKERS = {
    "docker": check_docker,
    "http": check_http,
    "tcp": check_tcp,
    "ollama_proxy": check_ollama_proxy,
}


async def check_target(target: dict) -> dict:
    fn = CHECKERS.get(target["type"])
    if fn is None:
        return {
            "id": target["id"],
            "status": "down",
            "latency_ms": None,
            "detail": {},
            "error": f"unknown type: {target['type']}",
        }
    return await fn(target)
