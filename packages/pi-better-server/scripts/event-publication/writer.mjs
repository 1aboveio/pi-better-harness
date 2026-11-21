import { commitMetadata } from './commit.mjs';
const path = process.argv[2];
process.on('message', async ({ marker }) => {
  process.send(await commitMetadata(path, marker));
});
process.send({ ready: true });
