'use strict';

// Tees console.log/info/warn/error to data/proxy.log with timestamps.
// Existing console.* calls throughout the project automatically get persisted.

const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(LOG_DIR, 'proxy.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function format(level, args) {
  const text = args
    .map(a =>
      typeof a === 'string'
        ? a
        : a instanceof Error
          ? (a.stack || a.message)
          : util.inspect(a, { depth: 4, breakLength: 120 })
    )
    .join(' ');
  return `${new Date().toISOString()} [${level}] ${text}\n`;
}

function tee(level, originalFn) {
  return (...args) => {
    originalFn(...args);
    try { stream.write(format(level, args)); } catch { /* never throw from logging */ }
  };
}

console.log   = tee('INFO',  console.log.bind(console));
console.info  = tee('INFO',  console.info.bind(console));
console.warn  = tee('WARN',  console.warn.bind(console));
console.error = tee('ERROR', console.error.bind(console));

module.exports = { LOG_PATH };
