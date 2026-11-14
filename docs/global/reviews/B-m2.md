CHANGES NEEDED

HIGH | fieldshift/planner/routes.py:514 | P2 refresh remains a stub; historical vulnerabilities stay empty. | Integrate P2 for changed plans and priorities; test refresh behavior.

HIGH | fieldshift/planner/future.py:276 | Editing season 1 also changes season 3; editing season 3 returns 400. | Expand repeated legs before applying season-specific edits; add regressions.

MEDIUM | fieldshift/planner/future.py:72 | Shifts use 2001: February 29 causes 500; February 28 +1 skips leap day in 2028. | Shift resolved dates in their actual years; test leap boundaries.

MEDIUM | fieldshift/planner/future.py:166 | Check dates copied from plan dates are labelled `verified_source`. | Separate date provenance from rule provenance; correct the existing provenance test.

MEDIUM | fieldshift/planner/future.py:381 | Moving season 2 harvest changes season 1’s growing window, but its diff is omitted. | Include dependent window changes in diffs.

MEDIUM | fieldshift/report/routes.py:352 | One provenance basis labels grower-supplied future plans `assumed`, or appended presets `grower`. | Track provenance per leg and field.

MEDIUM | fieldshift/report/field_note.py:694 | Later-season day counts audit against the first plan’s ID. | Reference each season’s actual plan and calculation dates; test audit contents.

MEDIUM | fieldshift/planner/future.py:346 | Without explicit location, the final crop has no harvest date despite `complete` status. | Resolve the known rotation harvest, or expose missing harvest with an appropriate status.