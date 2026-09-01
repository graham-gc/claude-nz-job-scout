# NZ Job Scout plugin

This directory is the installable Claude Code plugin.

The skill orchestrates CV reading and research across anonymously accessible employer, ATS, and permitted public job pages. Its bundled `bin/nz-job-scout` command uses only Node.js built-ins to validate the evidence session, remove stale or duplicate listings, calculate depth-aware role and practical scores, and generate Markdown. No package installation is required by plugin users.

Development commands:

```bash
npm install
npm run typecheck
npm test
```

The workflow never requests or uses login credentials, cookies, browser sessions, or employer-only API credentials. It also does not apply for jobs or submit personal information without explicit approval.
