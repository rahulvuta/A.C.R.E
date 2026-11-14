import os
import subprocess
import sys


def test_old_fieldshift_env_names_still_work():
    code = "import os, acre; print(os.environ.get('ACRE_ENV'), os.environ.get('ACRE_TRUST_PROXY'))"
    env = {**os.environ, "FIELDSHIFT_ENV": "production", "ACRE_TRUST_PROXY": "1", "FIELDSHIFT_TRUST_PROXY": "0"}
    env.pop("ACRE_ENV", None)
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True)
    assert out.stdout.split() == ["production", "1"]  # old name maps; new name wins
