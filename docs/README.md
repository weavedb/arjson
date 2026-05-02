# ARJSON technical documentation

These documents describe ARJSON's design, the architectural discovery that
makes its compression pipeline self-contained, and how it compares to existing
binary serialization formats.

## Contents

- [strmap-as-dictionary.md](./strmap-as-dictionary.md) —
  The central discovery. ARJSON's encoder builds its symbol table inline and
  deterministically; that table can be exported as a shared dictionary for any
  downstream compressor with no separate training step. This is what lets
  `arjson + zstd` beat `json + brotli` on every workload class measured.

- [delta-chains.md](./delta-chains.md) —
  Why ARJSON exists. Append-only delta chains for content-addressable
  storage, time-travel state reconstruction, and decentralized databases.
  The format's actual unique contribution.

- [format.md](./format.md) —
  Wire-format reference. Bit-level layout, column ordering, encoding choices.

- [benchmarks.md](./benchmarks.md) —
  Methodology and results. Side-by-side measurements vs MessagePack, CBOR,
  JSON, and the same formats with brotli/gzip/zstd applied.

- [comparison.md](./comparison.md) —
  ARJSON's position in the binary-serialization landscape. What competes,
  what doesn't, and the gap ARJSON occupies.

- [fuzz-testing.md](./fuzz-testing.md) —
  Property-based fuzz testing methodology, the bugs it surfaced, and how
  to run the bounded (`npm test`) and long-running (`npm run fuzz`)
  fuzzers.

- [test-architecture.md](./test-architecture.md) —
  How the 1,721-test suite is structured for optimization safety. Every
  observable behavior is pinned down so encoder/decoder optimizations
  are caught immediately if they break anything.

## Quick statement of contribution

ARJSON is a self-describing, schemaless, deterministic binary encoding for
JSON, designed for permanent append-only storage of structured documents.

Three properties together are not present in any existing format:

1. **Bit-level packing** of small values (variable-width integer schemes,
   single-byte primitives, type/key/value column layouts that share bits
   across slot boundaries).

2. **Inline deterministic symbol table** ("strmap") built during the single
   forward encoding pass, usable downstream as a shared dictionary without
   separate training or distribution.

3. **Append-only delta chain** of bit-level minimum updates, where each
   delta is content-addressable and the full state at any point in history
   is reconstructible by replaying the chain.

A fourth, narrower, but architecturally important property:

4. **Forward-compatible extension gate.** The byte-stream prefix `00000`
   is structurally unreachable from any valid input under the v1 encoder
   (it would require encoding a non-empty structure with zero values, a
   contradiction). The reservation costs zero bits in normal encodings
   and gives v2 decoders an unambiguous first-byte signal for extension
   payloads. See [format.md](./format.md) for details.

The combination targets workloads where per-mutation byte cost dominates
total storage, encoding determinism matters for hashing/consensus, and the
storage system requires history reconstruction. Decentralized databases,
append-only logs, and Merkle-addressed state machines are the canonical
fit.

## Headline measurement

50 user records (the homogeneous-corpus benchmark in
[benchmarks.md](./benchmarks.md)):

| Pipeline                                      | bytes |
| --------------------------------------------- | ----: |
| 50 documents × `json + brotli` (per document) | 5,336 |
| 50 documents × `arjson + brotli`              | 5,100 |
| ARJSON delta chain (raw)                      | 3,585 |
| **ARJSON delta chain + zstd**                 | **684** |

ARJSON+zstd on the delta chain is **7.8× smaller than json+brotli per-document**,
preserves every historical state, and is byte-for-byte deterministic across
encoders that pin the implementation version.
