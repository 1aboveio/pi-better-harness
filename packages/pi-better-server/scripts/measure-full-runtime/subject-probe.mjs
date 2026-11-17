import { register } from 'node:module';
import { parseSubjectBinding } from './subject-binding.mjs';

if (process.env.PI_FULL_RUNTIME_SUBJECT) register(new URL('./subject-binding.mjs', import.meta.url), {
  parentURL: import.meta.url, data: parseSubjectBinding(process.env.PI_FULL_RUNTIME_SUBJECT),
});
await import('./probe.mjs');
