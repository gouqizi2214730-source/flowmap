# Windows performance measurements

**NOTQUALIFIED — measured on 16 October 2026.** No complete matched sustained campaign establishes a Windows minimum. On this PC, CPU hard rate `1250/10000`, affinity `0xF` and a 6 GiB application-job commit cap passed graphics/input gates in a 600-second LIVE trial and an 1800-second normalized-history trial. History retains its original PASS output, with a separate retrospective INCOMPLETE assessment for its unknown health end tail. The LIVE trial still failed its independent source-debt rule. The lower rate 937 short PASS did not survive sustained testing. CPU/GPU entries describe this measured graphics configuration; the RAM tier is a planning estimate.

The [evidence JSON](windows-minimum-evidence.json) preserves original PASS, FAIL and INCOMPLETE statuses, compact measurements, input fingerprints and a SHA-256 inventory. The published evidence contains measured summaries and a SHA-256 inventory. Original raw traces are retained locally and are not publicly hosted.

## Test system and scope

| Item | Measured system |
|---|---|
| OS | Windows 11 Pro, build 26200 |
| Processor | AMD Ryzen 7 PRO 5750G; 8 physical cores, 16 logical processors |
| Physical memory | 32 GiB installed; 29.87 GiB visible to Windows; 2.13 GiB reserved |
| Discrete graphics | AMD Oland, PCI `1002:6613`, subsystem `048B1043`; nominal 2 GiB DDR3 |
| Driver | 27.20.1034.6 |
| Benchmark content | 1920 × 1080 physical client pixels; 96 DPI; DPR 1; verified 120 Hz display on the discrete adapter |

The driver calls the card “AMD Radeon R7 200 Series.” DXGI/AMD ADL evidence establishes Oland and DDR3 memory, but no retail R7 240 or R7 250 identity. The integrated Radeon adapter is separate. Only this physical PC was tested. These measurements make no new macOS or Linux performance claim.

After a host reboot on 16 October, the discrete adapter's LUID changed from `0,56063` to `0,60401`, on `DISPLAY6`. The refreshed probe verifies the same Oland identity, memory and driver. Adapter identifiers and monitor mapping are checked for each new campaign rather than carried across boots.

One Binance spot BTCUSDT chart is visible with DOM, tape, CVD, volume and profile data during continuous production pan and time-zoom gestures. LIVE ingestion with recording enabled and interaction with loaded normalized history are separate phases. Their results do not establish simultaneous LIVE-recording and full-history performance. Unrelated host applications remain running; their contention and host paging are part of the measured conditions.

The acceptance history is a synthetic normalized Parquet fixture: 3600 seconds, 4096 rows and 14,400 finalized columns at 250 ms intervals. Its content SHA-256 is `daa981b64ab4222c0b047b1244a50def568da925adc8449c66c4189cb390c772`; its file-set digest is `4b4c52a591b361acbdda3dbae4181994d121fa4df43106306e3a2d66aae03f64`. It exercises production disk-history loading and rendering. It contains no raw exchange frames and cannot substitute for the separate LIVE connector and recording phase.

The earlier real Binance capture is retained separately: 3600.011 seconds collected, a 3595-second finalized span, 2048 rows and 14,380 finalized columns. It had no recorder failures and one observed `tx_lag` increment. That increment remains in the evidence; this collection is not clean qualification evidence.

## Acceptance method

Every measured sliding five-second interaction window must reach 30 displayed FPS. A display gap or chart CPU draw-completion gap above 250 ms fails. Input-to-CPU-draw p95 must be at most 100 ms. PresentMon display changes from the owned, monitor-correlated stream supply displayed FPS; animation callbacks and draw submissions are separate counters. CPU input-to-draw is a timing proxy, not physical input-to-screen latency.

Trials also require verified application/runtime provenance, stable native window and adapter identity, the required workload, complete owned-process/resource coverage, successful recording, no increasing observed loss counters and no sustained increasing queue/backlog. Missing collection remains incomplete; an original FAIL is never rewritten as a PASS after a harness repair. Intentional history omission and normal partial replacement are recorded separately from loss.

LIVE source freshness has an independent gate. Every measured 5–10 second source window fails for at least 1000 ms conservative source-time debt growth with a positive trend. A five-second median earliest source age above 6000 ms also fails: the policy uses a 5000 ms allowance plus 1000 ms host/provider clock and timestamp uncertainty. An implausible future clock is incomplete. These fixed BTC-workload policies do not identify hardware causation or guarantee exchange latency.

