"""Rolling fine cores preserve recorded epochs and unresolved bucket mass."""

from __future__ import annotations

import numpy as np
import pytest

from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.price_scale import SCALE_HYBRID, row_to_price, step_at_row
from flowmap_server.proto.events import SIDE_BUY


DT = 1_000_000_000


def hybrid_grid(tick=0.01, multiple=50) -> Grid:
    return Grid(GridCfg(tick=tick, tick_multiple=multiple, dt_ns=DT, p0=0,
                        rows=4096, ring_columns=8, mode=0,
                        band_up=10.0, band_down=0.99, band_hybrid=True, core_rows=2048))


def book(mid: float, step: float):
    best_bid = np.floor(mid / step) * step
    bid = best_bid - np.arange(8) * step
    ask = best_bid + (np.arange(8) + 1) * step
    return bid, np.arange(1, 9, dtype=np.float64), ask, np.arange(2, 10, dtype=np.float64)


def edges(scale):
    return np.array([row_to_price(scale, r - 0.5) for r in range(scale.rows + 1)])


def overlap_reference(values, source, target):
    """Independent per-source interval integral; no row-index translation."""
    src, dst = edges(source), edges(target)
    expected = np.zeros_like(values)
    for channel in range(values.shape[0]):
        for r in np.flatnonzero(values[channel]):
            overlap = np.maximum(0, np.minimum(src[r + 1], dst[1:]) - np.maximum(src[r], dst[:-1]))
            expected[channel] += values[channel, r] * overlap / (src[r + 1] - src[r])
    return expected


def test_btc_rolls_before_mid_leaves_the_fine_core_and_keeps_native_resolution():
    grid = hybrid_grid()
    first = grid.maybe_reanchor(82916.0)
    assert first is not None and first.core_p0 == 82404.0
    old = grid.scale
    lower_guard = old.core_p0 + 0.15 * old.core_rows * old.core_step
    upper_guard = old.core_p0 + 0.85 * old.core_rows * old.core_step
    assert grid.maybe_reanchor(lower_guard) is None
    assert grid.maybe_reanchor(upper_guard) is None
    # Still inside the fine core, far inside the whole hybrid coverage.
    rolled = grid.maybe_reanchor(lower_guard - 0.5)
    assert rolled is not None and rolled.epoch == first.epoch + 1
    assert rolled.core_step == first.core_step == 0.5
    assert rolled.core_rows == first.core_rows == 2048
    assert rolled.tick_multiple == first.tick_multiple == 50
    assert grid.epoch_params_for(first.epoch) is first
    assert grid.maybe_reanchor(lower_guard - 0.5) is None


@pytest.mark.parametrize("mid", [81812.0, 84020.0, 81000.0, 88000.0])
def test_btc_wandering_book_rebuilds_into_distinct_half_dollar_bins(mid):
    grid = hybrid_grid()
    first = grid.maybe_reanchor(82916.0)
    args = book(mid, 0.5)
    grid.on_book(0, *args)
    rolled = grid.maybe_reanchor(mid)
    assert first is not None and rolled is not None
    scale = grid.scale
    assert scale.kind == SCALE_HYBRID
    assert scale.core_p0 < mid < scale.core_hi
    assert scale.core_rows == first.core_rows and scale.core_step == first.core_step
    bid_rows, ask_rows = np.flatnonzero(grid._state[0]), np.flatnonzero(grid._state[1])
    assert len(bid_rows) == len(ask_rows) == 8
    assert set(bid_rows).isdisjoint(ask_rows)
    assert np.all(np.diff(bid_rows) == 1) and np.all(np.diff(ask_rows) == 1)
    assert step_at_row(scale, ask_rows[0]) == pytest.approx(0.5)
    assert grid._state[0].sum() == args[1].sum()
    assert grid._state[1].sum() == args[3].sum()
    assert grid.maybe_reanchor(mid) is None


def test_rune_rolls_a_positive_core_without_changing_its_initial_row_count_or_tick():
    grid = hybrid_grid(tick=0.001, multiple=1)
    first = grid.maybe_reanchor(0.7835)
    assert first is not None and first.core_rows < grid.cfg.core_rows
    for mid in [0.91, 0.66, 1.01, 0.62]:
        args = book(mid, 0.001)
        grid.on_book(0, *args)
        rolled = grid.maybe_reanchor(mid)
        assert rolled is not None
        assert rolled.core_p0 > 0 and grid.scale.core_p0 < mid < grid.scale.core_hi
        assert rolled.core_step == first.core_step == 0.001
        assert rolled.core_rows == first.core_rows
        assert (rolled.tick, rolled.tick_multiple) == (first.tick, first.tick_multiple)
        assert np.count_nonzero(grid._state[0]) == np.count_nonzero(grid._state[1]) == 8
        assert set(np.flatnonzero(grid._state[0])).isdisjoint(np.flatnonzero(grid._state[1]))
        assert grid.maybe_reanchor(mid) is None


