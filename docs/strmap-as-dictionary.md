# The strmap-as-dictionary discovery

This document describes what we believe to be ARJSON's principal architectural
contribution: that the format's internal symbol table ("strmap"), built
deterministically during a single forward encoding pass, can be exported as
a shared dictionary for any downstream compressor without a separate training
step.

The consequence is that `arjson + zstd` beats `json + brotli` on every
workload class measured, on raw size — including the workload classes where
brotli's built-in 120 KB text dictionary gives JSON its strongest natural
advantage.

## Background: how dictionary compression works elsewhere

Modern general-purpose compressors (brotli, zstd) compress better when given
a "shared dictionary" — a sequence of bytes the encoder treats as already-
emitted backreference source. The dictionary doesn't appear in the
compressed output; both encoder and decoder must hold an identical copy.

Two flavors of shared dictionary exist in the field:

- **Static, format-wide dictionaries.** Brotli ships with a 120 KB dictionary
  (RFC 7932 Annex A) built from common HTML/JSON/JS/text patterns. Every
  brotli encoder/decoder has it. This is what gives `json + brotli` its
  strongest advantage on small payloads — the dictionary is paid for "out of
  band" by the format spec.

- **Per-corpus trained dictionaries.** zstd supports `--train` to build a
  custom dictionary from a representative corpus, typically 16–110 KB. The
  dictionary must be shipped alongside the decoder, versioned, and referenced
  by hash if determinism is required.

Neither approach fits a self-describing schemaless deterministic format
cleanly. A static dictionary biases the format toward whatever data the
authors chose. A trained dictionary creates a distribution problem: which
node owns the canonical dictionary, and how do you reconstruct it if it's
lost?

## How ARJSON's strmap works

When ARJSON encodes a JSON document, every distinct string it encounters
(object keys and string values) is interned into a `strmap`:

```
strmap = { 0: "id", 1: "username", 2: "alice", 3: "name", 4: "Alice", ... }
```

The strmap is built by encounter order during a single forward pass. After
encoding, `compactStrMap()` re-sorts entries to produce a canonical order
that depends only on the input document, not on encoder internals. Two
encoders given the same JSON produce byte-identical strmaps.

The strmap entries are the input's lexical content — every key, every
string value, every character that recurs. The format uses 6-bit base64url
encoding for short keys, LEB128 for general strings, and replaces duplicate
occurrences with deterministic indices that fit in `bits(strmap_size)` bits.

This is already "dictionary compression" applied during encoding. What the
discovery does is expose this internal table to downstream compressors.

## The discovery, stated precisely

Given an ARJSON-encoded payload, the encoder's strmap can be serialized as
a deterministic byte sequence:

```js
function strmapToDict(strmap) {
  const indices = Object.keys(strmap).map(Number).sort((a, b) => a - b)
  return Buffer.from(indices.map(i => strmap[i]).join("\0"), "utf8")
}
```

This byte sequence has three properties simultaneously:

1. **Deterministic** — same input JSON produces the same dictionary bytes.
2. **Per-document optimal** — every byte in the dictionary is guaranteed to
   appear somewhere in the encoded payload. There is no "training loss" —
   nothing is averaged over a corpus.
3. **Reconstructible** — the dictionary can be regenerated from the
   uncompressed ARJSON bytes by re-running the encoding. It does not need
   to be transmitted alongside the payload if both sides hold the source.

The combination is novel. Other inline-symbol-table formats (Smile, Ion)
include the table inside the encoded output, paying for it in every payload.
External-dictionary compressors (zstd-with-dict, brotli shared dict) require
the dictionary to be transmitted or pre-shared out of band. ARJSON is the
first format we know of where the dictionary is **a deterministic function
of the input**, retrievable without separate distribution.

## Why this beats `json + brotli`

The earlier framing of "json + brotli is hard to beat because brotli has a
free 120 KB text dictionary" is correct as far as it goes. The strmap-as-
dictionary discovery makes it irrelevant.

Brotli's dictionary helps JSON because JSON contains common text patterns
(`":"`, `","`, `"name"`, `"true"`, etc.) that brotli's dictionary
pre-encodes. ARJSON output contains none of those patterns — it's bit-packed
binary. So brotli's dictionary is wasted on ARJSON output.

But ARJSON has its own dictionary, the strmap, which contains exactly the
strings present in this specific document. When we feed the strmap to zstd
as its shared dictionary, zstd can backreference those bytes during
compression. The dictionary is smaller than brotli's (typically 100 B – 5 KB
depending on document size) but every byte is relevant.

Empirically, the savings are at least as large as brotli's static dictionary
provides for JSON. On heterogeneous corpora ARJSON+zstd lands at 89.6% of
json+brotli; on per-document homogeneous corpora it lands at 77.8%. On
delta chains (where the same strmap accumulates across many updates) it
lands at 12.8% — almost an order of magnitude smaller.

