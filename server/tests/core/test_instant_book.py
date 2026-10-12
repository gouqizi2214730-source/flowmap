import numpy as np
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.proto import events, wire


def test_current_book_has_its_own_binary_tag_and_preserves_quantity():
    grid = Grid(GridCfg(tick=.5, tick_multiple=1, dt_ns=100, p0=50, rows=256,
                        ring_columns=8, mode=events.MODE_L2))
    px, ask = np.array([100.0]), np.array([100.5])
    grid.on_book(0, px, np.array([2.0]), ask, np.array([3.0]))
    grid.on_book(50, px, np.array([1e9]), ask, np.array([4.0]))
    update = grid.book_update(50)
    encoded = wire.encode(update)
    decoded, end = wire.decode(encoded)
    assert encoded[0] == 0x23 and end == len(encoded)
    assert type(decoded) is events.BookUpdate
    assert decoded.bid[100] == 1e9
    assert decoded.ask[101] == 4
    assert grid.current_partial().bid[100] == 1.0  # time-weighted history remains separate
