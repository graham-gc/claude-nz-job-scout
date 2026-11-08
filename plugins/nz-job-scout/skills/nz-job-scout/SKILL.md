---
name: nz-job-scout
description: Read a local PDF or Markdown resume, find recent publicly accessible New Zealand jobs that genuinely fit it, and save a clear report with a direct application route.
allowed-tools:
  - Read
  - Edit(/.nz-job-scout-session-*.json)
  - Edit(/.nz-job-scout-state.json)
  - WebSearch
  - WebFetch
  - Bash(shasum -a 256 *)
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" clock)'
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" clock --since *)'
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" inventory-batch --board *)'
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" report --input *)'
  - Bash(rm -- .nz-job-scout-session-*.json)
disallowed-tools:
  - Grep
  - Bash(grep *)
  - Bash(rg *)
  - Bash(sed *)
  - Bash(awk *)
  - Bash(cat *)
  - Bash(head *)
  - Bash(tail *)
  - Bash(jq *)
  - Bash(python *)
  - Bash(python3 *)
  - Bash(node -e *)
  - Bash(curl *)
  - Bash(wget *)
---

# NZ Job Scout

One loop: **current resume and criteria → suitable current vacancies → a readable report with direct application paths**. A scan is research, not plugin maintenance.

## Start and bound the work

Use only the declared Bash commands, one per call, with literal arguments. Substitute the actual plugin root; no assignments, loops, pipes, redirects, chained commands, helper scripts, guessed endpoints, or global CLI lookup.

Start the clock before reading the CV:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" clock
```

Expect `pluginVersion: "0.8.7"`; evidence uses `sessionSchemaVersion: 6`. A stale version or broken runtime is a limitation to report, not permission to repair, build, install, copy into a cache, or edit source code. Do not inspect source/tests during a scan.

Keep the returned `startedAt`. After input preparation, before another batch of optional research, and immediately before creating the session, check the same start time:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" clock --since 'START_TIMESTAMP_FROM_CLOCK'
```

- `continue`: research within the plan.
- `finish-verification` (15 minutes): stop adding employers and reformulating searches; finish only the most promising already-found candidates.
- `report-now` (20 minutes): stop research, mark unfinished sources `skipped` with a budget reason, and generate the report from existing evidence. Never fabricate missing facts to finish.

These are wrap-up thresholds, not a guarantee that a skill can interrupt Claude, an in-flight web request, or an approval wait. Never claim a hard wall-clock limit. If the clock cannot run, disclose unavailable timing and keep research bounded; do not guess durations. Copy observed timestamps into optional `execution` checkpoints; do not reconstruct them at the end.

## Read the inputs once

Accept a PDF/Markdown resume, criteria, or both. Re-read the complete supplied CV and calculate its SHA-256 with `shasum -a 256` on every invocation. Never persist or reuse a global candidate profile. Use `profile` for CV only, `criteria` for criteria only, and `combined` for both; explicit user constraints take precedence. Default to postings within **7 days** unless overridden.

Use supplied facts without reconfirming them. Read `.nz-job-scout-state.json` when present and suppress matching applied, rejected, closed, or not-interested roles; change decisions only on explicit user instruction. Read [references/state-file.md](references/state-file.md) if needed. Do not inspect old reports: the report command handles history and deduplication.

Read [references/session-format.md](references/session-format.md) for evidence fields. Keep languages/tools, sustained capabilities, qualifications, availability and work rights separate. Match recurring responsibilities, not keyword counts. A certification alone is exposure, **not working experience or invented years**; record it in qualifications or use `evidenceKind: "certification"`, `level: "exposure"`, no hands-on years.

Record user-confirmed availability windows with hours and, when known, `workload: "full-time"` or `"part-time"`. If the user explicitly permits full-time work only inside those windows, add the hard `fullTimeScope: availability-windows-only` constraint described in the reference. Do not infer it merely from student status or a temporary visa. Keep personal visa conditions unknown unless evidenced.

Save `execution.inputsReadyAt` from a clock checkpoint after preparation.

## Discover broadly, deepen selectively

Plan web search, SEEK, **LinkedIn**, Trade Me Jobs, and four distinct confirmed public employer/ATS inventories. Add a broad programme inventory for student/internship/graduate searches and a technical-volunteer source when requested. These are planned routes, not a quota that justifies exceeding the budget; mark unfinished routes honestly and accept partial coverage.

For every intended family, attempt broad role/stage/location discovery and a relevant public inventory. Record any budget-limited gap instead of silently dropping the family. One inspected inventory can support several families; record them in one attempt's `roleFamilies` array, without refetching or duplicating the operation. Use a few broad queries, not title/technology permutations. For student work, inspect broad early-career listings before stack-specific searches; retain generic technical titles such as Technology Services Intern for duty review.