Normalized finalized/partial messages can repeat a source book. Accepted source-book events count parsed bridge BookSnapshot/BookDelta records, including unchanged books, through Status endpoints that can lag. Neither metric is raw wire-frame cadence or unique book changes. Both stay separate from displayed FPS.

Full qualification requires three distinct 600-second LIVE boundary trials, a 1800-second normalized-history soak and an additional 1800-second LIVE-recording soak at the same linked artifact, workload, adapter, CPU and commit settings. A short PASS does not satisfy that campaign.

The current harness uses an explicit health-domain contract, `independent-health-v1`, while retaining the existing 3000 ms client/source coverage gate. Its separate actual HTTP observations require at most 5000 ms completed-observation coverage and report maximum request latency independently. Client/source snapshots no longer wait for health. Each request to the exact owned literal-loopback endpoint has one unique observation ID, sequence, actual UTC/monotonic start/end/duration, HTTP status/error and exact response text. A cached body is never attached to a later client sample as fresh evidence, and health/client row counts need not match.

The corrected health worker begins during warmup. Assessment selects the nearest wholly completed pre-start counter baseline and requests wholly inside the measured interval; earlier warmup/history loss or resets do not become measured deltas. A request spanning the start is incomplete. At the end, actual pending health work drains under the unchanged 10000 ms request deadline while final client capture continues independently. If that response already completed before finalization, one actual final request bypasses the ordinary 250 ms pacing limit. Single-flight ownership remains enforced. An actual completed response after the measured end is mandatory; a missing bracket is INCOMPLETE even when ordinary 5000 ms coverage passes. A late response keeps its true bounds and cannot fill an in-window coverage gap or establish a fresh measured flush. Changed cumulative-counter or recorder state returned across, exactly at or after the end is incomplete because its phase is uncertain; unchanged end controls can pass. HTTP failures/timeouts, invalid bounds/identity/order, duplicate or replayed observations, malformed/missing mandatory fields and persistence/drain errors remain disqualifying, including outside-window errors. Existing loss/reset/recording/source/render/resource gates remain mandatory. Earlier scoped review approved the then-current end-state and finite-range arithmetic checks. Final whole-branch review found that ordinary pacing could suppress the final response entirely. The subsequent correction is separately identified below; the original traces did not use it. No instrumentation check creates hardware qualification.

## Completed short trials

The following are original result statuses. Durations are requested measured interaction time; exact actual durations and coverage are in the JSON. All restricted trials use affinity `0xF` and a 6 GiB commit cap unless stated otherwise.

| Trial suffix | CPU hard rate | Seconds | Original status | Worst 5 s displayed FPS | Longest display / CPU draw gap, ms |
|---|---:|---:|---|---:|---:|
| `b12-fullcpu-unlimited-history-reference01` | no rate cap; no commit cap | 120 | PASS | 58.8 | 46.7 / 81.3 |
| `b12-cpu1250-m6144-history-p01` | 1250 | 120 | PASS | 58.8 | 41.6 / 50.0 |
| `b12-cpu1250-m6144-live-p01` | 1250 | 120 | PASS | 59.4 | 41.7 / 86.8 |
| `b12-cpu937-m6144-history-p01` | 937 | 120 | PASS | 57.6 | 175.0 / 203.4 |
| `b12-cpu937-m6144-live-p01` | 937 | 120 | PASS | 58.0 | 125.0 / 133.7 |
| `b12-cpu625-m6144-history-p01` | 625 | 90 | FAIL | 39.2 | 366.7 / 360.2 |
| `b12-cpu312-m6144-history-p01` | 312 | 60 | FAIL | 19.6 | 475.0 / 467.3 |

At rate 937, input-to-draw p95 was 12.4 ms in history and 1.8 ms in LIVE. The LIVE source gate passed: maximum window debt growth was 587.3 ms and maximum five-second median earliest age was 21.3 ms. It accepted 1188 source-book events over approximately 120 seconds, or 9.895 per second, while delivering 44.268 normalized depth messages per second. These rates measure different events.

The lower rate 625 exceeds 30 displayed FPS but fails both gap limits. Rate 312 also fails the FPS requirement. These are measured performance failures on this host. The paired rate 937 PASS is historical short-run evidence; its later revision 15 sustained result fails. A 5 GiB commit-cap attempt at rate 937 failed before measurement when `OpenProcess` returned WinError 87; it supplies no RAM-capacity or FPS conclusion. The earlier revision 12 long-campaign attempt stopped in its first LIVE boundary after `QueryFullProcessImageNameW` returned WinError 5 on a newly observed child. Its original FAIL and missing final telemetry remain distinct from the valid short trials.

