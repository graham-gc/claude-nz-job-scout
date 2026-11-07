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

Find real, currently available New Zealand vacancies and assess them against the candidate's actual experience, constraints, and goals.

## Minimal workflow

The skill exists for one closed loop: **resume → suitable current jobs → an immediately usable application path**.

Accept a PDF or Markdown resume, optional natural-language criteria, or both. A resume-only request uses the role families and locations that are clearly supported by the resume. Explicit criteria narrow or extend that scope. Default to vacancies posted within the last 7 days, unless the user explicitly requests another window.

Use the criteria already supplied in the request and the work rights stated in the CV. Do not reconfirm supplied information or the default posting window. Leave unsupported facts unknown and continue with verifiable matches. Ask one short question only when a missing fact prevents a useful scan.

Read [references/session-format.md](references/session-format.md) before producing the evidence session. Read [references/state-file.md](references/state-file.md) only if a state file exists or the user provides a role decision.

**Do not inspect old reports during a scan.** Use the current resume, request, and project decision state. Do not list or open prior `output/nz-jobs-*.md` files, extract their context markers, or compare their dates or role families. The bundled `report` command reads report history and deduplicates automatically at the end. For a separate request to review a specific old report, use `Read` on that file directly; do not run a scan or a shell command just to review it.

**Use only the Bash commands declared in `allowed-tools` above, one per tool call, with literal arguments.** No helper commands for file discovery, history checks, or output parsing; no assignments, loops, pipes, redirects, or chained commands. If a permitted command cannot run, state the limitation instead of replacing it with a shell script.

## Public-source boundary

Use only anonymously accessible information. Never request, inspect, import, export, or retain cookies, passwords, tokens, browser storage, private profiles, logged-in sessions, paid extensions, or employer-only partner credentials.

Use `WebSearch` to find leads and `WebFetch` to read the public employer careers page, vacancy, or linked ATS page. The bundled `inventory-batch` command below is the only shell-based discovery route. Use public ATS board links confirmed from employer careers pages, not provider or account guesses. Keep approved commands separate in the project directory. Do not improvise `curl`, `wget`, inline Node/Python, shell loops, pipelines, or guessed API paths to discover vacancies or recover missing page data.

Prefer primary sources:

- employer career sites;
- public ATS pages and feeds such as Workday, Greenhouse, Lever, SmartRecruiters, Ashby, and BambooHR;
- public-sector, university, and permitted public job-board pages.

Use general search, SEEK, LinkedIn, Trade Me Jobs, aggregators, and indexed snippets only for discovery when publicly visible. A discovery result is not verification. Replace it with the exact public employer or ATS vacancy page before recommending it.

If neither the public careers pages nor an identified supported ATS lets you inspect the employer's vacancies, make at most one follow-up `WebSearch` for the employer's public vacancies in the target location. Follow a verified public link if one is found. Otherwise record the source as blocked, unavailable, or discovery-only as appropriate, retain any unresolved lead, and continue with other sources. Access failure does not mean the vacancy is closed.

## Recommendation gate

Only include a role in **Ready to apply** or **Worth considering** when all of these are true:

1. Its exact employer or public ATS vacancy page was opened.
2. Its posting date is visible and within the requested time window.
3. It has not closed or been removed.
4. The report can show either a direct online application link, or a plain email address with the employer's instructions.
5. Its daily responsibilities have genuine overlap with the resume or explicit criteria.

A `mailto:` link by itself is not an application route. If email is the method, record the email address, instructions, and any required materials. A job without these facts may be kept as a private research lead, but must not appear in the user-facing recommendations.

## Candidate model

For `profile` and `combined` modes, read the complete CV. Use document reading for PDF and direct text reading for Markdown.

Re-read the supplied resume on every invocation and calculate its SHA-256 with `shasum -a 256`. Store only that digest as `resumeFingerprint`; never store a global candidate profile. `profile` and `combined` sessions require the digest. `criteria` sessions omit it. A supplied resume always makes the mode `profile` or `combined`, never `criteria`.

Model:

- `skills`: concrete languages, frameworks, databases, protocols, and tools;
- `capabilities`: work repeatedly performed, such as backend development, API automation, performance testing, debugging, internal tooling, or technical support;
- `qualifications`, structured availability windows, and structured work rights separately.

Classify skills and capabilities as `core`, `frequent`, `working`, or `exposure` from duration, repetition, recency, ownership, production responsibility, and outcomes. Keyword presence alone is not evidence of proficiency. Do not infer AI/ML, cloud, frontend, mobile, or another speciality from an adjacent term.

