# ARJSON in the binary serialization landscape

This document situates ARJSON against existing formats. The goal is honest
calibration: where ARJSON is genuinely novel, where it is a recombination
of known techniques, and where it has no advantage at all.

## The landscape, axis by axis

The properties that distinguish binary serialization formats:

| Property                  | Notes |
| ------------------------- | --- |
| **Schemaless**            | Encodes arbitrary JSON without a schema. |
| **Self-describing**       | Decoder can fully reconstruct without external metadata. |
| **Bit-level packing**     | Values cross byte boundaries to save space. |
| **Inline dictionary**     | Symbol table built during encoding. |
| **Columnar**              | Same-typed values grouped together for compression. |
| **Delta-encoded**         | Updates are bit-stream patches, not full re-encodes. |
| **Deterministic**         | Same input → same output bytes, byte-for-byte. |
| **Content-addressable**   | Hash of payload is meaningful as identifier. |
| **CRDT semantics**        | Concurrent writes merge without coordination. |
| **Zero-copy reads**       | Decoder can return references to encoded bytes. |
| **Random access**         | Read field N without decoding 1..N-1. |

No format has all of these. The interesting question is which combinations
are taken.

## Format-by-format comparison

### MessagePack

**Schemaless, self-describing, byte-aligned, no inline dictionary, no
delta encoding.** The closest direct competitor on the schemaless binary
JSON axis.

Strengths: maturity, ecosystem, fast implementations in every language,
byte-aligned format that downstream compressors handle well.

Weaknesses: no compression of repeated keys (same key in 100 records is
encoded 100 times), no delta updates, larger than ARJSON on structured
repetitive data.

Where ARJSON beats it: structured data with repeated keys/values
(typically 30–50% smaller; up to 95% on sequential numeric arrays via
delta-pack).

Where it beats ARJSON: encoding/decoding speed (5–8× faster), simplicity
of implementation, ecosystem support.

### CBOR (RFC 8949)

**Schemaless, self-describing, byte-aligned, no inline dictionary, no
delta encoding, IETF standard.** Functionally similar to MessagePack with
slightly different encoding choices and standardization weight.

Strengths: IETF-standard with well-defined deterministic encoding profile
(CBOR-CDE), tagged extension mechanism for future extensibility.

Weaknesses: same as MessagePack — no key compression, no delta encoding.
On the workloads benchmarked, CBOR is marginally larger than MessagePack
(104% the size).

Where ARJSON beats it: same as for MessagePack, slightly more so.
Specifically, CBOR's per-level overhead on deeply nested structures is
heavier, so ARJSON's lead on `deep_nest_50` is larger vs CBOR (38% of
CBOR size) than vs MessagePack (63%).

Where it beats ARJSON: standardization, ecosystem, **CBOR has tagged
extensions** (the format reserves type tags for future extensions).
ARJSON does not — its 7 type values fit in 3 bits with no reserved space.
For long-lived storage where the format may need to evolve, CBOR-CDE is
better positioned.

### BSON (MongoDB)

**Schemaless, self-describing, byte-aligned, length-prefixed everything,
no inline dictionary, no delta encoding.**

Strengths: ecosystem in MongoDB-adjacent tools, supports types beyond JSON
(ObjectId, Date, BinData, Decimal128).

Weaknesses: significantly larger than MessagePack/CBOR/ARJSON because
length-prefixing every value pays per-field overhead. Not competitive on
size.

Not benchmarked here; trivially loses on every size metric.

### Smile (Jackson)

**Schemaless, self-describing, byte-aligned, **inline dictionary**, no
columnar restructuring, no delta encoding.**

Strengths: Smile has back-references for keys and short strings, similar
in spirit to ARJSON's strmap. JVM-focused. Closest format conceptually to
ARJSON's symbol-table approach.

Weaknesses: no bit-level packing, no columnar restructuring, no delta
encoding. Smile's back-reference table is per-document and not deterministic
in the way ARJSON's strmap is.

Where ARJSON improves on it: bit-level packing, columnar, delta chains.
The strmap-as-deterministic-dictionary property is also new — Smile's
back-reference table is not exposed for downstream compression.

### Apache Ion (Amazon)

**Schemaless, self-describing, byte-aligned, **inline symbol table**,
some columnar features, no delta encoding.**

Strengths: production-tested at Amazon scale, has both binary and text
forms with bidirectional conversion, symbol tables provide key
deduplication.

Weaknesses: no bit-level packing, no delta encoding, larger than ARJSON
on structured data.