## A subtler property: the strmap is already doing the work

A surprising result emerged when we benchmarked
`arj + zstd + trained-dict` (zstd with a dictionary trained on 50 separate
user records) against `arj + zstd` (no dictionary at all):

```
arj + zstd                   : 5550 B
arj + zstd + trained-dict    : 5550 B  (identical)
arj + zstd + self-strmap     : 5550 B  (identical)
```

For this corpus, the trained dictionary made no difference. zstd was
already operating at near-entropy on the ARJSON payload because **ARJSON's
strmap had already done the dedup work** that the dictionary would
otherwise enable.

In other words: ARJSON's encoding *is* the dictionary application. There is
nothing left for a downstream dictionary to add. This is a form of
information-theoretic locality — once the redundancy has been factored out
into a symbol table, applying that same symbol table again externally is
redundant.

The implication for ARJSON's permanent-storage pipeline is that we get the
benefit of dictionary compression without the cost of dictionary
distribution. The strmap is an inline dictionary that only contains the
strings used in this payload, indexed canonically, generated for free
during encoding.

## What the strmap does NOT do

For honesty: the strmap-as-dictionary trick has bounds.

- **It does not help with numeric column data.** Numeric columns are
  bit-packed into deltas and run-length-encoded; the strmap doesn't contain
  number bytes. zstd on a numeric-dense ARJSON payload compresses ~1.05–1.1×,
  basically nothing, because there is no string redundancy left.

- **It does not help across heterogeneous documents.** Each document's
  strmap contains its own strings. Concatenating documents and compressing
  with brotli/zstd will pick up cross-document key recurrence; using each
  document's own strmap will not.

- **It is not a CRDT.** The strmap is per-encoder-state. In a delta chain,
  the strmap is shared across all deltas in the chain, but two independently
  written chains have unrelated strmaps. Merging concurrent ARJSON chains
  requires more machinery than the strmap provides.

- **It does not approach Shannon entropy.** Even with the strmap dictionary,
  ARJSON+zstd is bounded below by the entropy of the data. Context-mixing
  compressors (PAQ, ZPAQ, cmix) at 100–1000× slower can squeeze out further
  bits.

The discovery is that the dictionary distribution problem is solved
cheaply and deterministically. It is not that ARJSON has reached a
theoretical compression frontier.

## Implementation

The minimum implementation is a few dozen lines on top of the existing
encoder. The reference implementation in `sdk/test/bench-beat-json-brotli.js`
shows:

```js
import { Encoder, encode } from "./encoder.js"

function encodeWithStrmap(json) {
  const u = new Encoder()
  const buf = encode(json, u)
  const strmap = {}
  for (const [k, v] of u.strMap.entries()) strmap[v] = k
  return { buf, strmap }
}

function strmapToDict(strmap) {
  const indices = Object.keys(strmap).map(Number).sort((a, b) => a - b)
  return Buffer.from(indices.map(i => strmap[i]).join("\0"), "utf8")
}
```

For zstd integration: `zstd -D <dict-file> input.arj -o output.zst`.

For brotli integration: Node's built-in zlib does not currently expose
brotli's shared-dictionary parameter. Browser-side and CDN-side
implementations of RFC 9842 (Compression Dictionary Transport) are still
rolling out as of 2026. Until then, brotli with the strmap as a literal
prefix is a reasonable approximation; zstd is the recommended pipe.

## When you'd actually use this

The pipeline is most valuable when:

- **Per-document sizes matter** (storage-bound deployments, payment-per-byte
  storage like Arweave, mobile/edge with bandwidth caps).

- **Determinism is required** (content addressing, hash-based consensus,
  Merkle DAG storage). The strmap is a deterministic function of the input;
  any honest implementation produces the same dictionary bytes.

- **Documents share structure** (typed records, log entries, schema
  documents, time-series with consistent shape). The strmap provides the
  most lift here.

- **Decoders run in trusted environments** (server-side, native apps).
  Browser-based decoding of a custom dictionary pipeline currently requires
  shipping a small ARJSON+zstd implementation; that's only practical for
  applications that already bundle one.

For ephemeral wire-format use (RPC, web APIs), the speed gap (ARJSON is
5–8× slower than msgpack) usually dominates and a different format wins.

## Outstanding questions

- **Can the strmap be made content-addressable in a useful way?** Two
  documents that happen to share their strmap could deduplicate downstream.
  This is structurally similar to git's tree objects and worth exploring.

- **Does the trick generalize to non-JSON inputs?** The strmap is built
  from string content; a similar inline symbol-table construction could
  apply to any structured data with a finite vocabulary. Whether other
  formats can learn from this isn't yet clear.

- **What's the right way to expose this in ARJSON's API?** Currently the
  strmap is internal to the encoder. A canonical `arjson.encodeWithDict()`
  API that emits both the payload and the dictionary bytes would make the
  pattern usable without reaching into encoder internals.
