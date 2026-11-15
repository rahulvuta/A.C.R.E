"""Concurrent views reuse a field's first seasonal calculation."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from acre.api.samples import load_samples
from acre.compare import engine
from acre.compare.context import get_context
from acre.simulate import seasons


def test_concurrent_requests_compute_one_leg_once(monkeypatch):
    ctx = get_context()
    plan = load_samples().plans["corn_soy__rye"].plan
    assert plan is not None
    ts = engine.threshold_set_for(ctx, [plan.next_plant])
    calls = []
    value = object()
    start = threading.Barrier(3)

    def compute(*args):
        calls.append(1)
        time.sleep(0.05)
        return value

    def run():
        start.wait(timeout=2)
        return seasons.leg_seasons(plan, ctx, ts)

    seasons.clear_cache()
    monkeypatch.setattr(seasons, "_compute", compute)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(run), pool.submit(run)
            start.wait(timeout=2)
            assert a.result(timeout=2) is value
            assert b.result(timeout=2) is value
        assert len(calls) == 1
    finally:
        seasons.clear_cache()
