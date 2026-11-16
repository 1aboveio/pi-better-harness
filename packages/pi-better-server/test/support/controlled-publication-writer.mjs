import { once } from 'node:events';
import { commitMetadata } from '../../scripts/event-publication/commit.mjs';

process.once('message', async ({ path, marker }) => {
  const commit = await commitMetadata(path, marker, async () => {
    const release = once(process, 'message');
    process.send({ renamed: marker });
    await release;
  });
  process.send(commit, () => process.disconnect());
});
process.send({ ready: true });
