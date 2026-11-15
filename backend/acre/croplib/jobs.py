"""Research jobs for a crop that is already in the library (economics and calendars).

Same pattern as ``croplib.research``: a job is returned at once, the work runs in a thread pool, jobs
live in an in-memory registry, and a repeated request is answered from the library (the cache key
holds the prompt version, model, crop and region) without a new AI call unless ``refresh`` is set.
A cache hit is ``ready`` with no ``check``, which is how the daily budget tells it from a new job.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from acre.research import client

log = logging.getLogger("acre.croplib")

REASONS = {
    "cached": "This crop was already researched for this region; the stored result is used.",
    "research_not_configured": "AI research is not configured on this server (no "
    "OPENROUTER_API_KEY).",
    "nothing_found": "The research ran, but nothing it found passed the source and quote checks.",
    "research_bad_output": "The research answer was not valid JSON in the required shape, even "
    "after one retry.",
    "research_truncated": "The research answer was cut off before it finished.",
    "rate_limited": "The research service is busy; try again later.",
    "provider_error": "The research service returned an error.",
    "research_timeout": "The research service did not answer in time.",
    "research_failed": "Research failed for an unexpected reason.",
}


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Job:
    job_id: str
    crop_id: str
    region_key: str
    job_status: str = "pending"  # pending | ready | failed
    status: str = "unknown"
    reason: str | None = None
    found: dict[str, int] | None = None
    check: dict[str, Any] | None = None
    started_at: str = field(default_factory=now)
    finished_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out = {"job_id": self.job_id, "job_status": self.job_status, "status": self.status,
               "crop_id": self.crop_id, "region_key": self.region_key, "reason": self.reason,
               "reason_text": REASONS.get(self.reason) if self.reason else None,
               "started_at": self.started_at, "finished_at": self.finished_at,
               "found": self.found}  # fmt: skip
        if self.check is not None:
            out["check"] = self.check
        return out


#: ``run()`` result: what was found per kind (counts), and the check log of the answer.
RunResult = tuple[dict[str, int], dict[str, Any]]


class JobBook:
    """The in-memory registry and thread pool of one kind of research job."""

    def __init__(self, prefix: str, thread_name: str) -> None:
        self.prefix = prefix
        self.jobs: dict[str, Job] = {}
        self.running: dict[str, str] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix=thread_name)

    def reset(self) -> None:
        with self.lock:
            self.jobs.clear()
            self.running.clear()

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def _work(self, job: Job, key: str, run: Callable[[], RunResult]) -> None:
        try:
            job.found, job.check = run()
            job.job_status = "ready"
            job.status = "partial" if sum(job.found.values()) else "insufficient_data"
            job.reason = None if sum(job.found.values()) else "nothing_found"
        except client.ResearchError as exc:
            job.job_status, job.status, job.reason = "failed", "unavailable", exc.code
        except Exception:  # noqa: BLE001 - a job must always end
            job.job_status, job.status, job.reason = "failed", "unavailable", "research_failed"
            log.exception("research job failed unexpectedly")
        job.finished_at = now()
        with self.lock:
            self.running.pop(key, None)

    def start(self, crop_id: str, region_key: str, *, key: str,
              cached: Callable[[], dict[str, Any] | None], run: Callable[[], RunResult],
              refresh: bool = False, wait_s: float = 0.0) -> Job:  # fmt: skip
        """``cached()`` returns the stored ``{status, found}`` for this exact key, or None."""
        with self.lock:
            running = self.jobs.get(self.running.get(key, ""))
            if running is not None and running.job_status == "pending":
                return running
            job = Job(f"{self.prefix}_" + uuid.uuid4().hex[:16], crop_id, region_key)
            self.jobs[job.job_id] = job
            hit = None if refresh else cached()
            if hit:
                job.job_status, job.status, job.reason = "ready", hit["status"], "cached"
                job.found, job.finished_at = hit["found"], now()
                return job
            if not client.configured() and not client._CALLER:
                job.job_status, job.status, job.reason = "failed", "unavailable", (
                    "research_not_configured")
                job.finished_at = now()
                return job
            self.running[key] = job.job_id
            fut = self.pool.submit(self._work, job, key, run)
        if wait_s > 0:
            try:
                fut.result(timeout=wait_s)
            except Exception:  # noqa: BLE001 - the job records its own failure
                pass
        return job