In `criteria` mode, create the neutral candidate object defined in the reference. Do not imply that a CV or personal fit was assessed.

## Search planning and discovery

Start every evidence session with `pluginVersion: "0.8.6"` and `sessionSchemaVersion: 6`. Set `preferences.maxPostingAgeDays` to `7` unless the user explicitly requests another window. If validation reports another version, stop and tell the user that Claude Code is running a stale installed plugin; do not silently fall back to an older schema.

Before discovery, read `.nz-job-scout-state.json` from the current project when present. Do not search for or report matching applied, rejected, not-interested, or closed roles. Update this file only after an explicit user decision; never infer rejection from silence or lack of progress.

Build search families from the user's explicit request plus sustained responsibility areas in the resume. Use a small number of broad role, programme and location queries; do not attempt to enumerate title-and-skill combinations. A role title is only a lead—read its duties before deciding fit.

Apply the requested posting window during discovery whenever a source offers a reliable posted-date filter (7 days by default). Still inspect broad public inventories to avoid missing generic titles, but recommend only vacancies whose exact employer/ATS page verifies a posting date inside the window. Do not treat a search-index date, crawl date, or page update date as the vacancy's posting date. Keep undated leads unverified rather than calling them new.

When the request includes internships, graduate roles, studentships, placements, fixed-term student work, part-time student work, or summer work, set `programmeFirstRequired: true` and perform a `programme-discovery` pass before stack-specific searching. Inspect broad student and early-career programme inventories without CV technology terms. Capture every plausibly technical vacancy first, including generic titles such as Technology Services Intern, Digital Services Intern, Systems Intern, ICT Intern, Service Management Intern, and Application Support Intern. Rank or reject them only after reading their duties. A title that omits “software”, “Java”, “QA”, or “automation” must not be discarded before duty review.

For every intended family, complete both discovery routes:

1. `broad-discovery`: use a deliberately broad role/stage/location query. Avoid adding a specific technology unless the user made it mandatory. For example, prefer `software testing intern Auckland` over a narrow stack phrase such as `Java API test automation internship Auckland`.
2. `source-inventory`: inspect a public collection of vacancies, such as a location/category result page, an employer careers listing, an ATS board/feed, or a public sitemap. Capture every plausibly relevant lead visible in the inspected collection before filtering it by CV fit.

Use `focused-follow-up` only to close a demonstrated gap; it is not a requirement to enumerate every possible job title. Merge duplicate leads within the current scan after discovery, not by narrowing discovery queries. Leave cross-report deduplication to `report`.

Whenever a lead reveals an employer operating in an intended responsibility family, decide whether the employer inventory needs expansion. Set `employerExpansionRequired: true` when the employer was discovered through a board, search result, inaccessible detail page, closed role, senior role, permanent role, or another listing that does not establish that the employer's current vacancy inventory was inspected. Then perform one `employer-expansion` attempt covering that employer's public careers/ATS inventory or a broad employer-and-location vacancy search. A specific role being unsuitable is not a reason to skip the employer expansion. Set the flag to `false` only when the lead itself came from an already-inspected employer/ATS inventory or the employer is demonstrably outside the requested responsibility families, and record the reason.

Continue discovery adaptively. After both required routes are attempted for a family, stop optional reformulation when two consecutive `focused-follow-up` operations produce no new canonical vacancy identities. Finding one vacancy is never a stopping condition. A blocked source makes coverage partial; it does not justify repeated retries or bypassing access controls.

Create `searchCoverage.sourceTargets[]` before searching. Every ordinary scan has an eight-source minimum plan: one target each for `web-search`, `seek`, `linkedin`, and `trade-me`, plus four distinct public employer or ATS inventories. Use `channel` to identify each target. LinkedIn, SEEK and Trade Me may be `blocked` or `discovery-only`, but they must still be planned and their limitation recorded; do not silently omit them. Use one employer/ATS target per named employer; never group several employers under one URL. For programme-first scans, add a programme-inventory target whose public listing collection is broad enough to expose generic early-career titles. Record `inventoryScope`, the exact target URL, every inspected `itemUrls` entry, and the matching `itemsInspected` count, including zero. Set each target to `searched`, `discovery-only`, `blocked`, `unavailable`, or `skipped` after the run. An aggregator, unrelated overseas inventory, single job detail page, event page, or search snippet is not a completed employer or Auckland/New Zealand programme inventory.

