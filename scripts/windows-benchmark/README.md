# Windows benchmark

This harness measures a private native FlowMap build with production ingestion,
recording, gestures and overlays. It records displayed frames separately from
animation callbacks, chart draws and source arrivals. A short PASS is a pilot;
`campaign.py` applies the sustained qualification rules.

Use Windows, the server's locked Python environment, Node, Playwright, Rust and
[PresentMon 2.6.0](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0).
The tested console binary is `PresentMon-2.6.0-x64.exe`, SHA-256
`b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af`.
ETW access must work for the current account. Missing telemetry stays INCOMPLETE.
Use a private writable local NTFS output directory. Snapshot publication uses
Windows rename semantics that keep an existing reader valid; unsupported
filesystems and persistent sharing errors stop the trial.

Owned-process acquisition runs on one observer thread, independently of main
thread disk publication, identity snapshots and window inspection. Its bounded
256-row queue fails the run on overflow. Schema 4 process rows retain actual
QPC/Unix acquisition start/end; a blocked writer cannot create backdated rows.
Only changed PID+creation sets publish identity snapshots. The observer is
stopped/joined and queued raw rows flushed before job teardown. A stuck native
observer invalidates the run and defers job handle release to runner exit.
RAM now uses [native EX2 PrivateWorkingSetSize](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2)
from `GetProcessMemoryInfo` on each held PID+creation process handle. This
instrumentation requires Windows 10/11 22H2 with the September 2023 update or
later; it does not change FlowMap's application OS support. The 96-byte x64
structure supplies actual private physical WS, separately from private commit,
total/shared WS and shared commit. Unsupported/unwritten EX2 fields or errors
are unavailable; no commit/total-WS/zero/CIM fallback can authorize RAM PASS.
Peak RAM is the maximum complete sampled owned-tree sum. Handles stay open
through an actual final job PID reconciliation; proven exited children retain
their PID+creation and same-handle exit evidence. A new/unqueried final member,
unproved disappearance, unsettled same-PID replacement or permission denial is
incomplete. Acquisition is bounded and reconciled, not an atomic all-process
instant or a guarantee that sampling sees every peak.

Process coverage and actual acquisition bounds retain the 3500 ms limit. The
independent CIM private WS diagnostic is omitted by the PDH sampler; native EX2
remains mandatory. Legacy CIM diagnostics retain their strict whole-tree join.
GPU allocation/engine evidence remains mandatory and unsummed: each attributed
PID+creation must be present in every actual observation across a full-query
outside bracket <=3500 ms. An unrelated utility child's normal lifetime need
not span that GPU query. Old process schemas/direct-native fields missing
cannot authorize RAM PASS. Native errors retain API/PID/WinError and traceback,
including partial acquisition attempts; only the same held handle signaling
exit permits a confirmed-exit classification. Error 5 or 31 alone proves none.

System sampler schema 4 uses `sample_pdh.py`, one synchronous worker, and fresh
`PdhAddEnglishCounterW` Unicode paths on every row. Memory, paging, all logical
CPUs, GPU process allocations, adapter totals and engines are collected together.
The stdlib-only helper runs through CPython's direct base executable so Windows
venv redirection cannot detach the executing sampler from the held helper PID.
Each row reports that PID and interpreter path; the runner retains exact creation
identity for cleanup.
Each query collects twice with a one-second wait. The first sample is recorded
as warmup, never measurement. Rates span **first collection start through second
collection end**; gauges use the second collection. Actual query bounds begin
before start identities and end after all extraction, mapping and final identity
reads. Existing continuous native ownership and <=3500 ms outside brackets cover
the entire rate interval as well as the current acquisition. No persistent query,
prior-row identity/cache, backdated timestamp or fabricated zero is used.

Every array records API and per-item status. Only VALID_DATA and NEW_DATA are
usable; numeric payloads of invalid statuses are unavailable. Raw first/current
instance unions retain new, removed and invalid owned candidates; a new rate
instance without two valid samples fails. Array growth has at most three attempts,
each starting with a fresh zero-size buffer probe, with a 64 MiB allocation bound.
Collection/extraction/identity errors remain in raw output and make it incomplete.
PDH schema/provider/rate/gauge/status proof is revalidated in assessment even if
the producer error list is removed. Old schema-3 CIM rows remain readable under
their original mandatory field/candidate/identity rules.

