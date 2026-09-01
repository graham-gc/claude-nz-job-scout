# claude-nz-job-scout

A Claude Code plugin for evidence-based New Zealand job discovery, CV matching, and Markdown reporting.

> Status: **0.2.4 alpha — usable interactive MVP.** Claude reads the CV and researches live pages; the bundled zero-dependency runtime validates evidence, rejects stale or unsuitable listings, deduplicates, scores, and writes the report.

## What works now

- reads a local Markdown or PDF CV through Claude;
- models skill depth as core, frequent, working, or exposure;
- automatically supports CV-driven, criteria-only, and combined searches;
- can use an existing signed-in browser session without extracting credentials;
- requires the exact vacancy page and application route to be observed;
- rejects expired, stale, duplicate, aggregator-only, and practically incompatible roles;
- scores role fit separately from employment, location, availability, and work-right fit;
- distinguishes complete, partial, and blocked searches so access failures are never reported as “no vacancies”;
- saves a structured Markdown report.

The default posting window is 30 days and can be overridden.

## Automatic login-session handling

Users do not choose a session mode and do not need to mention Chrome in each request. On every run the Skill automatically:

1. checks whether `claude-in-chrome` browser tools are available;
2. uses the existing browser login automatically when the requested site is already signed in;
3. never reads or stores cookies, passwords, access tokens, or browser storage;
4. skips session-only access when Chrome is unavailable or the site is logged out, then continues with public employer and ATS pages;
5. reports the resulting search coverage as complete, partial, or blocked.

Failure to obtain a logged-in session does not abort the entire search. It reduces coverage, and the report must disclose which sources were unavailable.

### Optional Chrome setup for broader coverage

Chrome is not an installation prerequisite, but connecting it gives the Skill access to SEEK, LinkedIn, Trade Me Jobs, and other JavaScript-heavy pages under the user's existing login state.

1. Install and enable the official Claude in Chrome extension.
2. Sign into the desired job sites normally in Chrome.
3. Run `/chrome` in Claude Code and connect the extension.
4. Run `/mcp` to confirm that `claude-in-chrome` is available.

Alternatively, start the CLI with:

```bash
claude --chrome
```

See the official [Claude Code with Chrome documentation](https://code.claude.com/docs/en/chrome) for installation, permissions, and troubleshooting.

## Install from GitHub

Run these commands inside Claude Code:

```text
/plugin marketplace add graham-gc/claude-nz-job-scout
/plugin install nz-job-scout@graham-nz-tools
/reload-plugins
```
If the plugin is already installed, refresh it after a new version has been pushed:

```text
/plugin marketplace update graham-nz-tools
/plugin update nz-job-scout@graham-nz-tools
/reload-plugins
```

Version changes are not loaded from the working repository automatically; Claude Code runs the cached installed version until it is updated and reloaded.


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

When Chrome is connected and a site is already signed in, the Skill uses that session automatically. Otherwise it continues without authenticated access and marks the reduced coverage in the report.

## How it works

1. Claude infers the search mode from the supplied resume and/or criteria, then models the candidate when a resume is available.
2. Claude searches and opens primary job pages in the browser.
3. Claude creates a temporary evidence-session JSON.
4. `nz-job-scout` validates, filters, deduplicates, scores, and writes the report.
5. Claude returns the report path and explains the strongest matches and blockers.

Everything needed at runtime is included in the plugin. Users do **not** need to run `npm install`.

## Reliability policy

A recommended listing must have a directly opened job-detail page, no visible expired state, a working application route or current application instructions, a posting date inside the requested window, and a verification timestamp. Aggregators can be used only to discover leads; they cannot be final evidence.

## SEEK or LinkedIn returns 403

Do not retry those pages with `Fetch`, `WebFetch`, or `curl`. A 403 normally means the site rejected a non-browser request; it does not mean the vacancy has expired.

The Skill automatically skips the blocked authenticated source and continues with accessible employer or ATS pages. Connecting Claude in Chrome can restore broader coverage, but it is not required to run the Skill.

The plugin never asks for or extracts your cookies or login credentials.

## Current boundaries

- This is an interactive research workflow, not an unattended scheduled crawler.
- Site coverage depends on pages that Claude can access; unavailable login-only or CAPTCHA-protected sources are skipped and disclosed.
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