Other earlier attempts remain in the JSON, including presentation/ownership collection failures, incomplete resource joins, old short pilot PASS statuses and a separate uncapped LIVE source-debt failure. Their original verdicts are preserved. Later instrumentation corrections do not retroactively qualify those attempts.

History preparation in the uncapped revision 12 reference took 47.426 seconds. It deliberately traverses the 3600-second fixture at 100× playback before fitting/loading the overview. It is not a pure file-read measurement and is separate from the subsequent measured interaction.

## Earlier sustained attempts: revision 13

All four results below retain their original statuses. They use the revision 13 harness and do not fill any slot in later campaigns.

| Trial | Actual measured seconds | Original status | Worst 5 s displayed FPS | Longest display / CPU draw gap, ms | Qualification limit |
|---|---:|---|---:|---:|---|
| `b13-q937-m6144-a01-live-boundary-01` | 600.005 | INCOMPLETE | 56.0 | 158.4 / 167.7 | Excluded: stale requested LUID selected the integrated adapter; discrete-adapter/display verification and target GPU allocation absent |
| `b13-q937-m6144-a02-live-boundary-01` | 600.037 | PASS | 58.6 | 125.0 / 142.3 | One valid LIVE boundary; no complete linked campaign |
| `b13-q937-m6144-a02-live-boundary-02` | 600.008 | INCOMPLETE | 57.0 | 166.6 / unavailable | Client/source coverage and full-query system/GPU coverage incomplete |
| `b13-q937-m6144-a02-history-soak-01` | 1800.066 | INCOMPLETE | 56.8 | 175.0 / 186.2 | Graphics gates pass; system/GPU coverage incomplete |

The valid LIVE boundary's input-to-draw p95 was 1.7 ms and its source gate passed. The history soak's input-to-draw p95 was 15.8 ms. That history result still has no failures and an overall INCOMPLETE verdict: its maximum system gap was 6468 ms, above the unchanged 5000 ms gate, with missing full-query GPU attribution.

Boundary 02 has no measured source-time FAIL: its source verdict is unavailable because client coverage is incomplete. Its 3586.9 ms client gap includes a health request awaited inside the single-flight sampler; its separate system query also exceeds coverage and GPU-bracket limits. The retained diagnosis observes rendering and dense native process acquisition through those intervals. It does not establish an application freeze, a host-clock jump, CPU contention or the cause of the health/provider waits. These missing observations are not replaced with a later PASS.

## Revision 14 boundary: complete resources, incomplete client coverage

`b14-q937-m6144-a01-live-boundary-01` remains **INCOMPLETE**, with no recorded failures or errors, after 600.062 measured seconds. Its hardware/workload/provenance verification and PDH resource evidence are complete: maximum system coverage gap 3711.2 ms and native-process gap 291.1 ms. The displayed-frame gate passes at 47.0 worst-five-second FPS with a 108.3 ms maximum display gap; input-to-draw p95 is 1.6 ms.

The original client gap is 3438.7 ms, exceeding its unchanged 3000 ms bound. Chart continuity and source-time verdicts are unavailable. A preceding actual health request took 3425.132 ms, while the page snapshots before and after took 5.369 ms and approximately 24.355 ms. This demonstrates collector coupling; it does not prove why the health response was delayed. PDH coverage and displayed FPS do not replace the missing chart/source observations, and Task15's later collector change does not rewrite this original verdict.

## Final revision 15 results

These completed trials used the same sealed revision 15 application/harness inputs before the final-review corrections. The table preserves original verdicts; it is not a corrected-method qualification table. The two rate 1250 phases share affinity, CPU/commit budgets, adapter and workload identity, but their LIVE FAIL prevents qualification. Three passing LIVE boundary repetitions and an additional LIVE soak are absent; no passing campaign-linker output exists.

| Trial | Actual seconds | Original verdict | Worst 5 s displayed FPS | Maximum display / chart draw gap, ms | Input p95, ms |
|---|---:|---|---:|---:|---:|
| `b15-q937-m6144-a01-live-boundary-01` | 600.050 | FAIL | 30.8 | 808.3 / 824.0 | 1.9 |
| `b15-q1250-m6144-a01-live-boundary-01` | 600.062 | FAIL | 54.0 | 73.8 / 103.8 | 2.3 |
| `b15-fullcpu-unlimited-live-reference01` | 600.061 | INCOMPLETE | 56.4 | 41.7 / 84.2 | 1.7 |
| `b15-q1250-m6144-history-soak01` | 1800.033 | PASS | 48.6 | 108.4 / 90.3 | 16.3 |

