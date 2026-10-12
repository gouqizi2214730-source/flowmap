"""Independent quantity oracle and restart/fault tests for derived history."""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import numpy as np
import msgspec
import polars as pl
import pytest

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.overview import (
    OverviewBuilder,
    OverviewCache,
    _bounded_coarse_ranges,
    add_recording,
)
from flowmap_server.core.pyramid import PersistentPyramid, metadata_page, pyramid_for
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import Session
from flowmap_server.proto import wire
from flowmap_server.proto.events import BarColumn, EpochParams, HistoryRequest, Marker


def fixture(tmp_path, count=137):
    root = Recorder(tmp_path, 20)
    params = {
        0: EpochParams(0, 0.5, 1, 250_000_000, 98.0, 8),
        1: EpochParams(1, 0.25, 1, 500_000_000, 99.0, 8),
    }
    writer = root.open_session("sim", "PYRAMID")
    for param in params.values():
        writer.record_epoch(param)
    columns = []
    for i in range(count):
        ep = params[(i // 19) % 2]
        bid = np.zeros(8, np.float32)
        ask = bid.copy()
        bid[4] = (i % 11 + 1) / 3
        ask[5] = (i % 7 + 1) / 5
        t = 1_000_000_000_000 + i * 1_000_000_000
        bar = BarColumn(ep.epoch, i, t, i, i + 3, i - 1, i + 2, 0.3, 0.2, i / 10, i * 10.0, i * 0.1)
        col = FinalizedColumn(ep.epoch, i, t, bid, ask, bar)
        columns.append(col)
        writer.record_column(col)
        if (i + 1) % 32 == 0:
            writer.flush()
    writer.flush()
    return root, writer, params, columns


def builder(params, count):
    return OverviewBuilder(params[0], 0, count - 1, 64, 2**63 - 1, count - 1, OverviewCache())


def test_native_integrals_match_independent_physical_overlap_oracle(tmp_path):
    root, writer, params, columns = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    stats = store.prepare(params)
    assert stats["source_columns"] == len(columns)
    result = builder(params, len(columns))
    store.add_available(result, params)
    out = result.finish()
    assert not result.missing_source_ranges()
    target_edges = 98 + (np.arange(9) - 0.5) * 0.5
    for actual in out:
        selected = columns[actual.col_seq : actual.col_seq + 64]
        weights = sum(params[c.epoch].dt_ns for c in selected)
        expected = np.zeros((2, 8), np.float64)
        for col in selected:
            ep = params[col.epoch]
            edges = ep.p0 + (np.arange(9) - 0.5) * ep.tick * ep.tick_multiple
            for src in range(8):
                for dst in range(8):
                    overlap = max(
                        0.0,
                        min(edges[src + 1], target_edges[dst + 1])
                        - max(edges[src], target_edges[dst]),
                    )
                    fraction = overlap / (edges[src + 1] - edges[src])
                    expected[:, dst] += np.array([col.bid[src], col.ask[src]]) * ep.dt_ns * fraction
        np.testing.assert_allclose(actual.bid, expected[0] / weights, rtol=2e-7)
        np.testing.assert_allclose(actual.ask, expected[1] / weights, rtol=2e-7)
        assert actual.bar.vol_buy == pytest.approx(0.3 * len(selected))
        assert actual.bar.cvd_cum == selected[-1].bar.cvd_cum
        assert actual.bar.vwap_den_cum == selected[-1].bar.vwap_den_cum
    assert len(result.gap_markers()) == len(columns) - 1


def test_prepared_restart_reads_no_raw_density_and_corrupt_fragment_falls_back(
    tmp_path, monkeypatch
):
    root, writer, params, columns = fixture(tmp_path)
    PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id).prepare(params)
    reopened = PersistentPyramid(Recorder(tmp_path, 20), "sim", "PYRAMID", writer.recording_id)
    import flowmap_server.core.overview as overview

    monkeypatch.setattr(
        overview,
        "recorded_batches",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("raw density read")),
    )
    result = builder(params, len(columns))
    reopened.add_available(result, params)
    assert not result.missing_source_ranges()
    for fragment in reopened.directory.glob("*.bin"):
        fragment.write_bytes(b"truncated")
    result = builder(params, len(columns))
    reopened.add_available(result, params)
    assert result.missing_source_ranges()
    assert reopened.stats["corrupt_fragments"] > 0


