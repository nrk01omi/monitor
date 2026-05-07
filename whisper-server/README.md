# whisper-server

faster-whisper の薄い HTTP ラッパ。Monitor/OllamaProxy の `/api/transcribe` がここに stream pass-through する想定。

## 仕様

```http
POST /api/transcribe
Content-Type: multipart/form-data

file:             <音声/動画ファイル>   (必須)
language:         ja                     (任意。省略時は自動判定)
vad_filter:       true                   (任意。無音区間スキップ)
word_timestamps:  false                  (任意)
beam_size:        5                      (任意)
```

レスポンス:

```json
{
  "text": "...",
  "language": "ja",
  "language_probability": 0.98,
  "duration": 1834.2,
  "segments": [{ "start": 0.0, "end": 5.2, "text": "..." }]
}
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `WHISPER_MODEL` | `large-v3-turbo` | faster-whisper のモデル名 |
| `WHISPER_DEVICE` | `auto` | `auto` / `cuda` / `cpu` |
| `WHISPER_COMPUTE_TYPE` | `auto` | `float16` / `int8` / `int8_float16` 等 |

## 同時実行性

faster-whisper はマルチスレッド推論で確定動作しないため、サーバ内 `asyncio.Lock` で **1リクエストずつ直列処理** する。並列化したい場合は別コンテナを別ポートで立てる方針。

## CPU で動かす場合

`Dockerfile` の base を `python:3.12-slim` に変えて、`docker-compose.yml` の `deploy.resources.reservations.devices` ブロックを削除すれば CPU でも起動できる（速度は10〜20倍遅くなる）。