def test_nonzero_partial_uses_true_price_overlap_and_preserves_time_and_trade_bars():
    grid = hybrid_grid()
    first = grid.maybe_reanchor(82916.0)
    # These two prices share one broad old wing bucket, but become distinct
    # fine rows after the roll. The already-integrated half remains unresolved.
    args = (np.array([81812.0]), np.array([2.0]), np.array([81812.5]), np.array([5.0]))
    grid.on_book(0, *args)
    grid.on_trade(DT // 4, 81812.25, 3, SIDE_BUY)
    grid.on_book(DT // 2, *args)
    previous_scale, accumulated = grid.scale, grid._acc.copy()
    old_bar, old_time = grid.bar_partial(), (grid._prev_ts, grid._cur_idx, grid._count)
    rolled = grid.maybe_reanchor(81812.25)
    assert first is not None and rolled is not None
    expected = overlap_reference(accumulated, previous_scale, grid.scale)
    np.testing.assert_allclose(grid._acc, expected, rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose(grid._acc.sum(axis=1), accumulated.sum(axis=1), rtol=1e-12)
    assert np.count_nonzero(grid._acc[0]) > 100  # coarse mass distributed, not shifted as one row
    assert np.count_nonzero(grid._state[0]) == np.count_nonzero(grid._state[1]) == 1
    assert np.flatnonzero(grid._state[0])[0] != np.flatnonzero(grid._state[1])[0]
    assert (grid._prev_ts, grid._cur_idx, grid._count) == old_time
    new_bar = grid.bar_partial()
    for field in ["t0_ns", "col_seq", "o", "h", "l", "c", "vol_buy", "vol_sell",
                  "cvd_cum", "vwap_num_cum", "vwap_den_cum"]:
        assert getattr(new_bar, field) == getattr(old_bar, field)
    finalized = grid.on_book(DT, *args)[0]
    assert finalized.epoch == finalized.bar.epoch == rolled.epoch
    np.testing.assert_allclose([finalized.bid.sum(), finalized.ask.sum()], [2, 5], rtol=0.001)
    assert finalized.bar.vol_buy == 3 and finalized.bar.vwap_num_cum == 81812.25 * 3


def test_source_edges_at_joins_and_coverage_are_nearest_centered_and_conservative():
    grid = hybrid_grid()
    grid.maybe_reanchor(82916.0)
    source = grid.scale
    # Include both joins, an out-of-target upper edge, and tiny mass beside
    # large quantities: remapping must not use a cancelling cumulative sum.
    grid._acc[0, [0, source.dn_rows - 1, source.dn_rows,
                  source.dn_rows + source.core_rows, source.rows - 1]] = [2, 3, 4, 5, 6]
    grid._acc[1, [source.dn_rows, source.dn_rows + source.core_rows // 2]] = [1e20, 1e-6]
    original = grid._acc.copy()
    grid.maybe_reanchor(81812.0)
    expected = overlap_reference(original, source, grid.scale)
    np.testing.assert_allclose(grid._acc, expected, rtol=1e-12, atol=1e-18)
    # Crop only the physical portion beyond target coverage.
    np.testing.assert_allclose(grid._acc.sum(axis=1), expected.sum(axis=1), rtol=1e-12)
    tiny_rows = np.flatnonzero(expected[1] < 1e-5)
    assert grid._acc[1, tiny_rows].sum() > 0


def test_preloaded_stale_btc_core_rolls_on_next_book_without_rewriting_old_epoch_history():
    source = hybrid_grid()
    first = source.maybe_reanchor(82916.0)
    old_book = book(82916, 0.5)
    source.on_book(0, *old_book)
    source.on_trade(DT // 2, 82916, 2, SIDE_BUY)
    old_column = source.on_book(DT, *old_book)[0]
    assert first is not None
    grid = hybrid_grid()
    grid.preload([old_column], [first])
    restored_epoch = grid.current_epoch_params()
    old_bid, old_ask = old_column.bid.copy(), old_column.ask.copy()
    live_book = book(81812, 0.5)
    grid.on_book(10 * DT, *live_book)
    rolled = grid.maybe_reanchor(81812.25)
    assert rolled is not None and rolled.epoch == first.epoch + 1
    assert grid.epoch_params_for(first.epoch) is restored_epoch
    assert (rolled.core_step, rolled.core_rows, rolled.tick_multiple) == (first.core_step, first.core_rows, first.tick_multiple)
    history = grid.history(20 * DT, 8)
    assert len(history) == 1
    historical = history[0]
    assert (historical.epoch, historical.col_seq, historical.t0_ns) == (old_column.epoch, old_column.col_seq, old_column.t0_ns)
    np.testing.assert_array_equal(historical.bid, old_bid)
    np.testing.assert_array_equal(historical.ask, old_ask)
    assert historical.bar is old_column.bar
    assert np.count_nonzero(grid._state[0]) == np.count_nonzero(grid._state[1]) == 8
    fresh = grid.on_book(11 * DT, *live_book)[0]
    assert fresh.epoch == rolled.epoch and fresh.col_seq == old_column.col_seq + 1
    assert fresh.t0_ns == 10 * DT
    assert np.count_nonzero(fresh.bid) == np.count_nonzero(fresh.ask) == 8


def test_preload_after_large_upward_roll_preserves_the_recorded_fine_step():
    source = hybrid_grid()
    first = source.maybe_reanchor(82916.0)
    rolled = source.maybe_reanchor(180000.0)
    args = book(180000.0, 0.5)
    source.on_book(0, *args)
    source.on_trade(DT // 2, 180000, 1, SIDE_BUY)
    column = source.on_book(DT, *args)[0]
    assert first is not None and rolled is not None
    grid = hybrid_grid()
    grid.preload([column], [first, rolled])
    assert grid.scale.core_step == 0.5
    assert grid.scale.core_rows == first.core_rows
    next_epoch = grid.maybe_reanchor(182000.0)
    assert next_epoch is not None
    assert next_epoch.tick_multiple == first.tick_multiple
    assert next_epoch.core_step == first.core_step
