# Public-source planning

Use this reference at the start of every scan. Its purpose is high recall with a bounded, auditable plan; it is not a request to exhaust every title or search-engine combination.

## Build a source plan

Create `searchCoverage.sourceTargets[]` before searching. Every target records an inventory scope and the exact `itemUrls` inspected; `itemsInspected` must equal that list's length. For an ordinary employment scan, plan at least:

1. one public board or search-discovery target, used only to discover employer names and canonical vacancy links;
2. one employer/ATS inventory target for one named employer, such as a public Workday, Greenhouse, Lever, SmartRecruiters, Ashby, BambooHR, employer careers listing, or public careers sitemap. Create separate targets for separate employers.

For internship, graduate, studentship, placement, fixed-term student, part-time student, or summer-work searches, also plan a `programme-inventory` target that exposes a broad current collection for the eligible geography without requiring role-title or technology keywords. A single vacancy detail page, expired event page, search snippet, or overseas inventory cannot satisfy this target.

Run this programme inventory first. Record a `programme-discovery` attempt and collect plausibly technical entries before applying CV-fit filters. Generic titles are expected: Technology Services, Digital Services, ICT, Systems, Service Management, Application Support, and similar roles may contain relevant software-support, integration, testing, data, platform, or operational engineering work.

If the user asks for technical volunteer roles, add one technical-volunteer target. Use public charity, community-technology, open-source, or volunteer-organisation listings, then verify the organisation's own description. It must state technical software work; a generic volunteer listing is out of scope.

Add a targeted employer inventory whenever a newly discovered lead reveals a relevant employer and the current inventory has not already been inspected. This is in addition to, not a replacement for, the two baseline target types.

## Discovery lenses

Choose a small number of distinct lenses instead of multiplying keywords:

- **work lens:** duties such as quality engineering, API automation, backend services, platform tooling, production support, or developer productivity;
- **programme lens:** internship, studentship, placement, graduate, fixed-term, part-time, or volunteer, when relevant;
- **employer lens:** relevant employers surfaced by a board, ATS, prior report, or user watchlist;
- **location lens:** the user's eligible locations and work arrangements.

Use a broad title/stage query for each responsibility family. Then inspect an inventory. Preserve every explicit user-supplied family in the plan, even if CV ranking later considers it secondary. Use focused follow-up only when an observed gap justifies it. Stop optional reformulation after two consecutive follow-ups yield no new canonical vacancy identities.

Every source target records its canonical public URL, `inventoryScope`, and every inspected item URL. A source target is not `searched` merely because one result or one detail page was opened. Aggregators and discovery boards cannot serve as employer/ATS inventories. Overseas, unrelated, or generic web results cannot satisfy a location-specific programme inventory.

Assign every lead a `priority` and `directSourceStatus`. High priority means the title, duties, employer, programme stage, or snippet gives a concrete reason to believe the role may be eligible. If a high-priority lead cannot be opened or no primary page can be found, keep it as an unresolved manual-verification lead; do not silently drop it.

Each `assessed` lead must produce one matching `jobs[]` record. Use the exact canonical detail URL whenever possible. Never reuse one LinkedIn, board, employer, or ATS detail URL for two materially different employer/title pairs.

## Status and coverage

- `searched`: the planned public result set or inventory was inspected, even when it produced zero leads;
- `discovery-only`: titles or snippets were visible but no public primary detail could be opened;
- `blocked` or `unavailable`: access or the target itself failed;
- `skipped`: intentionally omitted, with a reason.

Only use `complete` when every planned required target is `searched`, every explicit family is retained, every role family has both required routes, every required employer expansion was completed, and every required programme-first pass was completed. The runtime derives the status. If a target is inaccessible, record the limitation and continue with other public sources; never circumvent it.

## Watchlists and history

Treat a user-supplied employer watchlist as a source-plan input, not as proof that an employer has an opening. Check its public vacancy inventory once per scan and record the attempt, including zero-result checks. Use the report's hidden identity/state markers for daily deduplication; do not delete them. A changed application route, deadline, eligibility, employment form, or verification outcome should reappear as updated evidence.
