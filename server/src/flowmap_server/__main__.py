"""``python -m flowmap_server`` — run the app under uvicorn (spec §11).

Config is env-first via :meth:`Config.from_env`; the loopback-only bind is
enforced twice: ``from_env`` raises on a non-loopback ``FLOWMAP_HOST``, and
the explicit check below keeps the invariant visible at the entrypoint
(and survives ``python -O``).
"""

from __future__ import annotations

import os

import uvicorn

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.logging_setup import configure_logging, shutdown_logging

__all__ = ["main", "configure_logging"]

def _benchmark_provenance() -> None:
    report = os.environ.get("FLOWMAP_BENCHMARK_PROVENANCE")
    if not report:
        return
    import json
    import sys
    from pathlib import Path
    import flowmap_server
    path = Path(report).resolve()
    owner = os.environ.get("FLOWMAP_BENCHMARK_OWNER")
    profile = os.environ.get("FLOWMAP_BENCHMARK_PROFILE")
    try:
        same_profile = bool(profile) and path.parent.is_dir() and Path(profile).is_dir() and path.parent.samefile(profile)
    except (OSError, ValueError):
        same_profile = False
    if (not owner or not same_profile
            or path.name != "sidecar-provenance.json"
            or (path.parent / ".flowmap-benchmark-owner").read_text(encoding="utf-8") != owner
            or not sys.flags.isolated or not sys.dont_write_bytecode):
        raise RuntimeError("Invalid benchmark provenance ownership/isolation")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": os.getpid(), "owner": owner,
        "executable": str(Path(sys.executable).resolve()),
        "package_origin": str(Path(flowmap_server.__file__).resolve())}), encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    _benchmark_provenance()
    cfg = Config.from_env(os.environ)
    if cfg.host not in ("127.0.0.1", "localhost"):  # survives python -O, unlike assert
        raise SystemExit(f"loopback only (spec §11): refusing to bind {cfg.host!r}")
    log_level = os.environ.get("FLOWMAP_LOG_LEVEL", "info")
    configure_logging(log_level, os.environ.get("FLOWMAP_LOG_FILE") or None)
    try:
        uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port,
                    log_level=log_level, log_config=None)
    finally:
        shutdown_logging()


if __name__ == "__main__":
    main()
