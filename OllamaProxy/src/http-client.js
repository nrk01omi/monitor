'use strict';

// Shared axios instance for short-lived management traffic: health probes,
// /api/tags aggregation, benchmark, tune, and monitor checks. Forces
// keepAlive:false so the socket is closed after the response — this prevents
// the leak observed on 2026-05-10 where axios' default keep-alive agent held
// /api/tags connections open and accumulated ~1 socket per upstream per poll.
// See docs/socket_leak_incident_2026-05-10.md.
//
// Streaming hot paths in proxy.js (upstream forward, whisper passthrough)
// intentionally keep the default axios import — keepAlive:false there would
// pay a TCP handshake on every generate request.

const http = require('node:http');
const https = require('node:https');
const axios = require('axios');

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

module.exports = axios.create({ httpAgent, httpsAgent });
