# Monitor TODO

NASFileSearcher 側の whisper 対応に伴う Monitor リポでの追加作業。OllamaProxy 既存機能には触っていない。

> 連携元プロジェクト: https://github.com/nrk01omi/NASFileSearcher

---

## 今回の追加内容（参考）

| 変更 | ファイル |
|---|---|
| `whisper_url` 設定の追加（DB管理 + WHISPER_URL env） | [`OllamaProxy/src/config.js`](OllamaProxy/src/config.js) |
| `POST /api/transcribe` を whisper-server へ stream pass-through | [`OllamaProxy/src/proxy.js`](OllamaProxy/src/proxy.js) |
| whisper-server サービスを compose に追加（GPU 必要） | [`OllamaProxy/docker-compose.yml`](OllamaProxy/docker-compose.yml) |
| faster-whisper の薄い HTTP ラッパ | [`whisper-server/`](whisper-server/) |

---

## P0: 初回起動でつまずく可能性の高い項目

- [ ] **`nvidia-container-toolkit` が GPU ホストに入っているか確認**
  - 入っていない場合: 公式手順 https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
  - もしくは whisper-server を CPU で動かす（[whisper-server/README.md](whisper-server/README.md) 参照、Dockerfile base を `python:3.12-slim` に）
- [ ] **`large-v3-turbo` のモデルDLが完了するまで待つ必要あり**（初回起動時に約 1.5GB）
  - `docker compose logs -f whisper-server` で `model loaded` を確認
  - `whisper-cache` named volume にキャッシュされるので2回目以降は即起動
- [ ] **`docker-compose.yml` の networks**: whisper-server は `default` のみに参加させているが、ollama-proxy は `default` と `n8n_default` の両方。**ollama-proxy → whisper-server は `default` で通る**ので問題ないはずだが、本番環境で `default` の名前が衝突する場合は別名にする

## P1: スモークテスト

- [ ] whisper-server 単体疎通: `curl http://<gpu-host>:11436/health`
  ```json
  {"ok": true, "model": "large-v3-turbo", "device": "auto", "compute_type": "auto", "busy": false}
  ```
- [ ] OllamaProxy 経由疎通: `curl -F file=@sample.mp3 http://<gpu-host>:11435/api/transcribe`
- [ ] dashboard で `/api/transcribe` のリクエストログが見えること（[`OllamaProxy/src/proxy.js`](OllamaProxy/src/proxy.js) の finalize() で記録）
- [ ] 大ファイル（数百MB〜1GB）でメモリ消費が暴走しないこと（stream pass-through が効いている確認）

## P2: 設定 UI 追加

- [ ] 既存ダッシュボードに `whisper_url` 編集フィールドを追加
  - 場所: 設定パネル（[`OllamaProxy/src/dashboard.js`](OllamaProxy/src/dashboard.js)、[`OllamaProxy/public/`](OllamaProxy/public/)）
  - 値は `config.set('whisper_url', '...')` で保存される
- [ ] dashboard に whisper-server の health 表示（busy / model 名）

## P3: 機能拡張

- [ ] **複数の Whisper モデルをロード可能に**
  - 用途別に `tiny` (低レイテンシ用) と `large-v3-turbo` (高精度用) を切り替え
  - 案: whisper-server を 2インスタンス起動（11436 / 11437）して proxy 側で `model` form-data フィールドで振り分け
- [ ] **ジョブキュー化**: 現在は `asyncio.Lock` で直列処理だが、長尺ファイルが複数積まれた時の進捗が見えない
  - 案: 内部 SQLite で job 管理、`POST /api/transcribe` で job_id 返却、`GET /api/transcribe/{id}` で polling
- [ ] **WebSocket / SSE でストリーミング応答**
  - faster-whisper は segment 単位で出力できるので、進行中のテキストを逐次返すと UX 改善

## P4: 監視

- [ ] whisper-server を Monitor 自身の health-check 対象に登録
  - 既存の `health.js` / `monitor/poller.js` で `/health` をポーリング
- [ ] `busy=true` 時間の累計を metrics として記録（GPU稼働率の代替指標）

## P5: コード整備

- [ ] [`whisper-server/main.py`](whisper-server/main.py) の単体テスト（小さい音声 fixture で transcribe）
- [ ] OllamaProxy 側の `/api/transcribe` ハンドラを別ファイルに切り出して `proxy.js` を肥大化させない
  - 例: `OllamaProxy/src/transcribe-handler.js`
- [ ] CPU フォールバック用の Dockerfile を別ファイルとして用意（`Dockerfile.cpu`）
