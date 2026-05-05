'use strict';

// External LLM benchmark runner. Targets a registered upstream + model and
// reports per-run latency / tokens-per-sec, plus median / mean / min / max.
// The proxy hot path is unaffected — this is an additive feature.
//
// Optional request fields (all backward-compatible — omit them and behaviour
// matches the original spec):
//   options          — Ollama generation options (num_ctx, num_gpu, ...).
//                      OpenAI upstreams only forward the keys they understand;
//                      the rest are dropped with a warning.
//   system           — system prompt. Ollama: top-level `system`. OpenAI:
//                      messages[0] with role=system.
//   thinking         — 'auto' (default) | 'on' | 'off'. Maps to Ollama `think`
//                      or OpenAI `reasoning_effort` per spec.
//   reasoning_effort — 'low'|'medium'|'high'. Wins over `thinking` when both
//                      are set.
//   record_options   — when true the response includes the actual upstream
//                      request body for debugging.

const axios = require('axios');
const upstreams = require('./upstreams');

const DEFAULT_PROMPT = 'Say hello in one short sentence.';
const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_RUNS = 1;
const MAX_RUNS = 20;

// OpenAI keys we pass through verbatim from `options`. Anything else logs a
// warning and is dropped — the spec deliberately picks "ignore" over "fail".
const OPENAI_PASSTHROUGH = new Set(['temperature', 'top_p', 'seed', 'stop']);

function buildOllamaBody({ model, prompt, options, system, thinking, reasoning_effort }) {
  const body = { model, prompt, stream: true };
  if (system) body.system = system;
  if (thinking === 'on') body.think = true;
  else if (thinking === 'off') body.think = false;

  const opts = {};
  if (options && typeof options === 'object') Object.assign(opts, options);
  if (reasoning_effort) opts.reasoning_effort = reasoning_effort;
  if (Object.keys(opts).length > 0) body.options = opts;

  return body;
}

function buildOpenAIBody({ model, prompt, options, system, thinking, reasoning_effort }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model, messages, stream: false };

  const o = options || {};
  if (o.temperature  != null) body.temperature  = o.temperature;
  if (o.top_p        != null) body.top_p        = o.top_p;
  if (o.seed         != null) body.seed         = o.seed;
  if (o.num_predict  != null) body.max_tokens   = o.num_predict;
  if (o.stop         != null) body.stop         = o.stop;

  let effort = reasoning_effort;
  if (!effort) {
    if (thinking === 'on') effort = 'high';
    else if (thinking === 'off') effort = 'low';
  }
  if (effort) body.reasoning_effort = effort;

  const dropped = Object.keys(o).filter(
    k => !OPENAI_PASSTHROUGH.has(k) && k !== 'num_predict'
  );
  if (dropped.length) {
    console.warn('[Benchmark] OpenAI: ignoring unsupported options:', dropped.join(','));
  }
  return body;
}

// Best-effort <think>...</think> tracker. Ollama's stream emits the assistant
// text in `response` chunks; if a model surrounds its reasoning with these
// tags we can split wall-clock and eval_count between thinking and non-thinking
// regions. If the model never emits the tags, both fields stay null.
function makeThinkTracker() {
  let inside = false;
  let buffer = '';
  let thinkingMs = 0;
  let thinkingCount = 0;
  let regionStart = null;
  let regionStartEval = null;
  let lastEvalCount = 0;
  let saw = false;

  function flushBoundary(now, evalCount) {
    if (inside) {
      regionStart = now;
      regionStartEval = evalCount;
    } else if (regionStart != null) {
      thinkingMs += now - regionStart;
      if (regionStartEval != null && evalCount != null) {
        thinkingCount += Math.max(0, evalCount - regionStartEval);
      }
      regionStart = null;
      regionStartEval = null;
    }
  }

  return {
    onChunk(text, now, evalCount) {
      if (typeof evalCount === 'number') lastEvalCount = evalCount;
      if (!text) return;
      buffer += text;
      // Walk every boundary in this buffer; some streams emit `<think>` and
      // matching `</think>` in the same chunk.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tag = inside
          ? buffer.indexOf('</think>')
          : buffer.indexOf('<think>');
        if (tag === -1) break;
        const endIdx = inside ? tag + '</think>'.length : tag + '<think>'.length;
        buffer = buffer.slice(endIdx);
        inside = !inside;
        saw = true;
        flushBoundary(now, evalCount ?? lastEvalCount);
      }
      // Cap buffer growth — we only need enough lookback for the longest tag.
      if (buffer.length > 32) buffer = buffer.slice(-32);
    },
    finalize(now, finalEvalCount) {
      if (inside && regionStart != null) {
        thinkingMs += now - regionStart;
        if (regionStartEval != null && finalEvalCount != null) {
          thinkingCount += Math.max(0, finalEvalCount - regionStartEval);
        }
      }
      return {
        thinking_ms:    saw ? thinkingMs    : null,
        thinking_count: saw ? thinkingCount : null,
      };
    },
  };
}

