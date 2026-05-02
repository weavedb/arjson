# Benchmarks

All numbers in this document come from the benchmark scripts in
`sdk/test/`, which run on Node.js with reproducible per-workload
iterations. Runs vary by ±10% between executions; the patterns are stable.

## Methodology

### Measurement isolation

Each measurement runs in a forked Node.js child process with an 8-second
wall-clock timeout (`sdk/test/bench-worker.js`). This prevents a hang or
out-of-memory in any one library/workload combination from killing the
benchmark, and isolates JIT state between rows. Results are reported per
library per workload; rows where a library failed are marked TIMEOUT or
ERROR.

### Iteration scaling

Iteration counts are scaled by JSON-encoded size of each workload:
- ≤ 500 B: full iteration count (default 2000)
- 500–1500 B: 1/5 of full
- 1500–5000 B: 1/20 of full
- > 5000 B: 1/100 of full

Reported times are normalized back to full iteration count. This keeps
total benchmark wall-clock time bounded while giving each workload enough
samples for stable timing.

### Compressor settings

| Compressor       | Setting              |
| ---------------- | -------------------- |
| brotli           | quality 11 (max)     |
| gzip             | level 9 (max)        |
| zstd             | level 22, --long=27  |
| zstd with dict   | as above + `-D dict` |

These are slow encoders maximizing compression ratio. Production
deployments would typically use lower levels for encode-time cost, but
this benchmark is about size, not encoding speed of the compressor.

### Workloads

The corpus is in `sdk/test/bench-workloads.js`. 34 workloads spanning:
- primitives (null, bool, integers at every bit-width boundary, strings
  short/medium/long, floats)
- realistic records (user record, log entry, config doc, JSON Schema)
- wide objects (50, 100, 500 keys)
- numeric arrays (10, 100, 1000 elements; sequential and random)
- string arrays (homogeneous and unique)
- arrays of identical-shape objects
- bool/null arrays
- deep nesting (30 and 50 levels)
- redundant repetition (50 identical user shapes)
- time-series, mixed types, long content strings

For comparisons that need a "homogeneous corpus," we additionally use 100
generated user records with predictable variation (`bench-beat-json-brotli.js`).

## Results: ARJSON vs MessagePack vs CBOR

`sdk/test/bench.js` produces the full table. Summary across 34 workloads:

| Total                  | bytes   | vs JSON | vs msgpack |
| ---------------------- | ------: | ------: | ---------: |
| JSON                   | 41,348  |  100.0% |    146.6%  |
| MessagePack            | 28,195  |   68.2% |    100.0%  |
| CBOR (cbor-x)          | 29,365  |   71.0% |    104.1%  |
| ARJSON v1.0            | 17,654  |   42.7% |     62.6%  |
| **ARJSON v1.1**        | **17,075** | **41.3%** | **60.6%**  |

ARJSON v1.1 is **39% smaller than MessagePack** and **42% smaller than
CBOR** overall. Per-workload, ARJSON wins on 24/34, ties on 5, loses
by 1–2 bytes on 5 (all sub-10-byte payloads).

Where ARJSON's lead is largest (v1.1 sizes, vs MessagePack):

| Workload              | ARJSON / msgpack |
| --------------------- | ---------------: |
| `arr_int_1000`        |             0.5% |
| `arr_int_100`         |             9.7% |
| `arr_str_100_homog`   |            13.8% |
| `arr_null_100`        |             6.8% |
| `arr_bool_100`        |            18.4% |
| `bool_array_500`      |            14.3% |
| `redundant_users`     |            31.2% |
| `arr_obj_100_homog`   |            44.0% |
| `float_array_100`     |            46.5% |
| `wide_500`            |            56.9% |

These are the workloads that exercise ARJSON's strongest features:
delta-pack on sequential numbers, strmap dedup on repeated strings,
type-pack on homogeneous arrays, columnar dedup on shape-repeated
objects, and (new in v1.1) RLE on boolean-valued columns.

