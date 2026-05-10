# OllamaProxy ソケットリーク インシデントレポート

- **発生日**: 2026-05-10
- **対象**: `monitor` スタックの `ollama-proxy` コンテナ（NAS 192.168.0.198, Portainer 管理）
- **影響**: LAN 内で 60〜80 Mbps の不要トラフィック継続、Ollama (.196) が CPU を約4時間焼き続け
- **解消**: コンテナ restart で即時復旧
- **未解決**: 根本原因のコード修正（health.js のソケットリーク）

---

## 1. インシデント概要

OllamaProxy のログ出力に存在しないモデル `qwen3.5:9b` への "model not found" が大量に並んでいる、という報告から調査開始。最初は外部クライアントの retry storm を疑ったが、調査を進めるうち**外部クライアント不在のまま 73 Mbps の受信が続く**という矛盾に到達。最終的に **OllamaProxy 内部での TCP ソケットリーク** が真因であることが判明し、コンテナ restart で完全解消した。

---

## 2. タイムライン

| 時刻 (JST) | イベント |
|---|---|
| ~14:27 | 当日のコンテナ起動（後の検証で起点） |
| ~16:30 | ユーザが大量 "model not found" ログに気付く |
| ~16:40 | 当初仮説「外部クライアント (OpenClaw) からの retry storm」 |
| ~17:10 | DB に Host: `192.168.0.198:11435` を発見 → "OpenClaw が .198 から発信" と誤推定 |
| ~17:30 | 「OpenClaw VM 全停止」報告。にもかかわらず 9 Mbps → 61 Mbps へ送信増加 |
| ~17:40 | Windows 側 netstat で `ollama.exe` (PID 94596) が .198 へ 13本 ESTABLISHED を確認 |
| ~17:50 | Portainer 経由で `.198` のコンテナ一覧を取得：fail2ban / ollama-proxy / portainer の3つだけ。Dify・n8n・whisper-server は未稼働 |
| ~18:00 | コンテナ stats: **CPU 92% × 75min, RX 37GB, Write 27GB** |
| ~18:10 | コンテナ内 `ss` でクライアント接続 0、upstream 接続も snapshot 0 → 「内部の何かが暴走」と判断 |
| ~18:15 | benchmark.run runaway 仮説 → コードレビューで否定（MAX_RUNS=20、`requests` テーブルに書かない） |
| ~18:20 | `/api/ollama/pulls` = `[]` → モデル pull 暴走説も否定 |
| ~18:30 | `/proc/net/tcp` で **52本** の ESTABLISHED 確認、inode が **5秒間まったく不変** → リーク確定 |
| ~18:35 | 数学的整合：起動 75min ÷ health interval 180s × upstream 2 = **50本** ≒ 観測 52本 → health.js 起因仮説 |
| ~18:40 | コンテナ restart 実行 |
| ~18:42 | RX 73 Mbps → 約 700 bps、ESTABLISHED 52本 → 2本、完全鎮静 |

---

## 3. 調査の経緯：棄却された仮説

調査中に立てた仮説のうち、4つは証拠で否定された。学びは「最初の仮説に固執しない」「DB の `requests` 0件は『何も起きてない』ではなく『INSERT されてない』を意味する」。

