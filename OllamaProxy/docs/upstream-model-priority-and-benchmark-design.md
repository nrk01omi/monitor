# Upstream モデル管理拡張 / 外部ベンチマーク API — 設計書

## Context

`c:\Apps\monitor` の OllamaProxy(Node.js + Express + SQLite)では現在、Upstream を追加する際に「優先モデル」の代わりに glob 形式の `model_patterns` を手入力する設計になっている。同一モデルが複数 Upstream で提供されるケースの優先制御は Upstream 単位の `priority` のみで、モデル単位での優先指定はできない。また、LLM 性能計測の機能は存在しない。

本変更では (1) AddUpstream フォームを Ollama から実モデル一覧を取得して選択する UX に刷新し、(2) Upstream × モデルのマトリクステーブルでモデル単位の優先順位を編集可能にし、(3) 外部システムから登録済み Upstream を指定して LLM 性能を計測できる REST API を追加する。既存のプロキシ動作・`/api/tags` 集約・ヘルスチェック動作は変更しない(完全に追加仕様)。

---

# Part 1. 要求・機能・構造設計書

## 1. 要求仕様(Requirements)

### 1.1 機能要求(FR)

| ID | 要求 | 優先度 |
|----|------|--------|
| FR-1 | AddUpstream 時、URL+protocol 入力後にボタン操作で Ollama 側の利用可能モデル一覧を取得できる | High |
| FR-2 | 取得したモデル一覧から複数選択して登録できる | High |
| FR-3 | モデル取得失敗時は手入力でフォールバック登録できる | Medium |
| FR-4 | Upstream ごとに「Upstream × モデル」マトリクスを編集できる(モデル追加/削除/優先度/有効化) | High |
| FR-5 | 同一モデルが複数 Upstream に存在する場合、モデル単位の優先度をルーティングのタイブレーカとして使用 | High |
| FR-6 | 外部から登録済み Upstream を指定して LLM ベンチマークを実行できる(REST API) | High |
| FR-7 | ベンチマークは複数回試行し、中央値・平均・最小・最大を返却 | High |
| FR-8 | 既存のプロキシ動作・`/api/tags` 集約・ヘルスチェック動作はそのまま維持 | Critical |

### 1.2 非機能要求(NFR)

| ID | 要求 |
|----|------|
| NFR-1 | 既存スキーマとの後方互換(model_patterns を残し空マトリクス時のフォールバックに使用) |
| NFR-2 | ヘルスプローブで自動発見されたモデルは優先度 0/有効で `upstream_models` に upsert(IGNORE)し、ユーザー編集を破壊しない |
| NFR-3 | ベンチマーク中もプロキシ通常動作を阻害しない(逐次実行・1コール 120 秒タイムアウト) |
| NFR-4 | 外部ベンチ API は登録済み Upstream のみを対象とする(SSRF 抑制) |
| NFR-5 | モデル名にコロン等を含むため URL エンコード必須 |

### 1.3 範囲外(Out of Scope)

- 任意 URL 直指定でのベンチマーク(将来の拡張余地として残す)
- 認証・トークンによる API 保護(既存ダッシュボードと同等の到達制御に従う)
- ベンチマーク結果の永続化(初版は同期レスポンスのみ)

---

## 2. 機能仕様(Functional Spec)

### 2.1 AddUpstream フォーム刷新

**現状**: `OllamaProxy/public/index.html:1090-1150` の連続 `prompt()` ダイアログ。
**変更**: HTML `<dialog>` ベースのフォームに置換。`commit e1d4ae3` のトポロジー側ペイン編集フォームと同じパターンを踏襲。

入力欄:
1. `name`(text)
2. `url`(text)
3. `protocol`(select: `ollama` / `openai`)
4. **「モデル取得」ボタン** — 1〜3 が入力済みのとき、`POST /api/upstreams/probe-models` を呼んで応答内のモデル名一覧を multi-select に展開
5. `priority`(number, Upstream 単位)
6. `is_default`(checkbox)
7. `enabled`(checkbox)
8. **モデル選択 multi-select** — 取得済みモデルから複数チェック
9. **手入力フォールバック `<textarea>`** — 取得失敗時に表示。改行区切りでモデル名を入力

