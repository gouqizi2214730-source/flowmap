# Genuine recorded-depth overviews

The native RAM ring and GPU texture budget are caches, not the maximum time
range a user can inspect. A wide time view pages aggregated columns from the
same recording identity, including older depth held only on disk. A response
contains at most 256 output bins; that does not cap the number of source
columns read to build those bins.

## Protocol and quantities

`HistoryRequest` retains its previous JSON when the new optional fields are
absent. Explicit `start_col`, `end_col` (inclusive), and `stride` request bins
aligned to absolute multiples of `stride`. Binary `HistoryResponse` is
unchanged. Each output column carries its absolute group-start sequence and
the first genuine source timestamp. The client knows the requested stride.

Full-resolution navigation uses the same absolute range with `stride: 1`.
Jumping to a distant historical interval starts at that interval's newest
page, then fills its remaining visible pages. It does not walk backward from
the live ring or infer old positions from the newest clock. This keeps a
restart's wall-clock gap from redirecting a request to the wrong time.

Depth is the time-weighted mean of genuine recorded resting quantities. The
weight is each source epoch's column duration; offline wall-clock gaps add no
invented density. Changed price geometries are projected by physical price
interval overlap, rather than treating equal row addresses as equal prices.
Bars preserve OHLC, sum buy/sell quantities, and retain the latest cumulative
VWAP/CVD. Duplicate RAM/disk source columns contribute once. Files from other
recording identities cannot donate same-numbered source columns.

Recording seams between adjacent genuine source sequences retain exact clocks
inside an output bin. They travel as existing gap markers with a
`history-gap:v1 ` JSON text prefix and `left_col`, `right_col`, `left_t0_ns`,
`left_end_t_ns`, and `right_t0_ns`. Nanosecond values are decimal strings so the
client can preserve integer precision. Clients consume this metadata as time
knots and display a human-readable gap label. Metadata is capped at 1,024
markers per request. An unobserved/missing source sequence is not proof of a
wall-clock seam and does not produce a fabricated gap.

## Working memory and scheduling

- Source density is read in batches of at most 64 columns and approximately
  2 MiB on the production 4,096-row grid. Oversized historical Parquet parts
  are filtered into bounded batches instead of being decoded whole.
- Disk reads, aggregation, price projection, and response encoding run off
  the live feed event loop. Only small snapshots of the mutable live grid run
  on that loop, with yields between batches.
- A 32 MiB session LRU stores finalized bins and contiguous finalized
  prefixes. Newly finalized tail sources extend a prefix once; forming live
  columns are never cached. Repeated pan/zoom requests can reuse these bins.
- The optional `.flowmap-overview-index.json` contains replaceable scalar
  file bounds/identity metadata only. Every entry is validated against the
  authoritative file's size and modification time. It does not replace or
  alter recorded depth. Corrupt/missing metadata is rebuilt off-loop.
- Scalar-index prewarming starts two seconds after session startup and uses
  two bounded I/O workers. First live paint has priority.

## Visibility and navigation

Manual time zoom uses the genuine source range, independently of the raw GPU
cache. Manual price zoom and pan use physical price bounds; explicit Fit
contains the historical OHLC range. The overview has its own 512-column
surface, so wide views do not evict the live detail to make room for history.

Tolerance is calibrated against the visible positive-depth distribution,
rather than a fixed fraction of the largest order. Zero keeps all positive
depth, 50 uses its median, and 100 uses its 90th percentile. The histogram is
already maintained by normalization, so changing the slider does not add a
history-wide scan. The shader cutoff accounts for the visible price footprint
so a coarse price row does not make ordinary liquidity disappear.

## Measured scope and limits

On the user's BTC recording identity
`373323c330cb46d4afb8d2f774afc2bf`, 4,096 rows and 250 ms native columns, the
69,454-sequence benchmark read all 543 stride-128 output bins. The oldest,
middle, and latest thirds each contained 181 genuine nonzero depth bins.
The aggregate cache used 17,932,032 bytes. A cold process with no scalar index
took 16.33 seconds for its first 64-bin page and 43.70 seconds for the whole
recorded range; the repeat whole-range pass took 33.8 ms. The previous
uncached implementation took 28.24 seconds for its first page and 58.24
seconds overall, and reread the partial tail on repeat.

A separate new-process run after persistence, at sequence 71,973, took
6.463 seconds for its first 64-bin page (8,192 genuine source columns) and
6 ms for the repeated page. These are disk/aggregation timings, not renderer
FPS measurements. Different disk caches, CPU load, and growing recordings
change these values. A first large historical view remains progressive I/O;
the client should show loading progress while continuing live updates.

This preserves depth that was actually recorded. Tape/trade-only history from
before recording began cannot reproduce the historical resting order book.
Such intervals remain visibly absent instead of being filled with invented
heatmap data. Reprojection retains recorded quantities within the target
epoch's physical price coverage; it cannot create depth outside that coverage.

Validation: 108 focused overview/session/protocol tests passed, including
40,960 genuine source columns, absolute paging, changed epoch geometry,
physical quantity conservation, mutable-grid progress during blocked disk
work, finalized-prefix refresh, recording identity isolation, persisted-index
validation, and exact intra-bin/cross-partition gap clocks. Ruff passed for
the changed server files.
