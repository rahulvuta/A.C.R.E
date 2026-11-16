"""Non-dominated shortlist and rank-position ordering (P2). Method: ``docs/indicators.md``.

Pure functions over ``{candidate_id: {indicator: value}}`` and ``{indicator: direction}``. Raw values
of different indicators are never combined. Ordering uses only rank positions, and the sorting
key is never returned.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

Vector = Mapping[str, float | int | None]


def better(a: float, b: float, direction: str) -> bool:
    return a < b if direction == "lower_better" else a > b


def dominates(a: Vector, b: Vector, directions: Mapping[str, str]) -> bool:
    """``a`` is at least as good on every indicator and strictly better on one."""
    strictly = False
    for name, d in directions.items():
        va, vb = a[name], b[name]
        assert va is not None and vb is not None
        if better(vb, va, d):
            return False
        if better(va, vb, d):
            strictly = True
    return strictly


@dataclass
class ParetoResult:
    shortlist: list[str]  # ordered
    dominated: dict[str, list[str]]  # candidate -> dominated by
    not_comparable: dict[str, list[str]]  # candidate -> missing indicators
    ranks: dict[str, dict[str, int]] = field(default_factory=dict)  # within the shortlist
    # within every comparable candidate (shortlist + dominated), for explanations
    ranks_all: dict[str, dict[str, int]] = field(default_factory=dict)
    comparable: list[str] = field(default_factory=list)


def rank_positions(ids: list[str], vectors: Mapping[str, Vector], name: str,
                   direction: str) -> dict[str, int]:  # fmt: skip
    """1 = best; ties share the lower (better) rank (competition ranking)."""
    out: dict[str, int] = {}
    for cid in ids:
        v = vectors[cid][name]
        assert v is not None
        out[cid] = 1 + sum(1 for o in ids if better(vectors[o][name], v, direction))  # type: ignore[arg-type]
    return out


def pareto(
    vectors: Mapping[str, Vector], directions: Mapping[str, str], weights: Mapping[str, int]
) -> ParetoResult:
    """Shortlist over the indicators in ``directions``; order by sum(weight x rank position)."""
    names = list(directions)
    comparable = [c for c in vectors if all(vectors[c].get(n) is not None for n in names)]
    missing = {c: [n for n in names if vectors[c].get(n) is None]
               for c in vectors if c not in comparable}  # fmt: skip
    dominated: dict[str, list[str]] = {}
    for c in comparable:
        by = [o for o in comparable if o != c and dominates(vectors[o], vectors[c], directions)]
        if by:
            dominated[c] = sorted(by)
    short = [c for c in comparable if c not in dominated]
    ranks = {n: rank_positions(short, vectors, n, directions[n]) for n in names}
    per_candidate = {c: {n: ranks[n][c] for n in names} for c in short}

    def key(c: str) -> tuple[int, str]:
        return (sum(weights.get(n, 1) * per_candidate[c][n] for n in names), c)

    all_ranks = {n: rank_positions(comparable, vectors, n, directions[n]) for n in names}
    ranks_all = {c: {n: all_ranks[n][c] for n in names} for c in comparable}
    return ParetoResult(sorted(short, key=key), dominated, missing, per_candidate, ranks_all,
                        comparable)
