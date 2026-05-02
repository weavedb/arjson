# Test architecture

The test suite is structured to provide **optimization safety**: tests pin
down every observable behavior of the current implementation so any
optimization that silently changes outputs, sizes, or semantics is caught
immediately.

## File layout (`sdk/test/`)

| File | Tests | Purpose |
| --- | ---: | --- |
| `test.js` | 19 | Top-level encode/decode round-trip on canonical inputs |
| `delta.js` | 21 | Delta-update behavioral tests (every documented pattern) |
| `edge-cases.js` | 41 | Edge cases by category (empty, NaN/Inf, deep nest, large numbers, …) |
| `brackets.test.js` | 14 | Path parser + bracket-key delta updates (Bug 2) |
| `modular.test.js` | 14 | Original modular tests preserved verbatim |
| `regression.test.js` | 472 | Comprehensive regression — every concrete bug + boundary + property |
| `fuzz.test.js` | 25 | Property-based fuzz with shrinking |
| `extension-gate.test.js` | 5 | Structural reservation invariant (`00000` prefix) |
| **`golden.test.js`** | **76** | **Hex-locked encoded outputs + size markers** |
| **`unit.test.js`** | **122** | **Direct tests for every utility helper** |
| **`api.test.js`** | **99** | **Every public method, every constructor mode** |
| **`matrix.test.js`** | **922** | **Cartesian-product coverage of value × position × operation** |
| **Total** | **1,721** | **All pass; ~17 s on `npm test`** |

(Bold = added in the optimization-safety pass.)

## Files added for optimization safety

### `golden.test.js` — hex-locked encoder output

Each canonical input is paired with its exact encoded byte sequence. The
test fails if either:
- the encoded bytes change (catches silent format drift),
- the decoded value doesn't match the original (catches encoder/decoder skew).

Also includes:
- **Encoded-size locks** for canonical inputs and compressible patterns.
  Optimizations that grow the output (regression) get caught; optimizations
  that shrink it (improvement) require an explicit lock-update.
- **Format-feature sentinels** — assertions that strmap dedup, type-pack,
  delta-pack, and base64url 6-bit encoding are *active*. If a refactor
  accidentally disables any of these, the relevant sentinel fails.
- **Determinism golden tests** — multiple `enc(x)` calls produce
  byte-identical output across calls, instances, and chains.
- **Structural invariants** — single-mode encodings have bit 0 = 1,
  structured-mode have bit 0 = 0, no input produces leading `00000`
  (the extension gate).

### `unit.test.js` — direct utility tests

Direct tests for every function exported from `src/utils.js`:
- `bits(n)` at every bit-width edge
- `tobits` / `frombits` round-trip
- `getPrecision` for every numeric form
- `escapeKey` / `parsePath` round-trip across every special character
- `strmap` / `strmap_rev` / `base64` / `base64_rev` charmap consistency

These exist alongside the integration tests so a helper bug surfaces with
a localized error rather than a confusing round-trip failure.

### `api.test.js` — public API surface

Every public method, constructor mode, and parameter form:
- `enc(json)` and `dec(buf)` convenience functions
- `ARJSON({ json })`, `ARJSON({ arj })`, `ARJSON({ table })`
- `ARJSON#update`, `ARJSON#toBuffer`, `ARJSON#table`
- `ARJSON.fromBuffer`, `ARJSON.toBuffer` static methods
- Low-level `Encoder`, `Decoder`, `Builder`, `ARTable`
- Cross-validation: encoder/decoder round-trip from every entry point

Pins down API contracts so optimizations can't silently change semantics
even if they preserve round-trip.

### `matrix.test.js` — cartesian-product coverage

Exhaustive (value × position × operation) coverage:
- Every value class round-trips at every container position (bare,
  `{wrap}`, `[wrap]`, `[1, ...]`, `{a, ...}`, `{nested: {wrap}}`, etc.)
- Every value × every value transition as a delta update
- Array element replace at every index for sizes 1, 2, 5, 10
- Append/delete at every length boundary (0, 1, 2, 3, 4, 7, 8, 15, 16, 31,
  32, 63, 64)
- Object operations: add/delete/replace for every value class
- Nested updates at depths 1–10
- Chains cycling through every value class at root, in object, in array
- Number bit-width boundaries: every (2^k - 1, 2^k, 2^k + 1) for k = 1..52
- String length boundaries for ASCII, base64url, and non-base64 charsets
- Object key count boundaries and array length boundaries: 0..256

This is the bulk of the optimization safety net. Any encoder change that
breaks any of 922 cells of the matrix surfaces immediately.

## Running

```
npm test                # all 1721 tests, ~17 s
npm test -- -t goal     # run a single test by name (node test runner syntax)
npm run fuzz            # long-running stress (separate)
```

Each test file is independent — running individually:

```
node --test test/golden.test.js
node --test test/matrix.test.js
node --test test/unit.test.js
```

## Strategy for optimization

When optimizing the encoder/decoder:

1. **Run `npm test` before any change.** All 1,721 must pass.
2. **Make the optimization.** Re-run `npm test`.
3. **If `golden.test.js` fails with a size shrink**, that's a win — update
   the lock, commit. If it fails with a size grow, that's a regression —
   investigate.
4. **If `golden.test.js` fails with a byte mismatch but same size**, the
   encoded format changed. Verify intentionally and update the lock, OR
   revert the change.
5. **If `matrix.test.js` fails**, the optimization broke a value class
   somewhere — the failing test name pinpoints which (value × position ×
   operation) combination broke.
6. **If `unit.test.js` fails**, a helper changed semantics. Easiest to
   isolate.
7. **If `api.test.js` fails**, the public contract changed. Either the
   change is intended (update the test) or unintended (revert).
8. **If `fuzz.test.js` fails**, the optimization breaks an invariant —
   the test reports the shrunk-minimal failing input.
9. **`extension-gate.test.js`** must always pass — it's a format-spec
   invariant.

The full suite runs in ~17 seconds, fast enough to gate every optimization
commit.

## What's covered, what's not

**Covered exhaustively:**
- Round-trip for every documented value type at every container position
- Every documented delta operation
- Every documented edge case (empty, deep, wide, special values)
- Every public API surface
- Every utility helper
- Bit-level format invariants (top-bit dispatch, extension gate)
- Determinism under repeated encoding
- Decoder robustness against malformed input

**Not covered (out of scope):**
- Performance characteristics (those are in `bench.js` — separate)
- Multi-threaded / concurrent use (ARJSON is single-threaded)
- CRDT-style concurrent merges (single-writer model — see
  `comparison.md`)
- Format wire-version differences (only v1 exists today; the extension
  gate reservation is documented in `format.md`)

The goal of this test architecture is to make optimization *safe*: a
contributor changing the encoder for performance has 1,721 fast assertions
that catch any unintended behavior change, so they can iterate confidently
on the hot path.
