---
name: nz-job-scout
description: Use when the user wants to analyse a local PDF or Markdown CV, search for New Zealand jobs, verify job listings, compare role fit, or produce a Markdown job report.
---

# NZ Job Scout

Find real, currently available New Zealand vacancies and assess them against the candidate's actual experience, constraints, and goals.

## Required inputs

Obtain or infer only what is necessary:

- CV path (`.pdf` or `.md`) or a candidate profile already supplied in the conversation;
- search mode: profile-driven or explicit keywords;
- desired employment types, locations, and work arrangements;
- availability and New Zealand work-right restrictions;
- posting-age window, defaulting to 30 days.

Do not repeatedly ask for information already present in the CV or conversation. If a missing preference would materially change results, ask one concise question; otherwise use a conservative assumption and disclose it.

Before searching, read `${CLAUDE_PLUGIN_ROOT}/skills/nz-job-scout/references/session-format.md` completely. It is the contract between browser research and the deterministic report runtime.

## Workflow

### 1. Read and model the candidate

Read the complete CV. For PDF input, use Claude's document-reading capability; for Markdown, read the source text directly.

Build the `candidate` object described in the session-format reference. Classify each skill as `core`, `frequent`, `working`, or `exposure`. Base this on duration, repeated use, recency, project ownership, production responsibility, and outcomes. A technology is not a strong skill merely because it appears once.

### 2. Search in the browser

Before issuing searches, determine whether an interactive browser session is available.

- For SEEK and LinkedIn, use the interactive browser and the pages visible to the user.
- Never use `WebFetch`, `Fetch`, `curl`, or another direct HTTP client on SEEK or LinkedIn job pages. These sites commonly return 403 or login walls to non-browser requests, and a successful raw response would not prove that the user's application route works.
- If personalised results are requested, let the user connect Claude in Chrome and sign in themselves. Work through that browser session; never request, read, copy, save, or export cookies, passwords, session tokens, or browser storage.
- If no interactive browser is available, tell the user once that SEEK and LinkedIn cannot be reliably verified and ask them to connect a browser. Do not continue issuing equivalent search queries that return zero searches.

Search direct sources first:

- SEEK New Zealand;
- LinkedIn Jobs;
- Trade Me Jobs;
- employer career sites and their ATS pages.

A public web-search tool may be used to discover employer or ATS pages that can be opened normally. Search snippets and aggregator pages are leads only, not verification evidence. Replace every aggregator link with a currently open primary page before recommending it. Do not return full-time permanent roles when the requested scope is internships or part-time work merely because technical keywords match.

Use this failure routing:

1. On a 401, 403, login wall, CAPTCHA, or access-denied response, stop direct requests to that source immediately.
2. Switch to the interactive browser if available.
3. Otherwise search for a direct employer/ATS copy of the vacancy.
4. If no primary page can be opened, record the lead as unverified or omit it. Never label the access error as an expired vacancy.
5. After two consecutive search operations return no results, stop reformulating the same query family and report the coverage limitation.

Never claim that a listing was verified unless its exact detail page and application route were observed.

### 3. Build an evidence session

For every candidate vacancy, open the exact detail page and capture all required fields in the session JSON, including:

- exact title, employer, location, arrangement, and employment type;
- source and direct application URLs;
- posting and closing dates when visible;
- required and preferred skills based on the role's responsibilities;
- whether the detail page opened and an application route exists;
- visible expired or unavailable indicators;
- verification time in `Pacific/Auckland` time;
- availability and work-right compatibility only when supported by evidence.

Create the JSON as a temporary file outside the plugin installation directory. Do not store credentials or raw browser state. Never bypass CAPTCHAs, rate limits, access controls, or site restrictions; let the user complete login and challenge screens.

### 4. Validate and generate the report

Run the bundled, dependency-free runtime. Quote all paths.

```bash
nz-job-scout validate --input "/absolute/path/to/session.json"
nz-job-scout report --input "/absolute/path/to/session.json" --output "/absolute/path/to/output/nz-jobs-YYYY-MM-DD.md"
```

If the executable is not on `PATH`, use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" validate --input "/absolute/path/to/session.json"
node "${CLAUDE_PLUGIN_ROOT}/bin/nz-job-scout" report --input "/absolute/path/to/session.json" --output "/absolute/path/to/output/nz-jobs-YYYY-MM-DD.md"
```

The runtime is authoritative for evidence validation, stale-listing rejection, deduplication, role-fit scoring, practical blockers, and Markdown formatting. Do not hand-edit scores to make a result look stronger. If validation fails, correct the evidence JSON rather than bypassing validation.

Unless the user requests another location, write to `output/nz-jobs-YYYY-MM-DD.md` under the user's project directory. Remove the temporary session file after a successful report unless the user asks to keep the evidence.

### 5. Return the result

Tell the user:

- the absolute report path;
- how many listings were reviewed, recommended, rejected, or unverified;
- the strongest verified matches and their main blockers or gaps;
- whether browser/login limitations affected coverage.

If no role survives verification and practical constraints, say clearly: “Today there are no new qualified vacancies.”

## Search modes

In profile mode, derive search families from the candidate's sustained work. In keyword mode, preserve the user's keywords exactly as search criteria; use the CV only for ranking unless the user opts out.

## Action boundary

Searching, reading, comparing, and writing a local report are allowed. Applying, uploading a CV, sending a message, creating an account, or submitting personal data requires explicit approval at the moment of action. This skill performs an interactive search; it is not an unattended background crawler or application bot.
