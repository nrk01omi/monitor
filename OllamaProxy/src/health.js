'use strict';

// Periodic health poller for all enabled upstreams.
// - Pings GET <url>/api/tags with a short timeout.
// - Writes status, latency, and the model list back to upstream_health.
// - Restarts its interval whenever the upstreams list or interval setting changes,
//   so writes from the dashboard take effect immediately.
// - Triggers an immediate poll on every restart so newly-added upstreams light up
//   without waiting for the next tick.

const axios = require('axios');
const db = require('./db');
const config = require('./config');
const upstreams = require('./upstreams');

const POLL_TIMEOUT_MS = 5000;

let timer = null;

// Per-protocol info: which path to probe and how to extract the model list.
// Keep extractors lenient — different versions / forks return slightly different shapes.
const PROTOCOLS = {
  ollama: {
    listPath: '/api/tags',
    extractModels: data =>
      Array.isArray(data?.models) ? data.models.map(m => m.name || m.model).filter(Boolean) : [],
  },
  openai: {
    listPath: '/v1/models',
    extractModels: data =>
      Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [],
  },
};

function protocolFor(upstream) {
  return PROTOCOLS[upstream.protocol] || PROTOCOLS.ollama;
}

async function probe(upstream) {
  const start = Date.now();
  const proto = protocolFor(upstream);
  try {
    const resp = await axios.get(`${upstream.url}${proto.listPath}`, {
      timeout: POLL_TIMEOUT_MS,
      validateStatus: s => s >= 200 && s < 500,
    });
    const latency = Date.now() - start;
    const models = proto.extractModels(resp.data);
    if (resp.status >= 400) {
      db.upsertUpstreamHealth(upstream.id, {
        status: 'error',
        last_error: `HTTP ${resp.status}`,
        latency_ms: latency,
        models: JSON.stringify(models),
      });
    } else {
      db.upsertUpstreamHealth(upstream.id, {
        status: 'ok',
        last_error: null,
        latency_ms: latency,
        models: JSON.stringify(models),
      });
    }
  } catch (err) {
    db.upsertUpstreamHealth(upstream.id, {
      status: 'error',
      last_error: err.code || err.message,
      latency_ms: Date.now() - start,
      models: null,
    });
  }
}

async function pollAll() {
  const list = upstreams.getEnabled();
  await Promise.allSettled(list.map(probe));
  // Refresh the in-memory upstream cache so callers see updated joined health
  upstreams.reload();
}

function scheduleNext() {
  if (timer) clearInterval(timer);
  const seconds = Math.max(5, parseInt(config.get('health_interval_seconds'), 10) || 30);
  timer = setInterval(pollAll, seconds * 1000);
  return seconds;
}

function start() {
  const seconds = scheduleNext();
  console.log(`[Health]    Polling every ${seconds}s`);
  // Fire-and-forget initial probe; errors are captured per-upstream.
  pollAll().catch(err => console.error('[Health]    initial poll error:', err));

  // React to config / upstream changes by rescheduling and re-probing.
  config.on('changed', ({ key }) => {
    if (key === 'health_interval_seconds') {
      const s = scheduleNext();
      console.log(`[Health]    Interval updated to ${s}s`);
    }
  });
  upstreams.on('changed', () => {
    pollAll().catch(err => console.error('[Health]    poll-after-reload error:', err));
  });
}

async function checkOne(id) {
  const u = upstreams.getById(id);
  if (!u) throw new Error(`unknown upstream id ${id}`);
  await probe(u);
  upstreams.reload();
  return db.getUpstreamHealth(id);
}

module.exports = { start, checkOne };
