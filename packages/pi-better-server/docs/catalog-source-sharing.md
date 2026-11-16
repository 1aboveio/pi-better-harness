# Catalog Source Sharing

Markdown definitions and catalog `settings.json` remain authoritative. The fixed-build
server keeps bounded derived source, parse, entry and scope caches. Host grants are
verified before each catalog read. Project discovery is omitted when the current grant
does not allow it. Branch overlays are still checked against the current host grant and
applied after the shared source snapshot. No cached value authorizes a launch.

Interactive reads check current metadata. Persistent edits and managed launch admission
read fresh definition bytes and preferences. Existing content conflicts, symlink guards
and frozen launch recipes remain in the original domain paths.

## Observation And Repair

One observer cycle verifies live grants before reconciling sources. Equivalent observers
reuse the scope snapshot. Watchers share authorized directories, send exact filename
hints, and coalesce notifications for 50 ms. Missing/replaced directories and failed
watchers are rediscovered through the same cycle.

The one-second fallback advances at most 128 iterator/stat steps across all active scopes,
round-robin. Each scope completes at most one repair pass per call. Directory handles and
positions survive budget boundaries and ordinary hot-file hints. Directory order is
normalized when a pass finishes. Newly detected source changes rebuild the catalog value;
unchanged definition entries and parsed content are reused. Initial interactive discovery
and changed-scope assembly are synchronous; they are not counted as fallback repair.

Resolver reuse depends on the selected definition, its base role, and their saved/session
preferences. Other definitions and shadowed sources do not invalidate that resolution.
The returned effective definition always carries the current snapshot digest. Catalog-wide
revisions include effective preferences, not preferences for absent definitions.

Revoked scopes stop participating in repair and release their directory iterators and
watchers. The final subscription close clears timers, pending notifications, watchers,
repair iterators and source caches. Repeated close is harmless.

## Counters And Verification

`CatalogSources.metrics` counts definition reads, parses, scope assembly, notifications,
metadata checks, repair steps/completed passes, new entry assembly and preference-source
accesses. `catalogResolutionMetrics` counts inheritance assembly and reuse. Preference
access counts include missing-source checks, not just physical file reads.

File-backed tests cover bounded missed-event repair, continuous hints, dependency edits,
preferences, directory replacement, watcher failure, trust withdrawal and resource release.
The existing real daemon catalog test includes 1/5/10-client source-sharing assertions and
the UI/query/edit paths. That test requires qualifying CI where process-start inspection
is allowed. The local `spawnSync ps EPERM` denial is retained in `.work/804/catalog-tests.log`;
file-backed checks are not host-admission or real-socket proof.
