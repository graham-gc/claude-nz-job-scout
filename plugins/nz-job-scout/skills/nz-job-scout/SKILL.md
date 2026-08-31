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

## Workflow

### 1. Read and model the candidate

Read the complete CV. For PDF input, use Claude's document-reading capability; for Markdown, read the source text directly.

Build a compact profile containing:

- target role families;
- employment types and availability;
- location and remote constraints;
- work rights;
- years and recency of relevant experience;
- domain experience;
- skills classified as `core`, `frequent`, `working`, or `exposure`.

Do not treat a technology as strong merely because it appears once. Prefer evidence from duration, repeated use, project ownership, production responsibility, and quantified outcomes.

### 2. Search

Use the authenticated browser when the user wants results influenced by their SEEK or LinkedIn account. Ask the user to connect Claude in Chrome or log in when required. Never request, read, copy, save, or export cookies, passwords, session tokens, or browser storage.

Search direct sources first:

- SEEK New Zealand;
- LinkedIn Jobs;
- Trade Me Jobs;
- employer career sites and their ATS pages.

Aggregator sites may reveal leads, but always replace an aggregator link with the direct employer or primary job-board page before recommending it.

Respect the user's employment-type and location constraints. Do not return full-time permanent roles merely because they share technical keywords when the user asked only for internships or part-time work.

### 3. Verify every candidate listing

Open the detail page and record:

- exact title and employer;
- location and work arrangement;
- employment type;
- posting or closing date when visible;
- direct URL;
- whether the application control or instructions are available;
- verification timestamp in `Pacific/Auckland` time.

Reject a listing from the recommended list when it is expired, removed, redirects only to similar jobs, has no identifiable employer, or cannot be opened. Label uncertain evidence as `unverified`; never describe it as active.

Do not bypass CAPTCHAs, rate limits, access controls, or site restrictions. Let the user complete login and challenge screens.

### 4. Deduplicate

Treat listings as the same vacancy when employer, normalized title, location, and requisition ID or destination application URL match. Keep the direct source with the clearest evidence.

### 5. Score on two dimensions

Produce separate scores from 0 to 10:

- **Role fit**: actual depth and recency of required skills, responsibilities, domain transfer, and evidence of delivery.
- **Practical fit**: employment type, location, hours, start date, work rights, and any explicit eligibility rules.

A hard blocker must remain visible even when technical fit is high. Never inflate fit using technologies that are only exposure-level skills.

### 6. Report

Unless the user requests another path, save the report as:

```text
output/nz-jobs-YYYY-MM-DD.md
```

Include:

1. search criteria and assumptions;
2. a ranked table of verified roles;
3. role-fit and practical-fit scores;
4. evidence, gaps, and hard blockers;
5. direct links and verification times;
6. a separate rejected or unverified section with reasons;
7. suggested CV emphasis for the strongest roles, without inventing experience.

## User-directed keyword mode

When the user supplies keywords, use them as search criteria rather than silently replacing them with CV-derived terms. The CV can still be used for ranking unless the user opts out.

## Action boundary

Searching, reading, comparing, and writing a local report are allowed. Applying, uploading a CV, sending a message, creating an account, or submitting personal data requires explicit approval at the moment of action.
