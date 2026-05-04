'use strict';

// Merges runtime config from three layers, in order of precedence:
//   settings table  >  process.env  >  hardcoded defaults
// On first load, env values are seeded into the settings table so the UI
// can edit them. Subsequent edits via setSetting() bump the in-memory cache
// and emit 'changed' so subscribers (health.js) can react.

const EventEmitter = require('node:events');
const { getAllSettings, setSetting } = require('./db');

const DEFAULTS = {
  proxy_port: 11435,
  dashboard_port: 3005,
  health_interval_seconds: 30,
  archive_enabled: 1,                 // boolean stored as 0/1 to fit TEXT settings table
  archive_retention_days: 30,
  archive_hour_jst: 3,                // 0..23
};

const ENV_KEYS = {
  proxy_port: 'PROXY_PORT',
  dashboard_port: 'DASHBOARD_PORT',
  health_interval_seconds: 'HEALTH_INTERVAL_SECONDS',
  archive_enabled: 'ARCHIVE_ENABLED',
  archive_retention_days: 'ARCHIVE_RETENTION_DAYS',
  archive_hour_jst: 'ARCHIVE_HOUR_JST',
};

const COERCE = {
  proxy_port: v => parseInt(v, 10),
  dashboard_port: v => parseInt(v, 10),
  health_interval_seconds: v => parseInt(v, 10),
  archive_enabled: v => (v === '1' || v === 1 || v === true || v === 'true') ? 1 : 0,
  archive_retention_days: v => parseInt(v, 10),
  archive_hour_jst: v => parseInt(v, 10),
};

const emitter = new EventEmitter();
const cache = {};

function load() {
  const persisted = getAllSettings();
  for (const key of Object.keys(DEFAULTS)) {
    let raw;
    if (persisted[key] !== undefined) {
      raw = persisted[key];
    } else if (process.env[ENV_KEYS[key]] !== undefined) {
      raw = process.env[ENV_KEYS[key]];
      // Seed env values into settings table on first start so UI can edit them
      setSetting(key, raw);
    } else {
      raw = String(DEFAULTS[key]);
      setSetting(key, raw);
    }
    cache[key] = COERCE[key] ? COERCE[key](raw) : raw;
  }
}

load();

function get(key) {
  return cache[key];
}

function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown config key: ${key}`);
  setSetting(key, value);
  const coerced = COERCE[key] ? COERCE[key](value) : value;
  cache[key] = coerced;
  emitter.emit('changed', { key, value: coerced });
}

function getAll() {
  return { ...cache };
}

module.exports = {
  get,
  set,
  getAll,
  on:  (event, fn) => emitter.on(event, fn),
  off: (event, fn) => emitter.off(event, fn),
};