Use `WebSearch` for discovery and `WebFetch` for public employer/ATS pages. Indexed SEEK, LinkedIn, Trade Me and aggregator results are leads, not final verification. Never request credentials, cookies, logged-in browser state or employer-only APIs. Stop at login walls, CAPTCHA, 401/403/429, or robots restrictions. After a restricted source, make at most one public employer-copy search; never retry the restriction using scripts or alternate endpoints.

Collect confirmed supported ATS board URLs from employer pages and query them together:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" inventory-batch --board 'CONFIRMED_BOARD_URL' --board 'ANOTHER_CONFIRMED_BOARD_URL'
```

Supported: Workable, Greenhouse, Lever, SmartRecruiters, Ashby, BambooHR and exact Workday hosts/site paths. Up to ten boards per batch; the adapter already uses three concurrent requests and an eight-second per-request timeout. Read compact output directly, without temporary files or shell filters. Retain uncertain locations; exclude only clearly overseas ones. `nextOffset` continues returned rows, not upstream API pagination. Follow it only when relevant and within budget; unfinished inventories stay partial.

Within this scan, reuse an already-read canonical page, board result and access limitation. Do not reopen a vacancy just to count it or satisfy another family. Revisit only to resolve a specific conflicting fact. No cross-run cache of vacancy availability.

An unsuitable/senior/closed role may reveal a useful employer. Queue employer expansion by likely value: current student/part-time/technical-volunteer activity first. Do not recursively expand every discovered employer. Keep `employerExpansionRequired: true` for relevant inventories left uninspected, defer them with a reason, and let coverage stay partial. Rejecting one role never counts as inspecting its employer's whole inventory. Two follow-ups with no new canonical vacancy identities end optional reformulation; finding one role alone is not a stopping rule.

## Screen before writing full assessments

Check these in order:

1. Current opening, allowed location, employee versus contractor, workload, stated duration and candidate availability.
2. Actual core duties and required technical experience. A related title or AWS certificate cannot compensate for missing core cloud practice. Respect explicit core-technology exclusions; distinguish required, preferred, alternatives and genuine beginner training.
3. Only for survivors: exact recent primary page, evidence conflicts, eligibility, required materials and usable application path.

Known hard conflicts are **not unknowns**. When full-time work is explicitly window-limited, permanent full-time is incompatible even without an end date. Record a stated duration as `duration: {"value": 9, "unit": "months"}` rather than losing it because exact dates are absent. The runtime rejects durations longer than all confirmed full-time windows. Do not confuse short summer full-time work with ongoing full-time work. Missing dates/hours without a demonstrated conflict stay unknown; never invent dates or assume the role becomes part-time because the candidate has class-free days.

Do not fill complete `jobs[]` records for clearly rejected discoveries. A lightweight discarded lead needs only title, employer, URL, outcome and reason; add whether its detail page was actually opened. Keep richer evidence for assessed or genuinely high-value unresolved leads. Record one attempt per actual operation. Never retrospectively set every lead's `detailPageOpened` to true. The runtime can derive that count for assessed leads from matching observed vacancy evidence.

## Verify and report

Ready to apply / Worth considering both require an opened exact public employer/ATS vacancy, a verified posting date inside the window, no known closure, no known hard conflict, genuine duty overlap, and either a direct online link or a plain email address **with employer instructions**. A `mailto:` alone is insufficient. Work-right/scheduling unknowns never erase known incompatibility. A missing closing date alone is not a rejection; a contradictory primary deadline is different: set `verificationEvidence.unresolvedDateConflict: true` with notes and leave it unverified until reconciled.

Preserve stronger primary evidence and each observed date's provenance. Separate hard eligibility from preferences, and `any` from `all` technology groups. Events, talent pools and conditional programmes are not jobs. Technical volunteers need explicit software/test/automation/support duties and paid/unpaid/reimbursed/unknown compensation; never disguise them as employment.

After the final clock checkpoint, write one `.nz-job-scout-session-TIMESTAMP.json` in the project using the file-writing tool, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" report --input '/absolute/project/.nz-job-scout-session-TIMESTAMP.json'
```

It validates, deduplicates and writes `./output/nz-jobs-YYYY-MM-DD.md`. Do not override the location unless explicitly requested. Correct session evidence if validation fails; never bypass validation, hand-edit conclusions, or repair plugin code. If reporting fails after correcting an identifiable session error, stop and disclose the failure separately from search results.

Return the absolute report path and only actionable roles with direct links/email instructions. Read that returned path if needed. Do not expose raw logs or rejection tables. Keep partial/blocked coverage explicit; never infer market-wide absence. If history leaves the report unchanged, do not present old entries as new. Report timing only from clock checkpoints: research includes discovery and verification, not a guessed breakdown of interleaved work.

After success, remove only this run's exact temporary session with the permitted cleanup command, unless asked to retain it. No wildcard cleanup. Applying, uploading a CV, sending messages and creating accounts require explicit approval. A scan must not modify plugin code, dependencies, permissions, installed versions or caches.
