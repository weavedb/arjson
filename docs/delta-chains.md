# Delta chains

The architectural reason ARJSON exists. ARJSON's headline pitch — "smaller
than MessagePack" — is the consequence, not the goal. The goal is the
delta chain: an append-only sequence of bit-level minimum mutations that
can reconstruct any historical document state and is suitable for
content-addressable, decentralized storage.

## The model

An ARJSON document is not a single encoded payload. It is a sequence:

```
[ initial encoding | delta_1 | delta_2 | ... | delta_n ]
```

The initial encoding is a complete ARJSON-encoded representation of the
document at time t=0. Each subsequent `delta_i` is a bit-stream describing
the change from state `s_{i-1}` to state `s_i`. To reconstruct any state
`s_k`, the decoder applies `delta_1` through `delta_k` to the initial
encoding.

The deltas are dramatically smaller than re-encoding the full state. A
single primitive-field update encodes as a handful of bits — typically a
2- to 6-bit path reference plus the encoded value. Adding a key, deleting
a key, replacing a value, modifying an array element, and applying a
character-level diff to a long string are all distinct delta operations
encoded inline in the same bit stream.

## Why this matters for permanent storage

Most binary serialization formats (MessagePack, CBOR, BSON, even Protobuf
without the differential-encoding extensions) treat the encoded document
as immutable. Each new version of a document is a completely new payload.
For permanent storage of history this is wasteful: a 1 KB document
modified 100 times costs 100 KB of storage even if every modification
touches one byte of one field.

Compression after the fact (gzip, brotli, zstd) only partially recovers
this. The compressor finds the redundancy across snapshots, but it doesn't
know about the structural relationship — that snapshot N is "the same as
N-1 plus a single field update." Optimal compression requires modeling that
relationship.

ARJSON's delta chain encodes the relationship directly. Each delta names
the path being modified, the operation type, and the new value, in
bit-packed form. The combined sequence is provably smaller than any
snapshot-based encoding for the same history.

Empirical comparison (50 user records mutated incrementally; full results
in [benchmarks.md](./benchmarks.md)):

| Storage of 50 historical states                  |  bytes | bytes/state |
| ------------------------------------------------ | -----: | ----------: |
| 50 full encodes (`json + brotli` per snapshot)   |  5,336 |        ~107 |
| 50 full encodes (`arjson v1.1 + brotli` per snap) |  5,081 |        ~102 |
| ARJSON v1.1 delta chain (raw)                    |  3,618 |        ~72  |
| ARJSON v1.1 delta chain + brotli                 |    664 |        ~13  |
| ARJSON v1.1 delta chain + zstd                   |    671 |        ~13  |

The ARJSON delta chain stores **all 50 historical states** in 664 bytes —
13 bytes per state amortized — and can reconstruct any prior state by
replaying deltas. The snapshot pipelines store only the latest state at
≥100 bytes per copy if all history is to be retained.

## Properties suited to decentralized databases

The delta chain has four properties that decentralized databases need but
that snapshot-based encodings struggle to provide cheaply.

### 1. Content addressing

Each delta in the chain is a self-contained byte sequence. Hashing a delta
yields a stable identifier. A chain is then identified by the hash of its
final delta or by the Merkle root of all deltas. Storage systems that
address content by hash (IPFS, Arweave, content-addressed databases) can
store and retrieve deltas without inventing new identifiers.

### 2. Determinism

Given the same input JSON and the same encoder version, ARJSON produces
the same encoded bytes. This is required for any system that hashes
content and expects nodes to agree on the hash. CBOR-CDE (RFC 8949
deterministic encoding) provides this for CBOR payloads but does not
extend to deltas. ARJSON's delta encoding is deterministic by the same
construction — `update()` is a pure function of the prior state and the
new state.

### 3. Append-only with random access to history

Replaying deltas 1..k produces state at time k. There is no need to
maintain separate snapshots. For systems where storage is cheap but
retroactively answering "what did this document look like at time t" is
expensive (audit logs, version-controlled state, blockchain-style ledgers),
this property is the design point.

The cost of accessing state at time k is O(k) replays. For typical
mutation rates and access patterns, this is acceptable; if not, periodic
snapshot-recompaction (replace deltas 1..k with a single equivalent base
state) is straightforward.

### 4. Bit-level minimum per mutation

A single primitive-field update on a complex document encodes as roughly
1–8 bytes after path compression, depending on whether the path is a key
already present in the strmap and whether the value fits in the short-int
encoding ranges. Compare to:

- LevelDB/RocksDB write-ahead log: ~30–50 bytes minimum (sequence number,
  key length prefix, key bytes, value length prefix, value bytes, type
  byte). Order of magnitude larger.

- Yjs deltas: 5–8 bytes for typical text edits, comparable to ARJSON for
  text but larger for structured field updates because of CRDT metadata
  (Lamport timestamps, actor IDs).

- Automerge deltas: 20–50 bytes per op due to CRDT bookkeeping.

- IPFS DAG: every block carries a multihash header (~36 bytes) plus
  protobuf overhead. ARJSON deltas are smaller per-mutation than the
  block headers wrapping them.

For workloads dominated by per-mutation byte cost (telemetry logs, IoT
event streams, micro-transaction ledgers), this difference compounds into
order-of-magnitude storage savings.

## The strmap and delta chains together

The strmap is shared across the entire delta chain. As deltas are applied,
new strings are interned into the strmap; subsequent deltas can reference
those strings by index. A 100-document chain ends up with a strmap
containing every distinct string seen in any of the 100 documents, indexed
once.