The sampler retains raw GPU allocation/engine candidates for every PID in the
union of fresh start/end identity snapshots before successful-identity filters.
Unrequested host GPU instances alone are summarized by captured/omitted counts
and SHA-256, limiting trace size; all adapter/CPU/memory/pagefile data remain.
Expected
snapshot creation ticks remain distinct from verified creation identity. A
positive candidate whose start/end identity cannot be proved emits a mandatory
GPU error; assessment also rejects that retained uncertainty or an omitted
positive candidate even if the error array is missing its message. Counter
values are preserved rather than substituting zero. Known zero candidates and
unrelated non-GPU utility churn remain diagnostic-only. This is a bounded
snapshot of owned candidates, not atomic whole-machine allocation or missed-peak
coverage; full-query exact attribution and 3500 ms bounds still apply. Legacy
system rows without candidate evidence cannot authorize resource PASS. Pagefile
usage now retains floating PDH percentage precision from provider page counts;
the old `_integer` summary key is an unrounded compatibility alias. Separate
sampling intervals and CIM integer rounding mean live PDH/CIM rates need not
match numerically. A zero is valid only with valid counter status and does not
prove occupancy or activity between samples.

PDH API contracts: [English counter paths](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhaddenglishcounterw),
[array buffer sizing](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw),
and [API versus per-counter status](https://learn.microsoft.com/en-us/windows/win32/perfctrs/pdh-error-codes).

Each PresentMon capture records its exact command and unique owned ETW name.
Cleanup stops only that helper/session, preserves the original capture status
and separately verifies session absence. Any positive lost-event/buffer warning
invalidates collection even with exit 0 and CSV rows; missing CSV and empty
owned display streams have specific collection reasons. Optional GPU-duration
tracking remains enabled after the unchanged clean-session control succeeded;
display tracking, v2/QPC metadata and GPU allocation/engine evidence remain required.

## Prepare one frozen artifact

Follow [desktop build instructions](../../app/README.md) to prepare an owned
bundled runtime containing the current server and locked dependencies. Use the
benchmark Tauri identity in `app/src-tauri/tauri.benchmark.conf.json`, retaining
release Rust/Vite optimizations. Keep the actual merged native configuration
in an external JSON file and use that same file through `TAURI_CONFIG` when
building. Copy the resulting executable as `FlowMapBenchmark.exe` beside its
`pyruntime` directory in an isolated output directory. Normal application data
and installed binaries are outside this workflow.

From the repository root, freeze inputs **before** the frontend/native build,
then seal the actual executable/runtime **after** packaging. Paths below are
placeholders for the owned output directory and the saved build configuration.

```powershell
python -B scripts/windows-benchmark/provenance.py inputs --repo . --native-config WORK/native-config.json --inputs WORK/inputs.json
# Build the client and private native executable; package the matching runtime.
python -B scripts/windows-benchmark/provenance.py seal --repo . --native-config WORK/native-config.json --inputs WORK/inputs.json --exe WORK/bin/FlowMapBenchmark.exe --runtime WORK/bin/pyruntime --package WORK/bin/pyruntime/Lib/site-packages/flowmap_server --output WORK/build-manifest.json
```

The seal checks complete production inputs, executable and runtime hashes, and
installed server file parity. Runtime bytecode/cache files are rejected. Use
new manifest, profile and output paths for each build/run; retain failed evidence.
The sidecar must prove its actual interpreter, package origin and owned process
identity. Source `PYTHONPATH` cannot replace packaging verification.

## Run and qualify

Determine the current DXGI adapter LUID and the connected monitor's physical
coordinates; a LUID can change after reboot. The baseline requires visible
1920×1080 content, DPI 96, DPR 1 and the verified 120 Hz display. The runner
checks the active WebView2 renderer, owned presentation stream and display source.

```powershell
python -B scripts/windows-benchmark/run.py --exe WORK/bin/FlowMapBenchmark.exe --build-manifest WORK/build-manifest.json --profile WORK/profiles/live-01 --output WORK/runs/live-01 --scope live-recording --duration 600 --warmup 30 --affinity 0xF --cpu-rate 1250 --commit-mib 4096 --gpu-luid CURRENT_LUID --presentmon TOOLS/PresentMon-2.6.0-x64.exe --stream sole-owned --window LEFT TOP 1920 1080
```

`sole-owned` is valid only for the verified single-stream private WebView2
architecture; ambiguous streams remain INCOMPLETE. Affinity must match the host's
physical-core/SMT mapping. CPU caps describe this host's scheduling budget;
job commit caps do not simulate installed RAM or another CPU model.

Generate the one-hour normalized fixture with `create_fixture.py` using server
dependencies, then pass its `manifest.json` to `run.py` with
`--scope normalized-history-replay`. The fixture is explicitly synthetic,
4096 rows and 250 ms columns. It does not test raw connector parsing or live
recording, which require the separate real LIVE phase.

At the same combined artifact, adapter, CPU/commit limits and instrument,
`campaign.py` requires passing history and live results, three distinct
600-second LIVE boundary trials, a 1800-second history soak and an additional
1800-second LIVE soak. Supply these with `--history-result`, `--live-result`,
three `--boundary-result` arguments, `--soak-result`, `--live-soak-result` and
a fresh `--output`. Actual elapsed durations and runtime provenance are checked.

Every measured sliding five-second window needs at least 30 displayed FPS;
display/chart gaps must stay within 250 ms and input-to-CPU-draw p95 within
100 ms. Ownership, workload, recording, queue/loss and sampling coverage are
also required. CPU draw timing is a proxy, not physical input-to-screen latency.
Keep cold history loading separate from the measured interaction phase.

New runs use result schema 3 and the explicit `independent-health-v1` contract.
Client/source snapshots remain a single-flight 250 ms retry path with the same
**3000 ms** measured coverage limit. Actual health HTTP queries have their own
single-flight path, retried at most every 250 ms; awaiting a health response
cannot hold client snapshots or the continuous input loop. The driver reads
the injected backend URL once and verifies its literal `http://127.0.0.1:<port>`
against the run-owned native server port. Node HTTP makes direct requests to
that exact `/api/health` endpoint, sends no-cache headers, validates the connected
address/port, rejects redirects/non-200 responses and retains the original
**10000 ms** request timeout. This makes no claim about the cause of a slow
application health response.

`health.ndjson` records one row per actual request, with a unique collection/row
ID, sequence, UTC and monotonic request start/end, duration, URL, HTTP status,
timeout/error and exact response body. The body remains text so server
nanosecond integers survive losslessly; assessment parses that actual body.
Client rows contain no cached health object and health count need not equal
client count. Result `health_coverage` reports query latency, actual completion
gaps and used/excluded observation IDs independently from `client_coverage`.

The health domain has a **new 5000 ms completed-observation coverage limit**;
it is an explicit new constraint replacing accidental one-health-per-client
pairing. It does not widen the 3000 ms client/source gate or any process,
system, whole-GPU-query, FPS, display/draw, input, source-age/debt, no-loss or
recording rule. Health is never optional: missing/invalid/replayed observations,
request errors/timeouts, absent contract fields or failed persistence/drain
make a new run incomplete or failed even if client FPS/source telemetry pass.

The worker begins during warmup. Measurement starts only when a warmup response
has completed and both samplers are idle, before issuing the next health
request. Assessment selects the nearest wholly completed pre-start health
baseline and wholly in-window requests, using their actual completion times
for coverage. Earlier warmup/history loss or reset values are excluded from
measured counter deltas. A request crossing the start makes the counter
baseline uncertain. At the measured end the owned worker stops ordinary work
and drains its pending response within its existing timeout. If that response
already completed before finalization, it issues one final actual request
without the ordinary 250 ms pacing limit. Single flight and the real HTTP
timeout remain enforced; final client capture proceeds independently. The
actual row stays in the trace. A successful completed end bracket is required;
an absent bracket is INCOMPLETE even if ordinary 5000 ms coverage passes. A response ending after measurement cannot supply
in-window coverage or a fresh live flush. Loss/recorder changes returned by a
request crossing the end or the first completed end-bracketing/drain observation
remain INCOMPLETE because their phase is uncertain. A final request starting
exactly at or after the end still brackets the unsampled measured tail; its
cumulative counter increases/resets or recorder failures cannot certify that
tail as clean. This response remains excluded from measured coverage/fresh flush
and uncertain changes are not declared definite measured failures.
All HTTP errors and invalid bounds, including warmup/drain rows, disqualify.
Used recorder timestamps cannot follow their actual response; age/timestamp
consistency allows the server's documented 0.1 s rounding (50 ms plus 1 ms
serialization tolerance), without widening coverage or fresh-flush bounds.
Legacy paired raw evidence stays readable under its original contract; new
`run.py` collection always requires the independent contract and cannot fall
back to paired/cached data if driver capabilities or errors are removed.
Numeric evidence outside the finite float domain, including oversized legal
JSON integers, is invalid evidence. Validation returns INCOMPLETE without
throwing; independently observed failures still determine FAIL, including
during guarded report recovery.

