# claude-nz-job-scout

A Claude Code plugin for verified New Zealand job discovery, CV-based matching, and Markdown reporting.

> Status: pre-alpha scaffold. The plugin workflow and core scoring/reporting utilities are present. Live provider adapters and end-to-end browser tests are still under development.

## What it is for

`nz-job-scout` helps a candidate:

- read a local CV in Markdown or PDF;
- distinguish strong, frequently used skills from brief exposure;
- search by CV profile or explicit keywords;
- focus on New Zealand roles that match location, work rights, availability, and employment type;
- verify that a job detail page and application route are still active;
- separate technical fit from practical eligibility;
- save a ranked, evidence-based report as Markdown.

The default search window is 30 days. It can be overridden by the user.

## Repository layout

```text
.claude-plugin/marketplace.json          Marketplace catalogue
plugins/nz-job-scout/.claude-plugin/    Plugin manifest
plugins/nz-job-scout/skills/            Claude Code skill
plugins/nz-job-scout/src/               Typed core utilities
plugins/nz-job-scout/tests/             Unit tests
examples/                               Example configuration and report
```

Everything required by the installed plugin lives under `plugins/nz-job-scout`. Claude Code copies that directory into its plugin cache during installation.

## Install from GitHub

In Claude Code:

```text
/plugin marketplace add graham-gc/claude-nz-job-scout
/plugin install nz-job-scout@graham-nz-tools
```

For authenticated SEEK or LinkedIn searches, connect Claude in Chrome and sign in yourself. The plugin must not request, extract, store, or export browser cookies or passwords.

## Example requests

```text
Read ~/Career/CV.pdf and find verified Auckland software testing or backend roles posted in the last 30 days. I want internships or part-time work during semester and full-time work during scheduled breaks.
```

```text
Search for Java Spring Boot test automation roles in Auckland posted in the last 14 days. Save the results as Markdown.
```

## Reliability policy

A recommended listing must have:

1. a directly opened job-detail page;
2. no visible expired, closed, or unavailable state;
3. a working application route or clear application instructions;
4. a recorded source URL and verification timestamp.

Aggregator pages can be used for discovery, but they are not treated as final evidence. The report labels anything that cannot be verified instead of presenting it as an active vacancy.

## Development

Requirements: Node.js 20 or later and Claude Code.

```bash
cd plugins/nz-job-scout
npm install
npm run typecheck
npm test
```

From the repository root, validate the plugin metadata with the Claude Code CLI when it is installed:

```bash
claude plugin validate .
```

## Safety

The plugin does not apply for jobs, upload a CV, send messages, or submit personal information without explicit user approval. It does not bypass CAPTCHAs, access controls, or website restrictions.

## License

MIT
