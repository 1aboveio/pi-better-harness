# Failure observations

Structured tool, model, exit, and supervision failures are collected separately from lifecycle status. A child may still be `running`, or finish its agent loop, while checks remain unresolved. List, output, result, navigator, and completion notifications expose these observations before assistant progress can suggest that the work is healthy.

Each run retains a `failures.jsonl` journal. A later successful tool attempt clears an incident only when tool name, arguments, and working directory match and the retry began after the failure. Parallel or unrelated successes cannot clear it. Expected failures require explicit `expected: true` event/result metadata; prose such as “this test should fail” is not interpreted as metadata.

Running failures become eligible for attention after 60 seconds. Observation gaps are eligible immediately, and terminal runs use the existing completion callback. Delivery receipts are independent of recovery and are written after handoff; `callback:false` suppresses notifications without hiding inspection evidence.

The collector scans complete structured records independently of the finite progress tail. Missing terminal logs, unreadable records, and detected truncation are shown as **observation incomplete**. Failure classification uses structured error and exit fields; output text and domain-specific status codes are not failure signals.

A `.observed` companion marker makes missing journals detectable after restart. Failed writes retain evidence and receipts in memory and retry on subsequent reads, with an observation-incomplete warning until storage recovers. This pending memory cannot survive process loss while persistence is unavailable. Journals and markers follow existing run retention and explicit cleanup.
