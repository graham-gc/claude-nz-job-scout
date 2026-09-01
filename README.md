# claude-nz-job-scout

A Claude Code plugin for evidence-based New Zealand job discovery, CV matching, and Markdown reporting.

> Status: **0.3.2 alpha — public-source MVP.** Claude reads the CV and researches public job pages; the bundled zero-dependency runtime validates evidence, rejects stale or unsuitable listings, deduplicates, scores, and writes the report.

## What works now

- reads a local Markdown or PDF CV through Claude;
- models skill depth as core, frequent, working, or exposure;
- automatically supports CV-driven, criteria-only, and combined searches;
- uses only job information available without authentication or private credentials;
- requires the exact vacancy page and application route to be observed;
- rejects expired, stale, duplicate, aggregator-only, and practically incompatible roles;
- scores role fit separately from employment, location, availability, and work-right fit;
- distinguishes complete, partial, and blocked searches so access failures are never reported as “no vacancies”;
- saves a structured Markdown report.

The default posting window is 30 days and can be overridden.

## Public-source policy

The Skill searches only sources that can be accessed without signing in. Its normal source set is:

- employer career websites;
- public ATS pages such as Workday, Greenhouse, Lever, SmartRecruiters, Ashby, and BambooHR;
- public job-board pages and feeds where anonymous automated access is permitted;
- general web search for discovering primary employer or ATS pages.

SEEK, LinkedIn, or another job board may appear in public search results, but an indexed result is a discovery lead rather than final evidence. The Skill replaces it with an anonymously accessible employer or ATS vacancy page before recommending the role whenever possible.

The Skill never asks for or uses:

- account passwords;
- cookies or exported browser sessions;
- private browser profiles;
- Claude in Chrome;
- SEEK Partner credentials or other employer-only API credentials.

If a source presents a login wall, CAPTCHA, 401, 403, or other access restriction, the Skill skips it, looks for a public employer copy, and records the coverage limitation. It does not attempt to bypass access controls.

## Install from GitHub

Run these commands in a **system terminal** such as macOS Terminal, iTerm, or the VS Code terminal. Do not enter them in Claude Code's `/plugin` screen.

```bash
claude plugin marketplace add graham-gc/claude-nz-job-scout
claude plugin install nz-job-scout@graham-nz-tools
```

If the plugin is already installed, refresh the marketplace catalogue and then update the plugin from the system terminal:

```bash
claude plugin marketplace update graham-nz-tools
claude plugin update nz-job-scout@graham-nz-tools
```

After installing or updating, start a new Claude Code session. If Claude Code is already running, enter this command **inside the Claude Code session**:

```text
/reload-plugins
```

Some Claude Code builds route `/plugin ...` input to the interactive plugin manager and ignore the remaining subcommand. The terminal commands above avoid that behaviour and are the recommended installation and update method for this plugin.

Version changes are not loaded from the working repository automatically; Claude Code runs the cached installed version until it is updated and reloaded.

### Web access permission

NZ Job Scout pre-approves only the tools required by its routine workflow: reading the supplied resume, searching and fetching public pages, writing its narrowly named temporary evidence file, running the bundled validator and report generator, and deleting that temporary file. After the user accepts the plugin trust prompt, these routine actions do not require approval one by one.

This permission:

- applies only while this Skill is active;
- does not grant access to logged-in sessions, cookies, or private browser data;
- restricts shell approval to the bundled validation/report commands and cleanup of the Skill's temporary evidence file;
- can be inspected or revoked at any time with `/permissions` inside Claude Code.

A separate prompt can still appear when the resume is outside Claude Code's current working directories, the user chooses a non-default output location, or a managed organisational policy requires confirmation. The Skill does not and cannot bypass those boundaries.

Users who do not trust these permissions should not install or invoke the Skill. Claude Code permission deny rules and managed organisational policies always take precedence.


Then invoke the namespaced skill:

### 1. Resume-driven search

Provide a local PDF or Markdown resume and no additional job criteria. The Skill derives suitable role families from sustained experience and searches current New Zealand vacancies posted in the last 30 days.

```text
/nz-job-scout:nz-job-scout Use my resume at <absolute-path-to-your-resume> to find the best-matching current New Zealand jobs.
```

### 2. Criteria-only search

A resume is not required. State any combination of role, keywords, location, employment type, work arrangement, or posting window.

```text
/nz-job-scout:nz-job-scout Find current Auckland hybrid Java backend or test automation roles posted in the last 14 days.
```

### 3. Resume plus criteria

Provide both. Explicit criteria constrain the search, while the resume is used to assess genuine experience depth and rank the results.

```text
/nz-job-scout:nz-job-scout Use my resume at <absolute-path-to-your-resume> and find paid Auckland internships or part-time test automation roles posted in the last 30 days.
```

Replace `<absolute-path-to-your-resume>` with the path to the user's own local resume. All three forms accept natural language; users do not need to declare a mode. The default posting window is 30 days, and every returned vacancy must still be open and directly verifiable.

## How it works

1. Claude infers the search mode from the supplied resume and/or criteria, then models the candidate when a resume is available.
2. Claude discovers and opens anonymously accessible employer, ATS, and permitted public job pages.
3. Claude creates a temporary evidence-session JSON.
4. `nz-job-scout` validates, filters, deduplicates, scores, and writes the report.
5. Claude returns the report path and explains the strongest matches and blockers.

Everything needed at runtime is included in the plugin. Users do **not** need to run `npm install`.

## Reliability policy

A recommended listing must have a directly opened job-detail page, no visible expired state, a working application route or current application instructions, a posting date inside the requested window, and a verification timestamp. Aggregators can be used only to discover leads; they cannot be final evidence.

## A job board blocks anonymous access

The Skill stops using that source for the current run. It may use public search results to locate the employer's own vacancy page, but it does not retry with credentials, a browser session, or alternate scraping methods.

An access error does not prove that a vacancy has expired. The report records the source as blocked or unavailable and states whether search coverage was complete, partial, or blocked.

## Current boundaries

- This is an interactive research workflow, not an unattended scheduled crawler.
- Coverage is limited to sources that permit anonymous access; login-only and restricted sources are skipped and disclosed.
- The standalone runtime does not parse PDFs; Claude reads them before creating the evidence session.
- Website changes can require updates to the skill instructions.
- The plugin does not apply, upload a CV, send messages, or submit personal information without explicit approval.

## Repository layout

```text
.claude-plugin/marketplace.json               Marketplace catalogue
plugins/nz-job-scout/.claude-plugin/         Plugin manifest
plugins/nz-job-scout/skills/                 Skill and evidence contract
plugins/nz-job-scout/bin/                    Installed command
plugins/nz-job-scout/runtime/                Zero-dependency report runtime
plugins/nz-job-scout/src/                    Typed development modules
plugins/nz-job-scout/tests/                  Unit and runtime tests
examples/                                    Example session and report
```

## Local development

Requirements: Node.js 20 or later and Claude Code.

```bash
cd plugins/nz-job-scout
npm install
npm run typecheck
npm test
node bin/nz-job-scout validate --input ../../examples/session.example.json
node bin/nz-job-scout report --input ../../examples/session.example.json --output /tmp/nz-job-scout-report.md
```

From the repository root:

```bash
claude plugin validate .
```

## License

MIT
