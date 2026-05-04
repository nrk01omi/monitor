'use strict';

// In-memory cache of monitor_targets + monitor_edges, mirroring the pattern
// used by upstreams.js so subscribers (poller.js, routes.js) can react to
// changes without re-hitting the DB on every tick.
//
// Source-of-truth is the DB. The legacy Python config.yaml is imported once
// on first start when both monitor_targets and monitor_edges are empty.

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const db = require('../db');

const VALID_TYPES = new Set(['docker', 'http', 'tcp']);

const emitter = new EventEmitter();
let cache = { targets: [], edges: [] };

function parseTargetRow(row) {
  let cfg = {};
  try { cfg = row.config ? JSON.parse(row.config) : {}; }
  catch { cfg = {}; }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    group_name: row.group_name,
    config: cfg,
    enabled: !!row.enabled,
    created_at: row.created_at,
  };
}

function reload() {
  cache = {
    targets: db.listMonitorTargets().map(parseTargetRow),
    edges:   db.listMonitorEdges(),
  };
  emitter.emit('changed', cache);
  return cache;
}

function listTargets() { return cache.targets; }
function listEnabledTargets() { return cache.targets.filter(t => t.enabled); }
function getTarget(id) { return cache.targets.find(t => t.id === id) || null; }
function listEdges() { return cache.edges; }

function validateTarget(data) {
  if (!data || typeof data !== 'object') return 'body must be an object';
  if (!data.id || typeof data.id !== 'string') return 'id must be a non-empty string';
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(data.id)) return 'id must match [a-z0-9_-]';
  if (!data.name || typeof data.name !== 'string') return 'name required';
  if (!VALID_TYPES.has(data.type)) return `type must be one of: ${[...VALID_TYPES].join(', ')}`;
  const cfg = data.config || {};
  if (data.type === 'docker' && !cfg.container_name) return 'config.container_name required for docker';
  if (data.type === 'http'   && !cfg.url)            return 'config.url required for http';
  if (data.type === 'tcp'    && (!cfg.host || !cfg.port)) return 'config.host and config.port required for tcp';
  return null;
}

function insertTarget(data) {
  const err = validateTarget(data);
  if (err) throw new Error(err);
  db.insertMonitorTarget(data);
  reload();
  return getTarget(data.id);
}

function updateTarget(id, data) {
  const ok = db.updateMonitorTarget(id, data);
  if (!ok) return null;
  reload();
  return getTarget(id);
}

function deleteTarget(id) {
  const ok = db.deleteMonitorTarget(id);
  if (ok) reload();
  return ok;
}

function insertEdge(data) {
  if (!data?.from_id || !data?.to_id) throw new Error('from_id and to_id required');
  db.insertMonitorEdge(data);
  reload();
}

function deleteEdge(id) {
  const ok = db.deleteMonitorEdge(id);
  if (ok) reload();
  return ok;
}

// One-time import from the legacy Python monitor's config.yaml.
// Looks for the file at MONITOR_CONFIG_PATH (compose mounts it to /app/config/monitor.yaml).
// Skips entirely if the targets table already has rows.
function seedFromYaml() {
  if (db.countMonitorTargets() > 0) return;

  const candidates = [
    process.env.MONITOR_CONFIG_PATH,
    '/app/config/monitor.yaml',
    path.join(__dirname, '..', '..', 'config', 'monitor.yaml'),
  ].filter(Boolean);

  let yamlPath = null;
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) { yamlPath = p; break; }
    } catch { /* not found, try next */ }
  }
  if (!yamlPath) {
    console.log('[Monitor]   No seed YAML found; targets table starts empty');
    return;
  }

  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    console.warn('[Monitor]   js-yaml not installed; skipping YAML seed');
    return;
  }

  let parsed;
  try {
    parsed = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    console.error(`[Monitor]   failed to parse ${yamlPath}:`, err.message);
    return;
  }

  const rawTargets = Array.isArray(parsed?.targets) ? parsed.targets : [];
  const rawEdges   = Array.isArray(parsed?.edges)   ? parsed.edges   : [];

  let imported = 0;
  for (const t of rawTargets) {
    // Drop the legacy 'ollama_proxy' type — that role is filled by the
    // proxy/upstreams subsystem inside this same process.
    if (!t || !t.id || !t.type || t.type === 'ollama_proxy') continue;
    if (!VALID_TYPES.has(t.type)) continue;
    const cfg = {};
    if (t.url)              cfg.url = t.url;
    if (t.container_name)   cfg.container_name = t.container_name;
    if (t.host)             cfg.host = t.host;
    if (t.port)             cfg.port = t.port;
    if (t.timeout_seconds)  cfg.timeout_seconds = t.timeout_seconds;
    try {
      db.insertMonitorTarget({
        id: t.id,
        name: t.name || t.id,
        type: t.type,
        group_name: t.group || 'default',
        config: cfg,
        enabled: 1,
      });
      imported++;
    } catch (err) {
      console.warn(`[Monitor]   skipped target ${t.id}: ${err.message}`);
    }
  }

  let edgeCount = 0;
  for (const e of rawEdges) {
    if (!e?.from || !e?.to) continue;
    // Don't import edges that point at the dropped ollama_proxy target,
    // unless the user kept it as a real id (the route synthesizes those).
    try {
      db.insertMonitorEdge({ from_id: e.from, to_id: e.to, label: e.label || null });
      edgeCount++;
    } catch (err) {
      console.warn(`[Monitor]   skipped edge ${e.from}→${e.to}: ${err.message}`);
    }
  }

  console.log(`[Monitor]   Seeded ${imported} target(s), ${edgeCount} edge(s) from ${yamlPath}`);
}

seedFromYaml();
reload();

module.exports = {
  reload,
  listTargets,
  listEnabledTargets,
  getTarget,
  listEdges,
  insertTarget,
  updateTarget,
  deleteTarget,
  insertEdge,
  deleteEdge,
  on:  (event, fn) => emitter.on(event, fn),
  off: (event, fn) => emitter.off(event, fn),
};