送信フロー:
```
POST /api/upstreams        → upstream 作成、id 取得
POST /api/upstreams/:id/models { models: [...] }  → 選択モデルを matrix に一括登録
```

### 2.2 Upstream × モデル マトリクス編集 UI

Upstream リスト各行を `<details>` で展開し、その内側に編集テーブルを描画。

| 列 | 編集 | 説明 |
|----|------|------|
| `model_name` | × | 追加・削除のみ |
| `priority`   | ◯(数値) | 0 が最下位。タイブレーカで使用 |
| `enabled`    | ◯(チェックボックス) | 無効ならルーティング対象外 |
| ベンチマーク | ◯(ボタン) | 行単位で性能計測を起動 |
| 削除         | ◯(ボタン) | DELETE 呼び出し |

下部に `+モデル追加` ボタン: クリックで再度 probe-models を呼び、未登録のモデルだけを multi-select で追加。

### 2.3 ルーティング変更

`OllamaProxy/src/upstreams.js:84-101` の `resolveUpstream(model)` を以下に拡張:

```
1. enabled な Upstream のうち upstream_models に該当 model_name が enabled で存在するものを抽出
2. ソート順:
     a. upstream.priority DESC(既存・据置)
     b. upstream_models.priority DESC(新規・タイブレーカ)
     c. is_default 後ろ(既存・据置)
3. 1件以上ヒット → 先頭を返す
4. 0件 → 既存の model_patterns マッチング(matrix 空の Upstream のみ)にフォールバック
5. それでも 0件 → is_default の Upstream を返す
```

メモリキャッシュ: `cache.reload()` 時に各 Upstream の matrix も同時に読み込んで `u.matrix` として添付。ホットパスでの DB アクセスを回避。

### 2.4 ヘルスプローブとの同期

`OllamaProxy/src/health.js` の `probe()` 内、モデル抽出成功時に `INSERT OR IGNORE` で `upstream_models` に追記(priority=0, enabled=1)。**削除はしない** — Upstream 側で一時的に消えたモデルでもユーザー設定を破壊しないため。

### 2.5 外部ベンチマーク API

新規 `POST /api/benchmark`。リクエスト:
```json
{ "upstream_id": 1, "model": "qwen3:8b", "runs": 5, "prompt": "...", "timeout_ms": 120000 }
```

動作:
1. `upstream_id` から Upstream を解決(未登録なら 404)
2. protocol に応じて `/api/generate`(Ollama, stream)または `/v1/chat/completions`(OpenAI, 非 stream)を逐次 N 回呼び出し
3. 各回で `total_ms` / `ttft_ms`(Ollama のみ)/ `tokens_per_sec` を採取
4. 中央値・平均・最小・最大を集計して返却

---

## 3. 構造設計(Structural Design)

### 3.1 データモデル

#### 既存(変更なし)
- `upstreams`(id, name, url, protocol, model_patterns, priority, is_default, enabled, created_at)
- `upstream_health`(upstream_id, status, last_checked, last_error, latency_ms, models)

#### 新規テーブル: `upstream_models`

```sql
CREATE TABLE IF NOT EXISTS upstream_models (
  upstream_id  INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  model_name   TEXT    NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (upstream_id, model_name)
);
CREATE INDEX IF NOT EXISTS idx_upstream_models_name ON upstream_models(model_name);
```

`PRAGMA foreign_keys=ON` は db.js 既設(:19)で動作。`ON DELETE CASCADE` により Upstream 削除時に自動的に matrix 行も消える。`CREATE TABLE IF NOT EXISTS` で冪等のためマイグレーション不要。

### 3.2 モジュール構成

```
OllamaProxy/
├── src/
│   ├── db.js            ← upstream_models テーブル DDL + 5 つの新規関数
│   ├── upstreams.js     ← resolveUpstream() を matrix 対応に拡張
│   ├── health.js        ← probe() 終了時に matrix へ INSERT OR IGNORE
│   ├── dashboard.js     ← /api/upstreams/:id/models* と /api/benchmark を追加
│   ├── benchmark.js     ← 新規。runOne() / run() / summarize()
│   └── proxy.js         ← 変更なし
└── public/
    └── index.html       ← AddUpstream フォーム刷新 + マトリクス UI + ベンチ UI
```

