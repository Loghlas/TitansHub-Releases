# Shop Titans calendar — controlled publication, automatic mode OFF

The workflow runs each Monday at 05:17 UTC (06:17 Paris in winter, 07:17 in summer), or manually on main. Ubuntu 24.04, Node 24, Python 3.12; actions pinned to verified commit hashes, npm lockfile and hashed Linux Python dependencies. No PAT, Google personal credentials, TitansHub secrets, PDF or source images are uploaded. Reports/artifacts expire after 14 days.

## Jobs and default behavior

`simulate` has `contents: read` and `actions: read`. It anonymously downloads the full Google Sheets PDF, extracts placements, applies the ledger's reviewed official assertions before merging, validates and uploads JSON/Markdown only. Alternatively it replays an explicitly approved prior successful simulation from this exact workflow/main commit. Its network client rejects write methods. Simulate is the default dispatch mode.

`publish` alone has `contents: write` (and `actions: read` to download the current run's review artifact). It is skipped unless simulation succeeds, independent reconstruction validates both files, meaningful changes exist, and the trigger has the necessary explicit authorization. Checkout never persists credentials. No release, tag, version, latest.json or other repository path can be written by the publication API client.

**Automatic publication is disabled.** `automation/publication-policy.json` ships with `automaticPublicationEnabled: false`. A repository variable cannot override that versioned gate. No activation variable is set by this installation. Manual publication also requires an explicit dispatch mode, confirmation, a successful reviewed run ID and exact SHA-256.

## First manual publication — future authorization required

1. Run this workflow on main with `mode: simulate` and `confirm_publication: false`. Wait for Success and review `calendar-simulation-review`, including both JSON candidates, report, sources, gaps and exclusions.
2. Record that successful run ID and the exact calendar candidate SHA-256 in its summary. The run must come from this workflow, main, the same code/HEAD, and the same repository. The older run 44544017757 predates this installation and is intentionally not admissible. Any intervening main commit requires a new simulation.
3. Once explicitly authorized, choose **Run workflow**, branch **main**, `mode: publish-reviewed`, check `confirm_publication`, enter `review_run_id` and `approved_sha256` from step 2. Leave automatic configuration disabled; no repository variable is required for manual publication.
4. The read job validates the source run's status, repository, event, branch, workflow path and commit, downloads that artifact and independently reproduces the merge. The write job verifies again, reloads HEAD and the two published files, compares the exact analyzed base and hashes, preserves official assertions and the 702-event anchor, and refuses stale approval of a correction that has become historical.
5. Exactly calendar.json and calendar-state.json are committed together on main, without force. If HEAD changes, publication stops. Check the publication result, commit, both raw endpoints/hashes and TitansHub afterward. No actual publication was performed during installation tests.

## Future weekly activation — two independent gates

Only after separate explicit authorization and validation of the manual publishing path:

1. Review and commit `automaticPublicationEnabled: true` in `tools/calendar/automation/publication-policy.json`; refresh MANIFEST.json hashes. Leave repository variable absent/false while reviewing this code change. A main change invalidates older manual review artifacts.
2. Independently set the repository Actions variable `CALENDAR_AUTO_PUBLISH` to the exact string `true`. Do not add any personal token. Both gates are necessary, and the event must be the Monday schedule; a normal manual simulation still cannot publish.
3. Observe the first scheduled run and public verification. To stop automatic publishing, set that variable false; optionally also commit the versioned gate false. Policy changes always require review. Neither activation step has been performed by this installation.

## Integrity and failure behavior

The publisher reconstructs both JSONs from the saved base and extraction with the same schema/profile/merge rules, validates hashes, duplicates, coverage, all existing IDs, historical anchor and official bindings/exclusions, and rejects blockers or unexplained differences. Identical results create no commit; changed results without exploitable event data are refused. Unknown images, incomplete PDFs, insufficient counts and missing source occurrences remain blocking. The initial 702-event historical anchor is never recalculated, and the 19 incomplete days are never presented as fully covered. Dragon November 20 and Reinhold November 9 retain date precision, not invented hours. The reviewed date-only runtime contract is TitansHub 1.10.3; official durations remain in the ledger. Its legacy `blocked-pending-runtime-review` metadata is retained as review history, with runtime acceptance explicit in the versioned publication policy; it is not an activation switch.

Only a two-file tree based on the analyzed parent and one commit can be created. HEAD is read before writing and again before advancing main; a non-force ref update rejects divergent concurrent commits. Failures creating tree/commit cannot change either public file. A lost ref-update acknowledgement is resolved by reading HEAD and both files, never retrying a write blindly. If verification fails after the ref update, the outcome is explicitly **unknown** and requires inspection, not an automatic retry or rollback.

`npm test --prefix tools/calendar` exercises the publisher with synthetic fixtures and mocked GitHub only. No test performs a real publication. The simulation entry point remains read-only and the publisher is a separate CLI used only by its gated job. The schema is unchanged from TitansHub 1.10.3. Community reuse notices and runtime date-range limitations remain visible in reports; they are not erased by technical validation.
