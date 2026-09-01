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
    ],
    "capabilities": [
      {
        "name": "API test automation",
        "level": "core",
        "years": 4,
        "lastUsedYear": 2026,
        "evidence": ["Designed and delivered an API automation platform"]
      },
      {
        "name": "backend development",
        "level": "frequent",
        "years": 4,
        "lastUsedYear": 2026,
        "evidence": ["Implemented Spring Boot services and relational persistence"]
      }
    ],
    "qualifications": ["Bachelor of Engineering", "Master of Information Technology in progress"]
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
    "searchFamilies": ["software test engineering", "Java backend", "developer productivity"],
    "queriesRun": 6,
    "leadsDiscovered": 12,
    "detailPagesOpened": 5,
    "sources": [
      { "name": "Employer career sites", "status": "searched", "note": "Public vacancy and application pages opened" },
      { "name": "Public ATS pages", "status": "searched", "note": "Anonymous job-board pages opened" }
    ]
  },
  "assumptions": [],
  "jobs": [
    {
      "source": "Employer careers site",
      "sourceUrl": "https://careers.example/jobs/NZ-101",
      "applicationUrl": "https://careers.example/jobs/NZ-101/apply",
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
      "roleFamilies": ["software test engineering", "backend engineering"],
      "responsibilityAreas": ["API test automation", "backend debugging", "test framework development"],
      "domains": ["software quality", "developer productivity"],
      "requiredSkills": ["Java", "API automation"],
      "preferredSkills": ["SQL"],
      "eligibilityRequirements": ["Currently studying a New Zealand tertiary qualification"],
      "eligibilityCompatible": true,
      "selectionRisks": [],
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
- `skills` contains concrete technologies, languages, frameworks, protocols, and tools. `capabilities` contains sustained work such as backend development, test automation, performance testing, production troubleshooting, internal tooling, or stakeholder delivery.
- Set the level from duration, frequency, recency, ownership, and delivery evidence—not from keyword presence.
- A capability must be supported by work the candidate actually performed. Do not infer AI/ML, cloud, frontend, mobile, or another specialty from a nearby keyword.
- `years` can be fractional. Do not invent a number when the CV does not support one.
- Preserve visa wording accurately. Do not convert a temporary student work right into unrestricted work rights.

## Search coverage rules

- `searchCoverage` is required even when `jobs` is empty.
- `searchFamilies`, `queriesRun`, `leadsDiscovered`, and `detailPagesOpened` are required. They distinguish a narrow or blocked run from a meaningful market scan.
- In profile or combined mode, search each materially distinct role family derived from sustained experience. Finding one verified role is not a stopping condition.
- `status` is `complete`, `partial`, or `blocked`.
- A source status is `searched`, `discovery-only`, `blocked`, `unavailable`, or `skipped`.
- Use `discovery-only` when public search results or snippets were accessible but the exact detail/application page could not be verified.
- Use `complete` only when the intended primary sources were successfully searched and vacancy pages could be opened.
- Use `partial` when at least one primary source was searched but another requested source was inaccessible.
- Use `blocked` when no primary source was successfully searched. A blocked search is not evidence that no vacancies exist.
- `complete` and `partial` require at least one source with `status: "searched"`.
- Record concise access notes such as `403 from anonymous request; source skipped`. Do not put access failures only in `assumptions`.
- Never mark coverage complete from search-result snippets alone.

## Job evidence rules

- `sourceUrl` is the detail page that was actually opened.
- `roleFamilies` and `responsibilityAreas` must be derived from the work described in the JD, not merely from its title.
- Put only concrete technologies and hands-on technical practices in `requiredSkills` and `preferredSkills`.
- Put degree, NZQA level, current-student status, work rights, residency, availability, and similar screening rules in `eligibilityRequirements`, never in `requiredSkills`.
- Set `eligibilityCompatible` only after comparing the visible eligibility requirement with supported candidate evidence. Omit it when uncertain.
- `selectionRisks` is for evidence-based non-blocking cautions, such as a clearly different technical specialism. Do not speculate about age, personality, or unlawful criteria.
- `applicationUrl` is the employer or ATS application destination when available.
- Dates use ISO 8601. Use `YYYY-MM-DD` when only a date is visible.
- Set `detailPageOpened` only after the exact vacancy page opens.
- Set `applyRouteAvailable` only after observing an enabled apply control or explicit, current application instructions.
- Set `expiredIndicatorVisible` or `unavailableIndicatorVisible` whenever the page shows such a state.
- Use `availabilityCompatible` and `workRightsCompatible` only when the listing contains enough evidence. Omit the field if unknown; never turn uncertainty into `true`.
- Never request or record cookies, access tokens, passwords, browser storage, partner credentials, CV contents beyond the candidate model, or unrelated personal data.

The runtime rejects final links from known aggregation sites, stale listings, closed listings, duplicates, and roles with practical blockers. Unverified jobs remain in the rejection section rather than the recommendation table.
