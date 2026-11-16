import { commitMetadata } from './commit.mjs';
import { readFileSync } from 'node:fs';
const path = process.argv[2];
process.on('message', async ({ marker, id, mutation }) => {
  if (process.argv[3] === '--incremental-workload') {
    try { const { mutateWorkload } = await import('../measure-full-runtime/incremental-workload.mjs'); process.send({ id, result: mutateWorkload(JSON.parse(readFileSync(path, 'utf8')), mutation) }); }
    catch (error) { process.send({ id, error: String(error) }); }
  } else process.send(await commitMetadata(path, marker));
});
process.send({ ready: true });
