"""Reject cryptography Mach-O bindings that depend on non-system macOS libraries.

Run with the bundled interpreter after pip installs the locked dependencies.
The Intel source build must contain OpenSSL itself; Homebrew, @rpath, and other
relative load dependencies would otherwise work on CI but fail on a clean Mac.
The binding's own LC_ID_DYLIB install name is metadata, not a load dependency.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import sysconfig
from collections import Counter


LOAD_DYLIB_COMMANDS = {
    "LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB",
    "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB",
}


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


def command_path(commands: list[str], index: int, label: str, minimum_offset: int) -> str:
    if index + 2 >= len(commands):
        raise RuntimeError(f"incomplete {commands[index].strip()} command")
    size = re.fullmatch(r"cmdsize ([0-9]+)", commands[index + 1].strip())
    name = re.fullmatch(rf"{label} (.+) \(offset ([0-9]+)\)", commands[index + 2].strip())
    if size is None or name is None:
        raise RuntimeError(f"malformed {commands[index].strip()} command")
    path, offset = name.group(1), int(name.group(2))
    if offset < minimum_offset or offset + len(path.encode()) + 1 > int(size.group(1)):
        raise RuntimeError(f"invalid {commands[index].strip()} name offset/size")
    return path


def dylib_metadata(commands: list[str], binding: pathlib.Path) -> tuple[Counter[str], Counter[str]]:
    identities: Counter[str] = Counter()
    loaded: Counter[str] = Counter()
    identity_seen = False
    for index, line in enumerate(commands):
        if line.startswith(str(binding)) and line.endswith(":"):
            identity_seen = False  # one LC_ID_DYLIB per architecture slice
        kind = line.strip().removeprefix("cmd ")
        if kind == "LC_ID_DYLIB" or kind in LOAD_DYLIB_COMMANDS:
            name = command_path(commands, index, "name", 24)
            if kind == "LC_ID_DYLIB":
                if identity_seen:
                    raise RuntimeError(f"duplicate LC_ID_DYLIB in {binding}")
                identities[name] += 1
                identity_seen = True
            else:
                loaded[name] += 1
        elif kind == "LC_RPATH":
            rpath = command_path(commands, index, "path", 12)
            print(f"    LC_RPATH {rpath}", flush=True)
            if not system_path(rpath):
                raise RuntimeError(f"non-system cryptography LC_RPATH: {rpath} ({binding})")
    return identities, loaded


def audit(package_dir: pathlib.Path) -> None:
    bindings = sorted(package_dir.rglob("*.so"))
    if not bindings:
        raise RuntimeError(f"no cryptography Mach-O bindings found in {package_dir}")
    print("==> Auditing cryptography macOS library dependencies", flush=True)
    for binding in bindings:
        dependencies = otool("-L", binding)
        print(dependencies, end="" if dependencies.endswith("\n") else "\n", flush=True)
        listed: Counter[str] = Counter()
        for line in dependencies.splitlines():
            if not line.strip():
                continue
            if line.startswith(str(binding)) and line.endswith(":"):
                continue  # otool's filename / architecture header
            if " (compatibility version " not in line or not line[:1].isspace():
                raise RuntimeError(f"unrecognized otool dependency line: {line!r}")
            dependency = line.strip().split(" (compatibility version ", 1)[0]
            listed[dependency] += 1

        commands = otool("-l", binding).splitlines()
        identities, loaded = dylib_metadata(commands, binding)
        # -L includes LC_ID_DYLIB too. Match occurrences against authoritative
        # load commands so an actual load using the same name stays checked.
        if listed != identities + loaded:
            raise RuntimeError(f"otool dependency/load-command mismatch for {binding}")
        if not loaded:
            raise RuntimeError(f"otool reported no library dependencies for {binding}")
        for dependency in loaded:
            if not system_path(dependency):
                raise RuntimeError(f"non-system cryptography dependency: {dependency} ({binding})")
    print(f"    PASS: {len(bindings)} binding(s), system libraries only", flush=True)


if __name__ == "__main__":
    try:
        audit(pathlib.Path(sysconfig.get_path("platlib")) / "cryptography")
    except RuntimeError as exc:
        sys.exit(f"ERROR: {exc}")
