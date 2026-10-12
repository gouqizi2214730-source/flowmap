"""Replaceable native-geometry integrals; raw recordings remain authoritative.

64-source leaves are split at immutable-part/bounded-reader boundaries. Dyadic
parents contain child references, so rolling price maps never force a lossy
projection or an unbounded parent array. Queries stream one leaf at a time and
project each native component exactly once. No averaged display column is
ever input to this store. Preparation runs only on a background I/O worker.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import os
import threading
import uuid
from collections import Counter, OrderedDict
from pathlib import Path

import msgspec
import numpy as np

from flowmap_server.proto.events import BarColumn, EpochParams, HistoryRequest, Marker

logger = logging.getLogger(__name__)
SCHEMA = 1
ALGORITHM = "native-integral-dyadic-v1"
LEAF_COLUMNS = 64
METADATA_PAGE_SIZE = 1024
DERIVED_CACHE_BYTES = 2 * 1024 * 1024 * 1024


def geometry_fingerprint(params: EpochParams) -> str:
    # msgspec omits default fields by object/default representation; a value
    # reconstructed from Parquet may include 0.0 where a fresh Struct omits it.
    # Canonical explicit types make physically identical maps identical.
    physical = [
        params.rows,
        float(params.tick),
        int(params.tick_multiple),
        float(params.p0),
        int(params.scale_kind),
        int(params.dn_rows),
        int(params.core_rows),
        float(params.core_p0),
        float(params.core_step),
        float(params.lo_price),
        float(params.hi_price),
    ]
    return hashlib.sha256(msgspec.json.encode(physical)).hexdigest()


def integral_fingerprint(params: EpochParams) -> str:
    # Components may combine equal physical maps with different durations,
    # but source validity must also bind the duration used by q * dt.
    return hashlib.sha256(
        msgspec.json.encode([geometry_fingerprint(params), params.dt_ns])
    ).hexdigest()


def _atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def metadata_page(
    markers: list[Marker], req: HistoryRequest, coverage_generation: str = ""
) -> list[Marker]:
    """Opaque cursor binds metadata contents and the original range request.

    Legacy clients receive a conservative first page. New clients follow the
    continuation marker with the same range/clock. A stale cursor explicitly
    returns the first page with stale=true; clients discard previous pages.
    The page marker uses the existing cold Marker encoding inside history.
    """
    context = [
        coverage_generation,
        req.before_t,
        req.n_cols,
        req.start_col,
        req.end_col,
        req.stride,
    ]
    generation = hashlib.sha256(msgspec.json.encode([context, markers])).hexdigest()
    offset, stale = 0, False
    if req.metadata_cursor:
        try:
            decoded = json.loads(base64.urlsafe_b64decode(req.metadata_cursor.encode("ascii")))
            offset = decoded["offset"]
            if (
                decoded["generation"] != generation
                or not isinstance(offset, int)
                or not 0 <= offset <= len(markers)
            ):
                raise ValueError("stale metadata cursor")
        except (ValueError, KeyError, TypeError, UnicodeError):
            offset, stale = 0, True
    page = markers[offset : offset + METADATA_PAGE_SIZE]
    following = offset + len(page)
    complete = following >= len(markers)
    cursor = (
        None
        if complete
        else base64.urlsafe_b64encode(
            msgspec.json.encode({"generation": generation, "offset": following})
        ).decode("ascii")
    )
    if not req.metadata_cursor and complete:
        return page  # preserve byte/marker behavior for existing small pages
    return [
        *page,
        Marker(
            ts_ns=page[-1].ts_ns if page else 0,
            kind="history_metadata_page",
            text=json.dumps(
                {
                    "next_cursor": cursor,
                    "complete": complete,
                    "generation": generation,
                    "stale": stale,
                },
                separators=(",", ":"),
            ),
        ),
    ]


class PersistentPyramid:
    """One recording's derived sidecar, with bounded preparation and reads."""

    def __init__(
        self,
        root,
        market: str,
        symbol: str,
        recording_id: str | None,
        *,
        cache_directory: Path | None = None,
        byte_limit: int = DERIVED_CACHE_BYTES,
    ) -> None:
        self.root, self.market, self.symbol = root, market, symbol
        self.recording_id = recording_id or ""
        namespace = hashlib.sha256(self.recording_id.encode()).hexdigest()[:32]
        self.directory = (
            Path(cache_directory)
            if cache_directory is not None
            else root._symbol_dir(market, symbol) / ".flowmap-pyramid" / namespace
        )
        self.manifest = self.directory / "manifest.json"
        self.byte_limit = max(0, byte_limit)
        self._prepare_lock = threading.Lock()
        self._doc_lock = threading.Lock()
        self.stats = Counter()
        self._bad_fragments = set()
        self._indices_seeded = False
        self._scalar_by_name = {}
        self._generation_epoch_index = None
        self._doc = {
            "schema": SCHEMA,
            "algorithm": ALGORITHM,
            "recording_id": self.recording_id,
            "sources": {},
            "generation": "",
            "watermark": -1,
            "nodes": {},
            "aggregates": {},
        }
        try:
            doc = json.loads(self.manifest.read_bytes())
            if (
                doc["schema"] != SCHEMA
                or doc["algorithm"] != ALGORITHM
                or doc["recording_id"] != self.recording_id
                or not isinstance(doc["sources"], dict)
                or not isinstance(doc.get("aggregates", {}), dict)
                or not isinstance(doc.get("epoch_index", {}), dict)
                or not isinstance(doc.get("epoch_index", {}).get("mapping", {}), dict)
            ):
                raise ValueError("incompatible summary identity/schema")
            for name, source in doc["sources"].items():
                if (
                    not isinstance(name, str)
                    or Path(name).name != name
                    or "-columns-" not in name
                    or not name.endswith(".parquet")
                    or not isinstance(source, dict)
                    or not isinstance(source.get("geometry"), dict)
                    or not isinstance(source.get("fragments"), list)
                    or not isinstance(source.get("stamp"), list)
                    or len(source["stamp"]) != 2
                    or not all(type(i) is int and i >= 0 for i in source["stamp"])
                    or not isinstance(source.get("sha256"), str)
                    or len(source["sha256"]) != 64
                    or any(c not in "0123456789abcdef" for c in source["sha256"])
                    or not isinstance(source.get("integral_geometry", {}), dict)
                ):
                    raise ValueError("invalid summary source")
                for entry in source["fragments"]:
                    _validate_entry(entry)
                # Early schema-1 preparation saved the complete source epoch
                # index. Bind its original duration before any worker updates
                # that index; without it, the old integral is a safe miss.
                if "integral_geometry" not in source:
                    original = (
                        doc.get("epoch_index", {}).get("mapping", {}).get(self.recording_id, {})
                    )
                    source["integral_geometry"] = {
                        index: integral_fingerprint(
                            msgspec.convert(original[index], type=EpochParams)
                        )
                        for index in source["geometry"]
                        if index in original
                    }
            for stride, level in doc.get("aggregates", {}).items():
                if int(stride) < LEAF_COLUMNS or not isinstance(level, dict):
                    raise ValueError("invalid summary level")
                for entry in level.values():
                    _validate_entry(entry)
                    if not isinstance(entry.get("source_names"), list):
                        raise ValueError("invalid summary dependencies")
            self._doc = doc
            self._doc.setdefault("aggregates", {})
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            self.stats["manifest_misses"] += 1
        # A published query document never changes in place. Construction and
        # GC mutate only the private worker document; queries pin one version.
        self._query_doc = copy.deepcopy(self._doc)

    def snapshot(self):
        with self._doc_lock:
            return self._query_doc

    def parts(self, start=0, end=2**32 - 1, *, stop=None):
        from flowmap_server.core.overview import warm_part_index

        doc = self.snapshot()
        with self.root._column_time_lock:
            cache = getattr(self.root, "_overview_part_bounds", None)
            if cache is None:
                cache = self.root._overview_part_bounds = {}
            stored = doc.get("part_index", [])
            for item in stored if isinstance(stored, list) and not self._indices_seeded else []:
                try:
                    name, size, mtime, bounds = item
                    if (
                        not isinstance(name, str)
                        or Path(name).name != name
                        or "-columns-" not in name
                        or not name.endswith(".parquet")
                        or not all(type(i) is int and i >= 0 for i in [size, mtime])
                        or not isinstance(bounds, list)
                        or len(bounds) != 4
                        or not all(
                            type(i) is int and i >= 0 for i in [bounds[0], bounds[1], bounds[3]]
                        )
                        or not 0 <= bounds[0] <= bounds[1] < 2**32
                        or not isinstance(bounds[2], list)
                        or not all(isinstance(i, str) for i in bounds[2])
                    ):
                        continue
                    scalar = size, mtime, (bounds[0], bounds[1], tuple(bounds[2]), bounds[3])
                    path = None
                    if bounds[1] >= start and bounds[0] <= end:
                        path = self.root._symbol_dir(self.market, self.symbol) / name
                        cache.setdefault(path, scalar)
                    self._scalar_by_name[name] = path, scalar
                except (ValueError, TypeError, IndexError):
                    continue
            self._indices_seeded = True
        parts = PartSnapshot()
        parts.start, parts.end = start, end
        parts.index_by_name = self._scalar_by_name
        warm_part_index(self.root, self.market, self.symbol, stop=stop, parts=parts)
        return parts

    def save_scalar_indices(self, parts, epoch_maps):
        index = []
        with self.root._column_time_lock:
            cache = getattr(self.root, "_overview_part_bounds", {})
            for path, bounds in parts:
                cached = cache.get(path)
                if cached:
                    index.append([path.name, cached[0], cached[1], bounds])
        self._doc["part_index"] = index
        self._doc["epoch_index"] = {
            "parts": self._epoch_stamps(),
            "mapping": {
                identity: {str(i): msgspec.to_builtins(p) for i, p in maps.items()}
                for identity, maps in epoch_maps.items()
            },
        }

    def _epoch_stamps(self):
        directory = self.root._symbol_dir(self.market, self.symbol)
        stamps = []
        try:
            with os.scandir(directory) as scan:
                for entry in scan:
                    if (
                        "-epochs-" in entry.name
                        and entry.name.endswith(".parquet")
                        and entry.is_file(follow_symlinks=False)
                    ):
                        stat = entry.stat(follow_symlinks=False)
                        stamps.append([entry.name, stat.st_size, stat.st_mtime_ns])
        except OSError:
            pass
        return sorted(stamps)

    def epoch_maps(self, known_epochs, legacy_segments, doc=None, stamps=None):
        from flowmap_server.core.overview import _recording_epochs

        doc = self.snapshot() if doc is None else doc
        cached = doc.get("epoch_index", {})
        if not isinstance(cached, dict):
            cached = {}
        if cached.get("parts") == (self._epoch_stamps() if stamps is None else stamps):
            try:
                maps = {
                    identity: {
                        int(i): msgspec.convert(p, type=EpochParams) for i, p in mapping.items()
                    }
                    for identity, mapping in cached["mapping"].items()
                }
                for identity, mapping in maps.items():
                    for i, params in list(mapping.items()):
                        if (i in known_epochs and known_epochs[i] != params) or (
                            not identity and known_epochs.get(i) != params
                        ):
                            mapping.pop(i)
                return maps
            except (KeyError, TypeError, ValueError):
                pass
        return _recording_epochs(
            self.root._symbol_dir(self.market, self.symbol),
            self.recording_id,
            known_epochs,
            list(legacy_segments),
        )

    def _valid(
        self, path: Path, epochs: dict[int, EpochParams] | None = None, stamp=None, doc=None
    ):
        doc = self.snapshot() if doc is None else doc
        source = doc["sources"].get(path.name)
        if not isinstance(source, dict):
            return None
        try:
            if stamp is None:
                stat = path.stat()
                stamp = stat.st_size, stat.st_mtime_ns
            if source["stamp"] != list(stamp):
                return None
            if epochs is not None:
                for index, fingerprint in source["geometry"].items():
                    param = epochs.get(int(index))
                    if param is None or geometry_fingerprint(param) != fingerprint:
                        return None
                    integral = source.get("integral_geometry", {}).get(index)
                    if integral is None or integral != integral_fingerprint(param):
                        return None
            return source
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def generation(self, parts, start=0, end=2**32 - 1, known_epochs=None) -> str:
        # Fresh raw stamps, including absence, invalidate process-local display
        # caches as well. Derived files never extend authoritative coverage.
        stamps = []
        for path, bounds in parts:
            if (
                bounds is None
                or self.recording_id not in bounds[2]
                or bounds[1] < start
                or bounds[0] > end
            ):
                continue
            try:
                stamp = getattr(parts, "stamps", {}).get(path)
                if stamp is None:
                    stat = path.stat()
                    stamp = stat.st_size, stat.st_mtime_ns
                stamps.append((path.name, *stamp))
            except OSError:
                pass
        epoch_stamps = getattr(parts, "epoch_stamps", None)
        if epoch_stamps is None:
            epoch_stamps = self._epoch_stamps()
        with self._doc_lock:
            cached_index = self._generation_epoch_index
        if cached_index is None or cached_index[0] != epoch_stamps:
            mappings = self.epoch_maps(
                {} if self.recording_id else known_epochs or {}, [], stamps=epoch_stamps
            )
            epoch_ids = set(mappings.get(self.recording_id, {}))
            if not self.recording_id:
                epoch_ids.update(known_epochs or {})
            with self._doc_lock:
                self._generation_epoch_index = epoch_stamps, epoch_ids
        else:
            epoch_ids = cached_index[1]
        # A new live map that has never contributed to the recording cannot
        # invalidate an already complete native historical view. Existing
        # recorded maps bind physical semantics and duration separately.
        semantics = sorted(
            (epoch, integral_fingerprint(params))
            for epoch, params in (known_epochs or {}).items()
            if epoch in epoch_ids
        )
        return hashlib.sha256(
            msgspec.json.encode([self.recording_id, stamps, epoch_stamps, semantics])
        ).hexdigest()

    def representatives(self, parts, epochs, start, end, before_t, prepared=None):
        doc = self.snapshot()
        for path, _ in parts:
            source = (
                prepared
                if prepared is not None
                else self._valid(path, epochs, getattr(parts, "stamps", {}).get(path), doc)
            )
            if source is None:
                continue
            for fragment in source["fragments"]:
                if fragment["max_t"] >= before_t:
                    continue
                for low, high, epoch in fragment["runs"]:
                    if high < start or low > end:
                        continue
                    yield low, high, fragment["min_t"], epochs[epoch]

    def _publish(self) -> None:
        leaves = {}
        for source in self._doc["sources"].values():
            for fragment in source["fragments"]:
                group = str(fragment["low"] // LEAF_COLUMNS * LEAF_COLUMNS)
                leaves.setdefault(group, []).append(fragment["file"])
        nodes = {"64": leaves}
        stride = LEAF_COLUMNS
        while len(nodes[str(stride)]) > 1:
            parents = {}
            for group in nodes[str(stride)]:
                parent = str(int(group) // (stride * 2) * stride * 2)
                parents.setdefault(parent, []).append([stride, int(group)])
            stride *= 2
            nodes[str(stride)] = parents
        self._doc["nodes"] = nodes
        self._doc["watermark"] = max(
            (f["high"] for s in self._doc["sources"].values() for f in s["fragments"]), default=-1
        )
        fingerprints = [
            (name, s["stamp"], s["sha256"]) for name, s in sorted(self._doc["sources"].items())
        ]
        self._doc["generation"] = hashlib.sha256(msgspec.json.encode(fingerprints)).hexdigest()
        _atomic(self.manifest, msgspec.json.encode(self._doc))
        published = copy.deepcopy(self._doc)
        with self._doc_lock:
            self._query_doc = published

    def build_aggregates(self, *, stop=None):
        """Materialize bounded native components above the reference leaves.

        Parents add f64 native integrals with equal physical fingerprints.
        If independent maps would exceed 2 MiB, the reference hierarchy stays
        available and the query streams children instead. Parent source
        dependencies are validated against the authoritative raw parts.
        """
        stats = Counter()
        with self._prepare_lock:
            grouped = {}
            for name, source in self._doc["sources"].items():
                for entry in source["fragments"]:
                    grouped.setdefault(entry["group"], []).append((entry, [name]))
            aggregates = {}
            stride = LEAF_COLUMNS
            while grouped:
                next_groups = {}
                level = {}
                for group, children in sorted(grouped.items()):
                    if stop and stop():
                        stats["cancelled"] = 1
                        self._doc["aggregates"] = aggregates
                        self._publish()
                        return dict(stats)
                    key = str(group)
                    dependencies = sorted({name for _child, names in children for name in names})
                    source_hashes = {
                        name: self._doc["sources"][name]["sha256"] for name in dependencies
                    }
                    signature = hashlib.sha256(
                        msgspec.json.encode([stride, group, [c["sha256"] for c, _ in children]])
                    ).hexdigest()
                    cached = self._doc.get("aggregates", {}).get(str(stride), {}).get(key)
                    if (
                        cached is not None
                        and cached.get("children_hash") == signature
                        and (self.directory / cached["file"]).is_file()
                    ):
                        entry = {**cached, "source_hashes": source_hashes}
                    else:
                        components, spans = {}, []
                        first = last = None
                        high, low, buy, sell = -np.inf, np.inf, 0.0, 0.0
                        valid = True
                        for child, _names in children:
                            fragment = self._read_fragment(child)
                            if fragment is None:
                                valid = False
                                break
                            for comp in fragment["components"]:
                                fp = comp["fingerprint"]
                                if fp not in components:
                                    if (
                                        sum(
                                            c["bid"].nbytes + c["ask"].nbytes
                                            for c in components.values()
                                        )
                                        + comp["bid"].nbytes
                                        + comp["ask"].nbytes
                                        > 2 * 1024 * 1024
                                    ):
                                        valid = False
                                        break
                                    components[fp] = {
                                        **comp,
                                        "bid": comp["bid"].copy(),
                                        "ask": comp["ask"].copy(),
                                    }
                                else:
                                    components[fp]["weight"] += comp["weight"]
                                    components[fp]["bid"] += comp["bid"]
                                    components[fp]["ask"] += comp["ask"]
                            if not valid:
                                break
                            child_spans = fragment.get("spans") or _spans(fragment["samples"])
                            spans.extend(child_spans)
                            if first is None or fragment["first"].col_seq < first.col_seq:
                                first = fragment["first"]
                            if last is None or fragment["last"].col_seq > last.col_seq:
                                last = fragment["last"]
                            high, low = max(high, fragment["high"]), min(low, fragment["low"])
                            buy += fragment["buy"]
                            sell += fragment["sell"]
                        spans.sort(key=lambda span: span[0])
                        if (
                            not valid
                            or not spans
                            or any(a[1] >= b[0] for a, b in zip(spans, spans[1:]))
                        ):
                            continue  # duplicate/newest precedence uses exact leaves/raw
                        spans = _merge_spans(spans)
                        packed = [
                            {
                                **comp,
                                "params": msgspec.to_builtins(comp["params"]),
                                "bid": comp["bid"].astype("<f8").tobytes(),
                                "ask": comp["ask"].astype("<f8").tobytes(),
                            }
                            for comp in components.values()
                        ]
                        payload = msgspec.msgpack.encode(
                            {
                                "schema": SCHEMA,
                                "algorithm": ALGORITHM,
                                "recording_id": self.recording_id,
                                "components": packed,
                                "spans": spans,
                                "first": msgspec.to_builtins(first),
                                "last": msgspec.to_builtins(last),
                                "high": high,
                                "low": low,
                                "buy": buy,
                                "sell": sell,
                            }
                        )
                        checksum = hashlib.sha256(payload).hexdigest()
                        _atomic(self.directory / (checksum + ".bin"), payload)
                        entry = {
                            "file": checksum + ".bin",
                            "sha256": checksum,
                            "low": spans[0][0],
                            "high": spans[-1][1],
                            "min_t": first.t0_ns,
                            "max_t": last.t0_ns,
                            "children_hash": signature,
                            "source_names": dependencies,
                            "source_hashes": source_hashes,
                            "runs": [[s[0], s[1], 0] for s in spans],
                        }
                        stats["aggregate_writes"] += 1
                    level[key] = entry
                    next_groups.setdefault(group // (stride * 2) * stride * 2, []).append(
                        (entry, dependencies)
                    )
                if level:
                    aggregates[str(stride)] = level
                if len(next_groups) <= 1 and stride > self._doc["watermark"]:
                    break
                if not next_groups:
                    break
                grouped = next_groups
                stride *= 2
            self._doc["aggregates"] = aggregates
            self._publish()
        self.stats.update(stats)
        return dict(stats)

    @staticmethod
    def _cache_file(name: str) -> bool:
        """Names this module owns; never treat arbitrary files as garbage."""
        if len(name) == 68 and name.endswith(".bin"):
            return all(c in "0123456789abcdef" for c in name[:-4])
        if name.endswith(".tmp"):
            base, _, nonce = name[:-4].rpartition(".")
            return (
                len(nonce) == 32
                and all(c in "0123456789abcdef" for c in nonce)
                and (base == "manifest.json" or PersistentPyramid._cache_file(base))
            )
        return False

    def collect_cache(self, *, purge: bool = False):
        """Delete only this store's own derived files, with an independent cap.

        No recursive filesystem operation and no raw-source unlink occurs.
        A failed/partial GC only costs disk space; queries still require fresh
        source stamps. Unknown files, symlinks and directories are untouched.
        Purge deliberately evicts derived data; source coverage stays intact.
        """
        with self._prepare_lock:
            return self._collect_cache_locked(purge=purge)

    def _collect_cache_locked(self, *, purge=False):
        result = Counter(
            {"deleted_cache_files": 0, "deleted_cache_bytes": 0, "evicted_cache_parts": 0}
        )
        if not self.directory.is_dir():
            return dict(result)
        resolved = self.directory.resolve()
        raw_dir = self.root._symbol_dir(self.market, self.symbol).resolve()
        if resolved == raw_dir or self.directory.is_symlink():
            raise ValueError("derived GC requires its dedicated cache directory")
        for name, source in list(self._doc["sources"].items()):
            if purge or self._valid(raw_dir / name, doc=self._doc) is None:
                self._doc["sources"].pop(name, None)
                result["evicted_cache_parts"] += 1
        owned = {}
        for candidate in self.directory.iterdir():
            if (
                candidate.is_symlink()
                or not candidate.is_file()
                or candidate.parent.resolve() != resolved
                or not self._cache_file(candidate.name)
            ):
                continue
            try:
                owned[candidate.name] = (candidate, candidate.stat().st_size)
            except OSError:
                continue

        def references():
            return {
                f["file"] for source in self._doc["sources"].values() for f in source["fragments"]
            } | {
                f["file"]
                for level in self._doc.get("aggregates", {}).values()
                for f in level.values()
            }

        for stride, level in list(self._doc.get("aggregates", {}).items()):
            self._doc["aggregates"][stride] = {
                group: entry
                for group, entry in level.items()
                if all(name in self._doc["sources"] for name in entry["source_names"])
            }
        referenced = references()
        total = sum(size for name, (_path, size) in owned.items() if name in referenced)
        # Source parts are cache eviction units. Removing one derived entry
        # leaves exact raw fallback and never claims summaries as raw history.
        for name in sorted(self._doc["sources"]):
            if total <= self.byte_limit:
                break
            self._doc["sources"].pop(name)
            result["evicted_cache_parts"] += 1
            for level in self._doc.get("aggregates", {}).values():
                for group, entry in list(level.items()):
                    if name in entry["source_names"]:
                        level.pop(group)
            referenced = references()
            total = sum(size for filename, (_path, size) in owned.items() if filename in referenced)
        referenced = references()
        self._publish()  # atomic manifest no longer references deleted files
        for name, (candidate, size) in owned.items():
            if name in referenced:
                continue
            try:
                candidate.unlink()
            except OSError:
                continue  # another reader/preparation may hold the file
            result["deleted_cache_files"] += 1
            result["deleted_cache_bytes"] += size
        self.stats.update(result)
        return dict(result)

    def prepare(
        self,
        known_epochs: dict[int, EpochParams],
        legacy_segments=(),
        *,
        stop=None,
        start=0,
        end=2**32 - 1,
    ):
        """Resume after a crash; scan changed raw parts only, <=64 cols/batch.

        Cancellation checks bracket every batch/part. A published source entry
        is complete and checksummed; orphan .tmp/.bin files are harmless.
        """
        from flowmap_server.core.overview import recorded_batches

        stats = Counter(
            {"source_columns": 0, "max_source_batch": 0, "converted_parts": 0, "reused_parts": 0}
        )
        with self._prepare_lock:
            parts = self.parts(stop=stop)
            epochs = self.epoch_maps(known_epochs, legacy_segments, self._doc)
            self.save_scalar_indices(parts, epochs)
            mapping = epochs.get(self.recording_id, {})
            present = {path.name for path, _ in parts}
            self._doc["sources"] = {
                name: source for name, source in self._doc["sources"].items() if name in present
            }
            changes = 0
            for path, bounds in parts:
                if stop and stop():
                    stats["cancelled"] = 1
                    break
                if (
                    bounds is None
                    or self.recording_id not in bounds[2]
                    or bounds[1] < start
                    or bounds[0] > end
                ):
                    continue
                valid = self._valid(path, mapping, doc=self._doc)
                wanted_range = [max(start, bounds[0]), min(end, bounds[1])]
                if (
                    valid is not None
                    and valid.get("prepared_range", [bounds[0], bounds[1]])[0] <= wanted_range[0]
                    and valid.get("prepared_range", [bounds[0], bounds[1]])[1] >= wanted_range[1]
                    and all(
                        (self.directory / f["file"]).is_file()
                        and f["file"] not in self._bad_fragments
                        for f in valid["fragments"]
                    )
                ):
                    stats["reused_parts"] += 1
                    continue
                before = path.stat()
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                fragments, geometry, integrals = [], {}, {}
                batches = recorded_batches(
                    self.root,
                    self.market,
                    self.symbol,
                    [(bounds[0], bounds[1])],
                    self.recording_id,
                    mapping,
                    list(legacy_segments),
                    [(path, bounds)],
                    epoch_maps=epochs,
                )
                for batch, maps in batches:
                    if stop and stop():
                        stats["cancelled"] = 1
                        break
                    stats["source_columns"] += len(batch)
                    stats["max_source_batch"] = max(stats["max_source_batch"], len(batch))
                    grouped = {}
                    for col in batch:
                        if not start <= col.col_seq <= end:
                            continue
                        grouped.setdefault(col.col_seq // LEAF_COLUMNS, []).append(col)
                    for group, cols in grouped.items():
                        cols.sort(key=lambda c: c.col_seq)
                        components, runs, samples = {}, [], []
                        for col in cols:
                            params = maps[col.epoch]
                            fingerprint = geometry_fingerprint(params)
                            geometry[str(col.epoch)] = fingerprint
                            integrals[str(col.epoch)] = integral_fingerprint(params)
                            item = components.setdefault(
                                fingerprint,
                                {
                                    "params": msgspec.to_builtins(params),
                                    "fingerprint": fingerprint,
                                    "weight": 0,
                                    "bid": np.zeros(params.rows, np.float64),
                                    "ask": np.zeros(params.rows, np.float64),
                                },
                            )
                            duration = max(1, params.dt_ns)
                            item["weight"] += duration
                            item["bid"] += col.bid.astype(np.float64) * duration
                            item["ask"] += col.ask.astype(np.float64) * duration
                            samples.append([col.col_seq, col.t0_ns, duration])
                            if runs and runs[-1][1] + 1 == col.col_seq and runs[-1][2] == col.epoch:
                                runs[-1][1] = col.col_seq
                            else:
                                runs.append([col.col_seq, col.col_seq, col.epoch])
                        packed = []
                        for item in components.values():
                            packed.append(
                                {
                                    **item,
                                    "bid": item["bid"].astype("<f8").tobytes(),
                                    "ask": item["ask"].astype("<f8").tobytes(),
                                }
                            )
                        payload = msgspec.msgpack.encode(
                            {
                                "schema": SCHEMA,
                                "algorithm": ALGORITHM,
                                "recording_id": self.recording_id,
                                "components": packed,
                                "samples": samples,
                                "first": msgspec.to_builtins(cols[0].bar),
                                "last": msgspec.to_builtins(cols[-1].bar),
                                "high": max(c.bar.h for c in cols),
                                "low": min(c.bar.l for c in cols),
                                "buy": sum(c.bar.vol_buy for c in cols),
                                "sell": sum(c.bar.vol_sell for c in cols),
                            }
                        )
                        checksum = hashlib.sha256(payload).hexdigest()
                        filename = checksum + ".bin"
                        _atomic(self.directory / filename, payload)
                        self._bad_fragments.discard(filename)
                        fragments.append(
                            {
                                "file": filename,
                                "sha256": checksum,
                                "low": cols[0].col_seq,
                                "high": cols[-1].col_seq,
                                "min_t": min(c.t0_ns for c in cols),
                                "max_t": max(c.t0_ns for c in cols),
                                "runs": runs,
                                "group": group * LEAF_COLUMNS,
                            }
                        )
                if stats["cancelled"]:
                    break
                after = path.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    continue  # a concurrently replaced part is never published
                self._doc["sources"][path.name] = {
                    "stamp": [after.st_size, after.st_mtime_ns],
                    "sha256": digest.hexdigest(),
                    "geometry": geometry,
                    "integral_geometry": integrals,
                    "fragments": fragments,
                    "prepared_range": wanted_range,
                }
                changes += 1
                stats["converted_parts"] += 1
                if changes % 256 == 0:
                    self._publish()
            if changes or self.manifest.is_file():
                self._publish()
                stats.update(self._collect_cache_locked())
        self.stats.update(stats)
        if not stats["cancelled"]:
            stats.update(self.build_aggregates(stop=stop))
            with self._prepare_lock:
                stats.update(self._collect_cache_locked())
        return dict(stats)

    def _read_fragment(self, entry):
        try:
            name = entry["file"]
            if (
                len(name) != 68
                or not name.endswith(".bin")
                or any(c not in "0123456789abcdef" for c in name[:-4])
            ):
                raise ValueError("invalid fragment path")
            payload = (self.directory / name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise ValueError("summary checksum mismatch")
            fragment = msgspec.msgpack.decode(payload)
            if (
                fragment["schema"] != SCHEMA
                or fragment["algorithm"] != ALGORITHM
                or fragment["recording_id"] != self.recording_id
            ):
                raise ValueError("summary schema/identity mismatch")
            for comp in fragment["components"]:
                params = msgspec.convert(comp["params"], type=EpochParams)
                if geometry_fingerprint(params) != comp["fingerprint"]:
                    raise ValueError("summary geometry mismatch")
                comp["params"] = params
                for side in ("bid", "ask"):
                    values = np.frombuffer(comp[side], dtype="<f8")
                    if (
                        len(values) != params.rows
                        or np.any(~np.isfinite(values))
                        or np.any(values < 0)
                    ):
                        raise ValueError("invalid native integrals")
                    comp[side] = values
            fragment["first"] = msgspec.convert(fragment["first"], type=BarColumn)
            fragment["last"] = msgspec.convert(fragment["last"], type=BarColumn)
            self.stats["summary_reads"] += 1
            return fragment
        except (OSError, ValueError, KeyError, TypeError, msgspec.DecodeError):
            self.stats["corrupt_fragments"] += 1
            self._bad_fragments.add(entry.get("file"))
            logger.warning("unusable persistent summary; raw history remains authoritative")
            return None

    def add_available(self, builder, epochs, parts=None):
        parts = self.parts() if parts is None else parts
        doc = self.snapshot()
        paths = {path.name: path for path, _ in parts}
        overlapping = {}
        for path, bounds in parts:
            if (
                bounds is None
                or self.recording_id not in bounds[2]
                or bounds[1] < builder.start
                or bounds[0] > builder.end
            ):
                continue
            first = max(builder.start, bounds[0]) // builder.stride * builder.stride
            for group in range(first, min(builder.end, bounds[1]) + 1, builder.stride):
                overlapping.setdefault(group, []).append((path.name, bounds[0], bounds[1]))
        validity = {}

        def valid(name):
            if name not in validity:
                validity[name] = (
                    self._valid(
                        paths[name], epochs, getattr(parts, "stamps", {}).get(paths[name]), doc
                    )
                    if name in paths
                    else None
                )
            return validity[name]

        for level_stride in sorted((int(s) for s in doc.get("aggregates", {})), reverse=True):
            if level_stride > builder.stride:
                continue
            for entry in doc["aggregates"][str(level_stride)].values():
                if (
                    entry["low"] < builder.start
                    or entry["high"] > builder.end
                    or entry["max_t"] >= builder.before_t
                    or entry["low"] // builder.stride != entry["high"] // builder.stride
                ):
                    continue
                group = entry["low"] // builder.stride * builder.stride
                if group in builder.ready:
                    continue
                coverage = builder.bins[group].coverage.runs if group in builder.bins else []
                if any(
                    low <= last and high >= first
                    for low, high in coverage
                    for first, last, _ in entry["runs"]
                ):
                    continue
                if any(
                    valid(name) is None
                    or entry.get("source_hashes", {}).get(name) != valid(name)["sha256"]
                    for name in entry["source_names"]
                ):
                    continue
                # A new raw part which overlaps this old aggregate wins. Its
                # absence from the dependency list forces exact fallback.
                dependencies = set(entry["source_names"])
                if any(
                    name not in dependencies and low <= entry["high"] and high >= entry["low"]
                    for name, low, high in overlapping.get(group, [])
                ):
                    continue
                fragment = self._read_fragment(entry)
                if fragment is not None:
                    builder.add_integrals(fragment)
        blocked = []
        # Reverse-name order mirrors recorded_batches: newest source wins.
        for path, bounds in parts:
            if bounds is not None and (bounds[1] < builder.start or bounds[0] > builder.end):
                continue
            source = valid(path.name)
            if source is None:
                if bounds is not None and self.recording_id in bounds[2]:
                    blocked.append((bounds[0], bounds[1]))
                continue
            for entry in source["fragments"]:
                if (
                    entry["low"] < builder.start
                    or entry["high"] > builder.end
                    or entry["max_t"] >= builder.before_t
                    or entry["low"] // builder.stride != entry["high"] // builder.stride
                ):
                    blocked.extend((first, last) for first, last, _ in entry["runs"])
                    continue
                group = entry["low"] // builder.stride * builder.stride
                if group in builder.ready:
                    continue
                coverage = builder.bins[group].coverage.runs if group in builder.bins else []
                if any(
                    low <= last and high >= first
                    for low, high in coverage
                    for first, last, _ in entry["runs"]
                ):
                    continue  # partial duplicate: exact raw reader fills it
                if any(
                    low <= last and high >= first
                    for low, high in blocked
                    for first, last, _ in entry["runs"]
                ):
                    continue  # a newer unprepared source must win via raw IO
                fragment = self._read_fragment(entry)
                if fragment is not None:
                    builder.add_integrals(fragment)
                else:
                    blocked.extend((first, last) for first, last, _ in entry["runs"])


def pyramid_for(root, market, symbol, recording_id):
    key = market, symbol, recording_id or ""
    with root._column_time_lock:
        stores = getattr(root, "_persistent_pyramids", None)
        if stores is None:
            stores = root._persistent_pyramids = OrderedDict()
        existing = stores.get(key)
    created = (
        existing if existing is not None else PersistentPyramid(root, market, symbol, recording_id)
    )
    with root._column_time_lock:
        stores.setdefault(key, created)
        if isinstance(stores, OrderedDict):
            stores.move_to_end(key)
            while len(stores) > 16:
                stores.popitem(last=False)
        return stores[key]


def collect_retained_caches(root, directories):
    """Reclaim inactive recording sidecars after intentional raw retention.

    Only the recording-ID-derived namespace and known cache filenames are
    eligible. Existing workers finish first; their own post-prepare GC handles
    a skipped busy store. Unknown directories and symlinks are preserved.
    """
    for directory in set(directories):
        cache_root = directory / ".flowmap-pyramid"
        if cache_root.is_symlink() or not cache_root.is_dir():
            continue
        for namespace in cache_root.iterdir():
            if (
                namespace.is_symlink()
                or not namespace.is_dir()
                or len(namespace.name) != 32
                or any(c not in "0123456789abcdef" for c in namespace.name)
            ):
                continue
            try:
                doc = json.loads((namespace / "manifest.json").read_bytes())
                identity = doc["recording_id"]
                if (
                    not isinstance(identity, str)
                    or hashlib.sha256(identity.encode()).hexdigest()[:32] != namespace.name
                ):
                    continue
                market, symbol = directory.parent.name, directory.name
                store = getattr(root, "_persistent_pyramids", {}).get((market, symbol, identity))
                if store is None:
                    store = PersistentPyramid(root, market, symbol, identity)
                if store._prepare_lock.acquire(blocking=False):
                    try:
                        store._collect_cache_locked()
                    finally:
                        store._prepare_lock.release()
            except (OSError, ValueError, KeyError, TypeError):
                logger.warning("optional derived retention cleanup failed for %s", namespace)


def _validate_entry(entry):
    if (
        not isinstance(entry, dict)
        or not isinstance(entry.get("file"), str)
        or not PersistentPyramid._cache_file(entry["file"])
        or not entry["file"].endswith(".bin")
        or entry.get("sha256") != entry["file"][:-4]
        or not all(type(entry.get(key)) is int for key in ("low", "high", "min_t", "max_t"))
        or not 0 <= entry["low"] <= entry["high"] < 2**32
        or entry["min_t"] > entry["max_t"]
        or not isinstance(entry.get("runs"), list)
        or not all(
            isinstance(run, list)
            and len(run) == 3
            and all(type(i) is int for i in run)
            and entry["low"] <= run[0] <= run[1] <= entry["high"]
            for run in entry["runs"]
        )
    ):
        raise ValueError("invalid summary fragment index")


class PartSnapshot(list):
    """Fresh per-request enumeration attributes, never a persisted stat cache."""

    def __init__(self):
        super().__init__()
        self.stamps = {}
        self.epoch_stamps = []


def _spans(samples):
    return _merge_spans([[seq, seq, time, time, duration] for seq, time, duration in samples])


def _merge_spans(spans):
    result = []
    for low, high, first, last, duration in spans:
        if (
            result
            and low == result[-1][1] + 1
            and duration == result[-1][4]
            and first == result[-1][3] + duration
        ):
            result[-1][1], result[-1][3] = high, last
        else:
            result.append([low, high, first, last, duration])
    return result
