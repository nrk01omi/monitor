'use strict';

// Logger first — installs console.* tee to data/proxy.log so any log line
// produced by anything below (including crash handlers) is persisted.
const { LOG_PATH } = require('./logger');

process.on('uncaughtException', (err) => {
  console.error('[Server]    uncaughtException:', err);
  // Allow stdout/stderr/log file to flush before exit
  setTimeout(() => process.exit(1), 200);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server]    unhandledRejection:', reason);
});

const { markStalePendingAsCrashed } = require('./db');
const crashed = markStalePendingAsCrashed();
if (crashed > 0) {
  console.warn(`[Server]    Marked ${crashed} pending request(s) from a previous crash`);
}
console.log(`[Server]    Logging to ${LOG_PATH}`);

require('./proxy');
require('./dashboard');
require('./metrics').start();
require('./health').start();
require('./monitor/poller').start();
require('./archiver').start();
