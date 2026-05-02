# ARJSON wire format reference

This document is a working reference to ARJSON's binary layout. It is
derived from the implementation, not a normative specification — that
specification does not yet exist as a separable artifact. Producing one
would be a useful future contribution.

## Top-level dispatch

The first bit of every ARJSON payload determines whether the value is a
"single-mode" primitive or a structured (object/array) document.

```
bit 0 = 1  →  single-mode (primitive, empty {}, or empty [])
bit 0 = 0  →  structured-mode (non-empty object or array)
```

### Single-mode encoding (8 bits total for most cases)

When bit 0 is 1, the next 7 bits select a primitive form:

```
0000000   null              (1 byte)
0000001   true              (1 byte)
0000010   false             (1 byte)
0000011   ""                (1 byte)
0000100   []                (1 byte)
0000101   {}                (1 byte)
0000110   negative integer  (followed by uint(abs(value)))
0000111   positive float    (followed by uint(precision), uint(integer))
0001000   negative float    (followed by uint(precision), uint(integer))
001001 .. 111100   single alphabetical character (charmap + 9)
111101    single non-alphabetical character (followed by LEB128 charcode)
111110    multi-character alphabetical string (followed by short(charmap))
111111    multi-character non-alphabetical string (followed by LEB128 charcode)
1XXXXXX   positive integer ≤ 63 in 6 bits, or 63 + LEB128 if larger
```

This means `null`, `true`, `false`, `""`, `[]`, `{}`, every alphabetical
single character, and every positive integer ≤ 63 fit in exactly 1 byte.

### Structured-mode encoding

When bit 0 is 0, the document is a non-empty object or array. The remaining
bits are organized into 13 groups (columns), each encoding one aspect of
the document. The groups appear in a fixed order and are read sequentially:

1. Value count (number of values in the document)
2. Value flags (RLE-prefixed, 1 bit per value: delta-encoded or not)
3. Value links (references from each value to its parent key)
4. Key flags (RLE-prefixed, 1 bit per key: delta-encoded or not)
5. Key links (parent references for keys)
6. Key types (2 bits per key: array, object, base64 string, generic string)
7. Keys (the key strings themselves)
8. Data types (3 bits per value type)
9. Boolean values (RLE-prefixed, 1 bit each)
10. Number values (variable encoding)
11. String values (variable encoding)
12. String diffs (for delta-encoded string updates)
13. Padding (zero-pad to next byte boundary)

Each group exploits column-specific compression:
- **Sequential or repeated bit-widths in number values use delta-pack**
  (3+ consecutive matching deltas collapse to a single run-length entry).
- **Repeated types use type-pack** (3+ same type collapse to a run).
- **Strings are interned in the strmap and replaced with deterministic
  indices on subsequent occurrences.**
- **Keys with only base64url characters use 6-bit encoding rather than
  full LEB128.**
- **Boolean-valued columns (`vflags`, `kflags`, `bools`) use a 2-bit
  RLE mode prefix**: `00` (all zeros, no body), `01` (all ones, no
  body), `10` (mixed, raw body bits follow), `11` (reserved). For
  homogeneous columns this collapses N raw bits to 2 prefix bits;
  for mixed columns it costs 2 bits of overhead.

### Boolean-column RLE prefix (v1.1)

Each non-empty column among `vflags`, `kflags`, `bools` is preceded
by a 2-bit mode selector:

```
mode 00 → all zeros (column has expected length but no body bits)
mode 01 → all ones  (column has expected length but no body bits)
mode 10 → mixed     (column body is raw <expected length> bits)
mode 11 → reserved
```

When the column is empty (length 0), no prefix is emitted — the
adjacent columns abut directly. The expected length is determined
from the document structure already parsed (value count for
`vflags`, key chain length for `kflags`, count of boolean-typed
values for `bools`).

The detailed bit layout for each group is in
`sdk/src/encoder.js` (encode side) and `sdk/src/decoder.js` (decode side).
A formal specification document would extract these into a
language-independent reference.

## Adaptive integer encoding

ARJSON uses three integer-encoding schemes depending on context:

**Short** (used for counts, lengths, small values):
```
00 → 2-bit integer
01 → 3-bit integer
10 → 4-bit integer
11 → LEB128
```

**Uint** (used for slightly larger values):
```
00 → 3-bit integer
01 → 4-bit integer
10 → 6-bit integer
11 → LEB128
```

**Plain LEB128** (used for arbitrary integers, no width flag).

The choice of scheme is fixed per-position, not encoded inline. Both
encoder and decoder agree on which scheme applies to which field by
reading the surrounding column structure.

## Number encoding

Numeric values are encoded with a 2-bit type prefix:

```
00 → delta from previous number (3 bits)
01 → 4-bit integer
10 → 6-bit integer
11 → LEB128
```

If the delta value is 7 (out of the 0–7 representable range), it
indicates **delta-pack mode**: the next bits encode a run length and a
single repeated delta value, collapsing 3+ consecutive identical deltas
into one entry.

For floats, the encoding is sign + precision + integer:
- The first integer combines sign and precision (precision + 4 if
  negative, or 0 / 4 sentinel for "precision is in the next field").