Conceptually the closest "ancestor" to ARJSON among schemaless formats.
The symbol-table idea is shared. ARJSON adds bit-level columnar
restructuring + the deterministic-strmap-as-dictionary property + delta
chains.

### Protocol Buffers (Google)

**Schema-driven, byte-aligned, no inline dictionary, no delta encoding,
zero-copy with separate runtime.**

Strengths: very fast, well-deployed, smaller than schemaless formats when
you have a schema.

Weaknesses: requires schema. Doesn't compress repeated values across
records (each record is independent). No delta encoding. Schema evolution
is brittle (field tags must remain stable).

Different category. Protobuf wins decisively when a schema is available;
ARJSON is competing in the "no schema" lane.

### Cap'n Proto / FlatBuffers

**Schema-driven, byte-aligned, supports zero-copy reads.**

Strengths: extremely fast, support zero-copy decode (read a field without
parsing), suitable for IPC and memory-mapped storage.

Weaknesses: schema-driven. Bigger payloads than tightly-encoded formats
because they reserve space for alignment and pointer indirection.

Different category. Different problem.

### Apache Avro

**Schema-driven (schema can be inline or separate), byte-aligned, supports
schema evolution.**

Strengths: schema evolution semantics (forward/backward compatible), good
compression with separate schema.

Weaknesses: schema overhead inline, schemaless mode loses size advantage.

Different category. Avro is a good fit for evolving schemas; ARJSON is
schemaless.

### Apache Parquet / Arrow

**Schema-driven, byte-aligned, fully columnar across rows of a table,
delta encoding within columns, supports per-column compression algorithms.**

Strengths: massive size advantage on tabular data, column-by-column
compression chosen per data type.

Weaknesses: schema-driven, batch-oriented (terrible for single small
documents). Decoding individual rows is expensive.

Different category. Parquet wins on million-row datasets; ARJSON wins on
single small structured documents and delta chains.

The columnar idea overlaps. ARJSON's columnar restructuring is *within*
a single document; Parquet's is *across rows of a table*. The two serve
different access patterns.

### Yjs

**CRDT for collaborative document editing, delta-encoded.**

Strengths: deltas are minimal (5–8 bytes per text op), CRDT semantics let
concurrent writers merge without coordination, has a strong ecosystem in
collaborative editing tools.

Weaknesses: deltas carry causality metadata (Lamport timestamps, actor
IDs) which costs bytes; deterministic content-addressing is harder
(actor IDs vary per writer); not designed for arbitrary JSON state.

The closest competitor to ARJSON's delta-chain story. Yjs and ARJSON sit
on opposite sides of a tradeoff:

- **Yjs trades size for CRDT semantics.** Concurrent writers can merge.
  Per-op metadata is unavoidable.
- **ARJSON trades CRDT semantics for size.** Single-writer (or coordinated
  multi-writer). No per-op metadata.

For a peer-to-peer collaborative editor, Yjs is the right choice. For a
serialized-write decentralized database where consensus orders writes
before append, ARJSON has smaller per-mutation cost.

### Automerge

**Same category as Yjs, similar tradeoffs.** Automerge has heavier
per-op overhead than Yjs (richer CRDT operations) and is ~2–3× larger than
Yjs for typical workloads. Not competitive on size with ARJSON for
single-writer workloads.

### IPLD / IPFS DAG-CBOR

**Content-addressable storage layer with CBOR encoding.**

Strengths: standardized in the IPFS ecosystem, content-addressing built in.

Weaknesses: every block carries a multihash header (~36 bytes of
multihash + protobuf framing) before the payload. For small mutations,
the framing cost dominates the payload cost.

ARJSON deltas are smaller per-mutation than IPFS's block headers wrapping
them. For a decentralized DB on IPFS, ARJSON deltas inside an IPFS DAG
node would be a sensible composition (DAG addresses chains of ARJSON
deltas; each delta is small).

### Compressed JSON (gzip / brotli / zstd)

**Schemaless, byte-oriented, leverages general-purpose compression.**

Strengths: works with any JSON tooling, brotli's built-in static
dictionary helps on small JSON payloads, no special encoder/decoder
required.

Weaknesses: no random access, no streaming append, not deterministic
(JSON serialization is implementation-defined; compression itself is
deterministic but the input may not be).

For a pure size-of-static-blob comparison, `json + brotli` on a
concatenated corpus is the closest competitor and sometimes wins narrowly.
The bench shows json+brotli at 4,158 B for the 34-workload corpus
concatenated, vs arjson+brotli at 4,669 B. Within 12%.