### 3.3 db.js 追加関数

| 関数 | シグネチャ | 用途 |
|------|----------|------|
| `listUpstreamModels` | `(upstreamId) → row[]` | matrix 一覧。`ORDER BY priority DESC, model_name ASC` |
| `getUpstreamModel` | `(upstreamId, modelName) → row?` | resolveUpstream で 1 件参照 |
| `upsertUpstreamModel` | `(upstreamId, modelName, {priority, enabled}) → row` | INSERT … ON CONFLICT DO UPDATE |
| `deleteUpstreamModel` | `(upstreamId, modelName) → bool` | 1 件削除 |
| `bulkInsertUpstreamModels` | `(upstreamId, names[]) → int` | INSERT OR IGNORE をトランザクションで一括 |

### 3.4 ルーティング解決の擬似コード

```js
function resolveUpstream(model) {
  const enabled = getEnabled();
  if (!enabled.length) return null;
  if (model) {
    const hits = enabled
      .map(u => ({ u, m: u.matrix?.find(r => r.model_name === model && r.enabled) }))
      .filter(x => x.m)
      .sort((a, b) =>
        (b.u.priority - a.u.priority) ||
        (b.m.priority - a.m.priority) ||
        (a.u.is_default - b.u.is_default));
    if (hits.length) return hits[0].u;

    const patternHits = enabled
      .filter(u => (!u.matrix || u.matrix.length === 0) && patternsMatch(u.model_patterns, model))
      .sort(/* 既存と同等 */);
    if (patternHits.length) return patternHits[0];
  }
  return enabled.find(u => u.is_default) || null;
}
```

### 3.5 ベンチマーク実行構造

```js
// src/benchmark.js
async function runOne({ upstream, model, prompt, timeoutMs }) {
  // protocol に応じて Ollama stream / OpenAI 非 stream を呼び分け
  // 戻り値: { total_ms, ttft_ms, tokens_per_sec, eval_count }
}

async function run({ upstreamId, model, runs=5, prompt, timeoutMs=120000 }) {
  for (let i = 0; i < runs; i++) results.push(await runOne(...));  // 逐次
  return { runs: results, summary: summarize(results) };
}

function summarize(results) {
  // total_ms / ttft_ms / tokens_per_sec それぞれで median, mean, min, max
}
```

逐次実行(並列にしない)— 単独レスポンスタイムの実測が目的のため。

### 3.6 後方互換戦略

| 状態 | 動作 |
|------|------|
| 既存 Upstream(matrix 空、`model_patterns=["*"]` 等) | model_patterns でルーティング(従来動作) |
| 初回ヘルスプローブ後 | 発見モデルが matrix に自動登録(priority=0, enabled=1)。以降は matrix 優先 |
| ユーザーがマトリクス編集後 | matrix が真の優先度ソース。model_patterns はバックアップとして残置 |

### 3.7 シーケンス(参考)

```
[AddUpstream]
User → /api/upstreams/probe-models {url, protocol}  → return models[]
User submits form
User → /api/upstreams                                 → return {id}
User → /api/upstreams/:id/models {models:[...]}       → 一括登録

[Benchmark]
External → POST /api/benchmark {upstream_id, model, runs}
Server   → 逐次 N 回ジェネレート
Server   ← summary(median/mean/min/max)
```

---

# Part 2. API 仕様書(Single Spec)

すべての API は `application/json` を入出力。ベース URL は OllamaProxy ホスト(例: `http://localhost:3005`)。エラーは下記共通形式。

## 共通

### エラー形式

```json
{ "error": "human-readable message", "code": "OPTIONAL_MACHINE_CODE" }
```

### HTTP ステータス

| コード | 意味 |
|--------|------|
| 200 | 正常 |
| 201 | 作成 |
| 400 | リクエスト不正 |
| 404 | リソース未存在 |
| 409 | 一意制約違反 |
| 502 | Upstream 通信失敗 |
| 504 | Upstream タイムアウト |

