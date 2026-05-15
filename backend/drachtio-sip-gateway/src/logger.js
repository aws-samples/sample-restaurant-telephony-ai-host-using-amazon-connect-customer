'use strict';

// Minimal JSON-line logger. Writes to stdout so the Fargate awslogs
// driver ships each line as a CloudWatch Logs event. CloudWatch Logs
// Insights can then `parse` the JSON and filter by level / call_id.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  const line = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...fields,
  };
  process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  child: (baseFields) => ({
    debug: (msg, fields) => emit('debug', msg, { ...baseFields, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...baseFields, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...baseFields, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...baseFields, ...fields }),
  }),
};
