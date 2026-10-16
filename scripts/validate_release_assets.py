"""Block publication unless the selected release has all eight installers."""

import argparse
import json
from pathlib import Path
import re
import sys


INSTALLER_SUFFIXES = (
    "aarch64.dmg", "x86_64.dmg",
    "x64-setup.exe", "x64_en-US.msi",
    "arm64-setup.exe", "arm64_en-US.msi",
    "amd64.deb", "amd64.AppImage",
)
INSTALLER_EXTENSIONS = (".dmg", ".exe", ".msi", ".deb", ".appimage")
CHECKSUM_LINE = re.compile(r"[0-9a-fA-F]{64} [ *](.+)")


class ReleaseValidationError(ValueError):
    pass


def checked_basename(name):
    if (not isinstance(name, str) or not name or name != name.strip()
            or name in (".", "..") or "/" in name or "\\" in name
            or any(ord(char) < 32 or 127 <= ord(char) <= 159
                   or char in "\u2028\u2029" for char in name)):
        raise ReleaseValidationError(
            "Asset names must be nonempty basenames without control characters"
        )
    return name


def require_installers(label, names, expected):
    installers = {
        name for name in names
        if name.casefold().startswith("flowmap_")
        and name.casefold().endswith(INSTALLER_EXTENSIONS)
    }
    problems = []
    if expected - installers:
        problems.append("missing installers: " + ", ".join(sorted(expected - installers)))
    if installers - expected:
        problems.append("unexpected installers: " + ", ".join(sorted(installers - expected)))
    if problems:
        raise ReleaseValidationError(label + " " + "; ".join(problems))


def validate_release_assets(tag, checksum_text, release):
    if not re.fullmatch(r"v[0-9]+(?:\.[0-9]+){2,3}", tag):
        raise ReleaseValidationError("Expected a vX.Y.Z or vX.Y.Z.W release tag")
    expected = {f"FlowMap_{tag[1:]}_{suffix}" for suffix in INSTALLER_SUFFIXES}
    checksummed = set()
    # Only LF (optionally CRLF) separates records; splitlines() also discards
    # controls/Unicode separators that standard checksum tools cannot parse.
    records = checksum_text.replace("\r\n", "\n").removesuffix("\n").split("\n")
    for number, line in enumerate(records, 1):
        match = CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ReleaseValidationError(
                f"Malformed SHA256SUMS line {number}: "
                "expected SHA256, two spaces (or space/star), basename"
            )
        name = checked_basename(match[1])
        if name in checksummed:
            raise ReleaseValidationError(f"Duplicate SHA256SUMS basename: {name}")
        checksummed.add(name)

    if not isinstance(release, dict) or not isinstance(release.get("assets"), list):
        raise ReleaseValidationError("Expected GitHub release JSON with an assets array")
    uploaded = set()
    for asset in release["assets"]:
        if not isinstance(asset, dict):
            raise ReleaseValidationError("Expected each GitHub release asset to have a name")
        name = checked_basename(asset.get("name"))
        if name in uploaded:
            raise ReleaseValidationError(f"Duplicate GitHub release asset: {name}")
        uploaded.add(name)

    require_installers("SHA256SUMS", checksummed, expected)
    require_installers("GitHub release assets", uploaded, expected)
    if "SHA256SUMS" not in uploaded:
        raise ReleaseValidationError("GitHub release assets missing SHA256SUMS")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--checksums", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    try:
        validate_release_assets(
            args.tag,
            args.checksums.read_bytes().decode("utf-8"),
            json.loads(args.assets.read_text(encoding="utf-8")),
        )
    except (OSError, UnicodeError, ValueError) as error:
        print(
            f"Release publication blocked: {error}. Rebuild/upload the complete "
            f"installer set and SHA256SUMS for {args.tag}, then rerun the release "
            "workflow; keep the release draft.",
            file=sys.stderr,
        )
        return 1
    print(f"Validated all eight installers and SHA256SUMS for {args.tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
