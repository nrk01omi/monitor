'use strict';

// Uses Node.js built-in sqlite (available in Node >= 22.5, stable in Node >= 24)
// NOTE: In node:sqlite, named parameter binding keys do NOT include the sigil.
//   SQL: WHERE id = $id  →  stmt.all({ id: 1 })   (NOT { $id: 1 })
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'proxy.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    method          TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    request_headers TEXT,
    request_body    TEXT,
    response_status INTEGER,
    response_headers TEXT,
    response_body   TEXT,
    duration_ms     INTEGER,
    model           TEXT,
    is_streaming    INTEGER DEFAULT 0,
    error           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_model     ON requests(model);
  CREATE INDEX IF NOT EXISTS idx_requests_path      ON requests(path);

  CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
    request_body,
    response_body,
    content=requests,
    content_rowid=id,
    tokenize='unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS requests_ai AFTER INSERT ON requests BEGIN
    INSERT INTO requests_fts(rowid, request_body, response_body)
    VALUES (new.id, COALESCE(new.request_body, ''), COALESCE(new.response_body, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS requests_au AFTER UPDATE ON requests BEGIN
    INSERT INTO requests_fts(requests_fts, rowid, request_body, response_body)
    VALUES ('delete', old.id, COALESCE(old.request_body, ''), COALESCE(old.response_body, ''));
    INSERT INTO requests_fts(rowid, request_body, response_body)
    VALUES (new.id, COALESCE(new.request_body, ''), COALESCE(new.response_body, ''));
  END;

  CREATE TABLE IF NOT EXISTS system_metrics (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cpu_pct   REAL,
    mem_used  INTEGER,
    mem_total INTEGER,
    load_1    REAL,
    load_5    REAL,
    load_15   REAL,
    cpu_temp  REAL
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON system_metrics(timestamp DESC);

  CREATE TABLE IF NOT EXISTS upstreams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,
    url             TEXT    NOT NULL,
    protocol        TEXT    NOT NULL DEFAULT 'ollama',
    model_patterns  TEXT    NOT NULL DEFAULT '["*"]',
    priority        INTEGER NOT NULL DEFAULT 0,
    is_default      INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Partial unique index: at most one row may have is_default = 1
  CREATE UNIQUE INDEX IF NOT EXISTS ux_upstreams_default
    ON upstreams(is_default) WHERE is_default = 1;

  CREATE TABLE IF NOT EXISTS upstream_health (
    upstream_id   INTEGER PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE,
    status        TEXT    NOT NULL DEFAULT 'unknown',
    last_checked  TEXT,
    last_error    TEXT,
    latency_ms    INTEGER,
    models        TEXT
  );

  CREATE TABLE IF NOT EXISTS upstream_models (
    upstream_id  INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    model_name   TEXT    NOT NULL,
    priority     INTEGER NOT NULL DEFAULT 0,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (upstream_id, model_name)
  );

  CREATE INDEX IF NOT EXISTS idx_upstream_models_name ON upstream_models(model_name);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ── Infrastructure monitor tables ─────────────────────────────────────────
  -- A "target" is anything we periodically probe (docker container, http
  -- endpoint, tcp port). Ollama upstreams live in their own table and are
  -- surfaced as virtual nodes by the /api/monitor/status route.

  CREATE TABLE IF NOT EXISTS monitor_targets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,                 -- docker | http | tcp
    group_name  TEXT NOT NULL DEFAULT 'default',
    config      TEXT NOT NULL DEFAULT '{}',    -- JSON: url/container_name/host/port/timeout
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS monitor_edges (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id   TEXT NOT NULL,
    label   TEXT,
    UNIQUE(from_id, to_id)
  );

  -- Per-poll history. ts is unix seconds (matches the legacy Python schema
  -- so existing /api/history clients don't need to translate).
  CREATE TABLE IF NOT EXISTS checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    status      TEXT    NOT NULL,              -- up | degraded | down | unknown
    latency_ms  REAL,
    detail      TEXT,                          -- JSON
    error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_checks_target_ts ON checks(target_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_checks_ts        ON checks(ts);
`);

// Idempotent migrations for columns added after the table was first created.
// CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so we
// inspect PRAGMA table_info and ALTER TABLE only when missing.
(function migrate() {
  const hasColumn = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);

  if (!hasColumn('upstreams', 'protocol')) {
    db.exec("ALTER TABLE upstreams ADD COLUMN protocol TEXT NOT NULL DEFAULT 'ollama'");
  }
  if (!hasColumn('requests', 'upstream_name')) {
    db.exec('ALTER TABLE requests ADD COLUMN upstream_name TEXT');
  }
})();

const stmtInsert = db.prepare(`
  INSERT INTO requests (method, path, request_headers, request_body, model, is_streaming)
  VALUES ($method, $path, $request_headers, $request_body, $model, $is_streaming)
`);

const stmtUpdate = db.prepare(`
  UPDATE requests
  SET response_status  = $response_status,
      response_headers = $response_headers,
      response_body    = $response_body,
      duration_ms      = $duration_ms,
      error            = $error,
      upstream_name    = $upstream_name
  WHERE id = $id
`);

function insertRequest(data) {
  // Keys without sigil prefix per node:sqlite convention
  const result = stmtInsert.run({
    method:          data.method,
    path:            data.path,
    request_headers: data.request_headers,
    request_body:    data.request_body,
    model:           data.model,
    is_streaming:    data.is_streaming,
  });
  return result.lastInsertRowid;
}

function updateRequest(data) {
  stmtUpdate.run({
    id:               data.id,
    response_status:  data.response_status,
    response_headers: data.response_headers,
    response_body:    data.response_body,
    duration_ms:      data.duration_ms,
    error:            data.error,
    upstream_name:    data.upstream_name ?? null,
  });
}

// Dynamic query builder — uses positional ? params to avoid LIMIT/OFFSET named-param quirks
function getRequests({ search, model, reqPath, page = 1, limit = 50, dateFrom, dateTo } = {}) {
  const offset = (page - 1) * limit;
  const filters = [];
  const filterValues = [];

  if (model)    { filters.push('r.model = ?');       filterValues.push(model); }
  if (reqPath)  { filters.push('r.path LIKE ?');     filterValues.push(`%${reqPath}%`); }
  if (dateFrom) { filters.push('r.timestamp >= ?');  filterValues.push(dateFrom); }
  if (dateTo)   { filters.push('r.timestamp <= ?');  filterValues.push(dateTo); }

  const extraWhere = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const baseWhere  = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  let rows, total;

  if (search && search.trim()) {
    rows = db.prepare(`
      SELECT r.id, r.timestamp, r.method, r.path, r.response_status,
             r.duration_ms, r.model, r.is_streaming, r.error, r.upstream_name
      FROM requests r
      JOIN requests_fts ON requests_fts.rowid = r.id
      WHERE requests_fts MATCH ? ${extraWhere}
      ORDER BY r.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(search.trim(), ...filterValues, limit, offset);

    total = db.prepare(`
      SELECT COUNT(*) as count
      FROM requests r
      JOIN requests_fts ON requests_fts.rowid = r.id
      WHERE requests_fts MATCH ? ${extraWhere}
    `).get(search.trim(), ...filterValues).count;
  } else {
    rows = db.prepare(`
      SELECT id, timestamp, method, path, response_status,
             duration_ms, model, is_streaming, error, upstream_name
      FROM requests r
      ${baseWhere}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...filterValues, limit, offset);

    total = db.prepare(`
      SELECT COUNT(*) as count FROM requests r ${baseWhere}
    `).get(...filterValues).count;
  }

  return { rows, total, page, limit, pages: Math.ceil(total / limit) };
}

function getRequestById(id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

function getStats() {
  return {
    total:       db.prepare('SELECT COUNT(*) as c FROM requests').get().c,
    last1h:      db.prepare(`SELECT COUNT(*) as c FROM requests WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`).get().c,
    last24h:     db.prepare(`SELECT COUNT(*) as c FROM requests WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`).get().c,
    avgDuration: Math.round(db.prepare('SELECT AVG(duration_ms) as a FROM requests WHERE duration_ms IS NOT NULL').get().a || 0),
    models:      db.prepare('SELECT model, COUNT(*) as count FROM requests WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC LIMIT 10').all(),
    paths:       db.prepare('SELECT path, COUNT(*) as count FROM requests GROUP BY path ORDER BY count DESC LIMIT 10').all(),
    errors:      db.prepare('SELECT COUNT(*) as c FROM requests WHERE error IS NOT NULL').get().c,
  };
}

function getModels() {
  return db.prepare('SELECT DISTINCT model FROM requests WHERE model IS NOT NULL ORDER BY model').all().map(r => r.model);
}

// Sweep records left in-flight by a previous crash (no response_status, no error).
// Called once at startup so dangling rows surface as visible failures in the dashboard.
function markStalePendingAsCrashed() {
  const result = db.prepare(`
    UPDATE requests
    SET error = 'process exited before response was recorded'
    WHERE response_status IS NULL AND error IS NULL
  `).run();
  return result.changes;
}

const stmtInsertMetrics = db.prepare(`
  INSERT INTO system_metrics (cpu_pct, mem_used, mem_total, load_1, load_5, load_15, cpu_temp)
  VALUES ($cpu_pct, $mem_used, $mem_total, $load_1, $load_5, $load_15, $cpu_temp)
`);

function insertMetrics(data) {
  stmtInsertMetrics.run({
    cpu_pct:   data.cpu_pct,
    mem_used:  data.mem_used,
    mem_total: data.mem_total,
    load_1:    data.load_1,
    load_5:    data.load_5,
    load_15:   data.load_15,
    cpu_temp:  data.cpu_temp ?? null,
  });
}

function getLatestMetrics() {
  return db.prepare('SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1').get();
}

function getMetricsHistory(limit = 60) {
  // Return oldest-first so sparklines render left-to-right
  return db.prepare(`
    SELECT * FROM (
      SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT ?
    ) ORDER BY timestamp ASC
  `).all(limit);
}

// ── Upstreams ──

function listUpstreams() {
  return db.prepare(`
    SELECT u.*, h.status, h.last_checked, h.last_error, h.latency_ms, h.models
    FROM upstreams u
    LEFT JOIN upstream_health h ON h.upstream_id = u.id
    ORDER BY u.is_default DESC, u.priority DESC, u.id ASC
  `).all();
}

function getUpstreamById(id) {
  return db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id);
}

function insertUpstream(data) {
  db.exec('BEGIN');
  try {
    if (data.is_default) {
      db.prepare('UPDATE upstreams SET is_default = 0 WHERE is_default = 1').run();
    }
    const result = db.prepare(`
      INSERT INTO upstreams (name, url, protocol, model_patterns, priority, is_default, enabled)
      VALUES ($name, $url, $protocol, $model_patterns, $priority, $is_default, $enabled)
    `).run({
      name: data.name,
      url: data.url,
      protocol: data.protocol ?? 'ollama',
      model_patterns: data.model_patterns ?? '["*"]',
      priority: data.priority ?? 0,
      is_default: data.is_default ? 1 : 0,
      enabled: data.enabled === undefined ? 1 : (data.enabled ? 1 : 0),
    });
    db.exec('COMMIT');
    return result.lastInsertRowid;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function updateUpstream(id, data) {
  const existing = getUpstreamById(id);
  if (!existing) return false;
  db.exec('BEGIN');
  try {
    if (data.is_default && !existing.is_default) {
      db.prepare('UPDATE upstreams SET is_default = 0 WHERE is_default = 1').run();
    }
    db.prepare(`
      UPDATE upstreams
      SET name = $name, url = $url, protocol = $protocol,
          model_patterns = $model_patterns, priority = $priority,
          is_default = $is_default, enabled = $enabled
      WHERE id = $id
    `).run({
      id,
      name: data.name ?? existing.name,
      url: data.url ?? existing.url,
      protocol: data.protocol ?? existing.protocol ?? 'ollama',
      model_patterns: data.model_patterns ?? existing.model_patterns,
      priority: data.priority ?? existing.priority,
      is_default: (data.is_default ?? existing.is_default) ? 1 : 0,
      enabled: (data.enabled ?? existing.enabled) ? 1 : 0,
    });
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function deleteUpstream(id) {
  const r = db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);
  return r.changes > 0;
}

function countEnabledUpstreams() {
  return db.prepare('SELECT COUNT(*) as c FROM upstreams WHERE enabled = 1').get().c;
}

function upsertUpstreamHealth(upstreamId, data) {
  db.prepare(`
    INSERT INTO upstream_health (upstream_id, status, last_checked, last_error, latency_ms, models)
    VALUES ($upstream_id, $status, $last_checked, $last_error, $latency_ms, $models)
    ON CONFLICT(upstream_id) DO UPDATE SET
      status       = excluded.status,
      last_checked = excluded.last_checked,
      last_error   = excluded.last_error,
      latency_ms   = excluded.latency_ms,
      models       = excluded.models
  `).run({
    upstream_id: upstreamId,
    status: data.status,
    last_checked: data.last_checked ?? new Date().toISOString(),
    last_error: data.last_error ?? null,
    latency_ms: data.latency_ms ?? null,
    models: data.models ?? null,
  });
}

function getUpstreamHealth(upstreamId) {
  return db.prepare('SELECT * FROM upstream_health WHERE upstream_id = ?').get(upstreamId);
}

// ── Upstream model matrix ──
// Per-upstream registered models with priority used as tiebreaker when the
// same model is offered by multiple upstreams. enabled=0 excludes that
// upstream/model pair from routing.

function listUpstreamModels(upstreamId) {
  // Surface ranked rows (priority >= 1) first by ascending rank (1 wins),
  // then unranked rows alphabetically.
  return db.prepare(`
    SELECT upstream_id, model_name, priority, enabled, created_at
    FROM upstream_models
    WHERE upstream_id = ?
    ORDER BY (CASE WHEN priority >= 1 THEN 0 ELSE 1 END), priority ASC, model_name ASC
  `).all(upstreamId);
}

// All matrix rows joined across upstreams — used by the priority modal to
// render the cross-tab grid (rows = unique model names, cols = upstreams).
function listAllUpstreamModels() {
  return db.prepare(`
    SELECT upstream_id, model_name, priority, enabled
    FROM upstream_models
  `).all();
}

// Atomically set ranks for a single model across multiple upstreams.
// `ranks` = [{ upstream_id, priority }, ...]. Rows not listed are untouched.
// priority must be an integer >= 0; 0 means "excluded".
function setModelPriorities(modelName, ranks) {
  if (!modelName || !Array.isArray(ranks)) return 0;
  const upsert = db.prepare(`
    INSERT INTO upstream_models (upstream_id, model_name, priority, enabled)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(upstream_id, model_name) DO UPDATE SET priority = excluded.priority
  `);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of ranks) {
      const uid = parseInt(r.upstream_id, 10);
      const p   = parseInt(r.priority, 10);
      if (!Number.isInteger(uid) || !Number.isInteger(p) || p < 0) continue;
      upsert.run(uid, modelName, p);
      n++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function getUpstreamModel(upstreamId, modelName) {
  return db.prepare(`
    SELECT upstream_id, model_name, priority, enabled, created_at
    FROM upstream_models
    WHERE upstream_id = ? AND model_name = ?
  `).get(upstreamId, modelName);
}

function upsertUpstreamModel(upstreamId, modelName, { priority, enabled } = {}) {
  db.prepare(`
    INSERT INTO upstream_models (upstream_id, model_name, priority, enabled)
    VALUES ($upstream_id, $model_name, $priority, $enabled)
    ON CONFLICT(upstream_id, model_name) DO UPDATE SET
      priority = COALESCE($priority, upstream_models.priority),
      enabled  = COALESCE($enabled,  upstream_models.enabled)
  `).run({
    upstream_id: upstreamId,
    model_name:  modelName,
    priority:    priority ?? 0,
    enabled:     enabled === undefined ? 1 : (enabled ? 1 : 0),
  });
  return getUpstreamModel(upstreamId, modelName);
}

function deleteUpstreamModel(upstreamId, modelName) {
  const r = db.prepare(
    'DELETE FROM upstream_models WHERE upstream_id = ? AND model_name = ?'
  ).run(upstreamId, modelName);
  return r.changes > 0;
}

function bulkInsertUpstreamModels(upstreamId, names) {
  if (!Array.isArray(names) || names.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO upstream_models (upstream_id, model_name)
    VALUES (?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const name of names) {
      if (!name || typeof name !== 'string') continue;
      const r = stmt.run(upstreamId, name);
      inserted += r.changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

// ── Monitor targets / edges / checks ──

function listMonitorTargets() {
  return db.prepare(`
    SELECT id, name, type, group_name, config, enabled, created_at
    FROM monitor_targets
    ORDER BY group_name, id
  `).all();
}

function getMonitorTarget(id) {
  return db.prepare('SELECT * FROM monitor_targets WHERE id = ?').get(id);
}

function insertMonitorTarget(data) {
  db.prepare(`
    INSERT INTO monitor_targets (id, name, type, group_name, config, enabled)
    VALUES ($id, $name, $type, $group_name, $config, $enabled)
  `).run({
    id:         data.id,
    name:       data.name,
    type:       data.type,
    group_name: data.group_name ?? 'default',
    config:     typeof data.config === 'string' ? data.config : JSON.stringify(data.config ?? {}),
    enabled:    data.enabled === undefined ? 1 : (data.enabled ? 1 : 0),
  });
}

function updateMonitorTarget(id, data) {
  const existing = getMonitorTarget(id);
  if (!existing) return false;
  db.prepare(`
    UPDATE monitor_targets
    SET name       = $name,
        type       = $type,
        group_name = $group_name,
        config     = $config,
        enabled    = $enabled
    WHERE id = $id
  `).run({
    id,
    name:       data.name ?? existing.name,
    type:       data.type ?? existing.type,
    group_name: data.group_name ?? existing.group_name,
    config:     data.config !== undefined
                  ? (typeof data.config === 'string' ? data.config : JSON.stringify(data.config))
                  : existing.config,
    enabled:    (data.enabled ?? existing.enabled) ? 1 : 0,
  });
  return true;
}

function deleteMonitorTarget(id) {
  const r = db.prepare('DELETE FROM monitor_targets WHERE id = ?').run(id);
  // Cascade: drop edges referencing this id and history rows
  db.prepare('DELETE FROM monitor_edges WHERE from_id = ? OR to_id = ?').run(id, id);
  db.prepare('DELETE FROM checks WHERE target_id = ?').run(id);
  return r.changes > 0;
}

function countMonitorTargets() {
  return db.prepare('SELECT COUNT(*) AS c FROM monitor_targets').get().c;
}

function listMonitorEdges() {
  return db.prepare('SELECT id, from_id, to_id, label FROM monitor_edges ORDER BY id').all();
}

function insertMonitorEdge(data) {
  const r = db.prepare(`
    INSERT INTO monitor_edges (from_id, to_id, label)
    VALUES ($from_id, $to_id, $label)
    ON CONFLICT(from_id, to_id) DO UPDATE SET label = excluded.label
  `).run({
    from_id: data.from_id,
    to_id:   data.to_id,
    label:   data.label ?? null,
  });
  return r.lastInsertRowid;
}

function deleteMonitorEdge(id) {
  const r = db.prepare('DELETE FROM monitor_edges WHERE id = ?').run(id);
  return r.changes > 0;
}

const stmtInsertCheck = db.prepare(`
  INSERT INTO checks (target_id, ts, status, latency_ms, detail, error)
  VALUES ($target_id, $ts, $status, $latency_ms, $detail, $error)
`);

function insertCheck(data) {
  stmtInsertCheck.run({
    target_id:  data.target_id,
    ts:         data.ts ?? Math.floor(Date.now() / 1000),
    status:     data.status,
    latency_ms: data.latency_ms ?? null,
    detail:     typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? {}),
    error:      data.error ?? null,
  });
}

function getCheckHistory(targetId, sinceTs) {
  return db.prepare(`
    SELECT ts, status, latency_ms
    FROM checks
    WHERE target_id = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(targetId, sinceTs);
}

function cleanupOldChecks(cutoffTs) {
  const r = db.prepare('DELETE FROM checks WHERE ts < ?').run(cutoffTs);
  return r.changes;
}

// ── Archive iterators ──
// Used by archiver.js to stream rows older than a cutoff, table-by-table,
// in id-ascending order so we can DELETE WHERE id <= maxArchivedId safely
// without racing rows inserted concurrently.

function iterateRequestsBefore(cutoffIso) {
  return db.prepare(`
    SELECT * FROM requests
    WHERE timestamp < ?
    ORDER BY id ASC
  `).iterate(cutoffIso);
}

function deleteRequestsUpToId(maxId, cutoffIso) {
  const r = db.prepare(`
    DELETE FROM requests
    WHERE id <= ? AND timestamp < ?
  `).run(maxId, cutoffIso);
  return r.changes;
}

function iterateChecksBefore(cutoffTs) {
  return db.prepare(`
    SELECT id, target_id, ts, status, latency_ms, detail, error
    FROM checks
    WHERE ts < ?
    ORDER BY id ASC
  `).iterate(cutoffTs);
}

function deleteChecksUpToId(maxId, cutoffTs) {
  const r = db.prepare(`
    DELETE FROM checks
    WHERE id <= ? AND ts < ?
  `).run(maxId, cutoffTs);
  return r.changes;
}

function iterateMetricsBefore(cutoffIso) {
  return db.prepare(`
    SELECT id, timestamp, cpu_pct, mem_used, mem_total, load_1, load_5, load_15, cpu_temp
    FROM system_metrics
    WHERE timestamp < ?
    ORDER BY id ASC
  `).iterate(cutoffIso);
}

function deleteMetricsUpToId(maxId, cutoffIso) {
  const r = db.prepare(`
    DELETE FROM system_metrics
    WHERE id <= ? AND timestamp < ?
  `).run(maxId, cutoffIso);
  return r.changes;
}

// ── Settings (key/value) ──

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

module.exports = {
  insertRequest, updateRequest, getRequests, getRequestById, getStats, getModels,
  markStalePendingAsCrashed,
  insertMetrics, getLatestMetrics, getMetricsHistory,
  listUpstreams, getUpstreamById, insertUpstream, updateUpstream, deleteUpstream,
  countEnabledUpstreams, upsertUpstreamHealth, getUpstreamHealth,
  listUpstreamModels, getUpstreamModel, upsertUpstreamModel, deleteUpstreamModel,
  bulkInsertUpstreamModels, listAllUpstreamModels, setModelPriorities,
  listMonitorTargets, getMonitorTarget, insertMonitorTarget, updateMonitorTarget,
  deleteMonitorTarget, countMonitorTargets,
  listMonitorEdges, insertMonitorEdge, deleteMonitorEdge,
  insertCheck, getCheckHistory, cleanupOldChecks,
  iterateRequestsBefore, deleteRequestsUpToId,
  iterateChecksBefore,   deleteChecksUpToId,
  iterateMetricsBefore,  deleteMetricsUpToId,
  getAllSettings, getSetting, setSetting,
};
