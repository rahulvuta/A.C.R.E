CHANGES NEEDED

HIGH | fieldshift/farms/analyze.py:214 | Farm recommendations omit the original location; a South Carolina field’s replay resolves into NC and uses NC rules and thresholds (reproduced). | Pass a location that preserves the field’s cell, scope and catalog.

HIGH | fieldshift/compare/recommend.py:393 | Pareto uses numeric values from partial indicators; unresolved rule checks can influence dominance as though fully evaluated. | Exclude candidates with incomplete selected indicators from dominance comparisons.

MEDIUM | fieldshift/weather/ondemand.py:421 | Fetch deduplication is process-local; workers sharing the cache can fetch concurrently and race current.json/history updates. | Lock per cell across processes and recheck storage after acquiring the lock.

MEDIUM | fieldshift/api/routes.py:305 | Unprepared non-NC comparisons return Union’s 76.2 mm threshold and NC v2 catalog metadata (reproduced offline). | Return unavailable/null thresholds and catalog metadata instead of the Union fallback.