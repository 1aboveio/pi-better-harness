# Default module cases

| Module | Prior guidance | Observable behavior |
| --- | --- | --- |
| collaboration | Original Harness default on project instructions | A repository's specific status format takes precedence. |
| communication | ADR 0033, status pair | For "Did the unit run pass?", report that run's result. |
| verification | Original Harness status default | For "Can we close delivery?", disclose the outstanding acceptance check. |
| ownership | ADR 0018, outcome Todo | Run the pending acceptance check when asked to finish delivery. |
| engineering | Issue 947, validated-value example | Pass an already validated internal value through without adding another parser. |
| decisions | Issue 947, retry example | Preserve the payment operation's existing idempotency key when retrying. |
