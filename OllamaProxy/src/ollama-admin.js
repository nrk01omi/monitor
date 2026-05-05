'use strict';

// Upstream Ollama administration: pull / delete / copy / show / ps / tags.
// Strictly an additive feature — proxy hot path, /api/tags aggregation, health
// polling and matrix CRUD are unaffected. Calls are not logged to `requests`
// (NFR-5: management traffic is out of measurement scope).

const db = require('./db');

// In-memory registry of currently-running pulls keyed by `${upstream_id}::${model}`.
// Used to (a) reject duplicate pulls with 409 and (b) abort the upstream fetch
// when the client disconnects.
const activePulls = new Map();

function pullKey(upstreamId, model) {
  return `${upstreamId}::${model}`;
}

function trimUrl(url) {
  return url.replace(/\/+$/, '');
}

async function pull({ upstream, model, clientReq, clientRes }) {
  const key = pullKey(upstream.id, model);
  if (activePulls.has(key)) {
    clientRes.status(409).json({
      error: 'pull already in progress for this model',
      code: 'PULL_IN_PROGRESS',
    });
    return;
  }

  const controller = new AbortController();
  const entry = {
    upstreamId: upstream.id,
    model,
    startedAt: new Date().toISOString(),
    controller,
    lastProgress: null,
  };
  activePulls.set(key, entry);

  // If the client disconnects mid-stream, propagate the abort to upstream so
  // the Ollama side can stop pulling layers it no longer needs to deliver.
  const onClose = () => {
    if (!clientRes.writableEnded) {
      try { controller.abort(); } catch { /* ignore */ }
    }
  };
  clientReq.on('close', onClose);

  try {
    const upstreamRes = await fetch(`${trimUrl(upstream.url)}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal: controller.signal,
    });

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      if (!clientRes.headersSent) {
        clientRes.status(502).json({
          error: `upstream pull failed: HTTP ${upstreamRes.status}${text ? ` ${text}` : ''}`,
          code: 'UPSTREAM_ERROR',
        });
      }
      return;
    }

    clientRes.status(200);
    clientRes.setHeader('Content-Type', 'application/x-ndjson');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('X-Accel-Buffering', 'no');

    let buffer = '';
    let lastObj = null;
    for await (const chunk of upstreamRes.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      clientRes.write(buf);
      buffer += buf.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          lastObj = j;
          entry.lastProgress = j;
        } catch { /* ignore partial / malformed */ }
      }
    }
    if (!clientRes.writableEnded) clientRes.end();

    if (lastObj && (lastObj.status === 'success' || lastObj.status === 'pull complete')) {
      try {
        db.upsertUpstreamModel(upstream.id, model, { priority: 0, enabled: 1 });
      } catch (e) {
        console.error('[OllamaAdmin] upsertUpstreamModel failed:', e.message);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      if (!clientRes.writableEnded) clientRes.end();
    } else if (!clientRes.headersSent) {
      clientRes.status(502).json({ error: err.message, code: 'UPSTREAM_ERROR' });
    } else if (!clientRes.writableEnded) {
      try {
        clientRes.write(JSON.stringify({ error: err.message }) + '\n');
      } catch { /* ignore */ }
      clientRes.end();
    }
  } finally {
    clientReq.off('close', onClose);
    activePulls.delete(key);
  }
}

async function passthroughJson({ upstream, opPath, body, method = 'POST' }) {
  const url = `${trimUrl(upstream.url)}${opPath}`;
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, payload };
}

function listActivePulls() {
  return [...activePulls.values()].map(e => ({
    upstream_id:   e.upstreamId,
    model:         e.model,
    started_at:    e.startedAt,
    last_progress: e.lastProgress,
  }));
}

module.exports = { pull, passthroughJson, listActivePulls };
