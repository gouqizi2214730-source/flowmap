"""Recorded depth keeps its own geometry across legacy files and cold runs."""

from pathlib import Path

import msgspec
import numpy as np
import polars as pl
import pytest

from flowmap_server.core.record import Recorder
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto.events import EpochParams


MARKET, SYMBOL = "sim", "IDENTITY-TEST"
DT_NS = 250_000_000
HOUR_NS = 3_600_000_000_000
ROWS = 32
EPOCH = EpochParams(
    epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=92.0, rows=ROWS
)


def _history(count: int, start_ns: int = 0, seed: int = 3):
    return SimFeed.generate_history(
        seed=seed, n_cols=count, start_ns=start_ns, rows=ROWS
    )


def _record(rec: Recorder, columns, epoch: EpochParams = EPOCH) -> str:
    writer = rec.open_session(MARKET, SYMBOL)
    writer.record_epoch(epoch)
    for column in columns:
        writer.record_column(column)
    writer.close()
    return writer.recording_id


def _make_legacy(base: Path) -> None:
    for path in (base / MARKET / SYMBOL).glob("*.parquet"):
        frame = pl.read_parquet(path)
        if "recording_id" in frame.columns:
            frame.drop("recording_id").write_parquet(path)


def _assert_depth(tail, expected, epoch: EpochParams = EPOCH) -> None:
    assert tail is not None
    assert tail.epochs == [epoch]
    assert [(c.col_seq, c.t0_ns) for c in tail.columns] == [
        (c.col_seq, c.t0_ns) for c in expected
    ]
    for actual, original in zip(tail.columns, expected, strict=True):
        np.testing.assert_array_equal(actual.bid, original.bid)
        np.testing.assert_array_equal(actual.ask, original.ask)


def test_legacy_first_flush_spanning_hour_keeps_all_real_depth(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    columns = _history(8, HOUR_NS - 4 * DT_NS)
    _record(rec, columns)
    _make_legacy(tmp_path)

    whole = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=HOUR_NS + 4 * DT_NS, limit_cols=8,
    )
    _assert_depth(whole, columns)

    before_hour = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=HOUR_NS + 4 * DT_NS, end_ns=HOUR_NS, limit_cols=8,
    )
    _assert_depth(before_hour, columns[:4])


def test_legacy_hour_split_never_borrows_future_cold_run_geometry(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    old_columns = _history(8, HOUR_NS - 4 * DT_NS)
    future_columns = _history(4, HOUR_NS + 20 * DT_NS, seed=4)
    future_epoch = msgspec.structs.replace(EPOCH, p0=592.0)
    _record(rec, old_columns)
    _record(rec, future_columns, future_epoch)
    _make_legacy(tmp_path)

    before_hour = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=HOUR_NS + 24 * DT_NS, end_ns=HOUR_NS, limit_cols=20,
    )
    _assert_depth(before_hour, old_columns[:4])
    newest = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=HOUR_NS + 24 * DT_NS, limit_cols=20,
    )
    _assert_depth(newest, future_columns, future_epoch)
    assert newest.truncated


def test_legacy_hour_split_missing_metadata_cannot_borrow_cold_run_epoch(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    _record(rec, _history(8, HOUR_NS - 4 * DT_NS))
    future_epoch = msgspec.structs.replace(EPOCH, p0=592.0)
    _record(rec, _history(4, HOUR_NS + 20 * DT_NS, seed=4), future_epoch)
    _make_legacy(tmp_path)
    epochs = sorted((tmp_path / MARKET / SYMBOL).glob("*-epochs-*.parquet"))
    epochs[0].unlink()

    old_tail = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=HOUR_NS + 24 * DT_NS, end_ns=HOUR_NS, limit_cols=20,
    )
    assert old_tail is None


def test_mixed_legacy_and_identified_files_keep_latest_run_geometry(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    old_columns = _history(8)
    _record(rec, old_columns)
    _make_legacy(tmp_path)
    new_columns = _history(4, 20 * DT_NS, seed=4)
    new_epoch = msgspec.structs.replace(EPOCH, p0=592.0)
    newest_id = _record(rec, new_columns, new_epoch)

    tail = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=24 * DT_NS, limit_cols=20,
    )
    _assert_depth(tail, new_columns, new_epoch)
    assert tail.recording_id == newest_id
    assert tail.truncated


def test_scoped_read_recovers_older_run_without_mixing_latest_depth(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    old_columns = _history(8)
    old_id = _record(rec, old_columns)
    new_columns = _history(4, 20 * DT_NS, seed=4)
    new_epoch = msgspec.structs.replace(EPOCH, p0=592.0)
    new_id = _record(rec, new_columns, new_epoch)

    old_tail = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=24 * DT_NS, limit_cols=3,
        recording_id=old_id, max_column_parts=8, include_events=False,
    )
    _assert_depth(old_tail, old_columns[-3:])
    assert old_tail.recording_id == old_id
    assert old_tail.trades == []
    assert old_tail.markers == []
    newest = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=24 * DT_NS, limit_cols=20,
    )
    _assert_depth(newest, new_columns, new_epoch)
    assert newest.recording_id == new_id


def test_scoped_depth_read_caps_number_of_column_parts(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    columns = _history(12)
    writer = rec.open_session(MARKET, SYMBOL)
    writer.record_epoch(EPOCH)
    for offset in range(0, len(columns), 4):
        for column in columns[offset:offset + 4]:
            writer.record_column(column)
        writer.flush()
    writer.close()

    tail = rec.load_tail(
        MARKET, SYMBOL, max_age_ns=HOUR_NS,
        now_ns=12 * DT_NS, limit_cols=12,
        recording_id=writer.recording_id, max_column_parts=1, include_events=False,
    )
    _assert_depth(tail, columns[-4:])
    assert tail.recording_id == writer.recording_id
    assert tail.truncated


@pytest.mark.parametrize("legacy", [False, True])
def test_old_ranged_page_skips_newer_same_hour_parts_before_density_cap(
    tmp_path, monkeypatch, legacy,
):
    rec = Recorder(tmp_path, 20.0)
    columns = _history(84)
    writer = rec.open_session(MARKET, SYMBOL)
    writer.record_epoch(EPOCH)
    for offset in range(0, len(columns), 2):
        for column in columns[offset:offset + 2]:
            writer.record_column(column)
        writer.flush()
    writer.close()
    if legacy:
        _make_legacy(tmp_path)

    read = pl.read_parquet
    density_reads: list[Path] = []
    timestamp_reads: list[Path] = []

    def counting_read(path, **kwargs):
        if "-columns-" in Path(path).name:
            if kwargs.get("columns") is None:
                density_reads.append(Path(path))
            elif kwargs["columns"] == ["t0_ns"]:
                timestamp_reads.append(Path(path))
        return read(path, **kwargs)

    monkeypatch.setattr(pl, "read_parquet", counting_read)
    read_args = dict(
        max_age_ns=HOUR_NS, now_ns=84 * DT_NS, end_ns=6 * DT_NS,
        limit_cols=2, max_column_parts=16, include_events=False,
        recording_id="" if legacy else writer.recording_id,
    )
    tail = rec.load_tail(MARKET, SYMBOL, **read_args)
    _assert_depth(tail, columns[4:6])
    assert len(density_reads) == 1

    # Consecutive historical pages reuse the immutable-file timestamp index;
    # skipped future parts do not need another disk read or another array load.
    probes_before = len(timestamp_reads)
    again = rec.load_tail(MARKET, SYMBOL, **read_args)
    _assert_depth(again, columns[4:6])
    assert len(density_reads) == 2
    assert len(timestamp_reads) == probes_before
