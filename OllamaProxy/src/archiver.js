'use strict';

// Daily archive job. Treats SQLite as hot/working storage and exports rows
// older than `archive_retention_days` to per-day NDJSON.gz files under
// data/archive/{table}/{YYYY-MM-DD}.ndjson.gz, then DELETEs them.
//
// Atomicity: each day's file is written to a .tmp sibling, gzip-streamed,
// fsync'd, and renamed in-place. Only after every per-day rename succeeds
// do we DELETE the corresponding rows from the DB. A crash mid-write leaves
// stray .tmp files (cleaned up next run) but the source rows stay in DB.
//
// Concurrency invariant: we DELETE WHERE id <= maxArchivedId AND ts < cutoff,
// so rows inserted while the archive is running cannot be silently lost.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const db = require('./db');
const config = require('./config');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archive');
const CHECK_INTERVAL_MS = 60_000;          // poll once a minute for the trigger window
const SETTING_LAST_RUN = 'archive_last_run_jst_date';

const JST_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hour12: false,
});

function jstParts(unixMs) {
  const parts = JST_FMT.formatToParts(new Date(unixMs));
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
}

function isoDateOnly(unixMs) {
  return jstParts(unixMs).date;
}

// ── Per-table descriptors ────────────────────────────────────────────────────

const TABLES = [
  {
    name: 'requests',
    iterate: (cutoff) => db.iterateRequestsBefore(cutoff),
    deleteUpToId: (maxId, cutoff) => db.deleteRequestsUpToId(maxId, cutoff),
    cutoff: (retentionDays) => new Date(Date.now() - retentionDays * 86400 * 1000).toISOString(),
    rowDate: (row) => row.timestamp.slice(0, 10),  // YYYY-MM-DD prefix of ISO ts
  },
  {
    name: 'checks',
    iterate: (cutoff) => db.iterateChecksBefore(cutoff),
    deleteUpToId: (maxId, cutoff) => db.deleteChecksUpToId(maxId, cutoff),
    cutoff: (retentionDays) => Math.floor(Date.now() / 1000) - retentionDays * 86400,
    rowDate: (row) => isoDateOnly(row.ts * 1000),  // ts is unix seconds
  },
  {
    name: 'system_metrics',
    iterate: (cutoff) => db.iterateMetricsBefore(cutoff),
    deleteUpToId: (maxId, cutoff) => db.deleteMetricsUpToId(maxId, cutoff),
    cutoff: (retentionDays) => new Date(Date.now() - retentionDays * 86400 * 1000).toISOString(),
    rowDate: (row) => row.timestamp.slice(0, 10),
  },
];

// ── Per-day writer ───────────────────────────────────────────────────────────

