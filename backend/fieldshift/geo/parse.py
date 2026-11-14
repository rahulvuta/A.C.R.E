"""Parse a pair of coordinates typed by a person: decimal degrees or degrees-minutes-seconds.

``"35.1, -80.5"``, ``"35.1 N 80.5 W"`` and ``35°06'N 80°30'W`` all give the same point. Anything
that is not clearly two coordinates is ``None`` (the caller then treats the text as a place name).
A latitude/longitude out of range is a :class:`CoordinateError`, because the text *was* meant as
coordinates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_PRIMES = str.maketrans({"′": "'", "’": "'", "‘": "'", "″": '"', "”": '"', "“": '"', "−": "-",
                         "º": "°", "˚": "°", "(": " ", ")": " ", "[": " ", "]": " ",
                         "{": " ", "}": " "})  # fmt: skip
_BODY = r"""
    (?P<sign>[+-])?\s*
    (?:
        (?P<dd>\d*\.\d+|\d+\.)
      | (?P<d>\d+)
        (?:\s*°\s*|\s+)?
        (?:(?P<m>\d+(?:\.\d+)?)\s*'?\s*
           (?:(?P<s>\d+(?:\.\d+)?)\s*(?:"|'')?)?
        )?
    )
    \s*°?\s*
"""
# Letters come before the numbers ("N35°06' W80°30'") or after them ("35°06'N 80°30'W"), not both.
_PREFIXED = re.compile(r"(?P<pre>[NSEW])?\s*" + _BODY, re.VERBOSE | re.IGNORECASE)
_SUFFIXED = re.compile(_BODY + r"(?P<suf>[NSEW])?", re.VERBOSE | re.IGNORECASE)
_SEPARATORS = re.compile(r"[,;/]")


class CoordinateError(ValueError):
    """The text looks like coordinates but is not a valid point."""


@dataclass(frozen=True)
class ParsedPoint:
    latitude: float
    longitude: float


def _value(match: re.Match[str]) -> tuple[float, str | None]:
    """Signed decimal degrees of one component and the hemisphere letter it carried, if any."""
    groups = match.groupdict()
    letter = (groups.get("pre") or groups.get("suf") or "").upper() or None
    if match["dd"] is not None:
        magnitude = float(match["dd"])
    else:
        magnitude = float(match["d"])
        if match["m"] is not None:
            minutes = float(match["m"])
            if minutes >= 60:
                raise CoordinateError("minutes must be below 60")
            magnitude += minutes / 60
        if match["s"] is not None:
            seconds = float(match["s"])
            if seconds >= 60:
                raise CoordinateError("seconds must be below 60")
            magnitude += seconds / 3600
    negative = match["sign"] == "-"
    if letter is not None and negative:
        raise CoordinateError("a minus sign and a hemisphere letter contradict each other")
    if letter in ("S", "W"):
        negative = True
    return (-magnitude if negative else magnitude), letter


_COORDINATE_LIKE = re.compile(r"[\d\s.,;:/+\-°'\"NSEWnsew]+")


def looks_like_coordinates(text: str) -> bool:
    """True for text made only of numbers, signs, degree marks and N/S/E/W.

    Such text is never sent to a geocoder: if it did not parse as a point it is rejected locally,
    so a mistyped coordinate pair cannot leak to a third party as a search query.
    """
    raw = (text or "").strip().translate(_PRIMES)
    return (
        bool(raw) and any(c.isdigit() for c in raw) and _COORDINATE_LIKE.fullmatch(raw) is not None
    )


def parse_coordinates(text: str) -> ParsedPoint | None:
    """The point the text names, ``None`` if it is not two coordinates, or an error if invalid."""
    raw = (text or "").strip().translate(_PRIMES)
    if not raw or len(raw) > 80:
        return None
    pattern = _PREFIXED if raw[0].upper() in "NSEW" else _SUFFIXED
    parts = [p for p in _SEPARATORS.split(raw) if p.strip()]
    matches: list[re.Match[str]] = []
    if len(parts) == 2:
        for part in parts:
            m = pattern.fullmatch(part.strip())
            if m is None:
                return None
            matches.append(m)
    elif len(parts) == 1:
        pos = 0
        while pos < len(raw):
            m = pattern.match(raw, pos)
            if m is None or m.end() == pos:
                if raw[pos].isspace():
                    pos += 1
                    continue
                return None
            matches.append(m)
            pos = m.end()
    else:
        return None
    if len(matches) != 2:
        return None
    (v1, l1), (v2, l2) = (_value(m) for m in matches)
    if l1 is None and l2 is None:
        if any(m["m"] is not None for m in matches) and not any(c in raw for c in "°'\""):
            return None  # bare "1 2 3 4 5" is not degrees-minutes-seconds without marks or letters
        lat, lon = v1, v2
    elif l1 in ("N", "S") and l2 in ("E", "W", None):
        lat, lon = v1, v2
    elif l1 in ("E", "W") and l2 in ("N", "S", None):
        lat, lon = v2, v1
    elif l1 is None and l2 in ("E", "W"):
        lat, lon = v1, v2
    elif l1 is None and l2 in ("N", "S"):
        lat, lon = v2, v1
    else:
        raise CoordinateError("give one latitude (N/S) and one longitude (E/W)")
    if not -90 <= lat <= 90:
        raise CoordinateError("latitude must be within [-90, 90]")
    if not -180 <= lon <= 180:
        raise CoordinateError("longitude must be within [-180, 180]")
    return ParsedPoint(lat, lon)
