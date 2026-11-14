"""Research jobs (card B3): one region key at a time, cached, with token and time limits.

``start(query)`` returns a job at once; the work runs in a background thread. A finished job writes
``profile.json`` and a catalog v3 ``crop_rules.csv`` to ``$FIELDSHIFT_CACHE_DIR/regions/<key>/``,
which ``catalog_for_location`` then reads (committed profiles under ``data/catalogs/regions/``
still win). A region that already has a researched profile is not researched again unless
``refresh`` is asked for. Without credentials the job fails at once with
``research_not_configured`` and the SAGE profile keeps being served.

Only the region (key, country, admin1, climate class, crops) is ever sent. Logs carry the region
key and job id, never a location.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fieldshift.catalogs import regional, v3
from fieldshift.geo.config import cache_root
from fieldshift.research import client, prompt, verify

log = logging.getLogger("fieldshift.research")

REASONS = {
    "research_not_configured": "AI research is not configured on this server (no Anthropic "
    "credentials); the SAGE crop-calendar profile is used.",
    "research_refused": "The research model declined this request.",
    "research_truncated": "The research answer was cut off before it finished.",
    "research_too_long": "The research step ran out of turns before it finished.",
    "research_bad_output": "The research answer could not be read.",
    "research_rate_limited": "The research service is busy; try again later.",
    "research_api_error": "The research service returned an error.",
    "research_unreachable": "The research service could not be reached.",
    "research_sdk_missing": "The research client library is not installed on this server.",
    "research_failed": "Research failed for an unexpected reason.",
}
DISCLAIMER = ("AI-found suggestions to check with a local adviser; not verified advice. "
              "'source_checked' means code found the quoted words on the cited page, not that a "
              "person checked the advice.")  # fmt: skip


@dataclass
class Job:
    job_id: str
    region_key: str
    job_status: str = "pending"  # pending | ready | failed
    status: str = "unknown"
    reason: str | None = None
    started_at: str = field(default_factory=lambda: _now())
    finished_at: str | None = None
    check: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"job_id": self.job_id, "region_key": self.region_key,
                "job_status": self.job_status, "status": self.status, "reason": self.reason,
                "reason_text": REASONS.get(self.reason) if self.reason else None,
                "started_at": self.started_at, "finished_at": self.finished_at,
                "check": self.check,
                "profile_url": f"/v1/regions/{self.region_key}/profile"
                if self.job_status == "ready" else None}  # fmt: skip


_JOBS: dict[str, Job] = {}
_BY_KEY: dict[str, str] = {}
_LOCK = threading.Lock()
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="research")


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def reset() -> None:
    with _LOCK:
        _JOBS.clear()
        _BY_KEY.clear()


def out_dir(key: str) -> Path:
    return cache_root() / "regions" / key.replace(":", "_")


def researched(key: str) -> bool:
    try:
        doc = json.loads((out_dir(key) / regional.PROFILE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (doc.get("research") or {}).get("job_status") == "ready"


def _csv(rows: list[dict[str, Any]]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=v3.HEADER, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in v3.HEADER})
    return buf.getvalue()


def write_profile(q: prompt.RegionQuery, checked: dict[str, Any], check_log: dict[str, Any],
                  model: str) -> Path:  # fmt: skip
    d = out_dir(q.region_key)
    d.mkdir(parents=True, exist_ok=True)
    doc = {"region_key": q.region_key, "origin": "ai_suggested", "country": q.country,
           "admin1": q.admin1, "koppen": q.koppen,
           "research": {"job_status": "ready", "generated_at": _now(), "model": model,
                        "check": check_log},
           **checked["profile"], "disclaimer": DISCLAIMER}  # fmt: skip
    tmp = d / "profile.json.tmp"
    (d / "crop_rules.csv").write_text(_csv(checked["rows"]), encoding="utf-8")
    tmp.write_text(json.dumps(doc, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(d / regional.PROFILE_FILE)
    regional.clear_cache()
    return d


def run(q: prompt.RegionQuery, fetch: Any = None) -> tuple[dict[str, Any], Any]:
    """Research one region synchronously: the call, the code check, the files."""
    fetch = fetch or verify.fetch_page
    params = prompt.request_params(q)
    answer = client.call(params)
    checked, check_log = verify.check_answer(answer, {"region_key": q.region_key,
                                                      "country": q.country, "admin1": q.admin1,
                                                      "koppen": q.koppen}, fetch)  # fmt: skip
    write_profile(q, checked, check_log.as_dict(), params["model"])
    return checked, check_log


def _work(job: Job, q: prompt.RegionQuery) -> None:
    try:
        _, check_log = run(q)
        job.job_status, job.status, job.check = "ready", "partial", check_log.as_dict()
        log.info("research ready", extra={"region_key": q.region_key, "job_id": job.job_id})
    except client.ResearchError as exc:
        job.job_status, job.status, job.reason = "failed", "unavailable", exc.code
        log.warning("research failed: %s", exc.code)
    except Exception:  # noqa: BLE001 - a job must always end
        job.job_status, job.status, job.reason = "failed", "unavailable", "research_failed"
        log.exception("research failed unexpectedly")
    job.finished_at = _now()


def start(q: prompt.RegionQuery, *, refresh: bool = False, wait_s: float = 0.0) -> Job:
    """One job per region key at a time; a researched region is served from the cache."""
    with _LOCK:
        running = _JOBS.get(_BY_KEY.get(q.region_key, ""))
        if running is not None and running.job_status == "pending":
            return running
        job = Job(job_id="rj_" + uuid.uuid4().hex[:16], region_key=q.region_key)
        _JOBS[job.job_id] = job
        _BY_KEY[q.region_key] = job.job_id
        if not refresh and researched(q.region_key):
            job.job_status, job.status, job.finished_at = "ready", "partial", _now()
            return job
        if not client.configured() and not client._CALLER:
            job.job_status, job.status = "failed", "unavailable"
            job.reason, job.finished_at = "research_not_configured", _now()
            return job
        fut = _EXECUTOR.submit(_work, job, q)
    if wait_s > 0:
        try:
            fut.result(timeout=wait_s)
        except Exception:  # noqa: BLE001 - the job records its own failure; a timeout leaves it pending
            pass
    return job


def get(job_id: str) -> Job | None:
    with _LOCK:
        return _JOBS.get(job_id)
