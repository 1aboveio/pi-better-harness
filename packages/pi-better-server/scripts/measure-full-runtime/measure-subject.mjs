import assert from 'node:assert/strict';
import { register } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSubjectBinding } from './subject-binding.mjs';

const binding = parseSubjectBinding(process.env.PI_FULL_RUNTIME_SUBJECT);
for (const path of Object.values(binding)) assert.equal(realpathSync(path), path, 'Subject and driver roots must be canonical');
assert.equal(realpathSync(binding.driverCheckout), fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''), 'Driver must execute from its approved root');
register(new URL('./subject-binding.mjs', import.meta.url), { parentURL: import.meta.url, data: binding });
await import('../measure-full-runtime.mjs');