async function runOneOllama({ upstream, model, prompt, timeoutMs, options, system, thinking, reasoning_effort, captureRequest }) {
  const start = Date.now();
  let ttft = null;
  let evalCount = null;
  let evalDurationNs = null;
  const tracker = makeThinkTracker();

  const body = buildOllamaBody({ model, prompt, options, system, thinking, reasoning_effort });
  const url = `${upstream.url.replace(/\/+$/, '')}/api/generate`;
  if (captureRequest) captureRequest({ upstream_url: upstream.url, endpoint: '/api/generate', body });

  const resp = await axios.post(url, body, {
    timeout: timeoutMs,
    responseType: 'stream',
  });

  await new Promise((resolve, reject) => {
    let buffer = '';
    resp.data.on('data', chunk => {
      const now = Date.now();
      if (ttft === null) ttft = now - start;
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (typeof j.response === 'string') {
            tracker.onChunk(j.response, now, j.eval_count);
          }
          if (j.done) {
            evalCount = j.eval_count ?? null;
            evalDurationNs = j.eval_duration ?? null;
          }
        } catch { /* ignore partial JSON */ }
      }
    });
    resp.data.on('end', resolve);
    resp.data.on('error', reject);
  });

  const totalMs = Date.now() - start;
  const tokensPerSec = (evalCount && evalDurationNs)
    ? evalCount / (evalDurationNs / 1e9)
    : null;
  const think = tracker.finalize(Date.now(), evalCount);
  return {
    total_ms:       totalMs,
    ttft_ms:        ttft,
    tokens_per_sec: tokensPerSec,
    eval_count:     evalCount,
    thinking_count: think.thinking_count,
    thinking_ms:    think.thinking_ms,
  };
}

async function runOneOpenAI({ upstream, model, prompt, timeoutMs, options, system, thinking, reasoning_effort, captureRequest }) {
  const start = Date.now();
  const body = buildOpenAIBody({ model, prompt, options, system, thinking, reasoning_effort });
  const url = `${upstream.url.replace(/\/+$/, '')}/v1/chat/completions`;
  if (captureRequest) captureRequest({ upstream_url: upstream.url, endpoint: '/v1/chat/completions', body });

  const resp = await axios.post(url, body, { timeout: timeoutMs });
  const totalMs = Date.now() - start;
  const usage = resp.data?.usage || {};
  const ct = usage.completion_tokens ?? null;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? null;
  return {
    total_ms:       totalMs,
    ttft_ms:        null,
    tokens_per_sec: ct ? ct / (totalMs / 1000) : null,
    eval_count:     ct,
    thinking_count: reasoningTokens,
    thinking_ms:    null,
  };
}

async function runOne(args) {
  if (args.upstream.protocol === 'openai') return runOneOpenAI(args);
  return runOneOllama(args);
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarizeMetric(results, key) {
  const xs = results.map(r => r?.[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return { median: null, mean: null, min: null, max: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    median: median(xs),
    mean:   sum / xs.length,
    min:    Math.min(...xs),
    max:    Math.max(...xs),
  };
}

function summarize(results) {
  return {
    total_ms:       summarizeMetric(results, 'total_ms'),
    ttft_ms:        summarizeMetric(results, 'ttft_ms'),
    tokens_per_sec: summarizeMetric(results, 'tokens_per_sec'),
    thinking_ms:    summarizeMetric(results, 'thinking_ms'),
  };
}

async function run({ upstream_id, model, runs, prompt, timeout_ms,
                     options, system, thinking, reasoning_effort, record_options }) {
  if (!upstream_id || !Number.isInteger(upstream_id)) {
    const e = new Error('upstream_id required (integer)'); e.status = 400; throw e;
  }
  if (!model || typeof model !== 'string') {
    const e = new Error('model required'); e.status = 400; throw e;
  }
  const n = Math.max(MIN_RUNS, Math.min(MAX_RUNS, parseInt(runs, 10) || DEFAULT_RUNS));
  const promptText = (typeof prompt === 'string' && prompt.length > 0) ? prompt : DEFAULT_PROMPT;
  const timeoutMs = Math.max(1000, parseInt(timeout_ms, 10) || DEFAULT_TIMEOUT_MS);

  const upstream = upstreams.getById(upstream_id);
  if (!upstream) {
    const e = new Error(`unknown upstream_id ${upstream_id}`); e.status = 404; throw e;
  }
  if (!upstream.enabled) {
    const e = new Error(`upstream "${upstream.name}" is disabled`); e.status = 409; throw e;
  }
  // Explicit upstream+model API ignores priority but still rejects unreachable
  // targets up front so the caller gets a clear error instead of a generic
  // ECONNREFUSED storm.
  if (upstream.status === 'error') {
    const e = new Error(`upstream "${upstream.name}" is offline (${upstream.last_error || 'unreachable'})`);
    e.status = 502; throw e;
  }

  // Capture only the first run's actual upstream body — the rest are identical
  // and would just bloat the response.
  let actualRequest = null;
  const captureRequest = record_options
    ? (snap) => { if (!actualRequest) actualRequest = snap; }
    : undefined;

  const results = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await runOne({
        upstream, model, prompt: promptText, timeoutMs,
        options, system, thinking, reasoning_effort, captureRequest,
      });
      results.push(r);
    } catch (err) {
      results.push({
        error:          err.code || err.message,
        total_ms:       null,
        ttft_ms:        null,
        tokens_per_sec: null,
        eval_count:     null,
        thinking_count: null,
        thinking_ms:    null,
      });
    }
  }

  const allFailed = results.every(r => r.error);
  if (allFailed) {
    const firstErr = results[0]?.error || 'all benchmark runs failed';
    const e = new Error(firstErr);
    e.status = /timeout/i.test(firstErr) ? 504 : 502;
    e.runs = results;
    throw e;
  }

  const out = {
    upstream_id:   upstream.id,
    upstream_name: upstream.name,
    model,
    protocol:      upstream.protocol,
    runs:          results,
    summary:       summarize(results),
  };
  if (record_options && actualRequest) out.actual_request = actualRequest;
  return out;
}

module.exports = { run, summarize };
