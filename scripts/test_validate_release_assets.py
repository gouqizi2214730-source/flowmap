"""Offline release fixtures; no GitHub calls or installer builds."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from validate_release_assets import ReleaseValidationError, validate_release_assets


INSTALLERS = (
    "FlowMap_1.5.1_aarch64.dmg",
    "FlowMap_1.5.1_x86_64.dmg",
    "FlowMap_1.5.1_x64-setup.exe",
    "FlowMap_1.5.1_x64_en-US.msi",
    "FlowMap_1.5.1_arm64-setup.exe",
    "FlowMap_1.5.1_arm64_en-US.msi",
    "FlowMap_1.5.1_amd64.deb",
    "FlowMap_1.5.1_amd64.AppImage",
)


def manifest(names=INSTALLERS):
    return "".join(f"{hashlib.sha256(name.encode()).hexdigest()}  {name}\n" for name in names)


def release(names=INSTALLERS):
    return {"assets": [{"name": name} for name in (*names, "SHA256SUMS")]}


def record_variants(text):
    records = text.removesuffix("\n")
    yield "LF", text, True
    yield "LF-no-final-newline", records, True
    yield "CRLF", text.replace("\n", "\r\n"), True
    yield "CRLF-no-final-newline", records.replace("\n", "\r\n"), True
    for separator in ("\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029", "\r"):
        yield f"separator-U+{ord(separator):04X}", text.replace("\n", separator), False
    yield "bare-final-CR", records + "\r", False


def workflow_run(workflow, step_name):
    """Extract the actual literal shell block, without a YAML dependency."""
    lines = workflow.splitlines()
    start = lines.index(f"      - name: {step_name}")
    script = lines.index("        run: |", start) + 1
    body = []
    for line in lines[script:]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:])
    return "\n".join(body) + "\n"


class ReleaseAssetsTests(unittest.TestCase):
    def test_all_eight_and_ancillary_assets_are_allowed(self):
        names = (
            *INSTALLERS, "release-notes.txt",
            "FlowMap_1.5.1_amd64.AppImage.sig", "FlowMap_1.5.1_sbom.json",
        )
        validate_release_assets("v1.5.1", manifest(names), release(names))

    def test_hotfix_tag_and_binary_checksums(self):
        names = tuple(name.replace("1.5.1", "1.5.1.2") for name in INSTALLERS)
        validate_release_assets("v1.5.1.2", manifest(names).replace("  ", " *"), release(names))

    def test_missing_appimage_in_manifest_cannot_use_stale_uploaded_copy(self):
        with self.assertRaisesRegex(
            ReleaseValidationError, r"SHA256SUMS missing installers: .*amd64.AppImage"
        ):
            validate_release_assets("v1.5.1", manifest(INSTALLERS[:-1]), release())

    def test_missing_uploaded_appimage_blocks_publication(self):
        with self.assertRaisesRegex(
            ReleaseValidationError, r"GitHub release assets missing installers: .*amd64.AppImage"
        ):
            validate_release_assets("v1.5.1", manifest(), release(INSTALLERS[:-1]))

    def test_every_installer_is_required_on_both_sides(self):
        for missing in INSTALLERS:
            names = tuple(name for name in INSTALLERS if name != missing)
            for checksum_text, assets in (
                (manifest(names), release()), (manifest(), release(names))
            ):
                with self.subTest(missing=missing, checksums_complete=checksum_text == manifest()):
                    with self.assertRaisesRegex(ReleaseValidationError, "missing installers"):
                        validate_release_assets("v1.5.1", checksum_text, assets)

    def test_duplicate_and_conflicting_checksum_names_fail(self):
        for digest in (hashlib.sha256(INSTALLERS[0].encode()).hexdigest(), "f" * 64):
            with self.subTest(digest=digest):
                with self.assertRaisesRegex(ReleaseValidationError, "Duplicate SHA256SUMS basename"):
                    validate_release_assets(
                        "v1.5.1", manifest() + f"{digest}  {INSTALLERS[0]}\n", release()
                    )

    def test_duplicate_release_assets_fail(self):
        with self.assertRaisesRegex(ReleaseValidationError, "Duplicate GitHub release asset"):
            validate_release_assets(
                "v1.5.1", manifest(), release((*INSTALLERS, INSTALLERS[0]))
            )

    def test_unexpected_version_platform_architecture_or_format_fail(self):
        for name in (
            "FlowMap_1.5.0_amd64.AppImage", "FlowMap_1.5.1_arm64.deb",
            "FlowMap_1.5.1_x86.dmg", "FlowMap_1.5.1_amd64.msi",
        ):
            for checksum_text, assets in (
                (manifest((*INSTALLERS, name)), release()),
                (manifest(), release((*INSTALLERS, name))),
            ):
                with self.subTest(name=name, checksums_complete=checksum_text == manifest()):
                    with self.assertRaisesRegex(ReleaseValidationError, "unexpected installers"):
                        validate_release_assets("v1.5.1", checksum_text, assets)

    def test_malformed_checksum_lines_fail(self):
        for line in (
            "", "a" * 63 + "  file", "g" * 64 + "  file",
            "a" * 64 + " file", "a" * 64 + "\tfile", "a" * 64 + "  ",
        ):
            with self.subTest(line=line):
                with self.assertRaisesRegex(ReleaseValidationError, "Malformed SHA256SUMS"):
                    validate_release_assets("v1.5.1", manifest() + line + "\n", release())

    def test_paths_and_control_characters_are_not_basenames(self):
        for name in (
            "../" + INSTALLERS[0], "dir\\" + INSTALLERS[0],
            INSTALLERS[0] + "\t", "\x00file",
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ReleaseValidationError, "basenames"):
                    validate_release_assets(
                        "v1.5.1", manifest((*INSTALLERS, name)), release()
                    )

    def test_checksum_asset_itself_is_required(self):
        with self.assertRaisesRegex(ReleaseValidationError, "missing SHA256SUMS"):
            validate_release_assets(
                "v1.5.1", manifest(), {"assets": [{"name": name} for name in INSTALLERS]}
            )

    def test_invalid_tag_and_asset_json_fail_closed(self):
        for tag in ("1.5.1", "v1.5.1-beta", "v1.5", "v1.5.1; echo bad"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ReleaseValidationError, "release tag"):
                validate_release_assets(tag, manifest(), release())
        for assets in (
            {}, {"assets": None}, {"assets": [None]}, {"assets": [{"name": 1}]}
        ):
            with self.subTest(assets=assets), self.assertRaises(ReleaseValidationError):
                validate_release_assets("v1.5.1", manifest(), assets)

    def test_cli_exit_status_and_actionable_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checksums, assets = root / "SHA256SUMS", root / "release-assets.json"
            assets.write_text(json.dumps(release()), encoding="utf-8")
            for names, expected_status in ((INSTALLERS, 0), (INSTALLERS[:-1], 1)):
                checksums.write_text(manifest(names), encoding="utf-8")
                result = subprocess.run(
                    [sys.executable, "-B", str(Path(__file__).with_name("validate_release_assets.py")),
                     "--tag", "v1.5.1", "--checksums", str(checksums), "--assets", str(assets)],
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, expected_status, result.stderr)
                if expected_status:
                    self.assertIn("amd64.AppImage", result.stderr)
                    self.assertIn("keep the release draft", result.stderr)
                else:
                    self.assertIn("Validated all eight", result.stdout)

    def test_only_lf_or_crlf_record_endings_are_accepted(self):
        names = (*INSTALLERS, "notes with spaces.txt", "sürüm notları.txt")
        for label, text, accepted in record_variants(manifest(names)):
            with self.subTest(variant=label):
                if accepted:
                    validate_release_assets("v1.5.1", text, release(names))
                else:
                    with self.assertRaises(ReleaseValidationError):
                        validate_release_assets("v1.5.1", text, release(names))

    def test_control_and_unicode_separator_characters_in_ancillary_names_fail(self):
        controls = (*range(32), *range(127, 160), 0x2028, 0x2029)
        for codepoint in controls:
            name = "notes" + chr(codepoint) + ".txt"
            for text, assets in (
                (manifest((*INSTALLERS, name)), release()),
                (manifest(), release((*INSTALLERS, name))),
            ):
                with self.subTest(codepoint=codepoint, checksums_complete=text == manifest()):
                    with self.assertRaises(ReleaseValidationError):
                        validate_release_assets("v1.5.1", text, assets)

    def test_cli_does_not_normalize_invalid_record_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checksums, assets = root / "SHA256SUMS", root / "release-assets.json"
            assets.write_text(json.dumps(release()), encoding="utf-8")
            for label, text, accepted in record_variants(manifest()):
                with self.subTest(variant=label):
                    checksums.write_bytes(text.encode("utf-8"))
                    result = subprocess.run(
                        [sys.executable, "-B", str(Path(__file__).with_name("validate_release_assets.py")),
                         "--tag", "v1.5.1", "--checksums", str(checksums), "--assets", str(assets)],
                        capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)
                    if not accepted:
                        self.assertIn("keep the release draft", result.stderr)

    def test_actual_workflow_shell_blocks_invalid_checksum_records(self):
        shell = Path(r"C:\Program Files\Git\bin\bash.exe")
        if not shell.is_file():
            found = shutil.which("bash")
            if not found:
                self.skipTest("Bash is needed to execute the actual workflow shell")
            shell = Path(found)
        source = Path(__file__).resolve().parents[1]
        workflow = (source / ".github/workflows/release.yml").read_text(encoding="utf-8")
        script = workflow_run(workflow, "Require all eight installers before publishing")
        script += workflow_run(workflow, "Publish the release")
        contents = b"offline checksum record fixture\n"
        digest = hashlib.sha256(contents).hexdigest()
        text = "".join(f"{digest}  {name}\n" for name in INSTALLERS)
        for label, checksum_text, accepted in record_variants(text):
            with self.subTest(variant=label):
                with tempfile.TemporaryDirectory(prefix="task9-records-", dir=source.parent) as temporary:
                    root = Path(temporary)
                    (root / "scripts").mkdir()
                    shutil.copyfile(source / "scripts/validate_release_assets.py",
                                    root / "scripts/validate_release_assets.py")
                    (root / "SHA256SUMS").write_bytes(checksum_text.encode("utf-8"))
                    (root / "assets.json").write_text(json.dumps(release()), encoding="utf-8")
                    for name in INSTALLERS:
                        (root / name).write_bytes(contents)
                    binary = root / "bin"
                    binary.mkdir()
                    (binary / "gh").write_text(
                        '#!/usr/bin/env bash\nset -euo pipefail\n'
                        'case "$1 $2" in\n'
                        '  "release view") cat assets.json ;;\n'
                        '  "release edit") printf published > published.txt ;;\n'
                        '  *) exit 99 ;;\nesac\n',
                        encoding="utf-8", newline="\n",
                    )
                    (binary / "python3").write_text(
                        f'#!/usr/bin/env bash\nexec "{Path(sys.executable).as_posix()}" -B "$@"\n',
                        encoding="utf-8", newline="\n",
                    )
                    for path in binary.iterdir():
                        path.chmod(0o755)
                    (root / "check.sh").write_text(script, encoding="utf-8", newline="\n")
                    env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                           "TAG": "v1.5.1", "GITHUB_REPOSITORY": "offline/fixture",
                           "GH_TOKEN": "offline-record-fixture-token"}
                    checksum = subprocess.run(
                        [str(shell), "--noprofile", "--norc", "-c", "sha256sum -c SHA256SUMS"],
                        cwd=root, env=env, capture_output=True, text=True, timeout=30,
                    )
                    result = subprocess.run(
                        [str(shell), "--noprofile", "--norc", "check.sh"], cwd=root, env=env,
                        capture_output=True, text=True, timeout=30,
                    )
                    # CRLF is an explicitly supported input, even on checksum
                    # tool versions that retain CR in the filename themselves.
                    if not label.startswith("CRLF"):
                        self.assertEqual(checksum.returncode == 0, accepted, checksum.stderr)
                    self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)
                    self.assertEqual((root / "published.txt").exists(), accepted)
                    self.assertNotIn(env["GH_TOKEN"], result.stdout + result.stderr)
                    if not accepted:
                        self.assertIn("keep the release draft", result.stderr)


if __name__ == "__main__":
    unittest.main()