def test_changed_part_is_selectively_invalidated_and_resume_skips_valid_parts(tmp_path):
    root, writer, params, columns = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    first = store.prepare(params)
    assert store.prepare(params)["source_columns"] == 0
    source = next(root._symbol_dir("sim", "PYRAMID").glob("*-columns-*.parquet"))
    # A changed stamp makes that source unavailable until reconverted.
    import os

    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 100000))
    partial = builder(params, len(columns))
    store.add_available(partial, params)
    assert partial.missing_source_ranges()
    repaired = store.prepare(params)
    assert 0 < repaired["source_columns"] < first["source_columns"]
    final = builder(params, len(columns))
    store.add_available(final, params)
    assert not final.missing_source_ranges()
    # Crash/invalid manifest remains an optional cache, never source loss.
    store.manifest.write_text("{", encoding="utf8")
    reopened = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    assert reopened.prepare(params)["source_columns"] == len(columns)


def test_exact_ranges_and_all_gap_pages_are_accessible_and_stale_is_explicit():
    ranges = [(i * 3.0, i * 3.0 + 1.0, 0.5) for i in range(17)]
    assert _bounded_coarse_ranges(ranges) == tuple(ranges)
    markers = [Marker(i + 1, "gap", str(i)) for i in range(2200)]
    req = HistoryRequest(1, 999999, 256, 0, 2200, 32)
    first = metadata_page(markers, req)
    meta = json.loads(first[-1].text)
    assert len(first) == 1025 and not meta["complete"]
    req.metadata_cursor = meta["next_cursor"]
    second = metadata_page(markers, req)
    req.metadata_cursor = json.loads(second[-1].text)["next_cursor"]
    third = metadata_page(markers, req)
    assert len(first[:-1]) + len(second[:-1]) + len(third[:-1]) == 2200
    assert json.loads(third[-1].text)["complete"]
    markers.append(Marker(2201, "gap", "changed"))
    assert json.loads(metadata_page(markers, req)[-1].text)["stale"]


def test_retention_counts_coverage_loss_and_summary_never_replaces_deleted_raw(tmp_path):
    root, writer, params, columns = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    root._cap_bytes = 0
    removed = root.enforce_retention()
    assert removed and root.retention_status["deleted_columns_parts"] > 0
    assert root.retention_status["coverage_loss"]
    result = builder(params, len(columns))
    store.add_available(result, params)
    assert result.missing_source_ranges(), "summary cannot serve exact history after source removal"
    # Cache construction itself leaves the oldest original sources intact.
    retained = SimpleNamespace(count=len(list(tmp_path.rglob("*-columns-*.parquet"))))
    assert retained.count == 1


def session_for(root, writer, params, columns):
    current = params[columns[-1].epoch]
    grid = Grid(
        GridCfg(
            tick=current.tick,
            tick_multiple=current.tick_multiple,
            dt_ns=current.dt_ns,
            p0=current.p0,
            rows=current.rows,
            ring_columns=4,
            mode=0,
        )
    )
    grid.preload(columns[-4:], [current])
    grid._epoch_params.update(params)
    session = Session(
        "persistent-test",
        feed=SimpleNamespace(market="sim", symbol="PYRAMID", capability={"depth": "L2"}),
        grid=grid,
        recorder=root,
    )
    session._rec = writer
    return session


def decoded_response(frame):
    offset, result = 0, None
    while offset < len(frame):
        result, offset = wire.decode(frame, offset)
    return result