LIVE also requires source time to keep pace. Each snapshot captures the exact
newest renderer column start through production `timestampAtColumn(newestSeq)`
and its exclusive end (+ `timeBase.dtNs`), independently of camera pan/zoom.
Actual Node collector monotonic start/end bound the page snapshot. Over measured
5..10 second windows, at least 1000 ms conservative source-time debt growth
with a positive trend fails the existing no-increasing-backlog requirement.
Modest constant delay and brief plateaus followed by catch-up are permitted;
missing source/clock evidence, discontinuities and resets are INCOMPLETE. Normalized
history playback is excluded. Raw edge/debt samples and gate reasons remain
in the result. This detects source-progress debt, not physical exchange latency.

Raw client `timeline` now contains only scalar extent/viewport and anchor/dt
fields; the growing `timeBase.slots` table is omitted from telemetry. The actual
source edge is still captured through production `timestampAtColumn`, with
overview/history coverage and all workload fields retained. No renderer map is
mutated. Source assessment evaluates every same 5..10 second growth window and
five-second age boundary using bounded time slices and running summaries rather
than materializing all windows or scanning full tails. Raw source/debt samples,
first failures, maxima and window counts remain available. The separate
`source_time_cost.py` synthetic 1800s/4Hz diagnostic measures assessment CPU/memory
cost only and makes no native FPS or hardware qualification claim.

