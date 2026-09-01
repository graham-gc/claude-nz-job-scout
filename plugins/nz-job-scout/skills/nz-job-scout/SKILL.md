---
name: nz-job-scout
description: Use when the user wants to analyse a local PDF or Markdown CV, search for New Zealand jobs, verify job listings, compare role fit, or produce a Markdown job report.
---

# NZ Job Scout

Find real, currently available New Zealand vacancies and assess them against the candidate's actual experience, constraints, and goals.

## Required inputs

Accept either or both of these inputs:

- a CV path (`.pdf` or `.md`) or candidate profile already supplied in the conversation;
- explicit search criteria, including any combination of role titles, keywords, employment types, locations, work arrangements, availability, work-right constraints, and posting-age window.

Do not require the user to name a search mode. Infer it from the supplied inputs:

- `profile`: a CV or candidate profile is supplied without explicit job criteria;
- `criteria`: explicit job criteria are supplied without a CV or candidate profile;
- `combined`: both are supplied.

At least one of a candidate profile or explicit search criteria is required. If neither is available, ask one concise question requesting either a resume path or the desired job criteria.

Defaults:

- maximum posting age: 30 days;
- vacancy state: currently open with a directly verified application route;
- geography: New Zealand, unless the user or candidate context supplies a narrower constraint;
- employment type and work arrangement: do not invent restrictive filters when they cannot be inferred reliably.

Do not repeatedly ask for information already present in the CV or conversation. If a missing preference would materially change results, ask one concise question; otherwise use a conservative assumption and disclose it.

Before searching, read `${CLAUDE_PLUGIN_ROOT}/skills/nz-job-scout/references/session-format.md` completely. It is the contract between browser research and the deterministic report runtime.

## Workflow

### 0. Automatic browser and session preflight

Session handling is internal behaviour. Do not ask the user whether to use their login state and do not require session-related wording in the request.

1. Check whether interactive `claude-in-chrome` browser tools are available.
2. If available, use the visible browser for SEEK, LinkedIn, Trade Me Jobs, and other JavaScript-heavy sites.
3. If a requested site is already authenticated, use that existing browser session automatically.
4. If the browser is unavailable, the site is logged out, or access is blocked by a login wall or CAPTCHA, do not request credentials and do not stop the whole search. Skip session-only behaviour and continue with publicly accessible employer career sites and ATS pages.

Record inaccessible sources as `blocked` or `unavailable` and classify overall coverage as `partial` when at least one primary public source was searched. Use `blocked` only when no primary source could be searched. Never silently label the run `complete` after skipping SEEK or LinkedIn.

The browser integration supplies access to visible pages under the user's existing login state. Never inspect, request, export, or persist cookies, passwords, tokens, local storage, or other authentication material.

A Skill cannot install the browser extension or declare the user's browser login as a package dependency. Chrome support is an optional capability that improves coverage, not a user-selected search mode or a hard installation prerequisite.

### 1. Read and model the candidate

In `profile` or `combined` mode, read the complete CV. For PDF input, use Claude's document-reading capability; for Markdown, read the source text directly.

Build the `candidate` object described in the session-format reference. Classify each skill as `core`, `frequent`, `working`, or `exposure`. Base this on duration, repeated use, recency, project ownership, production responsibility, and outcomes. A technology is not a strong skill merely because it appears once.

In `criteria` mode, do not claim to have assessed personal fit. Build the minimal candidate object required by the evidence contract from only the user's stated criteria, leaving unsupported skills and personal constraints empty.

Resolve search scope before browsing. In `profile` mode, derive role families and useful query variants from sustained, recent work rather than every CV keyword. In `criteria` mode, preserve the user's constraints. In `combined` mode, explicit criteria constrain or override inferred preferences, while the CV determines experience-based ranking inside that scope.

### 2. Search in the browser

- For SEEK and LinkedIn, use the interactive browser and the pages visible to the user.
- Never use `WebFetch`, `Fetch`, `curl`, or another direct HTTP client on SEEK or LinkedIn job pages. These sites commonly return 403 or login walls to non-browser requests, and a successful raw response would not prove that the user's application route works.
- Work through the existing browser session and visible page state; do not access authentication material directly.

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

Before building the session, classify search coverage as `complete`, `partial`, or `blocked` according to the session-format reference. Access errors belong in `searchCoverage.sources`, not only in assumptions. Never equate zero collected listings with a complete search.

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

Also record every intended source and its search status. If SEEK returned 403 and no interactive browser was available, coverage is `blocked` unless another primary source was successfully searched. A blocked or partial run may still produce a diagnostic report, but it must not conclude that no suitable vacancies exist.

Create the JSON as a temporary file outside the plugin installation directory. Do not store credentials or raw browser state. Never bypass CAPTCHAs, rate limits, access controls, or site restrictions; skip the affected source and record the reduced coverage.

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

Say “Today there are no new qualified vacancies” only when `searchCoverage.status` is `complete`. For `partial`, say that no roles were found among accessible sources and that coverage was incomplete. For `blocked`, say that the search could not be completed and no conclusion can be made about vacancy availability.

When coverage is blocked because no primary source was accessible, finish with a diagnostic report. Do not ask the user to choose a session mode, provide credentials, or repeat the request with special session wording.

## Search modes

Select the mode automatically; the user never needs to pass a mode flag.

### Profile

Use when a resume or candidate profile is supplied without explicit job criteria. Derive several focused search families from the candidate's sustained, recent, and demonstrably strong work. Default to active New Zealand vacancies posted in the last 30 days. Do not narrow location, employment type, or work arrangement without supporting candidate context.

### Criteria

Use when search conditions are supplied without a resume. Treat those conditions as the source of truth. Synonymous query variants may be used for discovery, but do not silently broaden material constraints. Rank by criteria relevance and practical compatibility; do not present a personalised CV-match score.

### Combined

Use when both a resume and search conditions are supplied. Explicit conditions define the eligible vacancy set. Use the resume to rank those vacancies by real experience depth, recency, ownership, and outcomes. Never discard an explicit condition merely because a broader role would fit the CV.

## Action boundary

Searching, reading, comparing, and writing a local report are allowed. Applying, uploading a CV, sending a message, creating an account, or submitting personal data requires explicit approval at the moment of action. This skill performs an interactive search; it is not an unattended background crawler or application bot.
