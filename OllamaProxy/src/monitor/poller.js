'use strict';

// Periodic monitor poller. Mirrors the structure of src/health.js but operates
// on the user-defined monitor_targets list plus the Ollama upstream cache.
//
// On each tick we:
//   1. Run all enabled monitor_targets in parallel (docker/http/tcp).
//   2. For every enabled upstream, derive a check row with target_id
//      `ollama-backend-${id}` from the upstream_health snapshot, so the
//      latency chart on the topology page works for backends too.
//   3. Synthesize an aggregate `ollama-proxy` check row.
//   4. Update _latest (used by /api/monitor/status) and INSERT into checks
//      (used by /api/monitor/history).
//   5. Hourly: delete rows older than retention_days.

const db = require('../db');
const targets = require('./targets');
const upstreams = require('../upstreams');
const { runChecker } = require('./checkers');

const POLL_SECONDS = Math.max(2, parseInt(process.env.MONITOR_POLL_SECONDS, 10) || 10);
const RETENTION_DAYS = Math.max(1, parseInt(process.env.MONITOR_RETENTION_DAYS, 10) || 7);

let timer = null;
let lastCleanup = 0;
const _latest = new Map();   // target_id → result + meta

function nowSec() { return Math.floor(Date.now() / 1000); }

function mapUpstreamStatus(s) {
  // upstream_health stores ok | error | unknown
  if (s === 'ok')    return 'up';
  if (s === 'error') return 'down';
  return 'unknown';
}

function aggregateProxyStatus(backendStatuses) {
  if (backendStatuses.length === 0) return 'unknown';
  if (backendStatuses.some(s => s === 'up')) return 'up';
  if (backendStatuses.every(s => s === 'unknown')) return 'unknown';
  if (backendStatuses.some(s => s === 'unknown')) return 'degraded';
  return 'down';
}

function buildOllamaSnapshot() {
  const enabled = upstreams.getEnabled();
  const backends = enabled.map(u => {
    let models = [];
    try { if (u.models) models = JSON.parse(u.models); } catch { /* ignore */ }
    const status = mapUpstreamStatus(u.status);
    return {
      id: `ollama-backend-${u.id}`,
      name: u.name,
      type: 'ollama_backend',
      group: 'llm-backend',
      status,
      latency_ms: u.latency_ms ?? null,
      error: u.last_error ?? null,
      detail: {
        url: u.url,
        models,
        parent: 'ollama-proxy',
        protocol: u.protocol,
      },
    };
  });
  const aggregate = {
    id: 'ollama-proxy',
    name: 'OllamaProxy',
    type: 'ollama_proxy',
    group: 'llm-proxy',
    status: aggregateProxyStatus(backends.map(b => b.status)),
    latency_ms: null,
    error: null,
    detail: { backend_count: backends.length },
  };
  return { aggregate, backends };
}

async function pollAll() {
  const ts = nowSec();
  const list = targets.listEnabledTargets();

  // 1) User-defined targets in parallel
  const settled = await Promise.allSettled(list.map(t => runChecker(t)));
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const s = settled[i];
    const result = s.status === 'fulfilled' ? s.value : {
      id: t.id, status: 'down', latency_ms: null, detail: {},
      error: `checker exception: ${s.reason?.message || s.reason}`,
    };
    const node = {
      ...result,
      name: t.name,
      type: t.type,
      group: t.group_name || 'default',
      last_checked: ts,
    };
    _latest.set(t.id, node);
    try {
      db.insertCheck({
        target_id:  t.id,
        ts,
        status:     result.status,
        latency_ms: result.latency_ms,
        detail:     result.detail || {},
        error:      result.error,
      });
    } catch (err) {
      console.error(`[Monitor]   insertCheck ${t.id}:`, err.message);
    }
  }

  // 2) + 3) Ollama snapshot — proxy aggregate + per-backend rows from cache
  const { aggregate, backends } = buildOllamaSnapshot();
  for (const node of [aggregate, ...backends]) {
    _latest.set(node.id, { ...node, last_checked: ts });
    try {
      db.insertCheck({
        target_id:  node.id,
        ts,
        status:     node.status,
        latency_ms: node.latency_ms,
        detail:     node.detail || {},
        error:      node.error,
      });
    } catch (err) {
      console.error(`[Monitor]   insertCheck ${node.id}:`, err.message);
    }
  }

  // 4) Periodic retention sweep (hourly is plenty)
  if (Date.now() - lastCleanup > 3600_000) {
    const cutoff = ts - RETENTION_DAYS * 86400;
    try {
      const removed = db.cleanupOldChecks(cutoff);
      if (removed > 0) console.log(`[Monitor]   Pruned ${removed} check rows older than ${RETENTION_DAYS}d`);
    } catch (err) {
      console.error('[Monitor]   cleanup error:', err.message);
    }
    lastCleanup = Date.now();
  }
}

function start() {
  if (timer) return;
  console.log(`[Monitor]   Polling ${targets.listEnabledTargets().length} target(s) every ${POLL_SECONDS}s, retention ${RETENTION_DAYS}d`);
  // Fire-and-forget initial poll so the UI has data quickly
  pollAll().catch(err => console.error('[Monitor]   initial poll error:', err));
  timer = setInterval(() => {
    pollAll().catch(err => console.error('[Monitor]   poll error:', err));
  }, POLL_SECONDS * 1000);

  // Re-poll immediately when targets change (CRUD via /api/monitor/targets)
  targets.on('changed', () => {
    pollAll().catch(err => console.error('[Monitor]   poll-after-reload error:', err));
  });
}

function getLatest() {
  return [..._latest.values()];
}

module.exports = { start, getLatest, buildOllamaSnapshot };
