// Fake `pi` for the evaluator contract test.
//
// It stands in for the child process so the test can exercise the evaluator's
// real launch and classification path without a provider: it records the trace
// file it was handed *at start*, makes no tool calls, and reports text so the
// classification yields a handoff.
import { appendFileSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.env.PI_ROUTING_EVAL_CONFIG, 'utf8'));

// What did this child inherit? An empty trace here means the evaluator reset it.
appendFileSync(`${config.trace}.started`, `---\n${readFileSync(config.trace, 'utf8')}`);
// Every path handed to a child, so the test can prove invocations differ.
appendFileSync(`${config.trace}.paths`, `${config.trace}\n`);

process.stdout.write(`${JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'handoff' }] },
})}\n`);
