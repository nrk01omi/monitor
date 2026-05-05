'use strict';

const express = require('express');
const path = require('path');
const db = require('./db');
const { getRequests, getRequestById, getStats, getModels,
        getLatestMetrics, getMetricsHistory } = db;
const config = require('./config');
const upstreams = require('./upstreams');
const health = require('./health');
const benchmark = require('./benchmark');
const ollamaAdmin = require('./ollama-admin');
const tune = require('./tune');
const monitorRoutes = require('./monitor/routes');
const archiver = require('./archiver');

const DASHBOARD_PORT = config.get('dashboard_port');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/requests', (req, res) => {
  const { search, model, path: reqPath, page, limit, dateFrom, dateTo } = req.query;
  try {
    const result = getRequests({
      search: search || '',
      model: model || '',
      reqPath: reqPath || '',
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
    });
    res.json(result);
  } catch (err) {
    console.error('[Dashboard] getRequests error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/requests/:id', (req, res) => {
  const record = getRequestById(parseInt(req.params.id, 10));
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

app.get('/api/stats', (_req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models', (_req, res) => {
  try {
    res.json(getModels());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/current', (_req, res) => {
  try { res.json(getLatestMetrics() ?? {}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/metrics/history', (req, res) => {
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 300) : 60;
  try { res.json(getMetricsHistory(limit)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Upstreams CRUD ──────────────────────────────────────────────────────────

app.get('/api/upstreams', (_req, res) => {
  try {
    res.json(upstreams.getAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_PROTOCOLS = ['ollama', 'openai'];

function validateUpstreamPayload(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (body.name !== undefined && typeof body.name !== 'string') return 'name must be string';
  if (body.url !== undefined && typeof body.url !== 'string') return 'url must be string';
  if (body.url !== undefined && !/^https?:\/\/.+|^[\w.-]+:\d+/.test(body.url)) {
    return 'url must look like http(s)://host[:port] or host:port';
  }
  if (body.protocol !== undefined && !VALID_PROTOCOLS.includes(body.protocol)) {
    return `protocol must be one of: ${VALID_PROTOCOLS.join(', ')}`;
  }
  if (body.model_patterns !== undefined) {
    if (!Array.isArray(body.model_patterns)) return 'model_patterns must be a JSON array';
    if (!body.model_patterns.every(p => typeof p === 'string' && p.length > 0)) {
      return 'model_patterns entries must be non-empty strings';
    }
  }
  if (body.priority !== undefined && !Number.isInteger(body.priority)) return 'priority must be integer';
  return null;
}

app.post('/api/upstreams', (req, res) => {
  const err = validateUpstreamPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!req.body.name || !req.body.url) return res.status(400).json({ error: 'name and url required' });
  try {
    const id = db.insertUpstream({
      name: req.body.name,
      url: req.body.url,
      protocol: req.body.protocol ?? 'ollama',
      model_patterns: JSON.stringify(req.body.model_patterns ?? ['*']),
      priority: req.body.priority ?? 0,
      is_default: req.body.is_default ? 1 : 0,
      enabled: req.body.enabled === undefined ? 1 : (req.body.enabled ? 1 : 0),
    });
    upstreams.reload();
    res.status(201).json(upstreams.getById(Number(id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/upstreams/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const err = validateUpstreamPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const data = { ...req.body };
    if (Array.isArray(data.model_patterns)) {
      data.model_patterns = JSON.stringify(data.model_patterns);
    }
    const ok = db.updateUpstream(id, data);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    upstreams.reload();
    res.json(upstreams.getById(id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/upstreams/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Refuse to delete the last enabled upstream so the proxy keeps working
  const remaining = upstreams.getEnabled().filter(u => u.id !== id);
  if (remaining.length === 0) {
    return res.status(409).json({ error: 'cannot delete the last enabled upstream' });
  }
  try {
    const ok = db.deleteUpstream(id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    upstreams.reload();
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/upstreams/:id/check', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const result = await health.checkOne(id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Upstream model matrix ──────────────────────────────────────────────────
// Ad-hoc probe used by the AddUpstream form before the upstream is persisted.
// Body: { url, protocol }. Returns { models: [...] }.
app.post('/api/upstreams/probe-models', async (req, res) => {
  const { url, protocol } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (protocol && !VALID_PROTOCOLS.includes(protocol)) {
    return res.status(400).json({ error: `protocol must be one of: ${VALID_PROTOCOLS.join(', ')}` });
  }
  try {
    const models = await health.probeModelsAdHoc({ url, protocol: protocol || 'ollama' });
    res.json({ models });
  } catch (e) {
    const status = e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '') ? 504 : 502;
    const msg = e.message || e.code || 'upstream unreachable';
    res.status(status).json({ error: msg, code: e.code });
  }
});

app.get('/api/upstreams/:id/models', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.getUpstreamById(id)) return res.status(404).json({ error: 'upstream not found' });
  try {
    const rows = db.listUpstreamModels(id).map(r => ({
      ...r,
      enabled: !!r.enabled,
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Accept either { model_name, priority?, enabled? } or { models: [{model_name, priority?, enabled?}, ...] }
app.post('/api/upstreams/:id/models', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.getUpstreamById(id)) return res.status(404).json({ error: 'upstream not found' });
  const body = req.body || {};
  try {
    let added = [];
    if (Array.isArray(body.models)) {
      for (const m of body.models) {
        if (!m || typeof m.model_name !== 'string' || !m.model_name) continue;
        added.push(db.upsertUpstreamModel(id, m.model_name, {
          priority: Number.isInteger(m.priority) ? m.priority : undefined,
          enabled:  m.enabled === undefined ? undefined : !!m.enabled,
        }));
      }
    } else if (typeof body.model_name === 'string' && body.model_name) {
      added.push(db.upsertUpstreamModel(id, body.model_name, {
        priority: Number.isInteger(body.priority) ? body.priority : undefined,
        enabled:  body.enabled === undefined ? undefined : !!body.enabled,
      }));
    } else {
      return res.status(400).json({ error: 'model_name or models[] required' });
    }
    upstreams.reload();
    res.status(201).json(added.map(r => ({ ...r, enabled: !!r.enabled })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/upstreams/:id/models/:model_name', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const modelName = req.params.model_name;
  if (!db.getUpstreamById(id)) return res.status(404).json({ error: 'upstream not found' });
  if (!db.getUpstreamModel(id, modelName)) return res.status(404).json({ error: 'model not registered for upstream' });
  const body = req.body || {};
  if (body.priority !== undefined && !Number.isInteger(body.priority)) {
    return res.status(400).json({ error: 'priority must be integer' });
  }
  try {
    const row = db.upsertUpstreamModel(id, modelName, {
      priority: Number.isInteger(body.priority) ? body.priority : undefined,
      enabled:  body.enabled === undefined ? undefined : !!body.enabled,
    });
    upstreams.reload();
    res.json({ ...row, enabled: !!row.enabled });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/upstreams/:id/models/:model_name', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const modelName = req.params.model_name;
  if (!db.getUpstreamById(id)) return res.status(404).json({ error: 'upstream not found' });
  try {
    const ok = db.deleteUpstreamModel(id, modelName);
    if (!ok) return res.status(404).json({ error: 'model not registered for upstream' });
    upstreams.reload();
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cross-tab grid for the priority editor: returns every matrix row across all
// upstreams. The frontend pivots this into rows=model_name, cols=upstream_id.
app.get('/api/upstream-models', (_req, res) => {
  try {
    const rows = db.listAllUpstreamModels().map(r => ({ ...r, enabled: !!r.enabled }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Atomically set priority ranks for a single model across multiple upstreams.
// Body: { model_name: string, ranks: [{ upstream_id, priority }, ...] }
// priority semantics: 1 = best, 2 = next, ..., 0 = excluded.
app.put('/api/model-priorities', (req, res) => {
  const body = req.body || {};
  const modelName = body.model_name;
  const ranks = body.ranks;
  if (!modelName || typeof modelName !== 'string') {
    return res.status(400).json({ error: 'model_name required' });
  }
  if (!Array.isArray(ranks)) {
    return res.status(400).json({ error: 'ranks must be an array' });
  }
  for (const r of ranks) {
    if (!Number.isInteger(r?.upstream_id) || !Number.isInteger(r?.priority) || r.priority < 0) {
      return res.status(400).json({ error: 'each rank requires integer upstream_id and priority >= 0' });
    }
  }
  try {
    const { updated, skipped } = db.setModelPriorities(modelName, ranks);
    upstreams.reload();
    res.json({ updated, skipped, model_name: modelName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Ollama admin (pull / delete / copy / show / ps / tags) ─────────────────
// Lets Tester drive model lifecycle on a registered Ollama upstream. OpenAI
// upstreams are out of scope and answered with PROTOCOL_UNSUPPORTED. None of
// these calls hit the `requests` log (NFR-5: management traffic, not metered).

function requireOllamaUpstream(req, res) {
  const u = upstreams.getById(parseInt(req.params.id, 10));
  if (!u) {
    res.status(404).json({ error: 'upstream not found' });
    return null;
  }
  if (u.protocol !== 'ollama') {
    res.status(400).json({
      error: 'ollama-only operation; this upstream uses openai protocol',
      code:  'PROTOCOL_UNSUPPORTED',
    });
    return null;
  }
  return u;
}

// D-1. POST /api/upstreams/:id/ollama/pull  → NDJSON stream of layer progress
app.post('/api/upstreams/:id/ollama/pull', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  const model = (req.body || {}).model;
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }
  await ollamaAdmin.pull({ upstream: u, model, clientReq: req, clientRes: res });
});

// D-2. DELETE /api/upstreams/:id/ollama/model  → delete model on upstream
//      (matrix row is intentionally preserved; mirrors health probe policy)
app.delete('/api/upstreams/:id/ollama/model', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  const model = (req.body || {}).model;
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }
  try {
    const r = await ollamaAdmin.passthroughJson({
      upstream: u, opPath: '/api/delete', method: 'DELETE', body: { name: model },
    });
    if (r.status >= 200 && r.status < 300) {
      res.status(200).json(r.payload ?? { ok: true });
    } else {
      res.status(r.status).json(r.payload ?? { error: `upstream returned ${r.status}` });
    }
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
  }
});

// D-3. POST /api/upstreams/:id/ollama/copy  → duplicate a model on upstream
app.post('/api/upstreams/:id/ollama/copy', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  const { source, destination } = req.body || {};
  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required' });
  }
  try {
    const r = await ollamaAdmin.passthroughJson({
      upstream: u, opPath: '/api/copy', body: { source, destination },
    });
    if (r.status >= 200 && r.status < 300) {
      try {
        db.upsertUpstreamModel(u.id, destination, { priority: 0, enabled: 1 });
        upstreams.reload();
      } catch (e) {
        console.error('[OllamaAdmin] copy upsert failed:', e.message);
      }
      res.status(200).json(r.payload ?? { ok: true });
    } else {
      res.status(r.status).json(r.payload ?? { error: `upstream returned ${r.status}` });
    }
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
  }
});

// D-4. POST /api/upstreams/:id/ollama/show  → model details (ctx, params, ...)
app.post('/api/upstreams/:id/ollama/show', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  const model = (req.body || {}).model;
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }
  try {
    const r = await ollamaAdmin.passthroughJson({
      upstream: u, opPath: '/api/show', body: { name: model },
    });
    res.status(r.status).json(r.payload);
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
  }
});

// D-5. GET /api/upstreams/:id/ollama/ps  → currently-loaded models on upstream
app.get('/api/upstreams/:id/ollama/ps', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  try {
    const r = await ollamaAdmin.passthroughJson({
      upstream: u, opPath: '/api/ps', method: 'GET',
    });
    res.status(r.status).json(r.payload);
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
  }
});

// D-6. GET /api/upstreams/:id/ollama/tags  → immediate /api/tags refresh
app.get('/api/upstreams/:id/ollama/tags', async (req, res) => {
  const u = requireOllamaUpstream(req, res); if (!u) return;
  try {
    const r = await ollamaAdmin.passthroughJson({
      upstream: u, opPath: '/api/tags', method: 'GET',
    });
    res.status(r.status).json(r.payload);
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
  }
});

// D-7. GET /api/ollama/pulls  → cross-upstream view of in-flight pulls
app.get('/api/ollama/pulls', (_req, res) => {
  res.json(ollamaAdmin.listActivePulls());
});

// ── Tune: probe-load / evict ────────────────────────────────────────────────
// Used by Tester's "max num_ctx binary search". probe-load forces a 1-token
// generate so Ollama loads the model with the requested options, then reads
// /api/ps so the caller can compute offload_pct in a single round-trip.
// evict drops a model (or all models) from VRAM via keep_alive:0. Generate
// failures are returned as HTTP 200 + error so the caller can treat them as
// "upper bound found" rather than dying on a 5xx.

function requireTuneUpstream(req, res) {
  const u = upstreams.getById(parseInt(req.params.id, 10));
  if (!u) {
    res.status(404).json({ error: 'upstream not found', code: 'UPSTREAM_NOT_FOUND' });
    return null;
  }
  if (!u.enabled) {
    res.status(409).json({
      error: `upstream "${u.name}" is disabled`,
      code:  'UPSTREAM_DISABLED',
    });
    return null;
  }
  if (u.protocol !== 'ollama') {
    res.status(400).json({
      error: 'tune endpoints require an ollama upstream',
      code:  'PROTOCOL_NOT_OLLAMA',
    });
    return null;
  }
  if (u.status === 'error') {
    res.status(502).json({
      error: `upstream "${u.name}" is offline (${u.last_error || 'unreachable'})`,
      code:  'UPSTREAM_OFFLINE',
    });
    return null;
  }
  return u;
}

function sendTuneResult(res, result) {
  const status = result._httpStatus ?? 200;
  // Strip the internal status flag before serialising.
  const { _httpStatus, ...payload } = result; // eslint-disable-line no-unused-vars
  res.status(status).json(payload);
}

app.post('/api/upstreams/:id/tune/probe-load', async (req, res) => {
  const u = requireTuneUpstream(req, res); if (!u) return;
  try {
    const result = await tune.probeLoad(u, req.body || {});
    sendTuneResult(res, result);
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'MONITOR_ERROR' });
  }
});

app.post('/api/upstreams/:id/tune/evict', async (req, res) => {
  const u = requireTuneUpstream(req, res); if (!u) return;
  try {
    const result = await tune.evict(u, req.body || {});
    sendTuneResult(res, result);
  } catch (err) {
    res.status(502).json({ error: err.message, code: 'MONITOR_ERROR' });
  }
});

// ── External LLM benchmark ─────────────────────────────────────────────────
// POST /api/benchmark
// Body: { upstream_id, model, runs?, prompt?, timeout_ms?,
//         options?, system?, thinking?, reasoning_effort?, record_options? }
// Limited to registered upstreams (SSRF mitigation, see NFR-4).
app.post('/api/benchmark', async (req, res) => {
  const body = req.body || {};
  if (body.thinking != null && !['auto', 'on', 'off'].includes(body.thinking)) {
    return res.status(400).json({ error: "thinking must be 'auto'|'on'|'off'" });
  }
  if (body.reasoning_effort != null && !['low', 'medium', 'high'].includes(body.reasoning_effort)) {
    return res.status(400).json({ error: "reasoning_effort must be 'low'|'medium'|'high'" });
  }
  if (body.options !== undefined && (body.options === null || typeof body.options !== 'object' || Array.isArray(body.options))) {
    return res.status(400).json({ error: 'options must be an object' });
  }
  if (body.system !== undefined && typeof body.system !== 'string') {
    return res.status(400).json({ error: 'system must be a string' });
  }
  try {
    const result = await benchmark.run({
      upstream_id:      Number.isInteger(body.upstream_id) ? body.upstream_id : parseInt(body.upstream_id, 10),
      model:            body.model,
      runs:             body.runs,
      prompt:           body.prompt,
      timeout_ms:       body.timeout_ms,
      options:          body.options,
      system:           body.system,
      thinking:         body.thinking,
      reasoning_effort: body.reasoning_effort,
      record_options:   !!body.record_options,
    });
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    const payload = { error: e.message };
    if (e.runs) payload.runs = e.runs;
    res.status(status).json(payload);
  }
});

// ── Settings ────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(config.getAll());
});

app.put('/api/settings', (req, res) => {
  const allowedKeys = ['proxy_port', 'dashboard_port', 'health_interval_seconds'];
  const restartRequired = ['proxy_port', 'dashboard_port'];
  const incoming = req.body || {};
  let needsRestart = false;
  try {
    for (const key of Object.keys(incoming)) {
      if (!allowedKeys.includes(key)) continue;
      const value = incoming[key];
      if (value === undefined || value === null || value === '') continue;
      const numeric = parseInt(value, 10);
      if (Number.isNaN(numeric) || numeric < 1) {
        return res.status(400).json({ error: `${key} must be a positive integer` });
      }
      if (restartRequired.includes(key) && config.get(key) !== numeric) {
        needsRestart = true;
      }
      config.set(key, numeric);
    }
    res.json({ settings: config.getAll(), needsRestart });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Trigger a graceful exit so the supervisor (Docker / pm2) brings the process
// back up with the new port settings. The 1.5 s delay lets the JSON response
// flush before we drop the socket.
app.post('/api/restart', (_req, res) => {
  res.json({ restartIn: 1500 });
  setTimeout(() => {
    console.warn('[Server]    Restart requested — exiting in 1.5s');
    process.exit(0);
  }, 1500);
});

// Infrastructure monitor (topology page + its API)
app.use('/api/monitor', monitorRoutes);
app.get('/topology', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'topology.html'));
});

// Archives — list + download per-day NDJSON.gz files, plus an on-demand trigger.
app.get('/archives', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'archives.html'));
});

app.get('/api/archives', (_req, res) => {
  res.json(archiver.listArchives());
});

app.get('/api/archives/:table/:filename', (req, res) => {
  const full = archiver.archiveFilePath(req.params.table, req.params.filename);
  if (!full) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}-${req.params.filename}"`);
  res.sendFile(full);
});

app.post('/api/archives/run', async (_req, res) => {
  try {
    const result = await archiver.runArchive();
    if (result === null) return res.status(409).json({ error: 'archive already running' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function startListening(port, fallbackEnv, hardDefault) {
  const server = app.listen(port, () => {
    console.log(`[Dashboard] Listening on http://localhost:${port}`);
  });
  server.on('error', (err) => {
    const envPort = parseInt(process.env[fallbackEnv] || '', 10);
    if (port !== envPort && Number.isInteger(envPort) && envPort > 0) {
      console.error(`[Dashboard] listen on ${port} failed (${err.code}); falling back to env ${fallbackEnv}=${envPort}`);
      startListening(envPort, fallbackEnv, hardDefault);
    } else if (port !== hardDefault) {
      console.error(`[Dashboard] listen on ${port} failed (${err.code}); falling back to default ${hardDefault}`);
      startListening(hardDefault, fallbackEnv, hardDefault);
    } else {
      console.error('[Dashboard] all fallback ports failed:', err);
      process.exit(1);
    }
  });
}

startListening(DASHBOARD_PORT, 'DASHBOARD_PORT', 3005);

module.exports = app;
