'use strict';

// Per-target probes for the infrastructure monitor.
// Each checker resolves to a uniform shape:
//   { id, status: 'up'|'degraded'|'down', latency_ms, detail, error }
// The poller just stores whatever comes back and never throws.

const axios = require('axios');
const net = require('node:net');
const Docker = require('dockerode');

let _docker = null;
function getDocker() {
  if (_docker) return _docker;
  // socketPath defaults to /var/run/docker.sock on Linux; allow override via env
  // for Windows/Mac dev boxes that expose Docker over TCP.
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('tcp://')) {
    const u = new URL(host);
    _docker = new Docker({ host: u.hostname, port: parseInt(u.port, 10) || 2375 });
  } else {
    _docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }
  return _docker;
}

async function checkDocker(target) {
  const cfg = target.config || {};
  const name = cfg.container_name;
  if (!name) {
    return { id: target.id, status: 'down', latency_ms: null, detail: {}, error: 'container_name not set' };
  }
  try {
    const container = getDocker().getContainer(name);
    const info = await container.inspect();
    const state = info.State || {};
    const docker_status = state.Status || 'unknown';
    const running = state.Running === true;
    const restart_count = info.RestartCount ?? 0;
    const started_at = state.StartedAt || '';

    if (!running) {
      return {
        id: target.id,
        status: 'down',
        latency_ms: null,
        detail: { docker_status, restart_count },
        error: `container is ${docker_status}`,
      };
    }
    const status = (docker_status === 'restarting' && restart_count > 0) ? 'degraded' : 'up';
    return {
      id: target.id,
      status,
      latency_ms: null,
      detail: { docker_status, restart_count, started_at },
      error: null,
    };
  } catch (err) {
    // dockerode errors carry .statusCode for HTTP, .code for socket issues
    const notFound = err.statusCode === 404;
    return {
      id: target.id,
      status: 'down',
      latency_ms: null,
      detail: {},
      error: notFound ? 'container not found' : (err.message || String(err)),
    };
  }
}

async function checkHttp(target) {
  const cfg = target.config || {};
  const url = cfg.url;
  const timeout = (cfg.timeout_seconds ?? 5) * 1000;
  if (!url) {
    return { id: target.id, status: 'down', latency_ms: null, detail: {}, error: 'url not set' };
  }
  const start = Date.now();
  try {
    const resp = await axios.get(url, {
      timeout,
      validateStatus: () => true,           // we classify ourselves
      maxRedirects: 3,
    });
    const latency = Date.now() - start;
    if (resp.status >= 200 && resp.status < 400) {
      return {
        id: target.id,
        status: 'up',
        latency_ms: latency,
        detail: { http_status: resp.status },
        error: null,
      };
    }
    return {
      id: target.id,
      status: 'degraded',
      latency_ms: latency,
      detail: { http_status: resp.status },
      error: `HTTP ${resp.status}`,
    };
  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
    return {
      id: target.id,
      status: 'down',
      latency_ms: null,
      detail: {},
      error: isTimeout ? 'timeout' : (err.code || err.message || String(err)),
    };
  }
}

function checkTcp(target) {
  const cfg = target.config || {};
  const host = cfg.host;
  const port = cfg.port;
  const timeout = (cfg.timeout_seconds ?? 3) * 1000;
  if (!host || !port) {
    return Promise.resolve({
      id: target.id, status: 'down', latency_ms: null, detail: {},
      error: 'host/port not set',
    });
  }
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(result);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => {
      finish({
        id: target.id,
        status: 'up',
        latency_ms: Date.now() - start,
        detail: { host, port },
        error: null,
      });
    });
    sock.once('timeout', () => {
      finish({ id: target.id, status: 'down', latency_ms: null, detail: { host, port }, error: 'timeout' });
    });
    sock.once('error', (err) => {
      finish({ id: target.id, status: 'down', latency_ms: null, detail: { host, port }, error: err.code || err.message });
    });
    sock.connect(port, host);
  });
}

const CHECKERS = {
  docker: checkDocker,
  http:   checkHttp,
  tcp:    checkTcp,
};

async function runChecker(target) {
  const fn = CHECKERS[target.type];
  if (!fn) {
    return { id: target.id, status: 'down', latency_ms: null, detail: {}, error: `unknown type: ${target.type}` };
  }
  try {
    return await fn(target);
  } catch (err) {
    // Last-resort safety net — the type-specific checkers should never throw.
    return { id: target.id, status: 'down', latency_ms: null, detail: {}, error: err.message || String(err) };
  }
}

module.exports = { runChecker, checkDocker, checkHttp, checkTcp };
