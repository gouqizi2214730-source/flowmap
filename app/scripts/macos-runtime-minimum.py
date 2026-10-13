"""Derive a Tauri macOS minimum from every Mach-O in the bundled Python runtime."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys


MACHO_MAGICS = {
    bytes.fromhex(value)
    for value in ("feedface", "cefaedfe", "feedfacf", "cffaedfe",
                  "cafebabe", "bebafeca", "cafebabf", "bfbafeca")
}


def version(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", value):
        raise RuntimeError(f"invalid macOS version: {value!r}")
    parts = tuple(int(part) for part in value.split("."))
    if not parts[0]:
        raise RuntimeError(f"invalid macOS version: {value!r}")
    return (parts + (0, 0))[:3]


def version_string(value: tuple[int, int, int]) -> str:
    return f"{value[0]}.{value[1]}" + (f".{value[2]}" if value[2] else "")


def macho_files(runtime: pathlib.Path) -> list[pathlib.Path]:
    """Follow only in-tree links; visit each directory/file inode once."""
    root = runtime.resolve(strict=True)
    if not root.is_dir():
        raise RuntimeError(f"runtime is not a directory: {root}")
    pending = [root]
    visited = set()
    binaries = []
    while pending:
        entry = pending.pop()
        resolved = entry.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise RuntimeError(f"runtime symlink leaves the bundle: {entry} -> {resolved}")
        stat = resolved.stat()
        identity = (stat.st_dev, stat.st_ino)
        if identity in visited:
            continue
        visited.add(identity)
        if resolved.is_dir():
            pending.extend(sorted(resolved.iterdir(), reverse=True))
        elif resolved.is_file():
            with resolved.open("rb") as stream:
                if stream.read(4) in MACHO_MAGICS:
                    binaries.append(resolved)
        else:
            raise RuntimeError(f"unsupported runtime entry: {entry}")
    if not binaries:
        raise RuntimeError(f"no Mach-O files found in {root}")
    return sorted(binaries)


def minimum_commands(output: str, binary: pathlib.Path) -> list[dict[str, str]]:
    """Read minima only from the corresponding load command, for every slice."""
    slices = []
    current = None
    for line in output.splitlines():
        if line == f"{binary}:":
            current = {"architecture": "native", "lines": []}
            slices.append(current)
        elif line.startswith(f"{binary} (architecture ") and line.endswith("):"):
            architecture = line[len(str(binary)) + len(" (architecture "):-2]
            if not architecture:
                raise RuntimeError(f"missing architecture in otool output: {binary}")
            current = {"architecture": architecture, "lines": []}
            slices.append(current)
        elif current is None:
            if line.strip():
                raise RuntimeError(f"unexpected otool output for {binary}: {line!r}")
        else:
            current["lines"].append(line)
    if not slices:
        raise RuntimeError(f"missing Mach-O header in otool output: {binary}")
    architectures = [section["architecture"] for section in slices]
    if len(architectures) != len(set(architectures)):
        raise RuntimeError(f"duplicate architecture headers in otool output: {binary}")
    with binary.open("rb") as stream:
        header = stream.read(8)
    if header[:4] in {bytes.fromhex(value) for value in
                      ("cafebabe", "bebafeca", "cafebabf", "bfbafeca")}:
        endian = "big" if header[:4] in (bytes.fromhex("cafebabe"), bytes.fromhex("cafebabf")) else "little"
        if len(header) != 8 or int.from_bytes(header[4:], endian) != len(slices):
            raise RuntimeError(f"otool did not report every fat Mach-O slice: {binary}")
    records = []
    for section in slices:
        blocks = re.split(r"(?m)^Load command [0-9]+\s*$", "\n".join(section["lines"]))
        if len(blocks) < 2 or blocks[0].strip():
            raise RuntimeError(f"missing/malformed load commands: {binary} ({section['architecture']})")
        minima = []
        for block in blocks[1:]:
            commands = re.findall(r"(?m)^\s+cmd (\S+)\s*$", block)
            if len(commands) != 1:
                raise RuntimeError(f"malformed load command: {binary}: {block!r}")
            command = commands[0]
            if command not in ("LC_BUILD_VERSION", "LC_VERSION_MIN_MACOSX"):
                continue
            key = "minos" if command == "LC_BUILD_VERSION" else "version"
            values = re.findall(rf"(?m)^\s+{key} (\S+)\s*$", block)
            if len(values) != 1:
                raise RuntimeError(f"missing/malformed {key} in {command}: {binary}")
            minimum = version_string(version(values[0]))
            if command == "LC_BUILD_VERSION":
                platforms = re.findall(r"(?m)^\s+platform (\S+)\s*$", block)
                if len(platforms) != 1 or platforms[0].lower() not in ("1", "macos"):
                    raise RuntimeError(f"unsupported/malformed build platform in {binary}: {platforms}")
            minima.append({"architecture": section["architecture"], "command": command,
                           "minimum_version": minimum, "load_command": block.strip()})
        if not minima:
            raise RuntimeError(f"no macOS minimum load command: {binary} ({section['architecture']})")
        records.extend(minima)
    return records


def inspect(runtime: pathlib.Path, configured_floor: str) -> dict:
    root = runtime.resolve(strict=True)
    minimum = version(configured_floor)
    files = []
    for binary in macho_files(root):
        relative = binary.relative_to(root).as_posix()
        try:
            output = subprocess.run(["otool", "-arch", "all", "-l", str(binary)], check=True,
                                    capture_output=True, text=True).stdout
        except (OSError, subprocess.CalledProcessError) as exc:
            detail = exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
            raise RuntimeError(f"otool inspection failed for {relative}: {detail}") from exc
        commands = minimum_commands(output, binary)
        required = max(version(record["minimum_version"]) for record in commands)
        minimum = max(minimum, required)
        files.append({"path": relative, "required_macos": version_string(required),
                      "load_commands": commands})
        print(f"    macOS {version_string(required)}: {relative}", flush=True)
    result = {"configured_floor": version_string(version(configured_floor)),
              "required_macos": version_string(minimum), "macho_files": files}
    print(f"==> Bundled runtime requires macOS {result['required_macos']} "
          f"({len(files)} Mach-O files; configured floor {result['configured_floor']})", flush=True)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=pathlib.Path, required=True)
    parser.add_argument("--config", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    # Remove a previous override before inspection: a failed scan cannot leave a
    # stale lower floor available for a subsequent packaging command.
    args.output.unlink(missing_ok=True)
    args.report.unlink(missing_ok=True)
    config = json.loads(args.config.read_text())
    floor = config["bundle"]["macOS"]["minimumSystemVersion"]
    if not isinstance(floor, str):
        raise RuntimeError("configured macOS minimum must be a version string")
    result = inspect(args.runtime, floor)
    override = {"bundle": {"macOS": {"minimumSystemVersion": result["required_macos"]}}}
    for destination, data in ((args.report, result), (args.output, override)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, KeyError, ValueError) as exc:
        sys.exit(f"ERROR: {exc}")
