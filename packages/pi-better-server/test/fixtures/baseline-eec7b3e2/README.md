# Approved Baseline Sources

These six files are byte-identical copies from commit
`eec7b3e256a7548bbf67f69cd468f12eb3b91dc8`, under
`packages/pi-better-server/src/runtime/`. The four `.mjs` files come from
its `domain/` directory. The `.txt` suffix prevents automatic compilation.

`baseline-observation.test.ts` loads these actual baseline algorithms and applies
the external observer in memory. Compatibility test copies have no `.git`, so
the test cannot retrieve them with `git show` at execution time. These sources
do not replace the approved checkout or artifact in a real campaign.
