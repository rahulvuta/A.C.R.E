"""Field geometry (A3): validity, geodesic area and centroid. Pure functions, no dependencies.

* **Area** uses the same spherical-excess ring formula as turf.js ``@turf/area`` (Chamberlain and
  Duquette, "Some algorithms for polygons on a sphere", JPL 2007) with the WGS84 equatorial radius
  6378137 m, so the backend and the map agree. Holes are subtracted; a MultiPolygon is the sum of
  its parts (all parts are one field).
* **Centroid** is the area-weighted centroid in a local equirectangular projection around the
  field. It is for grouping by weather cell and for display (rounded to 2 decimals); it is never
  logged.
* **Validity**: GeoJSON ``Polygon`` or ``MultiPolygon``, closed rings of at least 4 positions,
  finite coordinates in range, no ring crossing itself (a "bowtie"), and holes inside their outer
  ring. Rings that cross the antimeridian are not supported.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

EARTH_RADIUS_M = 6378137.0  # turf.js earthRadius
M2_PER_HA = 10_000.0
HA_PER_AC = 0.40468564224
MAX_VERTICES = 5000

Ring = list[tuple[float, float]]  # (lon, lat)


class GeometryError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FieldShape:
    polygons: list[list[Ring]]  # [polygon][ring 0 = outer, 1.. = holes]
    area_m2: float
    centroid_lat: float
    centroid_lon: float

    @property
    def area_ha(self) -> float:
        return self.area_m2 / M2_PER_HA

    @property
    def area_ac(self) -> float:
        return self.area_ha / HA_PER_AC


def _ring(raw: Any) -> Ring:
    if not isinstance(raw, list) or len(raw) < 4:
        raise GeometryError("invalid_ring", "each ring needs at least 4 positions")
    pts: Ring = []
    for p in raw:
        if (not isinstance(p, list | tuple) or len(p) < 2
                or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in p[:2])):  # fmt: skip
            raise GeometryError("invalid_position", "each position must be [longitude, latitude]")
        lon, lat = float(p[0]), float(p[1])
        if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180
                and -90 <= lat <= 90):  # fmt: skip
            raise GeometryError("invalid_position", "coordinates are out of range")
        pts.append((lon, lat))
    if pts[0] != pts[-1]:
        raise GeometryError("ring_not_closed", "the first and last positions must be the same")
    if len(set(pts[:-1])) < 3:
        raise GeometryError("invalid_ring", "a ring needs at least 3 distinct positions")
    return pts


def ring_area_m2(ring: Ring) -> float:
    """Signed spherical ring area (turf ``ringArea``); the closing position is not repeated."""
    coords = ring[:-1]
    n = len(coords)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        lower, middle, upper = coords[i], coords[(i + 1) % n], coords[(i + 2) % n]
        total += (math.radians(upper[0]) - math.radians(lower[0])) * math.sin(
            math.radians(middle[1]))
    return total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0


def _orient(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a, b, p) -> bool:  # noqa: ANN001
    return (min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= p[1] <= max(a[1], b[1]))  # fmt: skip


def segments_intersect(p1, p2, q1, q2) -> bool:  # noqa: ANN001
    d1, d2 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    d3, d4 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    if ((d1 > 0) != (d2 > 0) and d1 != 0 and d2 != 0
            and (d3 > 0) != (d4 > 0) and d3 != 0 and d4 != 0):  # fmt: skip
        return True
    return ((d1 == 0 and _on_segment(q1, q2, p1)) or (d2 == 0 and _on_segment(q1, q2, p2))
            or (d3 == 0 and _on_segment(p1, p2, q1)) or (d4 == 0 and _on_segment(p1, p2, q2)))  # fmt: skip


Edge = tuple[tuple[float, float], tuple[float, float]]


def _overlapping_pairs(edges: list[tuple[int, Edge]]):  # noqa: ANN202
    """Pairs of edges whose bounding boxes overlap: a sweep over x, so a 5,000-vertex field costs
    about n log n plus the real near pairs instead of n² segment tests."""
    items = sorted(edges, key=lambda e: min(e[1][0][0], e[1][1][0]))
    active: list[tuple[float, int, Edge, float, float]] = []
    for tag, e in items:
        x0 = min(e[0][0], e[1][0])
        x1 = max(e[0][0], e[1][0])
        y0 = min(e[0][1], e[1][1])
        y1 = max(e[0][1], e[1][1])
        active = [a for a in active if a[0] >= x0]
        for _ax1, atag, ae, ay0, ay1 in active:
            if ay0 <= y1 and y0 <= ay1:
                yield (atag, ae), (tag, e)
        active.append((x1, tag, e, y0, y1))


def self_intersects(ring: Ring) -> bool:
    """True when two non-adjacent edges of the ring touch or cross (planar test in lon/lat)."""
    edges = list(zip(ring[:-1], ring[1:], strict=True))
    n = len(edges)
    for (i, ei), (j, ej) in _overlapping_pairs(list(enumerate(edges))):
        i, j = min(i, j), max(i, j)
        if j == i + 1 or (i == 0 and j == n - 1):
            continue  # adjacent edges share a vertex
        if segments_intersect(*ei, *ej):
            return True
    return False


def rings_touch(a: Ring, b: Ring) -> bool:
    """True when any edge of ``a`` touches or crosses any edge of ``b``."""
    ea = [(0, e) for e in zip(a[:-1], a[1:], strict=True)]
    eb = [(1, e) for e in zip(b[:-1], b[1:], strict=True)]
    return any(ta != tb and segments_intersect(*e1, *e2)
               for (ta, e1), (tb, e2) in _overlapping_pairs(ea + eb))  # fmt: skip


def _point_in_ring(pt: tuple[float, float], ring: Ring) -> bool:
    x, y = pt
    inside = False
    for (x1, y1), (x2, y2) in zip(ring[:-1], ring[1:], strict=True):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _centroid(polys: list[list[Ring]]) -> tuple[float, float]:
    lat0 = polys[0][0][0][1]
    lon0 = polys[0][0][0][0]
    k = math.cos(math.radians(lat0))
    sx = sy = sa = 0.0
    for poly in polys:
        for idx, ring in enumerate(poly):
            pts = [((lon - lon0) * k, lat - lat0) for lon, lat in ring]
            a = cx = cy = 0.0
            for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:], strict=True):
                cross = x1 * y2 - x2 * y1
                a += cross
                cx += (x1 + x2) * cross
                cy += (y1 + y2) * cross
            a /= 2.0
            if a == 0:
                continue
            cx, cy = cx / (6 * a), cy / (6 * a)
            w = abs(a) * (-1 if idx > 0 else 1)  # holes subtract
            sx, sy, sa = sx + cx * w, sy + cy * w, sa + w
    if sa == 0:
        raise GeometryError("zero_area", "the field has no area")
    return lat0 + sy / sa, lon0 + (sx / sa) / k


def parse_field(geometry: Any) -> FieldShape:
    """Validate a GeoJSON Polygon/MultiPolygon and measure it. Raises :class:`GeometryError`."""
    if not isinstance(geometry, dict):
        raise GeometryError("invalid_geometry", "geometry must be a GeoJSON object")
    kind, coords = geometry.get("type"), geometry.get("coordinates")
    if kind == "Polygon":
        raw_polys = [coords]
    elif kind == "MultiPolygon":
        raw_polys = coords if isinstance(coords, list) else None
    else:
        raise GeometryError("invalid_geometry", "geometry must be a Polygon or a MultiPolygon")
    if not raw_polys or not all(isinstance(p, list) and p for p in raw_polys):
        raise GeometryError("invalid_geometry", "the geometry has no rings")
    if sum(len(r) if isinstance(r, list) else 0 for p in raw_polys for r in p) > MAX_VERTICES:
        raise GeometryError("too_many_vertices", f"at most {MAX_VERTICES} positions per field")
    polys = [[_ring(r) for r in p] for p in raw_polys]
    if sum(len(r) for p in polys for r in p) > MAX_VERTICES:
        raise GeometryError("too_many_vertices", f"at most {MAX_VERTICES} positions per field")
    for poly in polys:
        for ring in poly:
            if max(lon for lon, _ in ring) - min(lon for lon, _ in ring) > 180:
                raise GeometryError("crosses_antimeridian",
                                    "fields that cross the 180th meridian are not supported")  # fmt: skip
            if self_intersects(ring):
                raise GeometryError("self_intersection", "the boundary crosses itself")
        outer = poly[0]
        holes = poly[1:]
        for k, hole in enumerate(holes):
            if rings_touch(hole, outer) or not _point_in_ring(hole[0], outer):
                raise GeometryError("hole_outside", "a hole must lie inside its field")
            for other in holes[k + 1:]:
                if (rings_touch(hole, other) or _point_in_ring(hole[0], other)
                        or _point_in_ring(other[0], hole)):  # fmt: skip
                    raise GeometryError("holes_overlap", "two holes overlap")
    def inside(pt: tuple[float, float], poly: list[Ring]) -> bool:  # in its area, not in a hole
        return _point_in_ring(pt, poly[0]) and not any(_point_in_ring(pt, h) for h in poly[1:])

    for i, a in enumerate(polys):
        for b in polys[i + 1:]:
            if (any(rings_touch(ra, rb) for ra in a for rb in b)
                    or inside(a[0][0], b) or inside(b[0][0], a)):  # fmt: skip
                raise GeometryError("parts_overlap", "two parts of the field touch or overlap")
    area = 0.0
    for poly in polys:
        area += abs(ring_area_m2(poly[0])) - sum(abs(ring_area_m2(h)) for h in poly[1:])
    if area <= 0:
        raise GeometryError("zero_area", "the field has no area")
    lat, lon = _centroid(polys)
    return FieldShape(polys, area, lat, lon)
