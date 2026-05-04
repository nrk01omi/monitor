'use strict';

const express = require('express');
const axios = require('axios');
const { insertRequest, updateRequest } = require('./db');
const config = require('./config');
const upstreams = require('./upstreams');

const PROXY_PORT = config.get('proxy_port');

const app = express();

// Hide Express signature so this stays a transparent passthrough — clients that
// sniff for raw Ollama (no wrapper headers) won't see X-Powered-By: Express.
app.disable('x-powered-by');

// Capture raw body for all content types
app.use(express.raw({ type: '*/*', limit: '100mb' }));

// Send an Ollama-shaped error response, choosing JSON vs NDJSON based on whether
// the original request asked for streaming. NDJSON streaming clients parse
// line-by-line and surface the {"error":...} field; JSON clients want a 4xx/5xx
// with the error in the body.
function sendOllamaError(res, { isStreaming, status, message }) {
  if (res.headersSent) {
    try { res.end(); } catch { /* noop */ }
    return;
  }
  if (isStreaming) {
    res.status(200);
    res.setHeader('content-type', 'application/x-ndjson');
    try {
      res.write(JSON.stringify({ error: message }) + '\n');
      res.end();
    } catch { /* client may have gone away */ }
  } else {
    try { res.status(status).json({ error: message }); } catch { /* ignore */ }
  }
}

// Special endpoints handled inside the proxy itself rather than forwarded.
// Aggregates models across all enabled upstreams, fetching each one with the
// path that matches its protocol, then normalizes the union to the shape the
// caller asked for (Ollama-style for /api/tags, OpenAI-style for /v1/models).
const PROTO_LIST_PATH = { ollama: '/api/tags', openai: '/v1/models' };
const PROTO_EXTRACT = {
  ollama: data => Array.isArray(data?.models) ? data.models.map(m => m.name || m.model).filter(Boolean) : [],
  openai: data => Array.isArray(data?.data)   ? data.data.map(m => m.id).filter(Boolean)              : [],
};

async function handleAggregatedModels(req, res, finalize) {
  const targets = upstreams.getEnabled();
  const responses = await Promise.allSettled(
    targets.map(async u => {
      const proto = u.protocol || 'ollama';
      const path = PROTO_LIST_PATH[proto] || '/api/tags';
      const r = await axios.get(`${u.url}${path}`, { timeout: 5000 });
      const names = (PROTO_EXTRACT[proto] || PROTO_EXTRACT.ollama)(r.data);
      return { upstream: u, names };
    })
  );

  const collected = []; // [{ name, upstreamName }]
  const seen = new Set();
  for (const r of responses) {
    if (r.status !== 'fulfilled') continue;
    for (const name of r.value.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      collected.push({ name, upstreamName: r.value.upstream.name });
    }
  }

  let body;
  if (req.path === '/v1/models') {
    body = {
      object: 'list',
      data: collected.map(m => ({ id: m.name, object: 'model', _upstream: m.upstreamName })),
    };
  } else {
    body = {
      models: collected.map(m => ({ name: m.name, _upstream: m.upstreamName })),
    };
  }

  res.json(body);
  finalize({
    response_status: 200,
    response_body: JSON.stringify(body),
    error: null,
  });
}

