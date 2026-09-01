# Evidence session format

Create one JSON session after resolving the inputs and opening job pages. The runtime treats this file as evidence: do not infer dates, employment terms, or application availability that were not visible.

## Input modes

Set `preferences.mode` automatically:

- `profile`: candidate profile supplied, no explicit search criteria;
- `criteria`: explicit criteria supplied, no candidate profile;
- `combined`: candidate profile and explicit criteria both supplied.

In `criteria` mode, the runtime still requires `candidate`. Create a neutral object using only stated search criteria: set `name` to `Not supplied`, derive `targetRoleFamilies` only from requested roles, and leave `skills` and unsupported personal fields empty. Do not imply that role-fit scores are based on a CV.

In `combined` mode, values in `preferences` represent explicit user constraints and take precedence over preferences inferred into `candidate`. The default `maxPostingAgeDays` is 30 in every mode.

## Required structure

```json
{
  "candidate": {
    "name": "Candidate name",
    "targetRoleFamilies": ["Software Test Engineer", "Java Backend Developer"],
    "employmentTypes": ["internship", "part-time"],
    "locations": ["Auckland"],
    "workArrangements": ["on-site", "hybrid", "remote"],
    "availability": "Full-time during scheduled summer break; up to 25 hours during study periods",
    "workRights": "New Zealand student visa with stated work-hour conditions",
    "domains": ["API test automation", "developer productivity"],
    "skills": [
      {
        "name": "Java",
        "level": "core",
        "years": 8,
        "lastUsedYear": 2026,
        "evidence": ["Built and maintained production-facing test tooling"]
      }
    ]
  },
  "preferences": {
    "mode": "profile",
    "keywords": [],
    "maxPostingAgeDays": 30,
    "employmentTypes": ["internship", "part-time"],
    "locations": ["Auckland"],
    "workArrangements": ["on-site", "hybrid", "remote"],
    "maxHoursPerWeekDuringStudy": 25,
    "includeUnverified": false
  },
  "searchCoverage": {
    "status": "complete",
    "interactiveBrowserUsed": true,
    "sources": [
      { "name": "SEEK", "status": "searched", "note": "Results and application routes opened in browser" },
      { "name": "Employer career sites", "status": "searched", "note": "Public ATS pages opened" }
    ]
  },
  "assumptions": [],
  "jobs": [
    {
      "source": "SEEK",
      "sourceUrl": "https://nz.seek.com/job/12345678",
      "applicationUrl": "https://employer.example/jobs/NZ-101",
      "requisitionId": "NZ-101",
      "title": "Software Test Engineer Intern",
      "employer": "Example Employer",
      "location": "Auckland",
      "workArrangement": "hybrid",
      "employmentType": "internship",
      "engagementModel": "employee",
      "hoursPerWeek": 40,
      "duringScheduledBreak": true,
      "availabilityCompatible": true,
      "workRightsCompatible": true,
      "postedAt": "2026-08-30",
      "closesAt": "2026-09-20",
      "summary": "API and backend quality engineering work",
      "requiredSkills": ["Java", "API automation"],
      "preferredSkills": ["SQL"],
      "verificationEvidence": {
        "detailPageOpened": true,
        "applyRouteAvailable": true,
        "expiredIndicatorVisible": false,
        "unavailableIndicatorVisible": false,
        "verifiedAt": "2026-09-01T09:00:00+12:00",
        "notes": []
      }
    }
  ]
}
```

## Candidate rules

- `preferences.mode` must be `profile`, `criteria`, or `combined`.
- `skills[].level` must be `core`, `frequent`, `working`, or `exposure`.
- Set the level from duration, frequency, recency, ownership, and delivery evidence—not from keyword presence.
- `years` can be fractional. Do not invent a number when the CV does not support one.
- Preserve visa wording accurately. Do not convert a temporary student work right into unrestricted work rights.

## Search coverage rules

- `searchCoverage` is required even when `jobs` is empty.
- `status` is `complete`, `partial`, or `blocked`.
- A source status is `searched`, `blocked`, `unavailable`, or `skipped`.
- Use `complete` only when the intended primary sources were successfully searched and vacancy pages could be opened.
- Use `partial` when at least one primary source was searched but another requested source was inaccessible.
- Use `blocked` when no primary source was successfully searched. A blocked search is not evidence that no vacancies exist.
- `complete` and `partial` require at least one source with `status: "searched"`.
- Record concise access notes such as `403 from direct request; interactive browser unavailable`. Do not put access failures only in `assumptions`.
- Never mark coverage complete from search-result snippets alone.

## Job evidence rules

- `sourceUrl` is the detail page that was actually opened.
- `applicationUrl` is the employer or ATS application destination when available.
- Dates use ISO 8601. Use `YYYY-MM-DD` when only a date is visible.
- Set `detailPageOpened` only after the exact vacancy page opens.
- Set `applyRouteAvailable` only after observing an enabled apply control or explicit, current application instructions.
- Set `expiredIndicatorVisible` or `unavailableIndicatorVisible` whenever the page shows such a state.
- Use `availabilityCompatible` and `workRightsCompatible` only when the listing contains enough evidence. Omit the field if unknown; never turn uncertainty into `true`.
- Never record cookies, access tokens, passwords, browser storage, CV contents beyond the candidate model, or unrelated personal data.

The runtime rejects final links from known aggregation sites, stale listings, closed listings, duplicates, and roles with practical blockers. Unverified jobs remain in the rejection section rather than the recommendation table.