---

## A. Upstream CRUD(既存・変更なし)

### A-1. `GET /api/upstreams`
全 Upstream 一覧(`upstream_health` JOIN 済)。

### A-2. `POST /api/upstreams`
リクエスト:
```json
{
  "name": "local-ollama",
  "url": "http://localhost:11434",
  "protocol": "ollama",
  "model_patterns": ["*"],
  "priority": 0,
  "is_default": false,
  "enabled": true
}
```

### A-3. `PUT /api/upstreams/:id`
部分更新。

### A-4. `DELETE /api/upstreams/:id`

### A-5. `POST /api/upstreams/:id/check`
即時ヘルスチェック実行。

---

## B. Upstream モデルマトリクス API(新規)

### B-1. `POST /api/upstreams/probe-models`

**用途**: AddUpstream フォーム上で Upstream 永続化前にモデル一覧を取得。

リクエスト:
```json
{ "url": "http://localhost:11434", "protocol": "ollama" }
```

レスポンス 200:
```json
{ "models": ["qwen3:8b", "llama3:latest", "..."] }
```

エラー: 502(到達不能)/ 504(タイムアウト 5s)/ 400(protocol 不正)。

### B-2. `GET /api/upstreams/:id/models`

レスポンス 200:
```json
[
  { "model_name": "qwen3:8b",      "priority": 10, "enabled": true,  "created_at": "..." },
  { "model_name": "llama3:latest", "priority": 0,  "enabled": true,  "created_at": "..." }
]
```

ソート: `priority DESC, model_name ASC`。

### B-3. `POST /api/upstreams/:id/models`

リクエスト(単一):
```json
{ "model_name": "qwen3:8b", "priority": 0, "enabled": true }
```

リクエスト(一括):
```json
{ "models": [
  { "model_name": "qwen3:8b",      "priority": 10 },
  { "model_name": "llama3:latest", "priority": 0  }
]}
```

レスポンス 201: 登録された行(配列)。重複はスキップ(`INSERT OR IGNORE`)。

### B-4. `PUT /api/upstreams/:id/models/:model_name`

`:model_name` は **URL エンコード必須**(例: `qwen3:8b` → `qwen3%3A8b`)。

リクエスト(部分更新):
```json
{ "priority": 20, "enabled": false }
```

レスポンス 200: 更新後の行。

### B-5. `DELETE /api/upstreams/:id/models/:model_name`

レスポンス 200: `{ "deleted": true }` または 404。

---

## C. 外部ベンチマーク API(新規)

### C-1. `POST /api/benchmark`

**用途**: 外部システムから登録済み Upstream + モデル指定で LLM 性能を計測。既存プロキシ・`/api/tags` 集約とは独立した追加仕様。

リクエスト:
```json
{
  "upstream_id": 1,
  "model": "qwen3:8b",
  "runs": 5,
  "prompt": "Say hello in one short sentence.",
  "timeout_ms": 120000
}
```

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|-----------|------|
| `upstream_id` | int | ◯ | - | 登録済み Upstream の ID |
| `model` | string | ◯ | - | モデル名(matrix 登録要否は問わない) |
| `runs` | int | × | 5 | 試行回数。1〜20 を許容 |
| `prompt` | string | × | `"Say hello in one short sentence."` | 共通プロンプト |
| `timeout_ms` | int | × | 120000 | 1 回あたりタイムアウト(ms) |

レスポンス 200:
```json
{
  "upstream_id": 1,
  "upstream_name": "local-ollama",
  "model": "qwen3:8b",
  "protocol": "ollama",
  "runs": [
    { "total_ms": 1820, "ttft_ms": 120, "tokens_per_sec": 42.7, "eval_count": 78 },
    { "total_ms": 1755, "ttft_ms":  98, "tokens_per_sec": 44.1, "eval_count": 77 },
    { "total_ms": 1810, "ttft_ms": 110, "tokens_per_sec": 43.0, "eval_count": 78 }
  ],
  "summary": {
    "total_ms":       { "median": 1810, "mean": 1795, "min": 1755, "max": 1820 },
    "ttft_ms":        { "median":  110, "mean":  109, "min":   98, "max":  120 },
    "tokens_per_sec": { "median": 43.0, "mean": 43.3, "min": 42.7, "max": 44.1 }
  }
}
```