app.use(async (req, res) => {
  const startTime = Date.now();

  let requestBody = null;
  let model = null;
  // Must be 0|1 (INTEGER column in SQLite) — bare booleans break the named binding.
  let isStreaming = 0;

  if (req.body && req.body.length > 0) {
    requestBody = req.body.toString('utf8');
    try {
      const parsed = JSON.parse(requestBody);
      model = parsed.model || null;
      // Ollama streams by default unless stream: false is set
      isStreaming = parsed.stream !== false ? 1 : 0;
    } catch {
      // Non-JSON body
    }
  }

  // Log before DB insert so the request is visible even if insertRequest itself throws.
  console.log(`[Proxy]     ${req.method} ${req.path} model=${model || '-'} stream=${isStreaming} bytes=${requestBody?.length || 0}`);

  let recordId;
  try {
    recordId = insertRequest({
      method: req.method,
      path: req.path,
      request_headers: JSON.stringify(req.headers),
      request_body: requestBody,
      model,
      is_streaming: isStreaming,
    });
  } catch (err) {
    console.error(`[Proxy]     insertRequest failed for ${req.method} ${req.path}:`, err);
    // Best-effort: still try to forward the request below; just skip DB updates.
    recordId = null;
  }

  // Set once routing succeeds; surfaced in logs and persisted to the requests row
  // so the dashboard shows which upstream handled each call.
  let routedUpstream = null;

  // Single-fire finalizer so disconnect/error/end don't double-update
  let finalized = false;
  function finalize(fields) {
    if (finalized) return;
    finalized = true;
    const upstreamName = fields.upstream_name ?? routedUpstream?.name ?? null;
    const payload = {
      id: recordId,
      response_status:  fields.response_status  ?? null,
      response_headers: fields.response_headers ?? null,
      response_body:    fields.response_body    ?? null,
      duration_ms:      Date.now() - startTime,
      error:            fields.error            ?? null,
      upstream_name:    upstreamName,
    };
    if (recordId != null) {
      try {
        updateRequest(payload);
      } catch (err) {
        console.error(`[Proxy]     #${recordId} finalize() failed:`, err);
      }
    }
    const tag = payload.error ? `error="${payload.error}"` : `status=${payload.response_status}`;
    const upstreamTag = upstreamName ? ` upstream=${upstreamName}` : '';
    console.log(`[Proxy]     #${recordId ?? '-'} done ${tag}${upstreamTag} ${payload.duration_ms}ms`);
  }

  // AbortController so we can cancel the upstream request if the client goes away.
  // res.on('close') fires either when the response completes OR when the connection
  // is torn down before the response finishes — distinguish via res.writableEnded.
  // (req.on('close') in Express/Node fires on body-read completion too, so it isn't
  // a reliable disconnect signal.)
  const abort = new AbortController();
  res.on('close', () => {
    if (!finalized && !res.writableEnded) {
      abort.abort();
      finalize({ response_status: 499, error: 'client closed connection' });
    }
  });

  // Fan-out endpoints: aggregate models across all enabled upstreams.
  if (req.method === 'GET' && (req.path === '/api/tags' || req.path === '/api/ps' || req.path === '/v1/models')) {
    routedUpstream = { name: '<aggregate>' };  // surfaced in log / DB
    try {
      await handleAggregatedModels(req, res, finalize);
    } catch (err) {
      sendOllamaError(res, { isStreaming, status: 502, message: `aggregation failed: ${err.message}` });
      finalize({ response_status: 502, error: err.message });
    }
    return;
  }

  // Pick an upstream based on the model name in the body.
  const upstream = upstreams.resolveUpstream(model);
  if (!upstream) {
    const message = model
      ? `model '${model}' not found, try pulling it first`
      : 'no upstream configured';
    const status = model ? 404 : 503;
    sendOllamaError(res, { isStreaming, status, message });
    finalize({ response_status: status, error: message });
    return;
  }
  routedUpstream = upstream;

  // If the chosen upstream's last health check failed, short-circuit instead of
  // letting the client wait for an axios timeout.
  if (upstream.status === 'error') {
    const message = `upstream '${upstream.name}' unreachable: ${upstream.last_error || 'unknown error'}`;
    sendOllamaError(res, { isStreaming, status: 503, message });
    finalize({ response_status: 503, error: message });
    return;
  }

  try {
    const ollamaUrl = `${upstream.url}${req.originalUrl}`;
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];
    delete forwardHeaders['content-length']; // axios recalculates

    const response = await axios({
      method: req.method,
      url: ollamaUrl,
      headers: forwardHeaders,
      data: req.body && req.body.length > 0 ? req.body : undefined,
      responseType: 'stream',
      timeout: 600_000, // 10 min for long generations
      signal: abort.signal,
    });

    res.status(response.status);

    const responseHeaders = {};
    for (const [k, v] of Object.entries(response.headers)) {
      // Skip transfer-encoding; express handles chunked encoding itself
      if (k.toLowerCase() === 'transfer-encoding') continue;
      res.setHeader(k, v);
      responseHeaders[k] = v;
    }

    const chunks = [];

    response.data.on('data', (chunk) => {
      chunks.push(chunk);
      // res.write throws if the client has already disconnected
      try { res.write(chunk); } catch { /* handled by 'close' */ }
    });

    response.data.on('end', () => {
      try { res.end(); } catch { /* ignore */ }
      finalize({
        response_status: response.status,
        response_headers: JSON.stringify(responseHeaders),
        response_body: Buffer.concat(chunks).toString('utf8'),
        error: null,
      });
    });

    response.data.on('error', (err) => {
      try { res.end(); } catch { /* ignore */ }
      finalize({
        response_status: response.status,
        response_headers: JSON.stringify(responseHeaders),
        response_body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
        error: err.message,
      });
    });

  } catch (err) {
    const upstreamStatus = err.response?.status;
    const message = upstreamStatus
      ? err.message  // Ollama itself returned a 4xx/5xx — preserve original semantics
      : `upstream '${upstream.name}' connection failed: ${err.message}`;
    const status = upstreamStatus || 502;

    sendOllamaError(res, { isStreaming, status, message });
    finalize({ response_status: status, error: message });
  }
});

function startListening(port, fallbackEnv, hardDefault) {
  const server = app.listen(port, () => {
    console.log(`[Proxy]     Listening on port ${port}`);
    const list = upstreams.getEnabled();
    console.log(`[Proxy]     ${list.length} upstream(s) enabled`);
    for (const u of list) {
      console.log(`[Proxy]       - ${u.name} → ${u.url} ${u.is_default ? '(default)' : ''}`);
    }
  });
  // Fall back to env / default if the saved setting is bad (occupied, invalid).
  // Otherwise a bad UI save would brick the container in a restart loop.
  server.on('error', (err) => {
    const envPort = parseInt(process.env[fallbackEnv] || '', 10);
    if (port !== envPort && Number.isInteger(envPort) && envPort > 0) {
      console.error(`[Proxy]     listen on ${port} failed (${err.code}); falling back to env ${fallbackEnv}=${envPort}`);
      startListening(envPort, fallbackEnv, hardDefault);
    } else if (port !== hardDefault) {
      console.error(`[Proxy]     listen on ${port} failed (${err.code}); falling back to default ${hardDefault}`);
      startListening(hardDefault, fallbackEnv, hardDefault);
    } else {
      console.error('[Proxy]     all fallback ports failed:', err);
      process.exit(1);
    }
  });
}

startListening(PROXY_PORT, 'PROXY_PORT', 11435);

module.exports = app;
