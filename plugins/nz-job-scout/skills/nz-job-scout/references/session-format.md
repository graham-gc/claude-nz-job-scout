# Evidence session format

Create one JSON session after reading the CV and opening job pages. The runtime treats this file as evidence: do not infer dates, employment terms, or application availability that were not visible.

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

- `skills[].level` must be `core`, `frequent`, `working`, or `exposure`.
- Set the level from duration, frequency, recency, ownership, and delivery evidence—not from keyword presence.
- `years` can be fractional. Do not invent a number when the CV does not support one.
- Preserve visa wording accurately. Do not convert a temporary student work right into unrestricted work rights.

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
