# Evidence session format

Create one JSON session after resolving inputs and researching public sources. The runtime treats it as evidence. Never invent dates, employment terms, eligibility, application availability, or proficiency.

## Modes and precedence

- `profile`: candidate evidence, no explicit job criteria.
- `criteria`: explicit criteria, no candidate evidence.
- `combined`: both; explicit user criteria define eligibility and candidate evidence ranks matching roles.

In criteria mode, use `name: "Not supplied"`, requested role families only, empty `skills`, `capabilities`, `availabilityWindows`, and `qualifications`, and omit `workRights` unless explicitly stated. Do not imply CV-based fit.

`preferences.constraints[]` records where a restriction came from. Only `hard` mismatches block a role. Use `soft` for defaults or genuine preferences that should affect ranking without excluding a vacancy.

## Complete example

```json
{
  "candidate": {
    "name": "Example Candidate",
    "targetRoleFamilies": ["Software Test Engineer", "Java Backend Developer"],
    "locations": ["Auckland"],
    "workArrangements": ["on-site", "hybrid", "remote"],
    "availabilityWindows": [
      {
        "startAt": "2026-11-01",
        "endAt": "2027-02-28",
        "maxHoursPerWeek": 40,
        "note": "Scheduled summer break"
      },
      {
        "startAt": "2026-07-01",
        "endAt": "2026-10-31",
        "maxHoursPerWeek": 25,
        "note": "Teaching period"
      }
    ],
    "workRights": {
      "country": "New Zealand",
      "status": "temporary",
      "unrestricted": false,
      "validUntil": "2027-12-31",
      "visaType": "Student Visa",
      "notes": ["Work conditions vary between teaching periods and scheduled breaks"]
    },
    "domains": ["API test automation", "developer productivity"],
    "skills": [
      {
        "name": "Java",
        "level": "core",
        "years": 8,
        "lastUsedYear": 2026,
        "evidence": ["Backend and test-platform development"]
      }
    ],
    "capabilities": [
      {
        "name": "API test automation",
        "level": "core",
        "years": 4,
        "lastUsedYear": 2026,
        "evidence": ["Designed and delivered an API automation platform"]
      }
    ],
    "qualifications": ["Bachelor of Engineering", "Master of Information Technology in progress"]
  },
  "preferences": {
    "mode": "combined",
    "keywords": [],
    "maxPostingAgeDays": 30,
    "includeUnverified": true,
    "constraints": [
      {
        "field": "programmeType",
        "value": "internship",
        "strength": "hard",
        "source": "user-explicit"
      },
      {
        "field": "location",
        "value": "Auckland",
        "strength": "hard",
        "source": "user-explicit"
      },
      {
        "field": "workArrangement",
        "value": "hybrid",
        "strength": "soft",
        "source": "resume-inferred"
      }
    ]
  },
  "searchCoverage": {
    "searchFamilies": ["software test engineering", "Java backend"],
    "attempts": [
      {
        "roleFamily": "software test engineering",
        "source": "Employer careers",
        "query": "software test internship Auckland",
        "status": "searched",
        "leadsDiscovered": 2,
        "detailPagesOpened": 1,
        "requiredForCoverage": true,
        "note": "Public vacancy pages inspected"
      },
      {
        "roleFamily": "Java backend",
        "source": "SEEK public pages",
        "query": "Java backend internship Auckland",
        "status": "discovery-only",
        "leadsDiscovered": 1,
        "detailPagesOpened": 0,
        "requiredForCoverage": true,
        "note": "Indexed result found; exact detail page was not anonymously accessible"
      }
    ]
  },
  "leads": [
    {
      "title": "Software Test Engineer Intern",
      "employer": "Example Engineering",
      "source": "Employer careers",
      "url": "https://careers.example.com/jobs/NZ-101",
      "roleFamily": "software test engineering",
      "discoveredAt": "2026-09-01T09:00:00+12:00",
      "detailPageOpened": true,
      "status": "assessed"
    },
    {
      "title": "Java Intern",
      "employer": "Example Systems",
      "source": "SEEK public search result",
      "url": "https://www.seek.co.nz/job/12345678",
      "roleFamily": "Java backend",
      "discoveredAt": "2026-09-01T09:10:00+12:00",
      "detailPageOpened": false,
      "status": "not-opened",
      "reason": "Exact detail page was not anonymously accessible and no primary copy was found"
    }
  ],
  "assumptions": ["Only public pages were used."],
  "jobs": [
    {
      "source": "Employer careers site",
      "sourceUrl": "https://careers.example.com/jobs/NZ-101",
      "applicationUrl": "https://careers.example.com/jobs/NZ-101/apply",
      "requisitionId": "NZ-101",
      "title": "Software Test Engineer Intern",
      "employer": "Example Engineering",
      "location": "Auckland",
      "workArrangement": "hybrid",
      "programmeType": "internship",
      "contractType": "fixed-term",
      "workload": "full-time",
      "engagementModel": "employee",
      "hoursPerWeek": 40,
      "summary": "API and backend quality-engineering work",
      "roleFamilies": ["software test engineering", "backend engineering"],
      "responsibilityAreas": ["API test automation", "backend debugging", "test framework development"],
      "domains": ["software quality", "developer productivity"],
      "requiredSkills": ["Java", "API automation"],
      "preferredSkills": ["SQL"],
      "requirements": [
        {
          "category": "study",
          "text": "Currently studying at a New Zealand tertiary institution",
          "strength": "hard",
          "compatibility": "met",
          "sourceUrl": "https://careers.example.com/jobs/NZ-101"
        }
      ],
      "workRightsRequirement": {
        "country": "New Zealand",
        "requiresCurrentRights": true,
        "requiresUnrestricted": false,
        "sponsorshipAvailable": false
      },
      "dateEvidence": {
        "postedAt": [
          {
            "value": "2026-08-25",
            "sourceUrl": "https://careers.example.com/jobs/NZ-101",
            "sourceType": "employer",
            "confidence": "high",
            "observedText": "Posted 25 August 2026"
          }
        ],
        "closesAt": [
          {
            "value": "2026-09-30",
            "sourceUrl": "https://careers.example.com/jobs/NZ-101",
            "sourceType": "employer",
            "confidence": "high"
          }
        ],
        "startAt": [
          {
            "value": "2026-11-16",
            "sourceUrl": "https://careers.example.com/jobs/NZ-101",
            "sourceType": "employer",
            "confidence": "high"
          }
        ],
        "endAt": [
          {
            "value": "2027-02-12",
            "sourceUrl": "https://careers.example.com/jobs/NZ-101",
            "sourceType": "employer",
            "confidence": "high"
          }
        ]
      },
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
  ],
  "relatedOpportunities": [
    {
      "kind": "event",
      "title": "Candidate Meet and Greet",
      "organisation": "Example Graduate Programme",
      "url": "https://programme.example.nz/events/meet-and-greet",
      "registrationStatus": "conditional",
      "audience": "Candidates already accepted into the programme",
      "conditions": "Not open to new candidate registrations",
      "startsAt": "2026-09-14",
      "verificationEvidence": {
        "detailPageOpened": true,
        "applyRouteAvailable": false,
        "expiredIndicatorVisible": false,
        "unavailableIndicatorVisible": false,
        "verifiedAt": "2026-09-01T09:20:00+12:00",
        "notes": []
      }
    }
  ]
}
```

