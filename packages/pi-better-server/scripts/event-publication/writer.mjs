import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const path = process.argv[2];
process.on('message', ({ marker }) => {
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  const staged = `${path}.${process.pid}.latency.tmp`;
  writeFileSync(staged, JSON.stringify({ ...meta, name: marker }));
  // Start before rename: another process can observe the new inode before
  // this process resumes after the syscall. This conservatively includes
  // rename latency rather than reporting a negative publication duration.
  const committedNs = process.hrtime.bigint().toString();
  renameSync(staged, path);
  process.send({ marker, committedNs });
});
process.send({ ready: true });
