CHANGES NEEDED

HIGH | fieldshift/tools/routes.py:171 | Argentina requests use NC irrigation rules; fertilizer also exposes NC nitrogen references. | Select agronomy by location; test both tools outside NC.

HIGH | fieldshift/research/verify.py:198 | Clearing conditions does not enforce manual_check: fixture ar_b_ai_003 still evaluates as complete. | Explicitly mark downgraded rows and assert their evaluated status.

MEDIUM | fieldshift/research/verify.py:215 | Profile harvest dates, seeding windows and gap_days bypass numeric evidence checks and receive source_checked. | Check each numeric field against its supporting quote.

MEDIUM | fieldshift/research/verify.py:94 | Numeric matching ignores signs; substring matching lets “October 15” support October 1. | Preserve signs and require complete date tokens.

MEDIUM | fieldshift/research/verify.py:192 | Unknown predecessor/successor IDs become null, silently broadening rule applicability. | Reject or downgrade unresolved crop references.

MEDIUM | fieldshift/planner/future.py:305 | P3 leap fix remains incomplete: February 28 +1 returns March 1 in 2028. | Shift resolved dates in their actual years; test both leap boundaries.

MEDIUM | fieldshift/tools/routes.py:49 | field_id rejects the contract’s farm.fields structure; tests exercise only FeatureCollection. | Accept the shared Farm shape and test it.

MEDIUM | fieldshift/field/soilgrids.py:106 | Malformed depths such as [null] raise AttributeError, producing 500 instead of unavailable. | Validate nested provider data and handle malformed responses.

MEDIUM | fieldshift/field/soilgrids.py:164 | A response containing only clay reports complete despite five missing requested properties. | Include all expected properties when determining completeness.

MEDIUM | fieldshift/field/openmeteo.py:30 | {"daily":{}} becomes a complete forecast with entirely missing conditions and no outlook. | Validate usable observations and forecast coverage before caching success.

MEDIUM | fieldshift/planner/routes.py:403 | Candidate provenance accepts arbitrary strings and echoes them as origin. | Validate against the exact origin vocabulary.

MEDIUM | fieldshift/planner/future.py:386 | A grower plan without a known final harvest still reports complete; harvest_known:false does not fix the earlier status finding. | Mark the affected season and overall response partial.
---
Agent B responses (2026-11-14, one pass, no rerun; all 12 fixed, each with a test):
- high tools outside NC: fixed. The fertilizer and irrigation tools use `catalog_for_location(location)`. Outside NC there are no NC irrigation or nitrogen rows; fertilizer products (grades) travel, the nitrogen rules don't.
- high downgraded rows: fixed. A new v3 column, `review: manual_check`, makes the rule engine answer `manual_check` for that row explicitly.
- medium profile numbers: fixed. Crop calendar dates and cover seed windows / gap_days not in their quote are removed and logged in `check.downgraded`.
- medium signs/date tokens: fixed (signed numbers, whole date tokens, thousands separators).
- medium unknown neighbour crops: fixed (row dropped and logged).
- medium leap shift: fixed. An edit moves the date in its season's real year (28 Feb + 1 = 29 Feb 2028).
- medium Farm shape: fixed (`farm.fields[{field_id, geometry}]` or a FeatureCollection).
- medium SoilGrids malformed / missing properties: fixed (malformed → unavailable; missing properties count as missing values → partial).
- medium Open-Meteo empty: fixed (no outlook or no current conditions → unavailable, not cached).
- medium candidate origins: fixed (exact vocabulary; otherwise 400 `invalid_origin`).
- medium unknown final harvest: fixed (season and plan `partial`).
