# claude-nz-job-scout

A Claude Code plugin for evidence-based New Zealand job discovery, CV matching, and Markdown reporting.

> Status: **0.2.1 alpha — usable interactive MVP.** Claude reads the CV and researches live pages; the bundled zero-dependency runtime validates evidence, rejects stale or unsuitable listings, deduplicates, scores, and writes the report.

## What works now

- reads a local Markdown or PDF CV through Claude;
- models skill depth as core, frequent, working, or exposure;
- supports profile-driven and user-keyword searches;
- can use an existing signed-in browser session without extracting credentials;
- requires the exact vacancy page and application route to be observed;
- rejects expired, stale, duplicate, aggregator-only, and practically incompatible roles;
- scores role fit separately from employment, location, availability, and work-right fit;
- saves a structured Markdown report.

The default posting window is 30 days and can be overridden.

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

Replace `<absolute-path-to-your-resume>` with the path to **your own local PDF or Markdown resume file**.

```text
/nz-job-scout:nz-job-scout Read <absolute-path-to-your-resume> and find verified Auckland software testing or Java backend internships posted in the last 30 days. Save the report as Markdown.
```

You can also ask naturally for New Zealand job research; Claude may select the skill when the description matches.

For personalised SEEK or LinkedIn results, connect Claude in Chrome and sign in yourself. The plugin uses the browser interaction available to Claude; it does not request, extract, store, or export cookies, passwords, or tokens.

## How it works

1. Claude reads the CV and models actual skill depth and constraints.
2. Claude searches and opens primary job pages in the browser.
3. Claude creates a temporary evidence-session JSON.
4. `nz-job-scout` validates, filters, deduplicates, scores, and writes the report.
5. Claude returns the report path and explains the strongest matches and blockers.

Everything needed at runtime is included in the plugin. Users do **not** need to run `npm install`.

## Reliability policy

A recommended listing must have a directly opened job-detail page, no visible expired state, a working application route or current application instructions, a posting date inside the requested window, and a verification timestamp. Aggregators can be used only to discover leads; they cannot be final evidence.

## SEEK or LinkedIn returns 403

Do not retry those pages with `Fetch`, `WebFetch`, or `curl`. A 403 normally means the site rejected a non-browser request; it does not mean the vacancy has expired.

Connect Claude in Chrome, sign in yourself, and run the request again. The skill is instructed to use the interactive browser for SEEK and LinkedIn. If no browser is connected, it may still verify publicly accessible employer or ATS pages, but it must disclose that SEEK and LinkedIn coverage is incomplete.

The plugin never asks for or extracts your cookies or login credentials.

## Current boundaries

- This is an interactive research workflow, not an unattended scheduled crawler.
- Site coverage depends on pages that Claude can access and on the user completing login or CAPTCHA challenges.
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
