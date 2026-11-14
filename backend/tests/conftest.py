"""Suite-wide: the API's rate limits are set high so ordinary tests are never throttled
(``tests/api/test_security.py`` builds its own app with low limits)."""

import os

for _name in ("FIELDSHIFT_RATE_CHEAP_PER_MIN", "FIELDSHIFT_RATE_ANALYSIS_PER_MIN",
              "FIELDSHIFT_RATE_GEO_PER_MIN", "FIELDSHIFT_RATE_WEATHER_PER_MIN",
              "FIELDSHIFT_RATE_RESEARCH_PER_HOUR", "FIELDSHIFT_RESEARCH_DAILY_LIMIT"):
    os.environ.setdefault(_name, "1000000")
os.environ.pop("FIELDSHIFT_ENV", None)
