# Evidence session — schema 7

Write compact facts, not a generated report. Never invent dates, work rights, application instructions or proficiency. Runtime fills mechanical defaults; do not copy the large example session.

## Prepare before discovery

Minimal initial shape (illustrative facts only):

```json
{
  "pluginVersion":"0.8.9",
  "sessionSchemaVersion":7,
  "resumeFingerprint":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "candidate":{
    "name":"Example Candidate",
    "targetRoleFamilies":["backend engineering","API test automation"],
    "locations":["Auckland"],
    "skills":[{"name":"Java","level":"core","evidenceKind":"hands-on"}],
    "capabilities":[{"name":"API test automation","level":"core"}]
  },
  "preferences":{
    "mode":"combined",
    "maxPostingAgeDays":7,
    "schedule":{
      "fullTime":"window-limited",
      "source":"user-explicit",
      "basis":"Summer-only full-time or part-time up to 25 hours/week",
      "partTimeMaxHours":25
    },
    "constraints":[
      {"field":"location","value":"Auckland","strength":"hard","source":"user-explicit"},
      {"field":"engagementModel","value":"employee","strength":"hard","source":"user-explicit"}
    ]
  }
}
```

Run prepare on this file before discovery. It freezes this run's resume hash, preferences, availability and work-right facts. Append research without weakening inputs. A changed request needs a fresh session filename. The ignored output/.audit trace is retained for debugging, not reused as a candidate profile.

Modes: profile = CV only; criteria = criteria only; combined = both. Profile/combined require the actual CV SHA-256. Criteria mode omits the hash, uses name "Not supplied", and never invents skills or CV-based fit. Missing candidate arrays default to empty.

Mandatory preferences.schedule:

- fullTime: window-limited / ongoing / excluded / unknown.
- source: user-explicit / conversation-context / resume / unknown.
- basis: faithful short quote/paraphrase; required unless source unknown.
- partTimeMaxHours: positive number only if supplied.
- maxFullTimeDuration: optional {"value":12,"unit":"weeks"} only when the user supplied that maximum; days/weeks/months. Never turn a preference for short internships into a fabricated hard maximum.
- No evidence: fullTime/source unknown, no numerical allowances. Unknown scope cannot become an actionable full-time recommendation.

When known, candidate.availabilityWindows contain actual startAt, endAt, maxHoursPerWeek and workload full-time/part-time. Leave unknown dates absent and preserve the restriction in schedule. Class-free days and availability do not establish visa permission.

Work rights only when evidenced: {"country":"New Zealand","status":"temporary","unrestricted":false,"evidenceSource":"user-explicit","visaType":"Student Visa"}. Status temporary/unrestricted/none/unknown; evidenceSource user-explicit/resume/official-document/unknown. Include validUntil only when known. No assumed future post-study visa.

Skill/capability levels: core/frequent/working/exposure. Years and lastUsedYear only when evidenced. Certifications belong in qualifications or use evidenceKind certification + level exposure + no hands-on years. Preserve sustained capabilities separately from tool keywords.

Constraints have field, value, strength hard/soft, source user-explicit/conversation-context/resume-inferred/skill-default. Fields include programmeType, contractType, workload, location, workArrangement, engagementModel, roleFamily, keyword, excludeCoreSkill. Use schedule for time limits; do not rely on optional legacy fullTimeScope.

## Append research

Append searchCoverage, jobs and leads. Missing jobs/leads/relatedOpportunities default to empty. Assessed leads are derived from jobs: never write them twice.

### Coverage

```json
{
  "searchFamilies":["backend engineering","API test automation"],
  "explicitSearchFamilies":["API test automation"],
  "programmeFirstRequired":true,
  "sourceTargets":[
    {"name":"LinkedIn discovery","channel":"linkedin","purpose":"board-discovery","status":"blocked","url":"https://www.linkedin.com/jobs/search/","note":"Login wall"},
    {"name":"Example careers","channel":"employer-careers","purpose":"employer-ats","employer":"Example","status":"searched","url":"https://careers.example.com/jobs","itemUrls":["https://careers.example.com/jobs/101"]}
  ],
  "attempts":[
    {"roleFamilies":["backend engineering","API test automation"],"strategy":"source-inventory","source":"Example careers","query":"Current public inventory","status":"searched"}
  ]
}
```

This fragment is not the whole source plan. Plan web-search, seek, linkedin, trade-me and at least four distinct employer inventories. Add programme inventory for student searches and technical-volunteer source when requested. Blocked/skipped targets still belong in the plan. Coverage remains partial.

