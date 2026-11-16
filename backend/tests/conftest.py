"""Suite-wide: the API's rate limits are set high so ordinary tests are never throttled
(``tests/api/test_security.py`` builds its own app with low limits)."""

import os

for _name in ("ACRE_RATE_CHEAP_PER_MIN", "ACRE_RATE_ANALYSIS_PER_MIN",
              "ACRE_RATE_GEO_PER_MIN", "ACRE_RATE_WEATHER_PER_MIN",
              "ACRE_RATE_RESEARCH_PER_HOUR", "ACRE_RESEARCH_DAILY_LIMIT"):
    os.environ.setdefault(_name, "1000000")
os.environ.pop("ACRE_ENV", None)
