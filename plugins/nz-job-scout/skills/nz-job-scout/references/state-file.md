# Persistent role decisions

Use the project-local `.nz-job-scout-state.json` file to preserve explicit user decisions across reports and plugin sessions. The file is ignored by Git because it is personal search state.

Read it before discovery. Do not search for, assess, or report an excluded role again unless the user explicitly reverses the decision. The runtime also filters matching evidence before report generation.

Create or update the file only after the user explicitly says that a role was applied to, rejected, closed, or not wanted. Never infer a rejection merely because an application has not progressed.

```json
{
  "schemaVersion": 1,
  "excludedRoles": [
    {
      "employer": "Example Engineering",
      "title": "Software Test Engineer Intern",
      "requisitionId": "NZ-101",
      "url": "https://careers.example.com/jobs/NZ-101",
      "decision": "rejected",
      "decidedAt": "2026-09-15",
      "reason": "The employer rejected the application"
    }
  ]
}
```

Rules:

- `employer` is required.
- At least one of `title`, `requisitionId`, or `url` is required. Prefer requisition ID or the canonical detail/application URL when available.
- `decision` is one of `applied`, `rejected`, `not-interested`, or `closed`.
- `decidedAt` is an ISO date or timestamp recording when the user supplied the decision.
- Keep exclusions role-specific. Do not exclude every future vacancy from an employer unless the user explicitly asks for an employer-wide exclusion; the current schema intentionally does not support employer-wide records.
- If a title changes but the requisition ID or canonical URL is the same, the exclusion still applies.
- A related but genuinely different role at the same employer remains eligible.
