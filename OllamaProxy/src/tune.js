'use strict';

// Single-model tuning helpers used by Tester's "max num_ctx binary search".
// Two operations:
//   probeLoad — force a 1-token generate so Ollama loads the model with the
//               caller-supplied options (num_ctx / num_gpu / num_batch), then
//               read /api/ps once so the caller can compute offload_pct.
//   evict    — generate with keep_alive:0 to drop a model (or every model) out
//              of VRAM. Used to bracket each binary-search probe.
//
// Strictly additive: the proxy hot path, /api/benchmark, /api/tags aggregation,
// matrix CRUD and the existing /api/upstreams/:id/ollama/* admin routes are
// untouched. Calls are not written to the `requests` log (NFR-2: this is
// management traffic, not metered).

const axios = require('axios');

const DEFAULT_KEEP_ALIVE = '5m';
const DEFAULT_NUM_GPU = -1;
const DEFAULT_NUM_BATCH = 512;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;

function trimUrl(url) {
  return url.replace(/\/+$/, '');
}

function clampTimeout(ms) {
  const n = parseInt(ms, 10);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, n));
}

// Best-effort axios-error → printable message. Prefers Ollama's own error
// string when present; falls back to status / code / generic message.
function describeAxiosError(err) {
  if (err?.code === 'ECONNABORTED') return 'timeout';
  const status = err?.response?.status;
  const upstreamMsg = err?.response?.data?.error
    ?? (typeof err?.response?.data === 'string' ? err.response.data : null);
  if (status) {
    return `upstream returned ${status}${upstreamMsg ? `: ${upstreamMsg}` : ''}`;
  }
  return err?.code || err?.message || 'unknown error';
}

async function fetchPs(upstream, timeoutMs = 5000) {
  try {
    const res = await axios.get(`${trimUrl(upstream.url)}/api/ps`, {
      timeout: timeoutMs,
      validateStatus: s => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;
    return res.data ?? null;
  } catch {
    return null;
  }
}

function findModelEntry(ps, model) {
  if (!ps || !Array.isArray(ps.models)) return null;
  return ps.models.find(m => m?.name === model || m?.model === model) || null;
}

function offloadPct(entry) {
  if (!entry) return null;
  const size = Number(entry.size);
  const vram = Number(entry.size_vram);
  if (!Number.isFinite(size) || !Number.isFinite(vram) || size <= 0) return null;
  return vram / size;
}

async function probeLoad(upstream, body) {
  const model = body?.model;
  if (!model || typeof model !== 'string') {
    return { _httpStatus: 400, error: 'model is required', code: 'BAD_REQUEST' };
  }
  const opts = body?.options || {};
  if (!Number.isInteger(opts.num_ctx) || opts.num_ctx <= 0) {
    return { _httpStatus: 400, error: 'options.num_ctx (positive integer) is required', code: 'BAD_REQUEST' };
  }
  // keep_alive:0 collides with evict semantics — refuse it explicitly so a
  // mistyped probe-load can't silently drop the model out of VRAM.
  const keepAliveRaw = body?.keep_alive ?? DEFAULT_KEEP_ALIVE;
  if (keepAliveRaw === 0 || keepAliveRaw === '0' || keepAliveRaw === '0s') {
    return { _httpStatus: 400, error: 'keep_alive:0 is not allowed for probe-load (use /tune/evict)', code: 'BAD_REQUEST' };
  }
  const timeoutMs = clampTimeout(body?.timeout_ms);

  const generateBody = {
    model,
    prompt: 'hi',
    stream: false,
    keep_alive: keepAliveRaw,
    options: {
      num_ctx:     opts.num_ctx,
      num_gpu:     Number.isInteger(opts.num_gpu)   ? opts.num_gpu   : DEFAULT_NUM_GPU,
      num_batch:   Number.isInteger(opts.num_batch) ? opts.num_batch : DEFAULT_NUM_BATCH,
      num_predict: 1,
    },
  };

  const start = Date.now();
  let loaded = false;
  let loadMs = null;
  let errorMsg = null;

  try {
    await axios.post(
      `${trimUrl(upstream.url)}/api/generate`,
      generateBody,
      { timeout: timeoutMs, validateStatus: s => s >= 200 && s < 300 }
    );
    loaded = true;
    loadMs = Date.now() - start;
  } catch (err) {
    errorMsg = describeAxiosError(err);
  }

  // Always read ps — even on generate failure the caller wants to know what's
  // currently in VRAM so it can decide whether to update the upper bound.
  const ps = await fetchPs(upstream);
  const entry = findModelEntry(ps, model);
  const modelEntry = entry
    ? {
        name:        entry.name ?? entry.model ?? model,
        size:        entry.size ?? null,
        size_vram:   entry.size_vram ?? null,
        offload_pct: offloadPct(entry),
      }
    : null;

  return {
    _httpStatus: 200,
    loaded,
    load_ms:     loaded ? loadMs : null,
    ps,
    model_entry: modelEntry,
    error:       errorMsg,
  };
}

async function evictOne(upstream, model, timeoutMs = 30000) {
  try {
    await axios.post(
      `${trimUrl(upstream.url)}/api/generate`,
      { model, prompt: '', keep_alive: 0, stream: false },
      { timeout: timeoutMs, validateStatus: s => s >= 200 && s < 300 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAxiosError(err) };
  }
}

async function evict(upstream, body) {
  const explicit = body?.model;
  let targets;
  if (typeof explicit === 'string' && explicit.length > 0) {
    targets = [explicit];
  } else if (explicit !== undefined && typeof explicit !== 'string') {
    return { _httpStatus: 400, error: 'model must be a string when provided', code: 'BAD_REQUEST' };
  } else {
    const psBefore = await fetchPs(upstream);
    targets = (psBefore?.models || [])
      .map(m => m?.name || m?.model)
      .filter(Boolean);
  }

  const evicted = [];
  const errors = [];
  for (const m of targets) {
    const r = await evictOne(upstream, m);
    if (r.ok) evicted.push(m);
    else errors.push({ model: m, error: r.error });
  }

  const psAfter = await fetchPs(upstream);
  return { _httpStatus: 200, evicted, errors, ps_after: psAfter };
}

module.exports = { probeLoad, evict };
