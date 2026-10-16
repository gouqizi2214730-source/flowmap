"""Generate a reproducible synthetic normalized history using the production Parquet writer.
This does NOT reproduce raw exchange connector parsing or live recording ingestion.
Run with server dependencies (PYTHONPATH=<repo>/server/src).
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.core.record import SessionRecorder
from flowmap_server.proto.events import BarColumn, EpochParams, Trade
from core import fixture_files

START_NS = 1_759_276_800_000_000_000  # 2025-10-01T00:00:00Z; immutable synthetic clock

def generate(output, seconds=3600, rows=4096, seed=5750):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    directory = output / 'recordings' / 'binance-spot' / 'BTCUSDT'
    directory.mkdir(parents=True)
    recorder = SessionRecorder(directory, enabled=True)
    recorder.recording_id = f'benchmark-normalized-v1-{seed}'
    dt = 250_000_000
    params = EpochParams(epoch=1, tick=5.0, tick_multiple=1, dt_ns=dt, p0=50_000.0, rows=rows)
    recorder.record_epoch(params)
    count = seconds * 4
    levels = min(128, rows // 4)
    cvd, vwap_num, vwap_den = 0.0, 0.0, 0.0
    digest = __import__('hashlib').sha256()
    for seq in range(count):
        # Integer-only content formula; f16 widening is exact in the production writer.
        mid_row = rows // 2 + ((seq // 8 + seed) % max(1, rows // 16)) - rows // 32
        bid = np.zeros(rows, dtype=np.float16); ask = np.zeros(rows, dtype=np.float16)
        for level in range(levels):
            size = ((seq * 17 + level * 31 + seed) % 64 + 1) / 8
            bid[mid_row - level - 1] = size
            ask[mid_row + level + 1] = ((seq * 23 + level * 19 + seed) % 64 + 1) / 8
        t0 = START_NS + seq * dt
        price = params.p0 + mid_row * params.tick
        buy, sell = float((seq * 7 + seed) % 11 + 1), float((seq * 3 + seed) % 13 + 1)
        cvd += buy - sell; vwap_num += price * (buy + sell); vwap_den += buy + sell
        bar = BarColumn(1, seq, t0, price, price+5, price-5, price, buy, sell, cvd, vwap_num, vwap_den)
        recorder.record_column(FinalizedColumn(1, seq, t0, bid, ask, bar))
        recorder.record_trade(Trade(t0 + 1_000_000, price, buy, 0, 0, 'synthetic-benchmark'))
        digest.update(bid.tobytes()); digest.update(ask.tobytes())
        if (seq + 1) % 256 == 0: recorder.flush()
    recorder.close()
    manifest = {
        'schema': 1, 'provenance': 'synthetic-normalized-parquet',
        'market': 'binance-spot', 'symbol': 'BTCUSDT', 'mode': 'replay', 'band': 'deep', 'seed': seed,
        'rows': rows, 'columns': count, 'timeWindowMs': seconds * 1000,
        'window': {'startNs': str(START_NS), 'endNs': str(START_NS + seconds * 1_000_000_000)},
        'interaction': {'stepMs': 1000/60, 'cycleMs': 20000, 'description': 'continuous deterministic pan and wheel cycles through production handlers'},
        'history': {'requiredSeconds': seconds, 'directory': 'recordings', 'files': fixture_files(output / 'recordings')},
        'content_sha256': digest.hexdigest(),
        'limitations': ['Synthetic normalized density/trade history, not real exchange data.',
                       'Production disk replay and renderer; raw L2/tape parsing absent. Live recording must be tested separately.'],
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=3600)
    parser.add_argument('--rows', type=int, default=4096)
    parser.add_argument('--seed', type=int, default=5750)
    args = parser.parse_args()
    if args.seconds <= 0 or args.rows < 64 or args.rows > 4096 or args.seconds > 3600:
        parser.error('seconds must be 1..3600 and rows 64..4096')
    manifest = generate(args.output, args.seconds, args.rows, args.seed)
    print(json.dumps({'columns': manifest['columns'], 'content_sha256': manifest['content_sha256']}))
