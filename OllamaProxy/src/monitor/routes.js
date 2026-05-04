'use strict';

// Express router mounted under /api/monitor by dashboard.js. Owns:
//   - status / topology / history (read-only data for the UI)
//   - targets / edges CRUD (so users can add monitored services from the UI)

const express = require('express');
const targets = require('./targets');
const poller = require('./poller');

const router = express.Router();

// ── Status / topology / history ─────────────────────────────────────────────

router.get('/status', (_req, res) => {
  try {
    res.json({
      ts: Math.floor(Date.now() / 1000),
      nodes: poller.getLatest(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/topology', (_req, res) => {
  try {
    const stored = targets.listEdges().map(e => ({
      from: e.from_id, to: e.to_id, label: e.label || '',
    }));
    // Synthetic edges from ollama-proxy to each enabled backend.
    const { backends } = poller.buildOllamaSnapshot();
    const synthetic = backends.map(b => ({
      from: 'ollama-proxy', to: b.id, label: 'routing',
    }));
    res.json({ edges: [...stored, ...synthetic] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:target_id', (req, res) => {
  const targetId = req.params.target_id;
  const hours = req.query.hours ? parseInt(req.query.hours, 10) : 1;
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    return res.status(400).json({ error: 'hours must be 1..168' });
  }
  try {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const db = require('../db');
    const points = db.getCheckHistory(targetId, since);
    res.json({ target_id: targetId, points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Targets CRUD ────────────────────────────────────────────────────────────

router.get('/targets', (_req, res) => {
  res.json(targets.listTargets());
});

router.post('/targets', (req, res) => {
  try {
    const created = targets.insertTarget(req.body);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/targets/:id', (req, res) => {
  try {
    const updated = targets.updateTarget(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/targets/:id', (req, res) => {
  const ok = targets.deleteTarget(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

// ── Edges CRUD ──────────────────────────────────────────────────────────────

router.get('/edges', (_req, res) => {
  res.json(targets.listEdges());
});

router.post('/edges', (req, res) => {
  try {
    targets.insertEdge(req.body);
    res.status(201).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/edges/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = targets.deleteEdge(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

module.exports = router;