When the user explicitly permits technical volunteering, set `preferences.includeTechnicalVolunteer: true`, add a technical-volunteer source target, and search only for roles with clearly stated software, QA, automation, backend, platform, developer-productivity, or software-support duties. Record `engagementModel: "volunteer"`, `isTechnicalVolunteer: true`, and whether it is paid, unpaid, reimbursed, or unknown. Do not label a general community, event, fundraising, or administrative role as technical. Never present volunteer work as paid employment.

When the candidate explicitly rules out a technology as a core daily requirement, record a hard `excludeCoreSkill` constraint. A role whose required technology matches that constraint is practically incompatible even if its title or generic duties look related.

## Search audit trail

For every search operation, record a `searchCoverage.attempts[]` entry with its role family, strategy, source, exact query, result status, discovered-lead count, opened-detail count, optional employer, and limitation note. Record every discovered lead in `leads[]`, including duplicates, inaccessible pages, out-of-scope results, and leads that were never opened. Each lead must record `priority`, `directSourceStatus`, and the employer-expansion decision and reason. Every `assessed` lead must have a matching `jobs[]` evidence record. High-priority blocked or unopened leads must stay visible for manual verification rather than disappearing. This creates an auditable funnel:

`query -> discovered lead -> opened detail page -> assessed listing -> recommendation/rejection`

Do not set coverage status manually. The runtime derives `complete`, `partial`, or `blocked` from the attempts. Complete coverage requires every explicit family to remain present; every family to have successful `broad-discovery` and `source-inventory` attempts; every required employer expansion to be completed; and, when programme-first is required, both a successful `programme-discovery` attempt and a searched programme inventory:

- `searched`: the intended discovery result set or public inventory was inspected;
- `discovery-only`: leads were visible but primary details could not be verified;
- `blocked` or `unavailable`: access failed;
- `skipped`: deliberately not searched, with a reason.

Do not describe a run as complete merely because each family has one generic `searched` attempt. A run missing any baseline discovery channel or fewer than four distinct public employer/ATS inventories is partial even if other attempts succeeded.

### Structured public evidence

Use the following evidence when the public page tools or bundled adapter expose it. Prefer, in order:

1. visible employer or ATS job content;
2. public `JobPosting` JSON-LD embedded in that exact page;
3. public ATS JSON endpoints linked to the vacancy;
4. employer or ATS sitemaps for discovery;
5. indexed snippets only as low-confidence discovery evidence.

Structured data may support title, organisation, location, posting date, closing date, employment terms, and application URL. Record its source URL and `sourceType`; do not silently merge conflicting dates.

