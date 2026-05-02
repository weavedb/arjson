# Fuzz testing

Property-based fuzz testing supplements ARJSON's regression suite with
invariant checks that must hold for any valid input.

## Properties checked

| Property                    | Invariant                                                              |
| --------------------------- | ---------------------------------------------------------------------- |
| **round-trip**              | `dec(enc(x)) ≡ x` for all valid JSON `x` (modulo NaN/Inf/-0 coercion)  |
| **determinism**             | `enc(x)` produces byte-identical output across calls                   |
| **delta-replay**            | A delta chain produces its final state via buffer round-trip and {table} |
| **JSON equivalence**        | `dec(enc(x))` is JSON-equivalent to `JSON.parse(JSON.stringify(x))`    |
| **mutation chain**          | Random structural mutations (add/delete/replace) preserve invariants   |
| **boundary values**         | Every IEEE 754 / Unicode / count boundary round-trips correctly        |
| **decoder robustness**      | Random / truncated / corrupted input does not hang or crash the host   |
| **size-bound sanity**       | Encoded size is within 4× JSON.stringify length                        |

## Running

The bounded suite is part of `npm test`:

```
npm test                # 502 tests including fuzz.test.js (~16s)
```

The long-running stress runner is invoked separately:

```
npm run fuzz                          # 1M iterations all-mode, default seed
npm run fuzz -- 5000000 0xC0FFEE      # custom budget + seed
npm run fuzz -- round-trip 1e7        # specific property
npm run fuzz -- decoder-robust 1e6    # decoder fuzzing only
```

Modes: `round-trip`, `determinism`, `delta-replay`, `mutation-chain`,
`decoder-robust`, `all` (default).

## Bugs surfaced by fuzz testing

Building this suite found three additional bugs that the regression suite
(targeted unit tests) had not caught:

### 14. Decoder hung on malformed bit-streams
The `n(len)` bit-reader returned implicit zero bits for reads past the
buffer end (because `this.o[oob]` is `undefined` and `(undefined >> n) & 1 = 0`).
The kcount/vcount-grow loop in `getKrefs`/`getVrefs` then spun forever
reading these implicit zeros. **Fix:** trip-wire in `n()` that throws
when the cursor advances >64 bits past the buffer end.
`sdk/src/decoder.js`.

### 15. Empty-object value lost during delta when chained with key additions
When an object's value transitioned from `{...}` to `{}` via deletes, the
artable's `compactKeys()` removed the parent key entirely (since no vrefs
pointed through it). Subsequent `update()` operations that added new keys
elsewhere lost the empty-object value. **Fix:** in `diff()`, an
"object becomes empty" transition emits a `replace` op rather than a
sequence of deletes — preserves the empty-container marker through the
artable's compaction pass.
`sdk/src/arjson.js`.

### 16. Empty-array element followed by non-empty array merged into one
The builder's line `obj.arrs[v + 1] = true` (intended to mark empty-array
positions as "already initialized") incorrectly marked the *next* sibling's
position. Adjacent `[empty, non-empty]` patterns produced `[non-empty]`
in the output. **Fix:** removed the line entirely; the empty-array marker
is handled correctly by the existing val-handling logic in
`build()`.
`sdk/src/builder.js`.

### Decoder allocation bounds (DoS hardening)
Malformed input could request multi-gigabyte allocations before the n()
trip-wire fired. Specifically, `getStrDiffs` could receive a huge LEB128
length and call `new Uint8Array(N)` for N near 2^45, triggering 32 TB
allocation requests. `getKrefs`/`getVrefs`/`getVtypes` could receive
malformed run-length values causing them to push billions of array
entries before the trip-wire stopped them. `getKeys`/`getStrs` could
build long strings from claimed lengths exceeding the buffer.

**Fix:** size-sanity guards in each loop that throw if a claimed length
exceeds remaining buffer bits. `sdk/src/decoder.js`.

After these fixes, decoder-robust mode runs at **35,000 iterations/sec**
with stable heap (single-digit MB delta).

## Coverage

The fuzz suite exercises:
- Primitives at every documented IEEE 754 / Unicode / bit-width boundary
- Random JSON at depth 1–4 with seeded reproducibility (mulberry32 PRNG)
- Mutation chains of 5–25 structural operations per chain
- Decoder against random byte streams, truncated valid encodings, single-byte
  inputs across all 256 values, repeated-byte corruption patterns, and
  malformed delta-chain buffers via `ARJSON({arj: bad_buf})`
- Determinism across `enc(x)` calls, `toBuffer()` calls, and chained-update
  sequences with the same input

Each fuzz failure attempts to **shrink** the failing input to a minimal
case before reporting, making bug reproduction direct.