function openWriter(tableName, dateKey) {
  const dir = path.join(ARCHIVE_DIR, tableName);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${dateKey}.ndjson.gz`);
  if (fs.existsSync(finalPath)) {
    // A previous run already finalized this day. Refuse to overwrite — surface
    // it so an operator can decide (delete the file to re-archive, or move
    // the in-DB rows out manually). Returning null here causes the caller to
    // skip these rows from BOTH archive AND delete.
    return null;
  }
  const tmpPath = finalPath + '.tmp';
  // Clean up any leftover .tmp from a prior crash before opening a new one.
  try { fs.unlinkSync(tmpPath); } catch { /* not present, fine */ }
  const fileStream = fs.createWriteStream(tmpPath);
  const gzip = zlib.createGzip();
  gzip.pipe(fileStream);
  return { finalPath, tmpPath, fileStream, gzip, count: 0 };
}

async function closeWriter(w) {
  return new Promise((resolve, reject) => {
    w.fileStream.once('close', resolve);
    w.fileStream.once('error', reject);
    w.gzip.end();
  });
}

// Promote .tmp → final path. fs.renameSync is atomic on the same filesystem
// on Linux and on NTFS (where Node maps it to MoveFileEx).
function commitWriter(w) {
  fs.renameSync(w.tmpPath, w.finalPath);
}

// ── Per-table runner ─────────────────────────────────────────────────────────

async function archiveTable(table, retentionDays) {
  const cutoff = table.cutoff(retentionDays);
  const writers = new Map();         // dateKey -> writer
  const skippedDates = new Set();    // dateKeys that already had a final file
  // Track ID ranges per state to drive a safe DELETE later.
  let archivedMaxId = 0;
  let totalRows = 0;
  let earliestSkippedId = null;      // smallest id we did NOT archive (file exists)

  try {
    for (const row of table.iterate(cutoff)) {
      const dateKey = table.rowDate(row);

      if (skippedDates.has(dateKey)) {
        if (earliestSkippedId === null || row.id < earliestSkippedId) earliestSkippedId = row.id;
        continue;
      }

      let w = writers.get(dateKey);
      if (!w) {
        w = openWriter(table.name, dateKey);
        if (!w) {
          skippedDates.add(dateKey);
          if (earliestSkippedId === null || row.id < earliestSkippedId) earliestSkippedId = row.id;
          console.warn(`[Archive]   ${table.name}/${dateKey}.ndjson.gz exists, skipping rows for that day`);
          continue;
        }
        writers.set(dateKey, w);
      }

      const ok = w.gzip.write(JSON.stringify(row) + '\n');
      if (!ok) {
        // Respect backpressure on huge response_body fields.
        await new Promise((res) => w.gzip.once('drain', res));
      }
      w.count++;
      totalRows++;
      if (row.id > archivedMaxId) archivedMaxId = row.id;
    }

    // Finalize all writers, gzip flush + close
    for (const [dateKey, w] of writers) {
      await closeWriter(w);
      console.log(`[Archive]   wrote ${table.name}/${dateKey}.ndjson.gz (${w.count} rows)`);
    }

    // Atomic rename only after every file finished cleanly
    for (const w of writers.values()) commitWriter(w);

    // Determine the safe delete bound:
    //   - Normally we delete WHERE id <= archivedMaxId.
    //   - If we skipped some days because their file already existed, we must
    //     not delete rows we didn't archive. Cap delete at (earliestSkippedId - 1).
    let deleteBound = archivedMaxId;
    if (earliestSkippedId !== null && earliestSkippedId - 1 < deleteBound) {
      deleteBound = earliestSkippedId - 1;
    }

    let deleted = 0;
    if (deleteBound > 0) {
      deleted = table.deleteUpToId(deleteBound, cutoff);
    }
    return { table: table.name, archived: totalRows, files: writers.size, skipped_days: skippedDates.size, deleted };
  } catch (err) {
    // On any error mid-write, abandon every still-open writer's .tmp file
    // so the next run starts clean. Source rows stay in DB.
    for (const w of writers.values()) {
      try { w.gzip.destroy(); } catch { /* noop */ }
      try { w.fileStream.destroy(); } catch { /* noop */ }
      try { fs.unlinkSync(w.tmpPath); } catch { /* not present, fine */ }
    }
    throw err;
  }
}

// ── Top-level run ────────────────────────────────────────────────────────────

let _running = false;

async function runArchive() {
  if (_running) {
    console.warn('[Archive]   already running; skipping overlap');
    return null;
  }
  _running = true;
  const t0 = Date.now();
  const retention = Math.max(1, config.get('archive_retention_days') || 30);
  const summary = [];
  try {
    for (const table of TABLES) {
      try {
        const r = await archiveTable(table, retention);
        summary.push(r);
      } catch (err) {
        console.error(`[Archive]   ${table.name} failed:`, err.message);
        summary.push({ table: table.name, error: err.message });
      }
    }
    const elapsed = Date.now() - t0;
    console.log(`[Archive]   done in ${elapsed}ms`, JSON.stringify(summary));
    db.setSetting(SETTING_LAST_RUN, jstParts(Date.now()).date);
    return { ok: true, elapsed_ms: elapsed, summary };
  } finally {
    _running = false;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let timer = null;

function shouldRunNow() {
  if (!config.get('archive_enabled')) return false;
  const targetHour = config.get('archive_hour_jst');
  const now = jstParts(Date.now());
  if (now.hour < targetHour) return false;
  const last = db.getSetting(SETTING_LAST_RUN);
  return last !== now.date;
}

function start() {
  if (timer) return;
  if (!config.get('archive_enabled')) {
    console.log('[Archive]   disabled (archive_enabled=0)');
    return;
  }
  console.log(`[Archive]   scheduled — daily at ${config.get('archive_hour_jst')}:00 JST, retention ${config.get('archive_retention_days')}d`);

  // Initial check at boot — runs immediately if today's run is overdue
  // (e.g., NAS was off when 03:00 fired) and the trigger hour has already passed.
  setImmediate(() => {
    if (shouldRunNow()) {
      runArchive().catch(err => console.error('[Archive]   boot run error:', err));
    }
  });

  timer = setInterval(() => {
    if (shouldRunNow()) {
      runArchive().catch(err => console.error('[Archive]   scheduled run error:', err));
    }
  }, CHECK_INTERVAL_MS);
}

// ── Listings (used by /api/archives) ────────────────────────────────────────

function listArchives() {
  const out = {};
  let root;
  try { root = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true }); }
  catch { return out; }
  for (const dirent of root) {
    if (!dirent.isDirectory()) continue;
    const table = dirent.name;
    out[table] = [];
    const tdir = path.join(ARCHIVE_DIR, table);
    let entries;
    try { entries = fs.readdirSync(tdir); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.ndjson.gz')) continue;
      const full = path.join(tdir, file);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out[table].push({
        date: file.replace(/\.ndjson\.gz$/, ''),
        size_bytes: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    out[table].sort((a, b) => b.date.localeCompare(a.date));
  }
  return out;
}

function archiveFilePath(table, filename) {
  // Defensive: prevent path traversal. Both segments must be plain names.
  if (!/^[A-Za-z0-9_]+$/.test(table)) return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.ndjson\.gz$/.test(filename)) return null;
  const full = path.join(ARCHIVE_DIR, table, filename);
  if (!full.startsWith(ARCHIVE_DIR + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = { start, runArchive, listArchives, archiveFilePath, ARCHIVE_DIR };