Collect confirmed supported ATS boards across the planned employers first. Query them together using the bundled adapter. Run it directly through Node using the plugin root; no global CLI lookup, shell wrapper, or change of directory is needed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" inventory-batch --board 'https://job-boards.greenhouse.io/example-employer' --board 'https://example-employer.bamboohr.com/careers'
```

Replace the example links with 1–10 distinct, confirmed ATS **board** URLs (not job details or endpoints). Use each URL as a literal `--board` value without tracking query or fragment. Submit exactly one Bash command per batch, with the plugin path already substituted by Claude Code. Read the compact JSON directly from the tool response. The adapter already filters clearly overseas listings and puts New Zealand leads first. Do not write its output to `/tmp`, redirect stderr, or add `python`, `node -e`, `jq`, `head`, another command, or a shell wrapper.

Each `ok` result contains location counts and discovery leads only. Check plausible `unknown` leads on the original vacancy page; do not infer that remote or regional work permits New Zealand. If a board has `nextOffset`, use another direct call with `--board 'URL' --offset NEXT_OFFSET` (literal values) for that board. This offset only continues the leads returned by the current upstream inventory response. If `sourceMayHaveMore` is true or a needed page was not reviewed, do not count that inventory as fully checked: use the public careers page or record partial coverage.

Supported boards: Workable, Greenhouse, Lever, SmartRecruiters, Ashby, BambooHR, and Workday (exact public host, including its wdN shard, and career-site path). Treat `blocked` and `unavailable` as limitations, not empty inventories. Skip `duplicate` entries and use the public-page fallback for unsupported boards. If the direct command needs approval and is denied, record the limitation and continue with accessible public pages; do not retry with a different shell script.

## Build the evidence session

Use Claude Code's file-writing tool to create `.nz-job-scout-session-<timestamp>.json` in the user's current project directory. Do not use a shell heredoc or script to write it. Do not place it in the plugin installation or store credentials, raw browser state, or unnecessary CV contents.

For each assessed vacancy record:

- programme type, contract type, and workload as separate dimensions;
- engagement model, location, arrangement, hours, duties, and technology requirements;
- every observed source in `sourceEvidence[]`, including its kind, URL, application route, observed state, and timestamp;
- the strongest primary source and application URLs, preferring employer/ATS evidence over job boards, snippets, and aggregators;
- `application`, using exactly one of:
  - `{ "method": "online", "url": "https://...", "requiredMaterials": ["CV"] }`; or
  - `{ "method": "email", "email": "jobs@example.nz", "instructions": "State the requested subject or message", "requiredMaterials": ["CV", "GitHub link"] }`;
- every observed posting, closing, start, and end date with provenance and confidence;
- hard eligibility rules and selection preferences separately, each with `met`, `not-met`, or `unknown` compatibility;
- explicit work-right requirements separately from candidate work rights;
- exact detail-page and application-route evidence with a `Pacific/Auckland` verification time.

Do not confuse a full-time fixed-term summer internship with permanent full-time employment. A temporary student visa is not unrestricted work rights, and full-time availability during a scheduled break is not post-study work status. Record a work-right `evidenceSource`; leave facts unknown unless the user, CV, or an official document states them. `unknown` is safer than an unsupported `met`.

Represent technology wording as `technicalRequirements[]` groups. Use `match: "any"` for phrases such as “TypeScript, Python, Java, or similar” and `match: "all"` only when every option is required. Mark each group `required`, `preferred`, or `exposure`. Never flatten an either/or list into several mandatory skills.

One vacancy may have several evidence sources. Preserve them all. Employer and ATS evidence outrank boards, search results, and aggregators. A weaker duplicate may add a discovery trail but must never replace an already observed official URL, application status, requirement, or date.

Treat events, talent pools, candidate programmes, and recruitment channels as `relatedOpportunities[]`, not jobs. Preserve conditional audiences: for example, an event open only to candidates already registered for a programme is `conditional`, not generally open. Do not encode one user's channel preference as a universal exclusion.

## Validate and report

### Simplicity priority

The minimal workflow and recommendation gate take priority over the implementation-level audit details above. Keep research bounded: use a few broad discovery searches, then verify primary employer or ATS pages for plausible matches. Do not keep searching merely to increase funnel counts, and do not expose the audit trail, rejected roles, events, talent pools, or raw queries in the final report. The only user-facing question is: **what can this person apply for now, and how?**

Quote paths and run the bundled report command once. It validates the evidence before processing history or writing the report; do not run a separate validation command for a normal scan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" report --input "/absolute/path/to/.nz-job-scout-session-TIMESTAMP.json"
```

Run the report command from the user's current project directory. The runtime writes to `./output/nz-jobs-YYYY-MM-DD.md` and keeps history in that directory. Do not supply `--output` for the normal workflow. Only when the user explicitly requests another location may you pass both `--output "/requested/path/report.md"` and `--allow-custom-output`.

The runtime is authoritative for validation, posting age, application-route completeness, deduplication, and Markdown output. Correct invalid evidence instead of bypassing validation or hand-editing the report.

The user-facing report is deliberately short. It contains only **Ready to apply**, **Worth considering**, and concise **Scan notes**. Do not fill it with stale jobs, closed roles, activities, talent pools, raw search queries, or lengthy rejection tables.

Use the path, write outcome, and history summary printed by `report`. If needed to summarise the result, use `Read` only on that returned path; no additional report or source-code lookup is needed. If the command says the existing report was left unchanged, do not present its old entries as new results.

After a successful report, run `rm -- .nz-job-scout-session-TIMESTAMP.json` with the exact filename created in this run unless the user asks to keep it. Never use a wildcard in the cleanup command. If cleanup needs additional approval, leave the temporary file and report its path.

## Return the result

Give the absolute report path, then name only the roles the user can act on immediately. State the direct application link or email path in the response as well. The report is authoritative: do not add a date, deadline, sponsorship statement, work-right claim, recommendation, or market conclusion that is absent from it. Do not recommend a role merely because logistics fit when the day-to-day work fit is weak.

Use bounded language:

- complete coverage with no qualifying roles: “Today there are no new qualified vacancies.”
- partial coverage: “No additional roles were verified among accessible sources; coverage was incomplete.”
- blocked coverage: “The search could not be completed, so no conclusion can be made about vacancy availability.”

Never claim market-wide absence from a partial or blocked run.

## Action boundary

Searching, reading, comparing, and writing the local report are allowed. Applying, uploading a CV, sending messages, creating accounts, or submitting personal information requires explicit approval at that moment. This skill is an interactive research workflow, not an unattended crawler or application bot.
