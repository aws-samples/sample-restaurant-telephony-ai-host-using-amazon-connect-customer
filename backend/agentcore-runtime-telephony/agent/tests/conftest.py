"""Shared fixtures — make the agent module importable under `pytest` when
invoked from the repo root or from the agent/ directory itself.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Put the agent/ directory on sys.path so top-level module imports
# (`import telephony_agent`, `import session`, etc.) work regardless of cwd.
_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

# Ensure tests never attempt real AWS calls.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("DEPLOYMENT_PREFIX", "qsr-tel-test")
# Empty pepper — pstn_customer.derive(raw, b"") still satisfies R8 determinism
# (two calls with the same raw + same empty pepper produce the same digest).
os.environ.setdefault("CUSTOMER_ID_PEPPER_PARAMETER_NAME", "")
