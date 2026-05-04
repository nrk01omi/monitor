# Infrastructure Monitor

NAS / VM / OllamaProxyMonitor / Ollama バックエンド / Canon プリンタの死活監視 + トポロジー可視化。

## 構成

```
クライアント (scan-worker, n8n, OpenClaw)
         │
         ▼
OllamaProxyMonitor  ──┬──► Ollama @ RTX 2080
                     ├──► Ollama @ RTX 5090
                     └──► Ollama @ MacBook M5
```

監視ツールは OllamaProxyMonitor の `/api/backends` を一回叩くだけで
バックエンド3台の状態をまとめて取得する設計。

## ディレクトリ構成 (NAS 上)

```
/volume2/docker/monitor/
├── docker-compose.yml
├── config.yaml
├── api/                        # FastAPI バックエンド
├── web/                        # 静的フロント
├── proxy-additions/            # OllamaProxyMonitor 側に追加するコード
└── data/                       # SQLite (自動生成)
```

## セットアップ手順

### 1. ファイル配置

`/volume2/docker/monitor/` にすべてコピー。

### 2. config.yaml の調整

- `targets[].container_name` を実際のコンテナ名に合わせる
- `targets[].url` の IP/ホスト名を確認
- `ollama-proxy` の URL は `http://ollama-proxy:9000` のように **Docker network 内のサービス名** で書く
  (Proxy も `n8n_default` ネットワークに参加していること)

### 3. OllamaProxyMonitor 側に API を追加

`proxy-additions/proxy_monitor_endpoints.py` を参考に、Proxy アプリに以下を組み込む:

```python
from proxy_monitor_endpoints import router as monitor_router
app.include_router(monitor_router)
```

`BACKENDS` リストは Proxy が既に持っているルーティング設定から取るように書き換える。

### 4. Portainer Stack に登録

1. Portainer → Stacks → Add stack
2. Name: `monitor`
3. Build method: **Repository** または **Web editor** で `docker-compose.yml` をペースト
4. Deploy the stack

### 5. アクセス

- フロント: `http://<NAS IP>:8766`
- API 直接: `http://<NAS IP>:8765/api/status`

## 監視対象の追加方法

`config.yaml` の `targets:` に追記して Stack を redeploy するだけ。
コードは触らなくていい。

| type | 用途 | 必要フィールド |
|------|------|--------------|
| `docker` | NAS 上の Docker コンテナ | `container_name` |
| `http` | HTTP ヘルスエンドポイント | `url`, `timeout_seconds` |
| `tcp` | TCP ポートが開いているか | `host`, `port` |
| `ollama_proxy` | OllamaProxyMonitor 専用 | `url`, `backends_endpoint`, `health_endpoint` |

## トラブルシュート

### Docker socket にアクセスできない
UGREEN の特殊な権限の関係で、socket マウントが効かないことがある。
`docker.sock` が `root:docker` ではなく `root:root` のままだと、
コンテナ内から読めない可能性がある。

確認: `ls -l /var/run/docker.sock`

### OllamaProxyMonitor に到達できない
- Proxy が `n8n_default` ネットワークに参加しているか
- `config.yaml` の URL がコンテナ名 (= サービス名) になっているか

### グラフが空
SQLite に履歴が溜まるまで数十秒かかる。最初の数チェック分待つ。
