CHANGES NEEDED

HIGH | fieldshift/planner/routes.py:514 | P2 refresh remains a stub; historical vulnerabilities stay empty. | Integrate P2 for changed plans and priorities; test refresh behavior.

HIGH | fieldshift/planner/future.py:276 | Editing season 1 also changes season 3; editing season 3 returns 400. | Expand repeated legs before applying season-specific edits; add regressions.

MEDIUM | fieldshift/planner/future.py:72 | Shifts use 2001: February 29 causes 500; February 28 +1 skips leap day in 2028. | Shift resolved dates in their actual years; test leap boundaries.

MEDIUM | fieldshift/planner/future.py:166 | Check dates copied from plan dates are labelled `verified_source`. | Separate date provenance from rule provenance; correct the existing provenance test.

MEDIUM | fieldshift/planner/future.py:381 | Moving season 2 harvest changes season 1’s growing window, but its diff is omitted. | Include dependent window changes in diffs.

MEDIUM | fieldshift/report/routes.py:352 | One provenance basis labels grower-supplied future plans `assumed`, or appended presets `grower`. | Track provenance per leg and field.

MEDIUM | fieldshift/report/field_note.py:694 | Later-season day counts audit against the first plan’s ID. | Reference each season’s actual plan and calculation dates; test audit contents.

MEDIUM | fieldshift/planner/future.py:346 | Without explicit location, the final crop has no harvest date despite `complete` status. | Resolve the known rotation harvest, or expose missing harvest with an appropriate status.
---
Agent B responses (2026-11-14, one pass, no rerun):
- high P2 refresh: fixed. `POST /v1/plans/future` runs A's `compare.recommend` on the (edited) plan only. It fills each season's `historical_vulnerabilities` and `recommendation_refresh` (status, result_id, method, indicators), and gives `unavailable` with a reason when P2 or its weather is missing (test).
- high repeated legs: fixed. `future.expand` makes one leg per season before edits; editing season 1 never moves season 3, and season 3 is editable (test).
- medium 02-29 shifts: fixed (shared leap-safe `_shift`; test). Plan dates carry no year, so a +1 from 02-28 still goes to 03-01.
- medium check-date provenance: fixed. A check's `origin` is the plan date it falls on (or `calculation`); the rule's own origin is `rule_origin` (test updated).
- medium dependent window diffs: fixed (`window_changes` per season; test).
- medium note provenance: fixed (per-leg origins: the note's plan, appended presets `assumed`, sent plans `grower`; test).
- medium note audit ids: fixed. Each season's days are audited against its own plan id and season (test).
- medium last-season harvest: fixed. It comes from the rotation's next leg, else the location's typical harvest; when neither is known the season says so (`harvest_known: false` + a note) (test).
