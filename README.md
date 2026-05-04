# Infrastructure Monitor

NAS / VM / プリンタ / Ollama バックエンドの死活監視 + Ollama リクエストプロキシを1つのアプリにまとめたもの。Node.js / Express / SQLite。

## 概要

```
クライアント (n8n, scan-worker, OpenClaw, ...)
      │
      ├── HTTP/Ollama  ──►  ollama-proxy:11435  ──┬──► Ollama @ RTX 5090
      │                                          ├──► Ollama @ RTX 2080
      │                                          └──► その他バックエンド
      │
      └── ブラウザ      ──►  ollama-proxy:3005   (ダッシュボード — 単一エントリ)
                                                  ├── /          Requests
                                                  ├── /topology  Topology
                                                  └── /archives  Archives
```

ダッシュボード(:3005)から:
- **Requests** — Ollama リクエスト/レスポンスのフルログ + フィルタ + FTS 検索 + Upstream CRUD + 設定
- **Topology** — Docker / HTTP / TCP / Ollama バックエンドの死活マップ(Cytoscape)、ノードクリックで応答時間グラフ(Chart.js)
- **Archives** — 30日より古い履歴を NDJSON.gz として書き出し、SQLite から削除

## デプロイ (NAS)

`OllamaProxy/` 配下を Portainer Stack または compose で起動:

```bash
cd OllamaProxy
docker compose up -d --build
```

[OllamaProxy/docker-compose.yml](OllamaProxy/docker-compose.yml) は次をマウント:
- `/var/run/docker.sock:ro` — Docker checker がコンテナ状態を読むため
- 名前付き volume `ollama-proxy-data` — SQLite DB / アーカイブ / ログ

`n8n_default` external network に参加する設定が入っているので、同じネットワーク上のコンテナ名で HTTP/Docker チェックできます。

### 初回起動時の seed

[OllamaProxy/seed/monitor.yaml](OllamaProxy/seed/monitor.yaml) が image にバンドル済み。`monitor_targets` テーブルが空のときに1回だけ流し込まれます。以降の編集は `/api/monitor/targets` CRUD またはダッシュボード経由。

## 環境変数 (主なもの)

[OllamaProxy/Dockerfile](OllamaProxy/Dockerfile) と [OllamaProxy/src/config.js](OllamaProxy/src/config.js) を参照:

| 変数 | 既定 | 用途 |
|---|---|---|
| `PROXY_PORT` | 11435 | Ollama 互換 listen ポート |
| `DASHBOARD_PORT` | 3005 | ダッシュボード listen ポート |
| `OLLAMA_HOST` | `host.docker.internal:11434` | 初回起動の default upstream |
| `HEALTH_INTERVAL_SECONDS` | 30 | upstream health probe 周期 |
| `MONITOR_POLL_SECONDS` | 10 | infra monitor の死活ポール周期 |
| `MONITOR_RETENTION_DAYS` | 7 | `checks` テーブルの保持日数 |
| `ARCHIVE_ENABLED` | 1 | 03:00 JST の自動アーカイブ |
| `ARCHIVE_RETENTION_DAYS` | 30 | これより古いものを NDJSON.gz に出力後 DELETE |
| `ARCHIVE_HOUR_JST` | 3 | アーカイブ実行時刻 (0..23) |

## API 早見表

### `/api` (proxy 経由)
Ollama 互換のパスはすべて自動ルーティング。`/api/tags` `/v1/models` は全 enabled upstream のモデルを集約。

### `/api/monitor/*` (Topology 用)
- `GET /api/monitor/status` — 全ノードの最新状態 (docker / http / tcp / ollama-proxy / ollama-backend-N を統合)
- `GET /api/monitor/topology` — DB 永続 edge + 合成 edge (proxy → backend)
- `GET /api/monitor/history/:target_id?hours=N` — 指定ターゲットの応答時間履歴
- `GET/POST /api/monitor/targets`、`PUT/DELETE /api/monitor/targets/:id`
- `GET/POST /api/monitor/edges`、`DELETE /api/monitor/edges/:id`

### `/api/archives/*`
- `GET /api/archives` — テーブル別の日別ファイル一覧
- `GET /api/archives/:table/:YYYY-MM-DD.ndjson.gz` — ダウンロード
- `POST /api/archives/run` — 即時実行

### その他
`GET /api/upstreams`、`GET /api/stats`、`GET /api/requests`、`GET /api/settings` — Requests 画面が利用。

## ローカル開発

```powershell
cd OllamaProxy
npm install
$env:MONITOR_POLL_SECONDS = "5"
$env:DOCKER_SOCKET = "//./pipe/docker_engine"   # Windows: Docker Desktop named pipe
npm start
```

`http://localhost:3005/` にアクセス。

## トラブルシュート

**Docker socket が読めない (`ENOENT`)**
コンテナに `/var/run/docker.sock:ro` が正しくマウントされているか確認。UGREEN/Synology は `docker.sock` の所有グループが特殊な場合があるので、必要なら `group_add` を追加。

**Topology で全部 down**
Compose が `n8n_default` network に参加しているか、`monitor_targets.config.url` がコンテナ名(=サービス名)になっているか。

**Archive が走らない**
`ARCHIVE_ENABLED=1` を確認。`POST /api/archives/run` でいつでも手動実行可能。`data/archive/` 配下にファイルが出ているか、`settings` テーブルの `archive_last_run_jst_date` を確認。

## ライセンス

Personal infra. 公開する場合は別途 LICENSE を追加してください。