- Channels: web-search/seek/linkedin/trade-me/employer-careers/public-ats/programme/technical-volunteer.
- Purposes: board-discovery/programme-inventory/employer-ats/technical-volunteer.
- Status: searched/discovery-only/blocked/unavailable/skipped.
- Attempts: one per real operation, strategies programme-discovery/broad-discovery/source-inventory/employer-expansion/focused-follow-up. One roleFamilies array can cover several families. Expansion attempts also identify employer.
- itemUrls contains actual inspected inventory items. Omit if empty; itemsInspected is derived. inventoryScope defaults listing-page for employer inventories, search-results otherwise; explicit ats-board also valid. Single details/events are not inventories.
- Deferred relevant employer expansion: lead employerExpansionRequired true, explain employerExpansionReason. Record budget gaps rather than fictional completion.

### Discarded/unresolved lead

```json
{"title":"QA Engineer","employer":"Example","url":"https://careers.example.com/jobs/101","status":"out-of-scope","reason":"Nine months full-time conflicts with summer-only availability","detailPageOpened":true}
```

Status out-of-scope/duplicate/previously-reported/blocked/not-opened; reason required. Optional priority high/normal/low and directSourceStatus found/not-found/not-checked. Never create a full assessment to justify obvious rejection. Unresolved short links or employer/title mismatches are audit-only, not chat recommendations.

### Assessed vacancy — plausible survivors only

```json
{
  "source":"Example careers",
  "sourceUrl":"https://careers.example.com/jobs/101",
  "title":"Backend Engineering Intern",
  "employer":"Example",
  "location":"Auckland",
  "workArrangement":"hybrid",
  "programmeType":"internship",
  "contractType":"fixed-term",
  "workload":"full-time",
  "engagementModel":"employee",
  "hoursPerWeek":40,
  "duration":{"value":12,"unit":"weeks"},
  "roleFamilies":["backend engineering"],
  "responsibilityAreas":["backend development","API test automation"],
  "domains":[],
  "technicalRequirements":[{"label":"Language","strength":"required","match":"any","options":["Java","Python"]}],
  "requirements":[{"category":"study","text":"Enrolled student","strength":"hard","compatibility":"met","evidenceSource":"resume"}],
  "dateEvidence":{"postedAt":[{"value":"2026-11-02","sourceUrl":"https://careers.example.com/jobs/101","sourceType":"employer","confidence":"high"}]},
  "observation":{"at":"2026-11-09T10:00:00+13:00","kind":"employer","detailPageOpened":true,"applyRouteAvailable":true},
  "application":{"method":"online","url":"https://careers.example.com/jobs/101/apply","requiredMaterials":["CV"]}
}
```

Substitute actual facts. Omit unknown hours/duration/dates. Do not derive an exact end date from approximate duration. Missing essential schedule facts cannot be repaired by a technology score.

- programmeType internship/graduate/standard/not-stated; contractType fixed-term/permanent/casual/contract/not-stated; workload full-time/part-time/variable/not-stated. engagementModel employee/independent-contractor/not-stated. "Contract" alone does not prove self-employment.
- Technical requirements required/preferred, any/all alternatives. Nontechnical requirements hard/preference, compatibility met/not-met/unknown, factual evidenceSource. Optional selectionRisks string array.
- observation creates verificationEvidence and sourceEvidence once; expired/unavailable default false. For conflicting primary deadlines use explicit verificationEvidence.unresolvedDateConflict true with notes. Multiple sources use sourceEvidence with name, url, kind employer/ats/job-board/aggregator, observedAt and observed flags.
- Dates postedAt/closesAt/startAt/endAt use observation arrays: value, sourceUrl, sourceType employer/ats/job-board/structured-data/search-result/legacy, confidence high/medium/low. Preserve conflicting primary values. Missing closing date alone is not a conflict.
- Optional workRightsRequirement country, requiresCurrentRights, requiresUnrestricted; never guess legal conditions.
- Email application: method email, plain email, employer instructions and requiredMaterials. No mailto-only route.
- Technical volunteering: isTechnicalVolunteer true, explicit technical duties, compensation kind paid/unpaid/reimbursed/unknown; preferences.includeTechnicalVolunteer true. Do not disguise as employment.

## Report and handoff

Optional execution checkpoints startedAt/inputsReadyAt/researchFinishedAt need real observed timestamps with timezone. stopReason finished/budget/blocked. Never reconstruct guessed timings.

Run report on the prepared session. Runtime independently checks employer/title and application identity for a bounded set of survivors; never supply identityVerification as evidence. Use canonical public HTTPS employer/ATS URLs, not unresolved short links or guessed domains. Restricted pages remain unverified, not closed.

Return the printed USER SUMMARY without extra roles or claims. It and Markdown share decisions. Remove only the exact temporary session after success, retaining output/.audit. Schema 6 sessions require fresh preparation; renaming their version does not supply missing evidence.