The rate 937 run has complete evidence with no missing items or errors, and actual display/chart gaps fail independently. Its source-debt growth reaches 9633.0 ms and its maximum five-second median earliest source age reaches 55,818.2 ms. The diagnosis records source timeline plateaus while chart/input/partial-message activity continues, as well as separate real chart/display interruptions. It does not attribute either failure to the CPU cap, provider, connector or another component.

At rate 1250, graphics/input and all resource gates pass. The only failure is 1045.1361 ms conservative source-debt growth, 45.1361 ms above the fixed rule. Only two of 41,298 overlapping source windows fail, with a shared endpoint; source time recovers approximately 1.315 seconds later. No observed unchanged source-edge span reaches one second in that trial. These observations describe a brief excursion and do not cancel the original strict FAIL or establish its cause. Source age remains within its separate freshness allowance.

The rate 1250 history soak retains its original PASS output, with its original failures/errors/missing lists empty. A separate retrospective assessment under the corrected end-bracket requirement is **INCOMPLETE**: none of its 6370 health rows brackets the measured end. The last response completed 156.65576171875 ms before that end, leaving loss/recorder state in this short tail unknown. This is not evidence of loss or a definite measured FAIL. Displayed-FPS, input and resource measurements remain usable within their own coverage. It loads the one-hour synthetic normalized fixture, then measures 1800.033 seconds of interaction. Its 7303 process observations are all published, with zero lost/pending observations or observer errors; the owned PresentMon session is verified absent after collection. The history source clock and accepted-book counter are outside LIVE source assessment, not failed LIVE tests. Warmup `tx_lag` is already 5406 at the baseline and stays unchanged: no new measured loss is reported. History preparation took 46.192 seconds, including the deliberate accelerated fixture traversal, separately from measured interaction.

The uncapped reference passes its graphics/source subgates, including maximum source-debt growth 717.9 ms. It remains INCOMPLETE solely because system coverage has a 7277.2 ms gap. It does not certify a restricted CPU configuration. No completed matched set satisfies the required LIVE repetitions and both soaks; the overall hardware outcome remains **NOTQUALIFIED**.

## CPU, memory and GPU interpretation

Affinity `0xF` selects group 0 logical processors 0–3: two complete physical SMT cores on this particular host. The hard-rate flags are ENABLE | HARD_CAP (`0x5`). The measured graphics budget is rate `1250/10000`, or 12.50% of the containing allocation; historical rate `937/10000` is 9.37%. The immediate ambient job reports rate control disabled; controls higher in the ancestor chain are unresolved, so an absolute whole-system percentage is not established. These constraints do not emulate another CPU model, clock speed or a generic two-core processor. [Microsoft CPU-rate semantics](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information) and [nested-job semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) explain those limits.

The final rate 1250 phases have these separate resource measurements. The LIVE row describes valid resource evidence from an overall source-debt FAIL; it does not convert that trial to PASS.

| Measurement | 1800-second history (original PASS; retrospective health INCOMPLETE) | 600-second LIVE FAIL |
|---|---:|---:|
| Peak whole-owned-tree private working set, bytes | 2,285,215,744 | 1,343,213,568 |
| Peak sampled private commit, bytes | 4,128,022,528 | 3,269,218,304 |
| Peak job commit, bytes | 5,467,774,976 | 3,287,453,696 |
| Native private-WS samples | 6948 | 2343 |
| Largest actual process coverage gap, ms | 276.3 | 271.0 |
| Largest actual system coverage gap, ms | 4571.6 | 3665.4 |
| Discrete GPU process-instance dedicated allocation peak, bytes | 594,116,608 | 572,661,760 |
| Discrete GPU process-instance shared allocation peak, bytes | 43,290,624 | 284,999,680 |
| Peak pagefile occupancy, percent | 1.015904 | 0.938416 |
| Peak host PagesInputPersec / PageReadsPersec | 100153.945 / 3531.935 | 78202.562 / 3490.081 |

Private physical working set comes from identity-bound [native EX2 PrivateWorkingSetSize](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2), summed across the complete owned tree at each observation. It is separate from private commit and total/shared working set. The nominal process interval is 250 ms, with actual bounds retained and a 3500 ms coverage gate; system coverage has a 5000 ms gate. Sampling can miss peaks and the tree is not acquired atomically. The optional independent CIM private-WS diagnostic is intentionally omitted in revision 15; required native EX2 samples are complete. No CIM, commit or total-WS value is used as a fallback.

