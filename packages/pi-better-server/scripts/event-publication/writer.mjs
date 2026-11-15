import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const path = process.argv[2];
process.on('message', ({ marker }) => {
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  const staged = `${path}.${process.pid}.latency.tmp`;
  writeFileSync(staged, JSON.stringify({ ...meta, name: marker }));
  renameSync(staged, path);
  // Same-host monotonic clock; timestamp after the atomic source commit.
  process.send({ marker, committedNs: process.hrtime.bigint().toString() });
});
process.send({ ready: true });