エラー:
| ステータス | 条件 |
|-----------|------|
| 400 | `runs` が範囲外 / 必須欠落 / `model` 空 |
| 404 | `upstream_id` が未登録 |
| 502 | Upstream への接続失敗 |
| 504 | いずれかの run がタイムアウト超過 |

#### 計測方法

- **Ollama (`/api/generate`, `stream:true`)**:
  - `total_ms` = 開始 → 完了の wall-clock
  - `ttft_ms` = 最初のチャンク到着までの wall-clock
  - `tokens_per_sec` = `eval_count / (eval_duration / 1e9)`(Ollama レスポンスの公式値を使用)
  - `eval_count` = 出力トークン数(完了オブジェクトより)
- **OpenAI (`/v1/chat/completions`, 非 stream)**:
  - `total_ms` = wall-clock
  - `ttft_ms` = `null`(非 stream のため未取得)
  - `tokens_per_sec` = `usage.completion_tokens / (total_ms / 1000)`
  - `eval_count` = `usage.completion_tokens`

#### `summary` 計算

各メトリクス配列について `null` を除外し、`median`(偶数長は中央2値の平均)・`mean`・`min`・`max` を算出。サンプル数 0 の場合は対象メトリクスの値を `null`。

#### 実行モデル

逐次実行。途中の run が失敗した場合はその run を `error` フィールド付きで `runs[]` に保存し、残り run も実行する(部分結果でサマリ算出)。全 run 失敗時は 502/504 を返す。

```json
{ "error": "ECONNREFUSED", "total_ms": null, "ttft_ms": null, "tokens_per_sec": null }
```

#### 呼び出し例

```bash
curl -X POST http://localhost:3005/api/benchmark \
  -H 'content-type: application/json' \
  -d '{"upstream_id":1,"model":"qwen3:8b","runs":3}'
```

---

## D. 検証手順(End-to-End)

| # | 操作 | 期待 |
|---|------|------|
| 1 | `curl /api/upstreams` | 既存行が変化なく返る |
| 2 | `curl -X POST /api/upstreams/probe-models -d '{"url":"http://localhost:11434","protocol":"ollama"}'` | `{models:[...]}` |
| 3 | `curl /api/upstreams/1/models` | 初回は空、ヘルスプローブ後に自動登録された行が並ぶ |
| 4 | `curl -X PUT /api/upstreams/1/models/qwen3%3A8b -d '{"priority":10}'` | 更新後の行 |
| 5 | 同モデル複数 Upstream で model_priority 差をつけ、`/api/generate` を流して `requests.upstream_name` が高い側に固定されること | ルーティングの優先制御 |
| 6 | `curl -X POST /api/benchmark -d '{"upstream_id":1,"model":"qwen3:8b","runs":3}'` | `runs[3]` と `summary` が返る |
| 7 | ブラウザでダッシュボードを開き、AddUpstream モーダル → モデル取得 → multi-select 登録、行展開でマトリクス編集、行ベンチマーク実行 | UI が想定通り動く |

---

## E. 影響を受けるファイル

| ファイル | 変更内容 |
|---------|---------|
| `OllamaProxy/src/db.js` | `upstream_models` テーブル DDL、5 関数追加、export 拡張 |
| `OllamaProxy/src/upstreams.js` | `reload()` で matrix 同梱、`resolveUpstream()` 拡張 |
| `OllamaProxy/src/health.js` | `probe()` 成功時に matrix へ INSERT OR IGNORE |
| `OllamaProxy/src/dashboard.js` | B-1〜B-5、C-1 のルートを追加 |
| `OllamaProxy/src/benchmark.js` | **新規ファイル**。runOne / run / summarize |
| `OllamaProxy/public/index.html` | AddUpstream モーダル化、マトリクス UI、ベンチ UI |
