"""Coverage counts for synthetic daily records, including gaps and leap days."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from acre.weather.series import DailySeries


@pytest.mark.parametrize("missing_date", [False, True])
@pytest.mark.parametrize("columns", [["precip_mm"], ["gwettop", "gwetroot"]])
@pytest.mark.parametrize("start,end", [
    ("2020-02-20", "2020-02-24"),
    ("2020-02-24", "2020-02-29"),
    ("2020-02-27", "2020-03-03"),
    ("2020-02-29", "2020-03-01"),
    ("2020-03-04", "2020-03-10"),
    ("2020-03-10", "2020-03-11"),
    ("2020-02-29", "2020-02-29"),
])
def test_stats_match_daily_windows(missing_date, columns, start, end):
    frame = pd.DataFrame({
        "date": pd.date_range("2020-02-26", periods=7),
        "precip_mm": [0, 1, np.nan, 3, 4, 5, 6],
        "gwettop": [0, np.nan, 0.2, 0.3, 0.4, 0.5, 0.6],
        "gwetroot": [0.1, 0.2, 0.3, np.nan, 0.5, 0.6, 0.7],
    })
    if missing_date:
        frame = frame.drop(2)
    series = DailySeries(frame)
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    window = series.window(columns, first, last)
    for _ in range(2):
        stats = series.stats(columns, first, last)
        assert stats.expected_days == len(window)
        assert stats.valid_days == int(window.notna().all(axis=1).sum())
        assert stats.missing_days == stats.expected_days - stats.valid_days
        outside = sum(d.date() < series.first_date or d.date() > series.last_date
                      for d in window.index)
        assert stats.days_outside_record == outside