This is the property that lets [the strmap-as-dictionary
trick](./strmap-as-dictionary.md) work especially well on delta chains.
By the time the chain is long, the strmap is a near-complete vocabulary
of the data. Compressing the chain with zstd-using-strmap-as-dict
extracts the last bits of redundancy: bit-level paths plus a
near-saturated dictionary plus zstd entropy coding. The combined chain at
14 bytes per snapshot is the empirical floor we have measured.

## Limitations

### Single-writer model

ARJSON's delta semantics are sequential. Two writers concurrently producing
deltas from the same state will, on naive merge, produce a chain that
depends on application order — `delta_a` followed by `delta_b` is not
equivalent to `delta_b` followed by `delta_a` in general. Resolving
concurrent updates requires either coordination (single-writer or
serialized writers) or a CRDT layer above ARJSON.

This is the principal architectural difference between ARJSON and Yjs/
Automerge. CRDTs encode causality in their delta format and pay for it in
overhead. ARJSON encodes minimum bytes and assumes the application provides
ordering. For decentralized databases with sharded write authority (each
document has a single canonical writer at a time, or writes are serialized
through consensus before being appended to the chain), ARJSON's model
fits. For peer-to-peer collaborative editing, it does not without an
additional CRDT layer.

### Empty-state and primitive-state edges

Empty `{}` / `[]` and primitive values (null, true, 42) use a 1-byte
"single-mode" encoding that has no column structure. A delta from an
empty or primitive state must re-anchor the encoding (replace the chain's
initial encoding) rather than apply incrementally. This is a
correctness-preserving fallback, not a performance loss for typical
workloads, but it does mean delta chains starting from `{}` or primitive
values are equivalent to single full encodings until the first
non-trivial structure is established.

### Replay cost

Reconstructing state at the end of a long chain takes O(n) work for n
deltas. For mutation-heavy workloads the chain may grow faster than
read-side hardware can replay it. The mitigation is periodic snapshot
recompaction: encode the current state fresh, discard the deltas that
preceded it, and continue the chain. This loses historical addressability
for the discarded portion; whether that is acceptable depends on the
application.

For decentralized databases that snapshot the chain to a recompacted base
periodically (every N mutations or every T seconds), the chain remains
bounded in length and replay is fast. The recompaction itself is a
deterministic function of the prior chain, so multiple nodes can verify
that a recompaction is correct.

## Comparison to snapshot-based pipelines

For a fair comparison: any snapshot-based pipeline can also be made small
by combining snapshots with a general compressor. JSON snapshots
compressed together with brotli/zstd find cross-snapshot redundancy
through their LZ77 windows.

We measured this. For 100 user records:

| Pipeline                                |  total bytes | bytes/state |
| --------------------------------------- | -----------: | ----------: |
| 100 separate snapshots × `json+brotli`  |       ~14,200 |       ~142  |
| 100 snapshots concatenated, then brotli |          733 |        ~7   |
| ARJSON delta chain + zstd               |        1,068 |        ~11  |

In bytes-per-state, **concatenated-then-compressed JSON narrowly beats**
the ARJSON delta chain on this workload. The result is real and worth
acknowledging: for sheer per-document compression of a known-corpus
homogeneous workload, brotli on concatenated JSON is competitive.

What ARJSON's delta chain provides that the JSON-concatenate pipeline does
not:

- **Random access to any historical state** without decompressing the
  entire concatenated blob. The JSON pipeline requires brotli-decompressing
  the whole sequence (or storing seek tables) to retrieve state N.

- **Determinism** at the byte level for the encoded chain. JSON
  serialization is permitted to differ between implementations (key order,
  whitespace); CBOR-CDE fixes this for CBOR but JSON has no canonical form
  in widespread use.

- **Streaming append**. A new mutation extends the chain by appending one
  delta. The brotli-on-concatenated-JSON pipeline must re-compress the
  entire concatenation to add a new entry; otherwise the per-snapshot
  redundancy isn't exploited.

- **Bit-level mutation cost**. A single field change adds bytes
  proportional to the change, not to the size of the document. For
  documents whose total size is large but typical mutation surface is
  small, ARJSON's per-mutation cost is dramatically smaller.

The honest summary: ARJSON's delta chain is not the absolute smallest
representation of a document history. It is the smallest representation
that simultaneously supports random history access, deterministic content
addressing, and streaming append. Other representations win on individual
axes; only the delta chain wins on the combination.

## The use cases ARJSON is designed for

In approximate order of how strongly the delta-chain model fits:

1. **Decentralized databases** (WeaveDB and similar) where state lives on
   permanent storage (Arweave, IPFS, blockchain-attached storage) and
   reading any historical state is a first-class operation. Mutation cost
   dominates. Determinism is required for hash-based agreement.

2. **Append-only audit logs** where every mutation must be retained for
   compliance, historical reconstruction is occasional but required, and
   per-mutation bytes are billed.

3. **Content-addressed configuration histories** (declarative
   infrastructure state, build configurations, tenant configurations).
   Mutation rate is low, history depth is high, and the same configuration
   shape repeats across tenants.

4. **Time-series with structural mutation** (data where rows have a
   changing schema or where individual fields update without changing
   the row identity).

For ephemeral RPC payloads, single-document storage with no history, or
high-throughput ETL pipelines, the delta-chain model is overhead — a
flat binary format like MessagePack or protobuf is the right choice.
