# Inputs and outputs

`start` needs a resume path (PDF with local `pdftotext`, or text/Markdown) and a request JSON. Only the explicitly requested work conditions are hard filters; do not promote salary, missing deadline, seniority or preferences into hard constraints.

```json
{
  "roleFamilies": ["Java backend engineering", "API test automation", "performance testing"],
  "postingDays": 7,
  "location": { "country": "New Zealand", "onsiteCities": ["Auckland"], "remoteOutside": true },
  "all": [],
  "any": [
    [{ "field": "hoursPerWeek", "op": "lte", "value": 25 }, { "field": "engagement", "op": "eq", "value": "employee" }],
    [{ "field": "durationMonths", "op": "lte", "value": 3 }, { "field": "engagement", "op": "eq", "value": "employee" }],
    [{ "field": "engagement", "op": "eq", "value": "volunteer" }]
  ],
  "preferences": ["Paid summer internship preferred"],
  "includeTalentPools": true,
  "exclusions": []
}
```

This is a **schema example**, not a prefilled profile. Do not copy its availability options without confirming they express this user's request. If summer full-time work is limited to specific dates, add `startAt` and `endAt` conditions to the appropriate alternative; without explicit vacancy dates those conditions stay unknown. The parser currently does not infer semester/work-rights rules or convert FTE to hours. Missing structured evidence stays unknown, rather than being supplied by the model. A prototype may therefore retain good roles under "Worth confirming".

**`requestId` names one user request, and the budget belongs to it.** `start` writes a `requestId` into the request file and every continuation run of the same request keeps it; the runs of one request share one observable-call budget, so reopening a run never buys more calls. A scan the user explicitly starts afresh is a new request: run `start --new-request`, which opens a fresh budget and does not carry the previous request's spend over. The same resume with the same criteria is not what makes two requests one request. The report prints the request ledger of the project, so every request that was opened is visible.

**A request has one live run at a time.** Two live runs would each hold a snapshot of the same budget and could each spend it in full, so `start` refuses to open a second run while one of the runs of that request is still live, and a request lock keeps two commands from starting one at the same moment. A run ends when it produces its report; an abandoned run that will never report is closed with `end --run RUN_ID`, and a finished run accepts no further calls, so it cannot spend behind the back of the next run.

`all` means every condition; `any` means at least one alternative whose conditions all pass. An alternative that cannot be judged stays **unknown**, and the whole `any` group is only a conflict when *every* alternative conflicts. A posting that states “9 months” therefore conflicts with a `durationMonths ≤ 3` alternative but leaves the group unknown when the posting says nothing about weekly hours or week counts: nine months alone does not rule out part-time work. Empty `any` adds no alternative restriction. Supported fields: location, workArrangement, hoursPerWeek, engagement, contractType, duration, durationWeeks, durationMonths, startAt, endAt, workRights. Supported operators: eq, in, lte, gte, contains. Numeric fields compare numbers; dates compare ISO YYYY-MM-DD strings. Work arrangements: on-site/hybrid/remote; engagement: employee/independent-contractor/volunteer; contractType: fixed-term/permanent. Supported automatic extraction is conservative: dates/hours/duration/engagement are populated only from actual source text or documented API fields; not all sites expose them. `preferences` guide the model's tie-breaking, never override a hard conflict.

**Duration units are never converted.** A posting that says "6 months" and a condition written as `durationMonths` compare directly; a condition written as `durationWeeks` against a months-stated posting yields **unknown**, not a pass and not a conflict. Use the field that matches the unit the employer stated.

**Location defaults are disclosed, not guessed.** If `location` is omitted, the region is judged at country level (New Zealand) and no city is assumed — the run states this in its disclosures. If `onsiteCities` is empty, no city is treated as a conflict. A posting that states only "Remote" keeps the region **unknown**: it is neither excluded nor asserted as hireable in New Zealand. Supply `onsiteCities` when a city-level answer is actually required.

**Preferences are executable.** Each free-text preference is matched to a rule over recorded facts (remote, hybrid, on-site, permanent, fixed-term, full-time, part-time, internship, salary, volunteer/not-volunteer, or a named city), and the report prints the field and value that decided it. A preference with no matching rule is reported as having no influence on the order, rather than being silently stored.

Date-only publication uses the Auckland calendar date; timestamp publication uses elapsed hours. Age 0–7 days inclusive passes the default window. Only first-published or explicit advertised-date semantics pass; last-published/created/updated timestamps do not. A missing deadline is not a hard failure. An anomalous deadline is retained as an advisory, never silently fixed or used for an urgency claim.

Exclusions can use `{ "employer": "...", "requisitionId": "...", "url": "https://...", "decision": "applied" }`. Exact known req IDs override reused titles/URLs. Do not add a decision simply because materials were generated. The project’s legacy `.nz-job-scout-state.json` is read without modification; no private decision file is committed.

Write request criteria, preferences, disclosures, and judgment reasons in English even when the user asks in another language. Source quotations and proper names remain verbatim, not translated. The runtime rejects Han-script characters in generated judgment reasons; this check does not apply to source quotations and is not a general-purpose language detector.

Model output contains no job facts:

```json
{
  "judgments": [
    {
      "recordId": "ID_FROM_RUNTIME",
      "fit": "strong",
      "reasons": ["Daily API automation work matches the resume's demonstrated backend testing experience; mobile automation is only desirable."],
      "quotes": ["An exact contiguous quote from this record's duties"]
    }
  ]
}
```

fit is strong/possible/weak. Quotes are checked against saved text, but **runtime cannot prove your reasoning or prevent you editing local files**: this is a workflow boundary, not OS isolation. Never claim automated tests validate match quality itself. Empty judgments can produce an honest blocked/unassessed report.

Outputs: `output/nz-jobs-YYYY-MM-DD[-RUN8].md` and a private JSON sidecar. Original reports remain untouched. Same-context unchanged recommendations are suppressed; new req IDs and substantive fact/application changes can reappear. Historical roles not re-read are “not reverified”, never assumed closed. Snapshots, raw resume extraction and the run ledger are private 0600 files under `.nz-job-scout/runs/RUN_ID/`; exclude this folder and report/input files from git. No individual request is sent with the resume content.

Sources: five seeded employers (Contact Energy, University of Auckland, accesso, Pushpay, ASB), Pushpay's official NZ page separately (its global API board may omit NZ roles), and LinkedIn public discovery entries built from the requested role families and location. Greenhouse/SmartRecruiters/Lever/Ashby parsers are implemented; no guessed Lever tenant is enabled by default. This is a **starting registry, not complete market coverage**. Unsupported sites require further adapter work, not manual JSON “facts”. An employer inventory that cannot be read is registered as an `unsupported` source with a warning, so the blind spot is visible rather than silent.
