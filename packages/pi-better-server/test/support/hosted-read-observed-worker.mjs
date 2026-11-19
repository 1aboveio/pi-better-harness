import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { instrumentHostedRead } from '../../scripts/measure-full-runtime/recovery-trace-loader.mjs';

const target = new URL('../../src/runtime/query-worker.mjs', import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url === target) return { format: 'module', shortCircuit: true,
      source: instrumentHostedRead(readFileSync(new URL(url), 'utf8'), 'worker') };
    return next(url, context);
  },
});
await import(target);
