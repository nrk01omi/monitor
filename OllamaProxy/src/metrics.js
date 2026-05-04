'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { insertMetrics } = require('./db');

const INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '30000', 10);

// ── CPU usage: measure over a 500ms sample ──
function measureCpu() {
  return new Promise(resolve => {
    const before = os.cpus();
    setTimeout(() => {
      let idle = 0, total = 0;
      os.cpus().forEach((cpu, i) => {
        for (const type in cpu.times) {
          const d = cpu.times[type] - before[i].times[type];
          total += d;
          if (type === 'idle') idle += d;
        }
      });
      resolve(total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0);
    }, 500);
  });
}

// ── CPU temperature via powermetrics (sudo -n = non-interactive, fails silently) ──
function measureTemp() {
  return new Promise(resolve => {
    execFile(
      'sudo', ['-n', 'powermetrics', '-n', '1', '-i', '100', '--samplers', 'smc'],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = stdout.match(/CPU die temperature:\s*([\d.]+)/);
        resolve(m ? parseFloat(m[1]) : null);
      }
    );
  });
}

// ── Collect and store one sample ──
async function collect() {
  try {
    const [cpu_pct, cpu_temp] = await Promise.all([measureCpu(), measureTemp()]);
    const load = os.loadavg();
    insertMetrics({
      cpu_pct,
      mem_used:  os.totalmem() - os.freemem(),
      mem_total: os.totalmem(),
      load_1:    Math.round(load[0]  * 100) / 100,
      load_5:    Math.round(load[1]  * 100) / 100,
      load_15:   Math.round(load[2]  * 100) / 100,
      cpu_temp,
    });
  } catch (err) {
    console.error('[Metrics] collection error:', err.message);
  }
}

function start() {
  collect(); // immediate first sample
  setInterval(collect, INTERVAL_MS);
  console.log(`[Metrics]   Collecting every ${INTERVAL_MS / 1000}s`);
}

module.exports = { start };
