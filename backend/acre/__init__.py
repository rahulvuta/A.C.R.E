"""A.C.R.E backend."""

import os as _os


def _legacy_env() -> None:
    """Accept the pre-rename ``FIELDSHIFT_*`` settings as ``ACRE_*`` (the new name wins).

    Deployments configured before the rename (e.g. Render env vars) keep working.
    """
    for key, value in list(_os.environ.items()):
        if key.startswith("FIELDSHIFT_"):
            _os.environ.setdefault("ACRE_" + key[len("FIELDSHIFT_"):], value)


_legacy_env()