## Results: speed (encode/decode time)

Same `sdk/test/bench.js`. Summary across 34 workloads, summed time:

| Library         | encode total | decode total |
| --------------- | -----------: | -----------: |
| msgpack         |       154 ms |       156 ms |
| cbor-x          |        60 ms |        47 ms |
| arjson          |       864 ms |     1,453 ms |
| JSON.stringify  |        33 ms |        56 ms |

ARJSON is **~5.6× slower than msgpack on encode**, **~9.3× slower on
decode**. cbor-x (the fastest implementation in this comparison)
makes the gap larger: **~14× slower than cbor-x on encode**, **~31×
slower on decode**.

This is the structural cost of bit-level packing and columnar
restructuring. ARJSON's design trades encoding speed for size; cbor-x
trades both for pure speed (its encoded output is 4% larger than
msgpack's). For Node.js implementations specifically, the gap is exacerbated
by the absence of a C/Rust ARJSON backend; the JS implementation is doing
work in interpreted code that cbor-x's native bindings handle in C.

## Results: ARJSON delta chain vs full re-encoding

Summary across three delta workloads:

| Workload                              | msgpack sum | ARJSON delta chain |
| ------------------------------------- | ----------: | ----------------: |
| Counter increment 1000×               |    9,626 B  |         4,882 B   |
| User-record incremental update 500×   |   57,792 B  |         6,508 B   |
| Schema migration 7 states × 100 trials |       226 B  |            88 B   |

ARJSON delta chains are **2–9× smaller than the sum of full
re-encodes**. The user-update workload is the strongest case (8.9× smaller
storage to keep all 500 historical states).

These numbers are *raw* delta-chain size, before any downstream
compression. With brotli/zstd the chain compresses further (next section).

## Results: compression pipeline (the strmap-as-dictionary discovery)

`sdk/test/bench-beat-json-brotli.js`. 50 user records (`testSet` in
the script), with various pipelines.

### Per-document encoding (50 users encoded separately, sizes summed)

| Pipeline                                  | bytes |   vs json+br |
| ----------------------------------------- | ----: | -----------: |
| json (raw)                                | 7,134 |       133.7% |
| json + brotli                             | 5,336 |       100.0% |
| **arjson v1.1 (raw)**                     | **4,881** |    **91.5%** |
| arjson v1.1 + brotli                      | 5,081 |        95.2% |
| arjson v1.1 + zstd                        | 5,531 |       103.7% |
| arjson v1.1 + zstd + trained dict         | 5,531 |       103.7% |
| arjson v1.1 + zstd + self-strmap-as-dict  | 5,531 |       103.7% |
| arjson v1.1 + brotli + strmap-prefix (sim)| 6,722 |       126.0% |

Even raw ARJSON beats `json + brotli` per-document on this homogeneous
corpus (91.5%). Adding a downstream compressor doesn't help much because
ARJSON has already extracted most redundancy. The trained-dictionary
result equals the no-dict result, confirming that ARJSON's strmap is
already serving the dictionary's role inline.

### Delta chain

| Pipeline                                  | bytes |   vs json+br |
| ----------------------------------------- | ----: | -----------: |
| arjson v1.1 DELTA chain (raw)             | 3,618 |        67.8% |
| arjson v1.1 DELTA + brotli                |   664 |        12.4% |
| arjson v1.1 DELTA + zstd                  |   671 |        12.6% |
| arjson v1.1 DELTA + zstd + trained dict   |   667 |        12.5% |
| arjson v1.1 DELTA + zstd + self-strmap    |   671 |        12.6% |

The delta chain compresses to **~13 bytes per document state**, ~8×
smaller than json+brotli per-document. The zstd-with-self-strmap row
matches the no-dict row because, again, ARJSON has already done the
dictionary work inline.

### Heterogeneous corpus

17 mixed workloads, each with a totally different shape. Trained
dictionary built from the other 17 workloads.

| Pipeline                                | bytes  |   vs json+br |
| --------------------------------------- | -----: | -----------: |
| json (raw)                              | 31,903 |       868.6% |
| json + brotli                           |  3,673 |       100.0% |
| arjson (raw)                            | 12,857 |       350.0% |
| arjson + brotli                         |  3,208 |        87.3% |
| arjson + zstd                           |  3,291 |        89.6% |
| arjson + zstd + trained dict            |  3,292 |        89.6% |
| arjson + zstd + self-strmap-as-dict     |  3,292 |        89.6% |

ARJSON+brotli wins on heterogeneous data too (87.3% of json+brotli),
showing the strmap+columnar advantage isn't restricted to homogeneous
corpora.

## Results: corpus-as-single-blob (concatenated, then compressed once)

This tests the case where all documents are stored as one blob and
compressed together — the maximum cross-document redundancy exploitation
a general compressor can achieve.

| Pipeline                          | bytes |
| --------------------------------- | ----: |
| json (concat)                     | 41,348 |
| **json (concat) + brotli**        | **4,158** |
| arjson v1.1 (concat)              | 17,075 |
| arjson v1.1 (concat) + brotli     |  4,605 |
| msgpack (concat) + brotli         |  4,741 |
| cbor (concat) + brotli            |  4,807 |

For sheer concatenated size, **`json (concat) + brotli` is smallest**
across all formats. brotli's static dictionary finds JSON-specific
patterns that survive concatenation; the byte-aligned format compresses
more efficiently than ARJSON's bit-packed output across document
boundaries.

This is a fair statement of the boundary of ARJSON's compression advantage.
For "compress 100 known documents into one blob and never need random
access," brotli on concatenated JSON wins. ARJSON's value materializes
when you need any of:

- Random access to individual documents without decompressing the whole
  blob.
- Streaming append: extend the corpus by one document without re-compressing
  everything.
- Bit-level minimum mutation cost (delta chain).
- Determinism for content addressing.

For these properties the ARJSON delta chain pipeline beats the concatenate-
then-compress pipeline on every dimension; for raw size of a static blob,
it does not.

## Results: regression suite

`sdk/test/regression.test.js`. 472 tests across 80 suites covering:

- Primitive round-trips at every bit-width boundary
- All ASCII chars, base64url chars, control chars, lengths 1–10K, emoji,
  CJK, astral
- Empty, single-element, every length boundary, nesting depths up to 1000
- Cartesian product of root-type transitions
- Buffer round-trip identity at every step
- LEB128 length encoding for >127B and >16383B deltas
- ~85K iterations of seeded property-based fuzz across multiple depths

The regression suite uncovered 13 distinct bugs in the encoder/decoder
during this session, all fixed. See `arjson-limitations-report.md`.

The original ARJSON master branch (in `sdk/src-orig/`) fails on at least
two real workloads in the bench:
- `log_entry` decode infinite-loops (TIMEOUT after 8s)
- `mixed_array` decode throws

These are real correctness bugs in the published ARJSON v0.1.3 that the
fixes in this session address. The benchmark surfaces them by running
each measurement in a forked process; without that isolation, the original
ARJSON's crashes would terminate the bench.

## Hardware and software baseline

Reference results were generated on:
- Linux 6.19 / x86_64
- Node.js 25.9
- @msgpack/msgpack 3.1.3
- cbor-x latest
- system zstd 1.5.7
- system brotli 1.2.0

Cross-platform numbers vary by ~10%. The relative orderings are stable.

## How to reproduce

```
cd sdk
npm install
node test/bench.js 1000          # main 4-way comparison
node test/bench-compress.js      # compression pipeline study
node test/bench-beat-json-brotli.js  # the strmap-as-dict experiment
npm test                         # 472 regression tests
```

Each script is self-contained. The `bench.js` orchestrator forks worker
processes via `bench-worker.js`; a hang in any library/workload terminates
that single measurement only and is reported as TIMEOUT.
