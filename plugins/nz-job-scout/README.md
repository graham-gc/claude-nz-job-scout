# NZ Job Scout plugin

This directory is self-contained because Claude Code installs plugins into a cache. Do not make runtime code depend on files outside this directory.

## Components

- `.claude-plugin/plugin.json`: plugin identity and metadata.
- `skills/nz-job-scout/SKILL.md`: the user-facing workflow and reliability rules.
- `src/resume`: local CV ingestion boundary.
- `src/providers`: browser-provider contracts and catalogue.
- `src/verification`: evidence classification and URL normalisation.
- `src/matching`: depth-aware role and practicality scoring.
- `src/reporting`: deterministic Markdown output.
- `tests`: unit tests for high-risk decision rules.

## Architecture boundary

The Claude Code skill coordinates document reading and browser interaction. TypeScript modules contain deterministic logic that can be tested without a live browser. This avoids handling browser credentials in Node.js and makes source-site adapters replaceable.

## Current limitations

- Live SEEK, LinkedIn, Trade Me, and employer-ATS adapters are not implemented yet.
- The CLI PDF adapter is not implemented; the skill uses Claude's document-reading capability.
- Match scoring is an initial transparent heuristic and needs fixture-based calibration.
- No unattended or scheduled search runner is included.

## Next implementation slice

1. Define browser observation fixtures for SEEK and direct employer ATS pages.
2. Add a provider-independent deduplication pipeline.
3. Add report persistence and CLI argument parsing.
4. Add end-to-end tests using saved, non-personal HTML fixtures.
