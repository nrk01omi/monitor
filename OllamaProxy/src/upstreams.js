'use strict';

// In-memory cache of upstream rows + resolveUpstream(model) routing.
// Writers (dashboard CRUD) must call reload() after committing to refresh the
// cache and notify subscribers (health.js, proxy.js).

const EventEmitter = require('node:events');
const db = require('./db');

const emitter = new EventEmitter();
let cache = [];

function normalizeUrl(url) {
  return url.startsWith('http') ? url : `http://${url}`;
}

// Glob support: only `*` wildcard. Examples that match `qwen3.6:35b-a3b`:
//   *           → match all
//   qwen3.6:*   → prefix
//   *:35b-a3b   → suffix
//   qwen3.6:*-a3b → middle
function compilePattern(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function modelPatternsMatch(patternsJson, model) {
  if (!model) return false;
  let patterns;
  try {
    patterns = JSON.parse(patternsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(patterns)) return false;
  return patterns.some(p => compilePattern(p).test(model));
}

function reload() {
  cache = db.listUpstreams().map(u => ({
    ...u,
    url: normalizeUrl(u.url),
    // Attach the per-upstream model matrix so resolveUpstream() can read it
    // without hitting the DB on the hot path.
    matrix: db.listUpstreamModels(u.id),
  }));
  emitter.emit('changed', cache);
}

// Seed a row from OLLAMA_HOST env on first start (when table is empty)
function seedIfEmpty() {
  const existing = db.listUpstreams();
  if (existing.length > 0) return;

  const rawHost = process.env.OLLAMA_HOST || 'localhost:11434';
  db.insertUpstream({
    name: 'default',
    url: rawHost.startsWith('http') ? rawHost : `http://${rawHost}`,
    model_patterns: '["*"]',
    priority: 0,
    is_default: 1,
    enabled: 1,
  });
  console.log(`[Upstreams] Seeded default upstream from OLLAMA_HOST: ${rawHost}`);
}

function getAll() {
  return cache;
}

function getEnabled() {
  return cache.filter(u => u.enabled);
}

function getById(id) {
  return cache.find(u => u.id === id) || null;
}

// Routing rules:
//   1. Matrix match: enabled upstreams that have this model in upstream_models
//      with enabled=1. Sort by upstream.priority DESC, then matrix.priority
//      DESC (tiebreaker), then non-default before default.
//   2. Pattern fallback: for upstreams whose matrix is empty, fall back to the
//      legacy model_patterns glob match.
//   3. Otherwise return the default upstream, or null.
function resolveUpstream(model) {
  const enabled = getEnabled();
  if (enabled.length === 0) return null;

  if (model) {
    const matrixHits = enabled
      .map(u => {
        const row = (u.matrix || []).find(r => r.model_name === model && r.enabled);
        return row ? { u, mp: row.priority } : null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.u.priority !== a.u.priority) return b.u.priority - a.u.priority;
        if (b.mp !== a.mp) return b.mp - a.mp;
        return a.u.is_default - b.u.is_default;
      });
    if (matrixHits.length > 0) return matrixHits[0].u;

    const patternHits = enabled
      .filter(u => (!u.matrix || u.matrix.length === 0) && modelPatternsMatch(u.model_patterns, model))
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.is_default - b.is_default;
      });
    if (patternHits.length > 0) return patternHits[0];
  }

  return enabled.find(u => u.is_default) || null;
}

seedIfEmpty();
reload();

module.exports = {
  reload,
  getAll,
  getEnabled,
  getById,
  resolveUpstream,
  on:  (event, fn) => emitter.on(event, fn),
  off: (event, fn) => emitter.off(event, fn),
};
