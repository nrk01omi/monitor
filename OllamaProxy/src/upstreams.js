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
//   1. If model is given, find enabled upstreams whose patterns match.
//   2. Among matches, sort by priority DESC (explicit user control wins).
//      Tie-breaker: non-default before default — so a specific upstream wins
//      over a wildcard-default at equal priority, while a higher-priority
//      default still beats a lower-priority non-default.
//   3. If nothing matches and a default exists, return default.
//   4. Otherwise return null (caller emits 503).
function resolveUpstream(model) {
  const enabled = getEnabled();
  if (enabled.length === 0) return null;

  if (model) {
    const matches = enabled
      .filter(u => modelPatternsMatch(u.model_patterns, model))
      .sort((a, b) => {
        // Primary: higher priority wins (user's explicit control)
        if (b.priority !== a.priority) return b.priority - a.priority;
        // Tiebreaker: non-default before default
        return a.is_default - b.is_default;
      });
    if (matches.length > 0) return matches[0];
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
