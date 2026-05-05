'use strict';

// External LLM benchmark runner. Targets a registered upstream + model and
// reports per-run latency / tokens-per-sec, plus median / mean / min / max.
// The proxy hot path is unaffected — this is an additive feature.

const axios = require('axios');
const upstreams = require('./upstreams');

const DEFAULT_PROMPT = 'Say hello in one short sentence.';
const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_RUNS = 1;
const MAX_RUNS = 20;

async function runOneOllama({ upstream, model, prompt, timeoutMs }) {
  const start = Date.now();
  let ttft = null;
  let evalCount = null;
  let evalDurationNs = null;

  const resp = await axios.post(
    `${upstream.url.replace(/\/+$/, '')}/api/generate`,
    { model, prompt, stream: true },
    { timeout: timeoutMs, responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    let buffer = '';
    resp.data.on('data', chunk => {
      if (ttft === null) ttft = Date.now() - start;
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
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
  return {
    total_ms:       totalMs,
    ttft_ms:        ttft,
    tokens_per_sec: tokensPerSec,
    eval_count:     evalCount,
  };
}

async function runOneOpenAI({ upstream, model, prompt, timeoutMs }) {
  const start = Date.now();
  const resp = await axios.post(
    `${upstream.url.replace(/\/+$/, '')}/v1/chat/completions`,
    { model, messages: [{ role: 'user', content: prompt }] },
    { timeout: timeoutMs }
  );
  const totalMs = Date.now() - start;
  const ct = resp.data?.usage?.completion_tokens ?? null;
  return {
    total_ms:       totalMs,
    ttft_ms:        null,
    tokens_per_sec: ct ? ct / (totalMs / 1000) : null,
    eval_count:     ct,
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
  };
}

async function run({ upstream_id, model, runs, prompt, timeout_ms }) {
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

  const results = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await runOne({ upstream, model, prompt: promptText, timeoutMs });
      results.push(r);
    } catch (err) {
      results.push({
        error:          err.code || err.message,
        total_ms:       null,
        ttft_ms:        null,
        tokens_per_sec: null,
        eval_count:     null,
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

  return {
    upstream_id:   upstream.id,
    upstream_name: upstream.name,
    model,
    protocol:      upstream.protocol,
    runs:          results,
    summary:       summarize(results),
  };
}

module.exports = { run, summarize };