| # | 仮説 | 棄却の根拠 |
|---|---|---|
| 1 | **外部クライアント (OpenClaw) の retry storm** | OpenClaw の VM 全停止後も 61 Mbps 継続。`Host: .198:11435` は宛先で発信元情報ではない |
| 2 | **Dify / n8n などのコンテナ** | Portainer の Containers 一覧で `.198` は fail2ban / ollama-proxy / portainer のみ。Dify 系・n8n は存在せず |
| 3 | **`benchmark.run()` の runaway** | [benchmark.js:262](../OllamaProxy/src/benchmark.js#L262) で `MAX_RUNS=20` clamp、[benchmark.js:289](../OllamaProxy/src/benchmark.js#L289) は逐次 `await` ループ、`insertRequest` 呼ばない |
| 4 | **モデル pull (`/api/upstreams/:id/ollama/pull`) stuck** | `GET /api/ollama/pulls` の戻りが `[]`（[ollama-admin.js:139-146](../OllamaProxy/src/ollama-admin.js#L139-L146) の `listActivePulls`） |

---

## 4. 決定的証拠：socket inode の不変性

### 4.1 観測コマンド

ollama-proxy コンテナ内で次を実行：

```sh
for i in 1 2 3; do
  date +%T
  awk '/:2CAA / && $4=="01"' /proc/net/tcp /proc/net/tcp6 \
    | awk '{print $10}' | sort -n | head -10
  echo "---"
  sleep 5
done
```

`:2CAA` は `:11434` の hex 表記、`$4=="01"` は ESTABLISHED 状態。

### 4.2 観測結果

```
T1 (07:39:30): 335413439 335413440 335418842 335418843 335472132 335472133 335484877 335484878 335499080 335499784
T2 (07:39:35): 335413439 335413440 335418842 335418843 335472132 335472133 335484877 335484878 335499080 335499784
                ↑ 完全一致
```

ソケット数は **52 本**、5 秒間 inode リスト完全一致。inode は単調増加するシステムリソースなので、新規ソケットなら新しい値になる。**古い inode が居続けている = リーク確定**。

### 4.3 数字の整合

| 指標 | 値 |
|---|---|
| コンテナ稼働時間 | 75 分 |
| Health interval (`config.health_interval_seconds`) | 180 秒 |
| Upstream 数 (.196:11434, .197:11434) | 2 |
| 想定 leak 数 = 75min ÷ 180s × 2 | **50 本** |
| 観測 ESTABLISHED 数 | **52 本** |

⇒ **health.js の axios.get(/api/tags) が 1 ポーリングごとに 1 ソケットずつ leak している**ことが計算上ほぼ確定。

---

## 5. 真因（仮説）

[OllamaProxy/src/health.js:43](../OllamaProxy/src/health.js#L43) の axios.get 呼び出し：

```js
const resp = await axios.get(`${upstream.url}${proto.listPath}`, {
  timeout: POLL_TIMEOUT_MS,
  validateStatus: s => s >= 200 && s < 500,
});
```

`/api/tags` は本来 1回返して終わる単発 GET だが、axios の default agent が `Connection: keep-alive` で接続を維持し、**Ollama 側がその接続上に何かを送り続ける挙動と組み合わさってソケットが解放されない**、というシナリオが最も整合する。

確定診断には次が必要（未実施）：

1. `/api/tags` を curl で叩いて Connection ヘッダ・Transfer-Encoding を確認
2. axios の httpAgent が default のとき keepAlive がどう設定されるか実機検証
3. `health.js` を `keepAlive: false` の Agent で書き換えて leak が消えるか A/B

---

## 6. 解消手順（実施済み）

### 6.1 即時対応

```
Portainer → Containers → ollama-proxy → Restart
```

DB は named volume `ollama-proxy-data` ([docker-compose.yml:14](../OllamaProxy/docker-compose.yml#L14)) に永続化されているため保持される。

### 6.2 解消結果

| 指標 | Before | After |
|---|---|---|
| `.196/.197:11434` への ESTABLISHED | 52 本 | 2 本（正常） |
| eth0 RX | 73 Mbps | ~700 bps |
| Windows ollama.exe → .198 接続 | 18 本 | 1 本 |
| ollama-proxy CPU | 92% | 数% |

完全鎮静を確認。

---

## 7. 対策案

### 7.1 短期対策（即〜数日）

| 対策 | 詳細 | 工数 |
|---|---|---|
| **再発検知ルール** | Windows タスクマネージャ → イーサネット → 送信が 10 Mbps 超で恒常的なら restart のサイン | 0 |
| **再発時プレイブック** | 後述 §9 を共有 | 0 |
| **Portainer API キー revoke** | 調査中にチャットへ漏れた `ptr_++eyalKhybRfLaBR7j0bmoPvfLNwRz6EoP2B3II29hg=` を Portainer → My account → Access tokens で失効 + 再発行 + monitor の `.env` 差し替え | 5分 |

### 7.2 中期対策（数日〜数週）

| 対策 | 詳細 | 工数 |
|---|---|---|
| **healthcheck 追加** | [docker-compose.yml](../OllamaProxy/docker-compose.yml) の `ollama-proxy` に `healthcheck:` を追加。`/api/stats` 応答 5秒超で unhealthy → `restart: unless-stopped` で自動復旧 | 30分 |
| **予防的 cron restart** | NAS 側で `0 4 * * * docker restart ollama-proxy`（毎朝 4時 JST）。1日 1回 restart で leak が実害になる前に解消 | 15分 |
| **接続数メトリクス** | proxy.js / dashboard に「現在の upstream ESTABLISHED 数」を `/api/stats` に追加。閾値超で alert | 1〜2時間 |

### 7.3 長期対策（コード修正）

| 対策 | ファイル | 工数 |
|---|---|---|
| **health.js の axios に明示的 Agent** | [health.js](../OllamaProxy/src/health.js) の `axios.get(...)` を `axios.get(url, { httpAgent: new http.Agent({ keepAlive: false }), ... })` に変更 | 30分 |
| **全 axios 呼び出しの review** | [proxy.js](../OllamaProxy/src/proxy.js), [ollama-admin.js](../OllamaProxy/src/ollama-admin.js), [tune.js](../OllamaProxy/src/tune.js), [benchmark.js](../OllamaProxy/src/benchmark.js) も同じ問題を持つ可能性。共通の axios インスタンスを導入し、全呼び出しで keepAlive を制御 | 2〜4時間 |
| **`req.socket.remoteAddress` を request_headers に保存** | [proxy.js:249](../OllamaProxy/src/proxy.js#L249) を 1行修正：`request_headers: JSON.stringify({ ...req.headers, _client_ip: req.socket.remoteAddress })`。今回の調査で犯人 IP が特定できなかった盲点を埋める | 15分 |
| **再現テスト** | `/api/tags` を 100回連打 → `/proc/net/tcp` の inode が累積するか測定する e2e テストを追加 | 1〜2時間 |

### 7.4 推奨実施順

1. **§7.1 全項目（特に API キー revoke）** ← 今すぐ
2. **§7.2 cron restart** ← 数日中（最も投資対効果が高い）
3. **§7.3 health.js patch + remoteAddress 修正** ← 別セッションで時間取って
4. **§7.3 全 axios review + 再現テスト** ← PR にしてリポジトリにマージ

---

## 8. 観測データ（数字の根拠）

### 8.1 OllamaProxy コンテナ stats（Portainer Container Statistics より）

| 指標 | 値 |
|---|---|
| CPU usage（持続） | ~92〜100% |
| Memory | ~120 MB |
| RX on eth0（累計） | 37 GB |
| TX on eth0（累計） | 1〜2 GB |
| I/O Write（累計） | 27 GB |
| 起動からの経過時間 | 1h 21min |

### 8.2 リクエスト DB の状態

```
last 1h: total=0, pending=0, completed=0, errored=0
全件: 直近のリクエストは ~4時間前
```

つまり **DB 上は完全に静止しているのに**、物理的なネットワーク使用量は 73 Mbps という乖離が問題発見の鍵。

### 8.3 解消直後の eth0 サンプリング

```
07:42:34  rx=4384  tx=7164
07:42:35  rx=4468  tx=7299    Δrx=84 bytes/s
07:42:36  rx=4555  tx=7439    Δrx=87 bytes/s
07:42:37  rx=4645  tx=7588    Δrx=90 bytes/s
```

≒ 700 bps、実質ゼロ。

---

## 9. 再発時プレイブック

### 9.1 検知

- Windows タスクマネージャ → パフォーマンス → イーサネット → 送信値を確認
- **10 Mbps 超** が恒常的に観測されたら再発サイン

### 9.2 即時診断（30秒）

ollama-proxy コンテナの Portainer console で：

```sh
# ESTABLISHED 接続数を確認
cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep ':2CAA ' | awk '$4=="01"' | wc -l
```

`>10` なら leak 確定。

### 9.3 復旧

```
Portainer → Containers → ollama-proxy → Restart
```

5秒で完了。DB は volume 永続化のため保持。

### 9.4 確認

```sh
# restart 直後（10秒後）
cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep ':2CAA ' | awk '$4=="01"' | wc -l
# → 0〜2 になれば成功
```

Windows 側でも送信値が 1 Mbps 以下に落ちることを確認。

---

## 10. 再利用可能な診断パターン

今回の調査で得られた、将来の類似インシデントで使えるパターン：

### 10.1 「DB ログ静止 vs 物理トラフィック高」の乖離

`requests` テーブル直近 N 分 = 0件 でも、コードパスによっては INSERT されないものが存在する：

- `health.js` の polling
- `monitor/poller.js` の checks
- `ollama-admin.js` の `passthroughJson` / `pull`
- `tune.js` の probe-load / evict
- `benchmark.js` の run

これらは **管理用通信なので requests に書かない**設計（`ollama-admin.js` 冒頭に明示コメントあり）。「DB に無いから動いていない」という推論は危険。

### 10.2 socket inode 不変性で leak vs 連続発火を切り分け

```sh
for i in 1 2 3; do
  awk '/:HEXPORT / && $4=="01"' /proc/net/tcp | awk '{print $10}' | sort -n
  echo ---
  sleep 5
done
```

- inode リスト **完全一致** が複数 snapshot 続く → **leak**（restart で復旧、再発の可能性は別途判定）
- inode リスト **入れ替わり続ける** → **連続発火**（restart しても再発、原因コード/外部 trigger を特定する必要）

### 10.3 コンテナと host の net namespace 二重視点

bridge network のコンテナでは：

- **container 内 `ss/netstat`** はコンテナ namespace のみを表示（NAT 後の host 視点は見えない）
- **host から `ss/netstat`** は SNAT 後のソケットを host 自身が発信したように表示

両方を取らないと「コンテナが innocent に見えるのに host で trace が出る」という錯覚に陥る。

---

## 11. References

- リポジトリ: <https://github.com/nrk01omi/monitor>
- 主要ファイル:
  - [`OllamaProxy/src/health.js`](../OllamaProxy/src/health.js) — leak 候補
  - [`OllamaProxy/src/proxy.js`](../OllamaProxy/src/proxy.js) — hot path、`req.socket.remoteAddress` 未保存
  - [`OllamaProxy/src/ollama-admin.js`](../OllamaProxy/src/ollama-admin.js) — `requests` 非記録経路
  - [`OllamaProxy/docker-compose.yml`](../OllamaProxy/docker-compose.yml) — healthcheck 追加対象
- 関連メモ:
  - `~/.claude/projects/.../memory/project_socket_leak.md`
  - `~/.claude/projects/.../memory/feedback_traffic_diagnostics.md`
  - `~/.claude/projects/.../memory/project_topology.md`