async def test_session_prepared_restart_matches_raw_and_reads_zero_density(tmp_path, monkeypatch):
    root, writer, params, columns = fixture(tmp_path)
    req = HistoryRequest(1, 2**63 - 1, 256, 0, len(columns) - 1, 64)
    raw = decoded_response(
        await session_for(root, writer, params, columns).handle_history_async(req)
    )
    pyramid_for(root, "sim", "PYRAMID", writer.recording_id).prepare(params)
    import flowmap_server.core.overview as overview

    monkeypatch.setattr(
        overview,
        "recorded_batches",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("raw density IO")),
    )
    prepared = decoded_response(
        await session_for(Recorder(tmp_path, 20), writer, params, columns).handle_history_async(req)
    )
    assert len(raw.depth_cols) == len(prepared.depth_cols)
    for a, b in zip(raw.depth_cols, prepared.depth_cols):
        np.testing.assert_allclose(a.bid, b.bid, rtol=2e-7)
        np.testing.assert_allclose(a.ask, b.ask, rtol=2e-7)
        assert a.epoch == b.epoch
    for a, b in zip(raw.bar_cols, prepared.bar_cols):
        assert (a.col_seq, a.epoch, a.t0_ns) == (b.col_seq, b.epoch, b.t0_ns)
        for field in (
            "o",
            "h",
            "l",
            "c",
            "vol_buy",
            "vol_sell",
            "cvd_cum",
            "vwap_num_cum",
            "vwap_den_cum",
        ):
            assert getattr(a, field) == pytest.approx(getattr(b, field), rel=1e-12, abs=1e-12)
    assert raw.markers == prepared.markers


async def test_session_metadata_pages_return_all_gaps_without_depth_reupload(tmp_path):
    root, writer, params, columns = fixture(tmp_path, 1100)
    pyramid_for(root, "sim", "PYRAMID", writer.recording_id).prepare(params)
    session = session_for(root, writer, params, columns)
    req = HistoryRequest(1, 2**63 - 1, 256, 0, len(columns) - 1, 2048)
    first = decoded_response(await session.handle_history_async(req))
    page = next(m for m in first.markers if m.kind == "history_metadata_page")
    req.metadata_cursor = json.loads(page.text)["next_cursor"]
    second = decoded_response(await session.handle_history_async(req))
    assert first.depth_cols and not second.depth_cols and not second.bar_cols
    gaps = [m for response in (first, second) for m in response.markers if m.kind == "gap"]
    assert len(gaps) == len(columns) - 1
    assert len({m.text for m in gaps}) == len(gaps)
    assert json.loads(second.markers[-1].text)["complete"]


@pytest.mark.parametrize("changed_epoch", [0, 1])
async def test_same_session_view_cache_invalidates_changed_source_epoch_duration(
    tmp_path, changed_epoch
):
    root, writer, params, columns = fixture(tmp_path, 64)
    session = session_for(root, writer, params, columns)
    request = HistoryRequest(1, 2**63 - 1, 256, 0, 63, 64)
    before = decoded_response(await session.handle_history_async(request))
    warmed_cache = session._overview_cache
    changed = {
        **params,
        changed_epoch: msgspec.structs.replace(params[changed_epoch], dt_ns=1_000_000_000),
    }
    session._grid._epoch_params.update(changed)
    for path in root._symbol_dir("sim", "PYRAMID").glob("*-epochs-*.parquet"):
        table = pl.read_parquet(path)
        table.with_columns(
            pl.when(pl.col("epoch") == changed_epoch)
            .then(pl.lit(1_000_000_000))
            .otherwise(pl.col("dt_ns"))
            .alias("dt_ns")
        ).write_parquet(path)
    updated = decoded_response(await session.handle_history_async(request))
    fresh = decoded_response(
        await session_for(Recorder(tmp_path, 20), writer, changed, columns).handle_history_async(
            request
        )
    )
    assert session._overview_cache is not warmed_cache
    assert not np.array_equal(before.depth_cols[0].bid, fresh.depth_cols[0].bid)
    np.testing.assert_allclose(updated.depth_cols[0].bid, fresh.depth_cols[0].bid, rtol=2e-7)
    np.testing.assert_allclose(updated.depth_cols[0].ask, fresh.depth_cols[0].ask, rtol=2e-7)