## Controlled values

- skill/capability level: `core`, `frequent`, `working`, `exposure`;
- programme type: `internship`, `graduate`, `standard`, `not-stated`;
- contract type: `fixed-term`, `permanent`, `casual`, `contract`, `not-stated`;
- workload: `full-time`, `part-time`, `variable`, `not-stated`;
- constraint strength: `hard`, `soft`;
- constraint source: `user-explicit`, `conversation-context`, `resume-inferred`, `skill-default`;
- requirement strength: `hard`, `preference`;
- requirement compatibility: `met`, `not-met`, `unknown`;
- attempt status: `searched`, `discovery-only`, `blocked`, `unavailable`, `skipped`;
- lead status: `assessed`, `duplicate`, `blocked`, `not-opened`, `out-of-scope`, `previously-reported`;
- opportunity status: `open`, `closed`, `conditional`, `unknown`.

## Evidence rules

### Candidate and preferences

- Determine depth from repeated duties, duration, recency, ownership, and outcomes—not keyword count.
- Keep qualifications and work rights separate from technical skills.
- Preserve visa wording exactly; temporary or hour-limited rights are not unrestricted.
- Availability uses explicit date windows and maximum weekly hours. Do not replace this with a vague sentence.
- Explicit user requirements are usually `hard`; inferred preferences and defaults are normally `soft` unless the user clearly made them mandatory.

### Search audit

- `searchCoverage` is required even when no jobs are assessed.
- Record every search operation in `attempts`; the runtime derives coverage and ignores any hand-written `status`.
- Every discovered lead belongs in `leads`, even if duplicated, inaccessible, out of scope, or not opened.
- A non-`assessed` lead requires a reason.
- `complete` requires at least one successful search attempt for every intended role family and no material required-source failure. Otherwise coverage is partial or blocked.

### Jobs and dates

- `sourceUrl` is the exact detail page actually opened; `applicationUrl` is the direct application destination.
- Derive role families and responsibilities from daily duties, not title alone.
- Put technical requirements in `requiredSkills`/`preferredSkills`; put study, degree, work-right, citizenship, availability, security, and export-control rules in `requirements`.
- A hard `not-met` requirement is a blocker. A hard `unknown` requirement is a caution requiring manual confirmation. A preference does not become a hard blocker.
- Record programme, contract, and workload independently. A full-time fixed-term summer internship remains an internship.
- Dates use ISO 8601. Use `YYYY-MM-DD` when only a date is visible. A date-only closing deadline remains open through that entire `Pacific/Auckland` calendar day.
- Record each date observation separately with URL, source type, and confidence. Do not choose silently between conflicting values; the runtime marks conflicting evidence unverified.
- Public employer/ATS content has stronger provenance than an indexed snippet. A snippet can remain a discovery lead but cannot make a job verified by itself.
- Set detail/application evidence only after observing it. An access error is neither an expired indicator nor proof of current availability.

### Related opportunities

- Events, programmes, talent pools, and recruitment channels never belong in `jobs`.
- `conditional` means useful only to an explicitly eligible audience, such as already-registered candidates.
- Do not globally suppress a legitimate channel because one candidate does not prefer it; model that user's preference in the current session.

### Privacy and history

- Never record credentials, cookies, tokens, private browser state, or unrelated personal data.
- Generated reports contain hidden non-sensitive identity/state markers. The runtime uses them to suppress unchanged roles and to re-report materially changed evidence as `Updated evidence`.
- Do not delete or edit those markers manually when incremental reporting is desired.