- The second integer (if precision > 2) is the actual decimal precision.
- The third integer is the value × 10^precision (a bigint).

So `-3.14` with precision 2 becomes:
```
01 (negative-float marker)
0110 (precision 2 + 4 = 6)
11 10011010 00000010  (LEB128 encoding of 314)
```

24 bits total, 3 bytes. MessagePack would use 9 bytes for the same value.

## Strings

Strings have two encoding paths:

**base64url path** (6 bits per character) for strings consisting only of
`[A-Za-z0-9_-]`. ARJSON detects this property and switches encoding when
applicable.

**LEB128 charcode path** for arbitrary strings. Each character is encoded
as a LEB128 integer.

For both paths, **strings already in the strmap are emitted as a
deterministic index** rather than the full string content. The index uses
the minimum number of bits needed to address the current strmap size.

## Keys

Keys use the same 2-bit type tag plus length-prefix scheme:

```
00 → array marker (next group establishes count)
01 → object marker
10 → base64url string key (followed by 2-bit length-encoding selector + length)
11 → generic string key (followed by 2-bit length-encoding selector + length)
```

Keys are stored in the strmap exactly like string values. Repeated keys
emit just a 2-bit "10/11 plus index" pattern — typically 5–8 bits total
for a key reference.

## Delta updates

A delta is a self-describing bit-stream that names a path, an operation,
and (where applicable) a new value:

- Path is encoded as a sequence of references: each path component is
  either a string index (for object keys) or a small integer (for array
  indices).
- Operations are: add new key, replace existing value, delete, string-diff
  (for long-string mutations using fast-diff/Myers).
- The delta is appended to the chain after the prior state's encoding.

The delta references the state the chain is currently in, including any
strmap entries already established. New strings introduced by the delta
are added to the strmap with the next available index.

A complete chain is then:
```
[ initial encoding | delta_1 | delta_2 | ... ]
```

with length-prefixed framing between deltas (LEB128 length, then bytes).

## Reserved extension space

The format reserves a structurally unreachable bit prefix for future
extensions. Specifically, the byte-stream prefix `00000` (five leading
zero bits) is never produced by any valid input under the current
encoder.

The reasoning is a logical impossibility in the dispatch:

```
bit 0 = 0   → structured mode (non-empty object or array)
bits 1–2    → "short" encoding selector for the value count (00 = 2-bit)
bits 3–4    → 2-bit value count
```

A structured-mode encoding with a value count of zero would mean "a
non-empty object containing zero values," which is contradictory: empty
`{}` and `[]` always take the single-mode path (codes `0000101` and
`0000100` respectively), and any non-empty object or array has at least
one value to encode.

The encoder never emits a stream beginning with `00000`. A v2 decoder,
on encountering this prefix, knows immediately that the payload is in an
extension format. A v1 decoder must reject such streams as invalid.

This gate enables forward-compatible evolution without invalidating any
existing v1 payloads:

- Sub-version dispatch can be encoded in the bits following the gate
  (e.g., `00000 000` for v2.0, `00000 001` for v2.1).
- New value types, longer header forms, embedded content hashes, or
  alternative encoding families can all be signaled here.
- A v2 decoder that doesn't see the gate falls through to the v1 parser,
  preserving full backward compatibility.

The cost in the wire format is zero: the reservation exists because of a
logical contradiction in the existing dispatch, not because of an
arbitrary held-back code.

## Determinism guarantees

The encoder's behavior is deterministic in three respects:

1. **Strmap construction**: strings are interned in encounter order during
   the single forward pass; `compactStrMap()` then re-sorts canonically.
   Same input → same final strmap.

2. **Column ordering**: the 13 groups appear in a fixed order, and within
   each group, values appear in document-order.

3. **Bit packing**: zero-padding to byte boundary uses zeros; no implementation
   choice is exposed.

Two implementations of the encoder, given the same input JSON and the
same encoder version, must produce byte-identical output. This is
required for content-addressing and hash-based consensus.

## What's missing from this reference

- **Formal grammar**. The implementation describes the format imperatively;
  a context-free grammar or pseudocode specification would help port the
  format to other languages.

- **Error semantics**. The implementation defines "what valid input looks
  like" but does not define how a decoder should handle malformed input
  (truncation, invalid type tags, references to nonexistent strmap
  indices). A normative spec would.

- **Endianness / byte order**. ARJSON is bit-stream-oriented; bytes are
  packed MSB-first within the bitstream. This is consistent across the
  implementation but not formally documented.

These gaps are the principal limitations to ARJSON being treated as a
standardized format. Closing them would make the format independently
implementable and interoperable across languages.

## Implementation reference

| Concern             | File                            |
| ------------------- | ------------------------------- |
| Encoder             | `sdk/src/encoder.js`            |
| Decoder             | `sdk/src/decoder.js`            |
| Stateful API + delta | `sdk/src/arjson.js`             |
| Column-table updates | `sdk/src/artable.js`            |
| Builder (table → JSON) | `sdk/src/builder.js`         |
| String fast-diff     | `sdk/src/diff.js`               |
| Bit / path / charmap utilities | `sdk/src/utils.js`     |
