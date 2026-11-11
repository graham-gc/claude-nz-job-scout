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
    [{ "field": "durationWeeks", "op": "lte", "value": 12 }, { "field": "engagement", "op": "eq", "value": "employee" }],
    [{ "field": "engagement", "op": "eq", "value": "volunteer" }]
  ],
  "preferences": ["Paid summer internship preferred"],
  "includeTalentPools": true,
  "exclusions": []
}
```

This is a **schema example**, not a prefilled profile. Do not copy its availability options without confirming they express this user's request. If summer full-time work is limited to specific dates, add `startAt` and `endAt` conditions to the appropriate alternative; without explicit vacancy dates those conditions stay unknown. The parser currently does not infer semester/work-rights rules or convert FTE to hours. Missing structured evidence stays unknown, rather than being supplied by the model. A prototype may therefore retain good roles under “值得确认”.

`all` means every condition; `any` means at least one alternative whose conditions all pass. Empty `any` adds no alternative restriction. Supported fields: location, workArrangement, hoursPerWeek, engagement, contractType, durationWeeks, startAt, endAt, workRights. Supported operators: eq, in, lte, gte, contains. Numeric fields compare numbers; dates compare ISO YYYY-MM-DD strings. Work arrangements: on-site/hybrid/remote; engagement: employee/independent-contractor/volunteer; contractType: fixed-term/permanent. Supported automatic extraction is conservative: dates/hours/duration/engagement are populated only from actual source text or documented API fields; not all sites expose them. `preferences` guide the model's tie-breaking, never override a hard conflict.

Date-only publication uses the Auckland calendar date; timestamp publication uses elapsed hours. Age 0–7 days inclusive passes the default window. Only first-published or explicit advertised-date semantics pass; last-published/created/updated timestamps do not. A missing deadline is not a hard failure. An anomalous deadline is retained as an advisory, never silently fixed or used for an urgency claim.

Exclusions can use `{ "employer": "...", "requisitionId": "...", "url": "https://...", "decision": "applied" }`. Exact known req IDs override reused titles/URLs. Do not add a decision simply because materials were generated. The project’s legacy `.nz-job-scout-state.json` is read without modification; no private decision file is committed.

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

Sources: five seeded employers (Contact Energy, University of Auckland, accesso, Pushpay, ASB), Pushpay's official NZ page separately (its global API board may omit NZ roles), and one LinkedIn SEO list. Greenhouse/SmartRecruiters/Lever parsers are implemented; no guessed Lever tenant is enabled by default. This is a **starting registry, not complete market coverage**. Unsupported sites require further adapter work, not manual JSON “facts”.