The GPU values are separate per-process-instance peaks on the tested discrete adapter. Independent peaks and lifetimes are not summed into an invented simultaneous total. Required GPU queries retain full-query process identity and timing evidence. Shared GPU allocation is not added to private RAM because the accounting can overlap. Host paging counters include unrelated applications, and do not establish that FlowMap caused the paging. The final PDH pagefile percentages retain fractional precision; older CIM integer-rounded measurements remain separately labeled in the evidence.

Revision 14 changes only external system-counter acquisition. Each row uses a fresh English-path PDH query with two collections separated by one second. The first collection is warmup; rates span the first collection's start through the second collection's end, while gauges use the second collection's actual bounds. The full query includes initial and final identity checks plus extraction/mapping. Native process identities must bracket the entire rate/query interval within the unchanged 3500 ms bound; the 5000 ms system-coverage gate also remains. Only VALID_DATA or NEW_DATA item statuses are usable. API success alone cannot authorize a missing or invalid value. Independent CIM private-WS diagnostics are omitted; native EX2 remains mandatory. PDH pagefile percentages retain fractional precision; the legacy `_integer` field is an unrounded compatibility alias. Slow synchronous calls remain visible and can still make a trial incomplete. See the [provider and ownership contract](../scripts/windows-benchmark/README.md).

A [Windows job memory cap](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) limits committed virtual memory. It does not test a computer with that amount of physical RAM. Only the installed 32 GiB system was tested.

For a planning estimate, use `R = next_common_capacity(H + B + max(1.25P, P + 0.5 GiB))`, rounding to 4/8/16/32 GiB. `H = 2.13 GiB` is this machine's observed reservation. `B = 3 GiB` is an explicit Windows/kernel/shared-code/background assumption, not a clean measured OS baseline. `P = 2,314,530,816 bytes` (2.156 GiB) conservatively retains the larger complete 120-second revision 12 history observation. The final 1800-second history peak is 2,285,215,744 bytes (2.128 GiB); its longer duration does not justify replacing the larger valid short-run observation with a smaller value. This gives 7.824 GiB before rounding and an **8 GiB planning tier**. Varying `B` from 2–4 GiB and proportional headroom from 20–30% gives **8–16 GiB** tiers. The estimate includes both complete short and long observations, with no qualifying sustained LIVE campaign and sampled-peak uncertainty. An actual 8 GiB PC test is required to verify that physical capacity.

## Build identity and reproduction