For this fixed active Binance BTC benchmark, LIVE age has a 5000 ms allowance
plus an explicitly declared 1000 ms host/provider clock and timestamp-precision
uncertainty. In measured five-second windows, a median earliest possible source
age **above 6000 ms** fails fresh-LIVE workload eligibility, even when that delay
is constant. Earliest age is `collector RPC start Unix - exclusive source end`;
the exclusive column width is already included and is not added again. Short
age outliers do not by themselves make the five-second median stale.
An exclusive source end more than `column dtMs + 1000 ms` beyond the actual
collector RPC end is an implausible future clock and stays INCOMPLETE. These are
benchmark policy allowances, not Binance guarantees or clock calibration. Source
age failures identify no hardware cause. Exact nanosecond subtraction precedes
conversion to milliseconds so epoch float precision cannot hide boundary errors.

Depth cadence is finalized + partial **normalized messages**, which can repeat
the same source book. It is separate from accepted upstream book events.
When present, `capability.source_book_events` supplies its own delta/cadence:
parsed BookSnapshot/BookDelta records accepted by the bridge, including
unchanged books, sampled via Status at most once per second. It is neither
raw network-frame cadence nor unique book-change cadence; absent/reset counters
stay unavailable. LIVE interaction cycles click the production GO LIVE button
at each declared cycle boundary, verify follow, then resume continuous gestures.