def test_atomic_manifest_failure_leaves_raw_and_resumable_orphans(tmp_path, monkeypatch):
    root, writer, params, columns = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    import flowmap_server.core.pyramid as module

    atomic = module._atomic

    def fail_manifest(path, payload):
        if path.name == "manifest.json":
            raise OSError("interrupted publish")
        atomic(path, payload)

    monkeypatch.setattr(module, "_atomic", fail_manifest)
    with pytest.raises(OSError):
        store.prepare(params)
    assert not store.manifest.exists()
    assert (
        root.load_tail(
            "sim",
            "PYRAMID",
            max_age_ns=2**63 - 1,
            now_ns=2**63 - 1,
            limit_cols=4,
            end_ns=columns[4].t0_ns,
            recording_id=writer.recording_id,
        )
        .columns[0]
        .col_seq
        == 0
    )
    monkeypatch.setattr(module, "_atomic", atomic)
    assert PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id).prepare(params)[
        "source_columns"
    ] == len(columns)


def test_newer_unprepared_duplicate_wins_over_prepared_old_part(tmp_path):
    root, writer, params, columns = fixture(tmp_path, 32)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    replacement = columns[7]
    replacement = FinalizedColumn(
        replacement.epoch,
        replacement.col_seq,
        replacement.t0_ns,
        replacement.bid * 9,
        replacement.ask * 9,
        replacement.bar,
    )
    writer.record_column(replacement)
    writer.flush()
    result = builder(params, len(columns))
    store.add_available(result, params)
    # Conservative whole fragment fallback prevents old prepared quantities
    # from claiming the sequence occupied by a newer authoritative part.
    assert any(lo <= 7 <= hi for lo, hi in result.missing_source_ranges())


def test_manifest_wrong_schema_or_recording_identity_is_not_adopted(tmp_path):
    root, writer, params, columns = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    for field, value in [("schema", 999), ("recording_id", "another-recording")]:
        original = json.loads(store.manifest.read_bytes())
        original[field] = value
        store.manifest.write_text(json.dumps(original), encoding="utf8")
        reopened = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
        result = builder(params, len(columns))
        reopened.add_available(result, params)
        assert result.missing_source_ranges()
        reopened.prepare(params)


def test_cancellation_is_resumable_and_batches_remain_bounded(tmp_path):
    root, writer, params, columns = fixture(tmp_path, 500)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    calls = [0]

    def stop():
        calls[0] += 1
        return calls[0] > 5

    interrupted = store.prepare(params, stop=stop)
    assert interrupted["cancelled"]
    finished = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id).prepare(params)
    assert finished["source_columns"] + interrupted["source_columns"] >= len(columns)
    assert finished["max_source_batch"] <= 64


def test_scoped_gc_purge_and_independent_budget_leave_all_raw_and_unknown_files(tmp_path):
    root, writer, params, columns = fixture(tmp_path, 137)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    directory = store.directory
    orphan = directory / ("e" * 64 + ".bin")
    orphan.write_bytes(b"orphan")
    interrupted = directory / ("a" * 64 + ".bin." + "b" * 32 + ".tmp")
    interrupted.write_bytes(b"interrupted")
    unknown = directory / "user-notes.tmp"
    unknown.write_bytes(b"preserve")
    outsider = tmp_path / "outside.bin"
    outsider.write_bytes(b"preserve outside")
    original_parts = {p: p.read_bytes() for p in tmp_path.rglob("*-columns-*.parquet")}
    result = store.collect_cache()
    assert result["deleted_cache_files"] == 2
    assert not orphan.exists() and not interrupted.exists()
    assert unknown.exists() and outsider.exists()
    store.byte_limit = 0
    evicted = store.collect_cache()
    assert evicted["evicted_cache_parts"] > 0
    assert not list(directory.glob("*.bin"))
    for path, payload in original_parts.items():
        assert path.read_bytes() == payload
    store.byte_limit = 2**30
    store.prepare(params)
    assert store.collect_cache(purge=True)["deleted_cache_files"] > 0
    assert unknown.read_bytes() == b"preserve"
    assert all(p.read_bytes() == b for p, b in original_parts.items())


