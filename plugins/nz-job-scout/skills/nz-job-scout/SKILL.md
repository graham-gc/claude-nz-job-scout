---
name: nz-job-scout
description: Analyse a local PDF or Markdown CV and/or user criteria, research publicly accessible New Zealand vacancies, verify evidence, assess genuine experience fit, and save a Markdown job report without authenticated accounts.
allowed-tools:
  - Read
  - Edit(.nz-job-scout-session-*.json)
  - WebSearch
  - WebFetch
  - Bash(nz-job-scout validate *)
  - Bash(nz-job-scout report *)
  - Bash(node *nz-job-scout validate *)
  - Bash(node *nz-job-scout report *)
  - Bash(rm .nz-job-scout-session-*)
---

# NZ Job Scout

Find real, currently available New Zealand vacancies and assess them against the candidate's actual experience, constraints, and goals.

## Inputs and modes

Accept a CV path (`.pdf` or `.md`), explicit search criteria, or both. Infer the mode:

- `profile`: candidate evidence without explicit job criteria;
- `criteria`: explicit criteria without candidate evidence;
- `combined`: both.

At least one is required. Do not ask for information already present in the CV or conversation. Ask one concise question only when an omitted fact would materially change the eligible job set; otherwise state a conservative assumption.

Defaults:

- maximum posting age: 30 days;
- state: currently open with a directly verified application route;
- geography: New Zealand unless narrowed by user or supported context;
- no invented employment-type, location, work-right, or arrangement restrictions.

Before research, read [references/session-format.md](references/session-format.md) completely. It is the evidence contract used by the deterministic runtime.

## Public-source boundary

Use only anonymously accessible information. Never request, inspect, import, export, or retain cookies, passwords, tokens, browser storage, private profiles, logged-in sessions, paid extensions, or employer-only partner credentials.

Prefer primary sources:

- employer career sites;
- public ATS pages and feeds such as Workday, Greenhouse, Lever, SmartRecruiters, Ashby, and BambooHR;
- public-sector, university, and permitted public job-board pages.

Use general search, SEEK, LinkedIn, Trade Me Jobs, aggregators, and indexed snippets only for discovery when publicly visible. A discovery result is not verification. Replace it with the exact public employer or ATS vacancy page before recommending it.

On a login wall, CAPTCHA, 401, 403, robots restriction, or access denial, stop using that source for the run. Look for a public primary copy and record the limitation. Do not evade, retry repeatedly, or interpret access failure as evidence that a role is closed.

## Candidate model

For `profile` and `combined` modes, read the complete CV. Use document reading for PDF and direct text reading for Markdown.

Model:

- `skills`: concrete languages, frameworks, databases, protocols, and tools;
- `capabilities`: work repeatedly performed, such as backend development, API automation, performance testing, debugging, internal tooling, or technical support;
- `qualifications`, structured availability windows, and structured work rights separately.

Classify skills and capabilities as `core`, `frequent`, `working`, or `exposure` from duration, repetition, recency, ownership, production responsibility, and outcomes. Keyword presence alone is not evidence of proficiency. Do not infer AI/ML, cloud, frontend, mobile, or another speciality from an adjacent term.

In `criteria` mode, create the neutral candidate object defined in the reference. Do not imply that a CV or personal fit was assessed.

## Search and audit trail

In profile or combined mode, derive several materially distinct role families from sustained recent work. Search each family with New Zealand title variants; finding one vacancy is not a stopping condition. In criteria mode, preserve explicit scope.

For every search operation, record a `searchCoverage.attempts[]` entry with its role family, source, exact query, result status, discovered-lead count, opened-detail count, and limitation note. Record every discovered lead in `leads[]`, including duplicates, inaccessible pages, out-of-scope results, and leads that were never opened. This creates an auditable funnel:

`query -> discovered lead -> opened detail page -> assessed listing -> recommendation/rejection`

Do not set coverage status manually. The runtime derives `complete`, `partial`, or `blocked` from the attempts:

- `searched`: primary results were inspected;
- `discovery-only`: leads were visible but primary details could not be verified;
- `blocked` or `unavailable`: access failed;
- `skipped`: deliberately not searched, with a reason.

After two consecutive empty operations for the same family/source approach, stop reformulating it and record the limitation.

### Structured public evidence

When the visible page is sparse, inspect public page data without bypassing access controls. Prefer, in order:

1. visible employer or ATS job content;
2. public `JobPosting` JSON-LD embedded in that exact page;
3. public ATS JSON endpoints linked to the vacancy;
4. employer or ATS sitemaps for discovery;
5. indexed snippets only as low-confidence discovery evidence.

Structured data may support title, organisation, location, posting date, closing date, employment terms, and application URL. Record its source URL and `sourceType`; do not silently merge conflicting dates.

## Build the evidence session

Create `.nz-job-scout-session-<timestamp>.json` in the user's current project directory. Do not place it in the plugin installation or store credentials, raw browser state, or unnecessary CV contents.

For each assessed vacancy record:

- programme type, contract type, and workload as separate dimensions;
- engagement model, location, arrangement, hours, duties, and technology requirements;
- primary source and application URLs;
- every observed posting, closing, start, and end date with provenance and confidence;
- hard eligibility rules and selection preferences separately, each with `met`, `not-met`, or `unknown` compatibility;
- explicit work-right requirements separately from candidate work rights;
- exact detail-page and application-route evidence with a `Pacific/Auckland` verification time.

Do not confuse a full-time fixed-term summer internship with permanent full-time employment. A temporary student visa is not unrestricted work rights. `unknown` is safer than an unsupported `met`.

Treat events, talent pools, candidate programmes, and recruitment channels as `relatedOpportunities[]`, not jobs. Preserve conditional audiences: for example, an event open only to candidates already registered for a programme is `conditional`, not generally open. Do not encode one user's channel preference as a universal exclusion.

## Validate and report

Quote paths and run:

```bash
nz-job-scout validate --input "/absolute/path/to/.nz-job-scout-session-TIMESTAMP.json"
nz-job-scout report --input "/absolute/path/to/.nz-job-scout-session-TIMESTAMP.json" --output "/absolute/path/to/output/nz-jobs-YYYY-MM-DD.md"
```

If the installed command is unavailable:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" validate --input "/absolute/path/to/.nz-job-scout-session-TIMESTAMP.json"
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" report --input "/absolute/path/to/.nz-job-scout-session-TIMESTAMP.json" --output "/absolute/path/to/output/nz-jobs-YYYY-MM-DD.md"
```

The runtime is authoritative for validation, date conflicts, search coverage, deduplication, fit scoring, eligibility blockers, categorisation, and Markdown output. Correct invalid evidence instead of bypassing validation or hand-editing scores.

The report separates:

- verified recommendations;
- verified stretch roles;
- high-value leads requiring manual verification;
- verified closed or unavailable roles;
- practically incompatible roles;
- verified low-fit roles;
- other rejected or unverified items;
- related opportunities and recruitment channels.

If today's report already exists, the runtime appends only new or materially changed items. Across recent daily reports, unchanged roles are suppressed. A changed closing date, availability state, application route, requirement, or verification outcome must reappear as `Updated evidence`.

After a successful report, remove the exact temporary session filename unless the user asks to keep it. Never use a wildcard in the cleanup command.

## Return the result

Give the absolute report path, the search funnel counts, strongest verified roles, manual-verification leads, blockers, and coverage limits. Do not recommend a role merely because logistics fit when the day-to-day work fit is weak.

Use bounded language:

- complete coverage with no qualifying roles: “Today there are no new qualified vacancies.”
- partial coverage: “No additional roles were verified among accessible sources; coverage was incomplete.”
- blocked coverage: “The search could not be completed, so no conclusion can be made about vacancy availability.”

Never claim market-wide absence from a partial or blocked run.

## Action boundary

Searching, reading, comparing, and writing the local report are allowed. Applying, uploading a CV, sending messages, creating accounts, or submitting personal information requires explicit approval at that moment. This skill is an interactive research workflow, not an unattended crawler or application bot.
