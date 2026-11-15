"""Indexed access to the normalized daily table (date-indexed, window slicing)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd


@dataclass(frozen=True)
class WindowStats:
    """Coverage of one window for a set of columns."""

    expected_days: int
    valid_days: int  # days where every requested column is valid
    missing_days: int
    days_outside_record: int  # part of ``missing_days`` that lies outside the table span


class DailySeries:
    """Wraps ``daily.parquet``'s table. Windows are ``[start, end_exclusive)``."""

    def __init__(self, daily: pd.DataFrame):
        frame = daily.copy()
        frame["date"] = pd.to_datetime(frame["date"])
        self._frame = frame.set_index("date").sort_index()
        self.first_date: date = self._frame.index.min().date()
        self.last_date: date = self._frame.index.max().date()
        # one row per calendar day with no gaps: windows inside the record are position slices
        self._contiguous = (self._frame.index.is_unique and len(self._frame)
                            == (self.last_date - self.first_date).days + 1)  # fmt: skip

    @property
    def fingerprint(self) -> str:
        """Hash of the table's dates and values; identifies the data a derived result used."""
        if not hasattr(self, "_fp"):
            digest = hashlib.sha256()
            digest.update(self._frame.index.values.astype("datetime64[D]").tobytes())
            for col in sorted(self._frame.columns):
                if not col.endswith("_reason"):
                    digest.update(col.encode())
                    digest.update(self._frame[col].to_numpy(dtype="float64").tobytes())
            self._fp = digest.hexdigest()[:32]
        return self._fp

    @property
    def frame(self) -> pd.DataFrame:
        return self._frame

    def window(self, columns: list[str], start: date, end_exclusive: date) -> pd.DataFrame:
        """Rows for every calendar day in the window; days outside the record are all-NaN."""
        if (self._contiguous and self.first_date <= start
                and end_exclusive <= self.last_date + timedelta(days=1)):  # fmt: skip
            i0 = (start - self.first_date).days
            i1 = max(i0, (end_exclusive - self.first_date).days)
            rows = self._frame[columns].iloc[i0:i1]
            rows.index.freq = "D"
            return rows
        index = pd.date_range(start, end_exclusive - timedelta(days=1), freq="D")
        return self._frame[columns].reindex(index)

    def stats(self, columns: list[str], start: date, end_exclusive: date) -> WindowStats:
        rows = self.window(columns, start, end_exclusive)
        expected = len(rows)
        valid = int(rows.notna().to_numpy().all(axis=1).sum())
        first, last = start, end_exclusive - timedelta(days=1)
        before = max(0, min((self.first_date - first).days, expected))
        after = max(0, min((last - self.last_date).days, expected))
        outside = min(expected, before + after)
        return WindowStats(expected, valid, expected - valid, outside)