Windows requires WebView2. Linux requires WebKitGTK 4.1, GTK 3 and Ayatana AppIndicator; these compatibility dependencies and the x64 AVX2/FMA/[Polars SIMD requirements](https://github.com/pola-rs/polars/blob/py-1.42.1/.github/workflows/release-python.yml) are separate from this Windows benchmark.

The measured optimized private build contains FlowMap 1.5.1 and Crocodile 0.3.2. Its executable SHA-256 is `1574a5fa31ae320e1030c9b7ad1fb92206cc26e91b8e8f7bb3fc393b12863752`, runtime digest `96d137bcdbbd4c49f5e76c2622af7b9e0fc06b45a3f7e304a2f3d557d19d5365` and installed-server digest `78365e4b7a12fe3ef74716cfa84cf09066ff05a2408becf84c402426fec6d900`. The measured prereview application had 251 application/native inputs identical to build08, with historical application digest `eff438adff342f517822dcbe335c137e2cc4c97829f6706287ce927a12f04a99`. The short trials use harness revision 12 fingerprint `7f4ad807be71b6e9df0d4d494a2a20c2b37b775bf3e61f1cf6ec382839938660`. The historical sustained attempts use revision 13 fingerprint `01d4e5d8487642797a999c3b4a6b9f674231b2cd2de07cceee8a9aa00be36f6d`. The incomplete revision 14 boundary uses sealed fingerprint `566894aaf4601537503f92041b4fded455af32a3a7ed7f3bb244a7819aee40b8`. The four completed revision 15 trials use fingerprint `f6d7325fc6f69096dbb052c7e571edd41dcdda852f4cfa8006a6640a95550ea1`, including the unchanged native configuration. Original trial statuses and resource scopes remain unchanged.

Final whole-branch review found one missing end bracket in the history soak. Reassessment preserves the other three revision-15 outcomes: rate937 FAIL, rate1250 LIVE FAIL and uncapped LIVE INCOMPLETE; each has an actual bracket with unchanged cumulative loss/recorder state. Original totals across all 30 trials remain **11 FAIL / 9 INCOMPLETE / 10 PASS**. The separate history INCOMPLETE assessment does not rewrite these totals or its raw result/hash.

The subsequently corrected picker changes an application source input, and the corrected health harness has a new source fingerprint. The [corrected source manifest](windows-minimum-corrected-source.json) records both identities and changed inputs. It is a source snapshot, without a new executable seal. The measured executable/runtime/server hashes above identify the prereview private build only. Original native Istanbul replay observations remain observations of that build. There was no new native performance/campaign, installer identity or changed-pixel validation.

The exact baselines are FlowMap `5b70767a6bc9ac95990186d25a92051136527013` and Crocodile `f8f28007954137a85b75790d4b6418f170c69d90`. The intended release tags are `v1.5.1` and `v0.3.2`. Final release commits and CI-built installers are recorded by the release process; their hashes are not assumed equal to this private benchmark artifact.

Use the [harness preparation instructions](../scripts/windows-benchmark/README.md) to freeze inputs and seal the optimized executable and bundled runtime. Use the server's locked Python dependencies and [PresentMon 2.6.0](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0). The tested PresentMon binary SHA-256 is `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af`. Re-query CPU topology, discrete-adapter LUID and monitor coordinates after a reboot. Replace `WORK`, `TOOLS`, `CURRENT_LUID`, `LEFT` and `TOP` with your own local paths and observed display values. The measured monitor origin was LEFT=-1920, TOP=357; its post-reboot target LUID was 0,60401. These identifiers must be refreshed on another machine or boot. Keep each output/profile path fresh.

```powershell
# From the repository root, with the server dependencies available:
$env:PYTHONPATH = 'server/src'
python -B scripts/windows-benchmark/create_fixture.py --output WORK/fixture --seconds 3600 --rows 4096 --seed 5750
Remove-Item Env:PYTHONPATH

# Repeat with fresh live-02 and live-03 profile/output names.
python -B scripts/windows-benchmark/run.py --exe WORK/bin/FlowMapBenchmark.exe --build-manifest WORK/build-manifest.json --profile WORK/profiles/live-01 --output WORK/runs/live-01 --manifest scripts/windows-benchmark/live.json --scope live-recording --duration 600 --warmup 30 --affinity 0xF --cpu-rate 1250 --commit-mib 6144 --gpu-luid CURRENT_LUID --gpu-device 6613 --presentmon TOOLS/PresentMon-2.6.0-x64.exe --stream sole-owned --window LEFT TOP 1920 1080

python -B scripts/windows-benchmark/run.py --exe WORK/bin/FlowMapBenchmark.exe --build-manifest WORK/build-manifest.json --profile WORK/profiles/history-soak --output WORK/runs/history-soak --manifest WORK/fixture/manifest.json --scope normalized-history-replay --duration 1800 --warmup 30 --affinity 0xF --cpu-rate 1250 --commit-mib 6144 --gpu-luid CURRENT_LUID --gpu-device 6613 --presentmon TOOLS/PresentMon-2.6.0-x64.exe --stream sole-owned --window LEFT TOP 1920 1080

python -B scripts/windows-benchmark/run.py --exe WORK/bin/FlowMapBenchmark.exe --build-manifest WORK/build-manifest.json --profile WORK/profiles/live-soak --output WORK/runs/live-soak --manifest scripts/windows-benchmark/live.json --scope live-recording --duration 1800 --warmup 30 --affinity 0xF --cpu-rate 1250 --commit-mib 6144 --gpu-luid CURRENT_LUID --gpu-device 6613 --presentmon TOOLS/PresentMon-2.6.0-x64.exe --stream sole-owned --window LEFT TOP 1920 1080

python -B scripts/windows-benchmark/campaign.py --history-result WORK/runs/history-soak/result.json --live-result WORK/runs/live-01/result.json --boundary-result WORK/runs/live-01/result.json --boundary-result WORK/runs/live-02/result.json --boundary-result WORK/runs/live-03/result.json --soak-result WORK/runs/history-soak/result.json --live-soak-result WORK/runs/live-soak/result.json --output WORK/campaign.json
```

Preserve every original result and raw presentation/resource/client/ownership/recording artifact, including failed attempts. Do not reuse a short result to fill a sustained campaign slot. Fixture content and file hashes must match the published evidence; a regenerated file encoding can change byte hashes even if normalized content matches.
