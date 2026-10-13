"""Reject cryptography Mach-O bindings that depend on non-system macOS libraries.

Run with the bundled interpreter after pip installs the locked dependencies.
The Intel source build must contain OpenSSL itself; Homebrew, @rpath, and other
relative dependencies would otherwise work on CI but fail on a clean Mac.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import sysconfig


def system_path(path: str) -> bool:
    return (
        path in ("/usr/lib", "/System/Library")
        or path.startswith(("/usr/lib/", "/System/Library/"))
    ) and ".." not in pathlib.PurePosixPath(path).parts


def otool(flag: str, binding: pathlib.Path) -> str:
    try:
        return subprocess.run(
            ["otool", flag, str(binding)], check=True, capture_output=True, text=True
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        raise RuntimeError(f"otool {flag} failed for {binding}: {detail}") from exc


def audit(package_dir: pathlib.Path) -> None:
    bindings = sorted(package_dir.rglob("*.so"))
    if not bindings:
        raise RuntimeError(f"no cryptography Mach-O bindings found in {package_dir}")
    print("==> Auditing cryptography macOS library dependencies", flush=True)
    for binding in bindings:
        dependencies = otool("-L", binding)
        print(dependencies, end="" if dependencies.endswith("\n") else "\n", flush=True)
        found = 0
        for line in dependencies.splitlines():
            if not line.strip():
                continue
            if line.startswith(str(binding)) and line.endswith(":"):
                continue  # otool's filename / architecture header
            if " (compatibility version " not in line or not line[:1].isspace():
                raise RuntimeError(f"unrecognized otool dependency line: {line!r}")
            dependency = line.strip().split(" (compatibility version ", 1)[0]
            if not system_path(dependency):
                raise RuntimeError(f"non-system cryptography dependency: {dependency} ({binding})")
            found += 1
        if not found:
            raise RuntimeError(f"otool reported no library dependencies for {binding}")

        # An absolute build-machine RPATH must not survive even if currently
        # unused. Relative RPATHs are unnecessary for this static OpenSSL build.
        commands = otool("-l", binding).splitlines()
        for index, line in enumerate(commands):
            if line.strip() != "cmd LC_RPATH":
                continue
            if index + 2 >= len(commands):
                raise RuntimeError(f"incomplete LC_RPATH command in {binding}")
            path_line = commands[index + 2].strip()
            if not path_line.startswith("path ") or " (offset " not in path_line:
                raise RuntimeError(f"unrecognized LC_RPATH path: {path_line!r}")
            rpath = path_line[5:].rsplit(" (offset ", 1)[0]
            print(f"    LC_RPATH {rpath}", flush=True)
            if not system_path(rpath):
                raise RuntimeError(f"non-system cryptography LC_RPATH: {rpath} ({binding})")
    print(f"    PASS: {len(bindings)} binding(s), system libraries only", flush=True)


if __name__ == "__main__":
    try:
        audit(pathlib.Path(sysconfig.get_path("platlib")) / "cryptography")
    except RuntimeError as exc:
        sys.exit(f"ERROR: {exc}")
