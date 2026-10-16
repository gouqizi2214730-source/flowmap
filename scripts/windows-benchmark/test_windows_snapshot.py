"""Real Windows snapshot I/O, using the production PowerShell functions and writer."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from run import _replace_snapshot, write

HERE = Path(__file__).resolve().parent
PS_LOAD = r'''
param([string]$Source, [string]$Root)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Sampler parse error' }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @('Open-IdentitySnapshot', 'Read-IdentitySnapshot')
}, $true))
if ($functions.Count -ne 2) { throw 'Production snapshot functions missing' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$IdentityFile = Join-Path $Root 'identities-ışık.json'
'''


@unittest.skipUnless(os.name == 'nt', 'Real Windows/PowerShell file sharing')
class WindowsSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='snapshot-Kullanıcı-ışık-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root/'identities-ışık.json'

    def powershell(self, body):
        script = self.root/'reader.ps1'
        script.write_text(PS_LOAD + body, encoding='utf-8-sig')
        proc = subprocess.Popen(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(script), str(HERE/'sample.ps1'), str(self.root)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8')

        def close():
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=10)
        self.addCleanup(close)
        return proc

    def finish(self, proc, message=None):
        stdout, stderr = proc.communicate(message, timeout=20)
        self.assertEqual(proc.returncode, 0, stderr)
        return json.loads(stdout)

    def snapshot(self, version):
        return [{'pid': version*100+i, 'creation_ticks': 134365278654594588+i,
                 'text': 'Kullanıcı-ışık-日本語-'+str(version)+'x'*2048} for i in range(16)]

    def hold_file(self, path=None, share=3):
        """Actual Windows reader handle with the legacy non-delete share mode."""
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                           ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        create.restype = ctypes.c_void_p
        close = kernel.CloseHandle
        close.argtypes = [ctypes.c_void_p]
        close.restype = ctypes.c_int
        handle = create(str(path or self.path), 0x80000000, share, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        closed = False

        def release():
            nonlocal closed
            if not closed:
                self.assertTrue(close(handle))
                closed = True
        self.addCleanup(release)
        return release

    def test_production_opener_holds_complete_old_snapshot_during_atomic_replace(self):
        old, new = self.snapshot(1), self.snapshot(2)
        # Put real UTF-8 bytes on disk; run.write intentionally escapes Unicode.
        self.path.write_text(json.dumps(old, ensure_ascii=False), encoding='utf-8')
        proc = self.powershell(r'''
$stream = Open-IdentitySnapshot -Path $IdentityFile
$reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $true)
try {
    $first = $reader.Read()
    [Console]::WriteLine('HELD')
    if ([Console]::ReadLine() -ne 'continue') { throw 'Handshake failed' }
    $old = (([char]$first).ToString() + $reader.ReadToEnd()) | ConvertFrom-Json
} finally { $reader.Dispose() }
$new = @(Read-IdentitySnapshot -Path $IdentityFile)
@{old=@($old);new=$new} | ConvertTo-Json -Depth 5 -Compress
''')
        self.assertEqual(proc.stdout.readline().strip(), 'HELD')
        with patch('run._replace_snapshot', wraps=_replace_snapshot) as replace:
            write(self.path, new)
        # Delete sharing removes this conflict; retry must not be needed.
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.finish(proc, 'continue\n'), {'old': old, 'new': new})

    def test_utf8_bom_and_no_bom_and_disposal_before_process_exit(self):
        expected = self.snapshot(3)
        for name, encoding in (('plain.json', 'utf-8'), ('bom.json', 'utf-8-sig')):
            (self.root/name).write_text(json.dumps(expected, ensure_ascii=False), encoding=encoding)
        proc = self.powershell(r'''
$result = @()
foreach ($name in @('plain.json', 'bom.json')) {
    $path = Join-Path $Root $name
    $result += ,@(Read-IdentitySnapshot -Path $path)
    # Exclusive open in this same process proves Read-IdentitySnapshot disposed.
    $exclusive = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $exclusive.Dispose()
}
ConvertTo-Json -InputObject $result -Depth 5 -Compress
''')
        self.assertEqual(self.finish(proc), [expected, expected])

    def test_parse_decode_and_missing_errors_remain_missing_observations_and_dispose(self):
        (self.root/'malformed.json').write_text('[{"pid":', encoding='utf-8')
        (self.root/'invalid-utf8.json').write_bytes(b'[{"text":"\xff"}]')
        proc = self.powershell(r'''
$readAttempt = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.TryStatementAst] -and
    $node.Body.Statements.Count -eq 1 -and
    $node.Body.Statements[0].Extent.Text -eq '$identities = Read-IdentitySnapshot -Path $IdentityFile'
}, $true)
if (-not $readAttempt) { throw 'Production missing-observation catch absent' }
$result = @()
foreach ($name in @('malformed.json', 'invalid-utf8.json', 'missing.json')) {
    $IdentityFile = Join-Path $Root $name
    $identities = @(); $errors = [Collections.Generic.List[string]]::new()
    . ([scriptblock]::Create($readAttempt.Extent.Text))
    $result += @{observations=@($identities).Count;errors=$errors.Count}
    if (Test-Path -LiteralPath $IdentityFile) {
        $exclusive = [IO.File]::Open($IdentityFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $exclusive.Dispose()
    }
}
ConvertTo-Json -InputObject $result -Depth 5 -Compress
''')
        self.assertEqual(self.finish(proc), [{'observations': 0, 'errors': 1}]*3)

    def test_repeated_production_reads_only_observe_coherent_old_or_new_json(self):
        old, new = self.snapshot(4), self.snapshot(5)
        write(self.path, old)
        proc = self.powershell(r'''
$reads = [Collections.Generic.List[object]]::new()
$reads.Add(@(Read-IdentitySnapshot -Path $IdentityFile))
[Console]::WriteLine('READY')
while (-not (Test-Path -LiteralPath (Join-Path $Root 'stop'))) {
    $reads.Add(@(Read-IdentitySnapshot -Path $IdentityFile))
}
$reads.Add(@(Read-IdentitySnapshot -Path $IdentityFile))
ConvertTo-Json -InputObject @($reads.ToArray()) -Depth 5 -Compress
''')
        self.assertEqual(proc.stdout.readline().strip(), 'READY')
        try:
            for i in range(100):
                write(self.path, old if i % 2 == 0 else new)
                time.sleep(.001)
        finally:
            (self.root/'stop').touch()
        reads = self.finish(proc)
        self.assertGreater(len(reads), 2)
        self.assertEqual(reads[0], old)
        self.assertEqual(reads[-1], new)
        self.assertTrue(all(value == old or value == new for value in reads))

    def test_actual_transient_sharing_error_recovers_on_next_atomic_replace(self):
        old, new = self.snapshot(6), self.snapshot(7)
        write(self.path, old)
        release = self.hold_file()

        def unblock(delay):
            self.assertEqual(delay, .01)
            self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), old)
            self.assertEqual(json.loads(self.path.with_suffix('.json.tmp').read_text(encoding='utf-8')), new)
            release()

        with patch('run.time.sleep', side_effect=unblock) as sleep:
            write(self.path, new)
        self.assertEqual(sleep.call_count, 1)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), new)
        self.assertFalse(self.path.with_suffix('.json.tmp').exists())
        self.hold_file(share=0)()  # The production rename handle is already closed.

    def test_actual_persistent_sharing_error_is_bounded_and_preserves_old_snapshot(self):
        old, new = self.snapshot(8), self.snapshot(9)
        write(self.path, old)
        release = self.hold_file()
        with patch('run.time.sleep') as sleep, \
                patch('run._replace_snapshot', wraps=_replace_snapshot) as replace:
            with self.assertRaises(OSError) as caught:
                write(self.path, new)
        self.assertIn(caught.exception.winerror, (5, 32, 33))
        self.assertEqual(replace.call_count, 5)
        self.assertEqual([call.args for call in sleep.call_args_list], [(.01,)]*4)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), old)
        self.assertEqual(json.loads(self.path.with_suffix('.json.tmp').read_text(encoding='utf-8')), new)
        self.hold_file(self.path.with_suffix('.json.tmp'), share=0)()
        release()
        self.hold_file(share=0)()

    def test_only_windows_replacement_sharing_errors_retry(self):
        for code in (5, 32, 33):
            with self.subTest(code=code), patch('run._replace_snapshot', side_effect=ctypes.WinError(code)) as replace, \
                    patch('run.time.sleep') as sleep:
                with self.assertRaises(OSError):
                    write(self.path, [])
                self.assertEqual(replace.call_count, 5)
                self.assertEqual(sleep.call_count, 4)
        for error in (ctypes.WinError(2), ctypes.WinError(50), ctypes.WinError(87), ctypes.WinError(123), ctypes.WinError(1175), ctypes.WinError(1176),
                      ctypes.WinError(1177), PermissionError('no Windows sharing code')):
            with self.subTest(error=str(error)), patch('run._replace_snapshot', side_effect=error) as replace, \
                    patch('run.time.sleep') as sleep:
                with self.assertRaises(OSError) as caught:
                    write(self.path, [])
                self.assertIs(caught.exception, error)
                self.assertEqual(replace.call_count, 1)
                sleep.assert_not_called()
        with patch('run.os.name', 'posix'), patch('run._replace_snapshot', side_effect=ctypes.WinError(5)) as replace, \
                patch('run.time.sleep') as sleep:
            with self.assertRaises(OSError):
                write(self.path, [])
            self.assertEqual(replace.call_count, 1)
            sleep.assert_not_called()

    def test_temp_write_failure_is_never_retried(self):
        with patch.object(Path, 'write_text', side_effect=ctypes.WinError(5)) as save, \
                patch('run._replace_snapshot') as replace, patch('run.time.sleep') as sleep:
            with self.assertRaises(OSError):
                write(self.path, [])
        self.assertEqual(save.call_count, 1)
        replace.assert_not_called()
        sleep.assert_not_called()

    def test_initial_creation_and_existing_extended_unicode_path(self):
        # A non-BMP character occupies two UTF-16 code units on Windows.
        self.path = self.root/'identities-ışık-🚀.json'
        extended = Path('\\\\?\\' + str(self.path.resolve()))
        old, new = self.snapshot(10), self.snapshot(11)
        with patch.object(Path, 'replace', autospec=True, side_effect=Path.replace) as rename:
            write(extended, old)
            self.assertEqual(rename.call_count, 1)
            write(extended, new)
            self.assertEqual(rename.call_count, 1)
        self.assertEqual(json.loads(extended.read_text(encoding='utf-8')), new)

    def test_nonwindows_atomic_path_uses_path_replace(self):
        write(self.path, [])
        temporary = self.path.with_suffix('.json.tmp')
        temporary.write_text('[1]', encoding='utf-8')
        with patch('run.os.name', 'posix'), patch.object(Path, 'replace', autospec=True, side_effect=Path.replace) as rename:
            _replace_snapshot(temporary, self.path)
        self.assertEqual(rename.call_count, 1)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), [1])


if __name__ == '__main__':
    unittest.main()
