# Managed timing notification ownership

The runtime enforces deadlines and publishes bounded pending timing notices. It does not send a recipient message or mark a notification handled because its own SDK context differs from the parent. Foreground snapshot observation and session reconnect replay retained notices under the existing exact session/workspace/branch gate.

The recipient writes a timing receipt after handoff. Urgent messages carry a structured native receipt identity, allowing reconnect to repair a missing receipt without another model turn. The runtime folds receipts into existing timing markers and removes folded files; frontend receipt writes do not race the runtime's timing metadata writes.

There are at most 64 detailed pending notices plus one explicit overflow summary directing the recipient to retained evidence. Terminal runs keep these pending notices and receipts until ordinary run retention permits cleanup. This is intentional coalescing beyond the detailed-notice budget, not a claim that every overflowing tool call was individually delivered.

Validation with this worktree's own npm ci:

- Seven deterministic managed launch/watcher/deadline queue tests pass. Deadline enforcement persists one wake, does not send a parent message, and folds/deletes a later recipient receipt.
- Two pure notification tests cover 10,000 queued events bounded to 65 records and exact durable receipt identity.
- Real local SDK and HostedSession witnesses deliver an initial notice, close the recipient, retain another notice on an already-terminal run, reopen the native transcript and deliver only the new notice. Deleting the first receipt before reconnect proves native transcript repair without redelivery. These tests use automatic observation/tickers, no synthetic workflow trigger or manual callback flush.
- All 66 callback-batcher tests pass.

Legacy health/timing tests that combine manager and frontend in one fake ExtensionAPI still require migration. These checks do not claim the full suite or #751 is complete.