For a per-document or streaming-append workload, ARJSON pulls ahead — it
preserves the random-access and append properties that compression-of-
concatenation loses.

## The gap ARJSON occupies

Crossing the property axes against the formats:

| Format       | Schemaless | Bit-pack | Inline dict | Columnar | Delta | Deterministic |
| ------------ | :--------: | :------: | :---------: | :------: | :---: | :-----------: |
| JSON         |     ✓      |          |             |          |       |               |
| MessagePack  |     ✓      |          |             |          |       |       ✓       |
| CBOR         |     ✓      |          |             |          |       |       ✓ CDE   |
| BSON         |     ✓      |          |             |          |       |       ✓       |
| Smile        |     ✓      |          |     ✓       | partial  |       |       ✓       |
| Ion          |     ✓      |          |     ✓       | partial  |       |       ✓       |
| Protobuf     |            |          |    n/a      |          |       |       ✓       |
| Cap'n Proto  |            |          |    n/a      |          |       |       ✓       |
| Avro         |            |          |    n/a      |          |       |     varies    |
| Parquet      |            |    ✓     |     ✓       |    ✓     |       |       ✓       |
| Yjs          |     ✓      |          |             |          |   ✓   |     partial   |
| Automerge    |     ✓      |          |             |          |   ✓   |     partial   |
| **ARJSON**   |   **✓**    |   **✓**  |   **✓**     |   **✓**  | **✓** |     **✓**     |

ARJSON is the only row with all six checkmarks. That intersection is
empty in the prior art.

## Where ARJSON is a recombination, not a discovery

Every individual technique ARJSON uses has prior art:

- **Bit-level integer encoding**: LEB128, varint, UTF-8.
- **Symbol tables / inline dictionaries**: Smile, Ion, every protocol with
  a string interning step.
- **Columnar restructuring**: Parquet, Arrow, ClickHouse, every analytical
  database.
- **Delta packing for sequential numbers**: standard run-length and delta
  encoding, used in Parquet, Postgres, every numeric column store.
- **Append-only delta chains for state**: Yjs, Automerge, git, Hypercore,
  every WAL-based database.
- **Content-addressable storage**: git, IPFS, Merkle trees in general.

ARJSON's contribution is the *combination* and the engineering choices
that make all of them coexist in a single deterministic schemaless format
suitable for permanent decentralized storage. No individual piece is a
research breakthrough; the combination occupies an empty cell in the
table above.

## Where ARJSON is genuinely novel

The [strmap-as-dictionary property](./strmap-as-dictionary.md) is the
strongest claim to novelty:

> The encoder's internal symbol table can be exported as a deterministic
> shared dictionary for any downstream compressor, retrievable from the
> uncompressed payload by re-running the encoding, with no separate
> training or distribution step.

This is a structural property that depends on:

1. The symbol table being built deterministically (encounter order plus
   canonical re-sort).
2. The symbol table being a strict function of the input data (no
   external state).
3. The encoded payload being the input from which the symbol table can
   be reconstructed.

These together are not trivially true. Smile's back-reference table is
deterministic but not exposed for downstream use. Ion's symbol tables
can be shared but require explicit catalog management. Protobuf has no
symbol table. Brotli's dictionary is static and external. zstd's
dictionary is trained externally.

ARJSON appears to be the first format where the dictionary is the
encoder's runtime state, exported losslessly, and usable without
distribution overhead. That is the one defensible claim of structural
novelty in this work.

## When you would pick ARJSON

For **decentralized databases with append-only state and permanent
storage**, where:

- Mutation cost dominates total storage (many small updates).
- History reconstruction is a first-class operation.
- Determinism is required for content addressing or hash-based consensus.
- Documents are structured (objects with stable shapes), not opaque
  blobs.
- Writes are coordinated (single-writer or consensus-serialized).

For everything else, a more mature format is usually the right choice:

- **High-throughput RPC**: msgpack or protobuf.
- **Schema-driven storage**: protobuf, Cap'n Proto, Parquet (for tables).
- **Browser/HTTP**: JSON+brotli, leveraging existing infrastructure.
- **Collaborative editing**: Yjs.
- **Document databases without history**: msgpack or BSON.

ARJSON's lane is real but narrow. The benefit inside the lane is
genuine and (as far as we can tell) not available from any other format
without adding multiple layers of integration that ARJSON provides
together.