def test_gc_drops_sources_retained_away_and_ignores_other_recording_namespace(tmp_path):
    root, writer, params, _ = fixture(tmp_path)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    unrelated = store.directory.parent / "another-recording"
    unrelated.mkdir()
    keep = unrelated / ("f" * 64 + ".bin")
    keep.write_bytes(b"other recording")
    before = len(list(store.directory.glob("*.bin")))
    root._cap_bytes = 0
    # Use a fresh recorder: inactive recording caches must be reclaimed too.
    restarted = Recorder(tmp_path, 20)
    restarted._cap_bytes = 0
    restarted.enforce_retention()
    assert len(list(store.directory.glob("*.bin"))) < before
    assert keep.read_bytes() == b"other recording"


def test_duration_change_invalidates_integrals_even_with_same_physical_map(tmp_path):
    root, writer, params, _ = fixture(tmp_path, 32)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    path = next(p for p, _ in store.parts() if p.name in store.snapshot()["sources"])
    changed = {**params, 0: EpochParams(0, 0.5, 1, params[0].dt_ns * 2, 98.0, 8)}
    assert store._valid(path, params) is not None
    assert store._valid(path, changed) is None


def test_coverage_generation_binds_epoch_file_stamps_and_known_semantics_separately(tmp_path):
    root, writer, params, _ = fixture(tmp_path, 32)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    parts = store.parts()
    original = store.generation(parts, known_epochs=params)
    changed = {**params, 0: msgspec.structs.replace(params[0], dt_ns=params[0].dt_ns * 4)}
    assert store.generation(parts, known_epochs=changed) != original
    epoch_path = next(root._symbol_dir("sim", "PYRAMID").glob("*-epochs-*.parquet"))
    table = pl.read_parquet(epoch_path)
    table.with_columns((pl.col("dt_ns") * 2).alias("dt_ns")).write_parquet(epoch_path)
    assert store.generation(store.parts(), known_epochs=params) != original


@pytest.mark.parametrize("broken", [[], {"mapping": []}, {"mapping": {"wrong": []}}])
def test_malformed_optional_epoch_index_is_a_safe_cache_miss(tmp_path, broken):
    root, writer, params, _ = fixture(tmp_path, 32)
    store = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    doc = json.loads(store.manifest.read_bytes())
    for source in doc["sources"].values():
        source.pop("integral_geometry")
    doc["epoch_index"] = broken
    store.manifest.write_text(json.dumps(doc), encoding="utf8")
    reopened = PersistentPyramid(root, "sim", "PYRAMID", writer.recording_id)
    assert reopened.epoch_maps(params, [])
    assert reopened.prepare(params)["max_source_batch"] <= 64


def test_query_pins_published_document_during_concurrent_cache_eviction(tmp_path, monkeypatch):
    root, writer, params, columns = fixture(tmp_path)
    store = pyramid_for(root, "sim", "PYRAMID", writer.recording_id)
    store.prepare(params)
    entered, release = threading.Event(), threading.Event()
    original = store._read_fragment
    first = [True]
    errors = []
    result = builder(params, len(columns))

    def paused(entry):
        fragment = original(entry)
        if first[0]:
            first[0] = False
            entered.set()
            assert release.wait(10)
        return fragment

    monkeypatch.setattr(store, "_read_fragment", paused)

    def query():
        try:
            store.add_available(result, params)
            add_recording(result, root, "sim", "PYRAMID", writer.recording_id, params, [])
        except Exception as error:
            errors.append(error)

    thread = threading.Thread(target=query)
    thread.start()
    assert entered.wait(10)
    published = store.snapshot()
    store.byte_limit = 0
    store.collect_cache()
    assert published["sources"] and not store.snapshot()["sources"]
    release.set()
    thread.join(10)
    assert not thread.is_alive() and not errors
    expected = builder(params, len(columns))
    expected.add(columns, params)
    for actual, wanted in zip(result.finish(), expected.finish()):
        np.testing.assert_allclose(actual.bid, wanted.bid, rtol=2e-7)
    assert not result.missing_source_ranges()
