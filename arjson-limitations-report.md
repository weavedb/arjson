# ARJSON Delta Update — Bug Report & Fix Status

## Status

All four bugs originally tracked in this report have been fixed, plus nine additional encoder/decoder/builder bugs uncovered while building the regression suite. JavaScript test suite: **472 tests passing**, including ~85K iterations of seeded property-based fuzz across multiple depths and shape distributions.

## Fixes

### 1. Empty structures cannot be delta-updated — **FIXED**
**Was:** `new ARJSON({ json: {} }).update({ a: 1 })` produced `{"null":1}`; `new ARJSON({ json: [] }).update([1,2,3])` produced `3`.

**Fix:** `ARJSON.update()` now detects when the current state has no usable column structure (null, primitives, empty `{}`/`[]`) and re-anchors by replacing the delta history with a fresh self-contained encoding of the new JSON. The same path also handles structural transitions at the root (`{a:1} → [1,2,3]`, `[1] → null`, etc.).

`sdk/src/arjson.js` — `isNonStructural`, `update`, `reanchor`.

### 2. Keys with brackets break the path parser — **FIXED**
**Was:** `parsePath("data[2020]")` returned `["data", 2020]`, treating `[2020]` as an array index. Updates to `{"data[2020]": 100}` threw or misrouted.

**Fix:** Path strings now support `\[`, `\]`, and `\\` escape sequences. Whenever paths are emitted internally (`diff` in `arjson.js`, `buildMap`/`getPath` in `artable.js`), object keys are run through `escapeKey` so brackets become escape sequences. End-to-end behavior: any object key — including ones with numeric brackets like `data[2020]` — round-trips and delta-updates correctly. Users never write paths by hand, so no API change is visible.

`sdk/src/utils.js` — `parsePath`, `escapeKey`.
`sdk/src/arjson.js` — `diff` uses `escapeKey`.
`sdk/src/artable.js` — `buildMap` and `getPath` use `escapeKey`.

### 3. Large numbers cause infinite loops or precision loss — **FIXED**
**Was:** Numbers with non-finite values (NaN, ±Infinity) hung the encoder. `getPrecision` mishandled scientific notation, dropping precision for very small/large floats.

**Fix:**
- The encoder now coerces non-finite numbers to `null` at entry (matching JSON spec).
- `getPrecision` now parses scientific-notation `toString()` output (mantissa + exponent) instead of just looking for `.`.
- The integer-vs-float check in the number branch now uses `Number.isInteger(v)` instead of the buggy `v % 1 === v`, which had been treating purely-fractional values like `0.1` as integers.

Verified: `1e-10`, `1e20`, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER+1`, `0.1`, `0.0001` all round-trip correctly.

`sdk/src/encoder.js`, `sdk/src/utils.js`.

### 4. Deep nesting performance — **FIXED (was already fixed)**
At the time of writing, depth 100 round-trips in ~2ms / 187 bytes. The recursive algorithms were never the bottleneck the original report suggested; the constraint may have applied to an older revision.

## Bonus fixes

While building the regression suite (~420 tests, including ~10K-iteration property fuzz), the following encoder/decoder bugs surfaced and were fixed:

### 5. Builder's parent-walk used a wrong indexing scheme
`getKey` in `builder.js` recursed via `obj.krefs[d - 1]` (double-deref into krefs), while `buildMap` in `artable.js` walked via `krefs[p - 2]` (single-deref). The two coincided for fresh encodings but diverged after delta-added entries. Symptom: a new array element added after a new object key in the same delta batch was misrouted into the wrong parent. Fix: recurse on `d` directly. `sdk/src/builder.js`.

### 6. Number type-pack used a hardcoded type
The `_encode` number branch checked `prev_type[0] !== 4` instead of `prev_type[0] !== type`, type-packing negative integers (type 5) as if they were positive (type 4). Symptom: `{i: 42, ni: -7}` decoded `i` as `-42`. Fix: use the dynamically computed `type` like the other branches. `sdk/src/encoder.js`.

### 7. Boolean replace decoded as `undefined`
`getBools` in `decoder.js` read `_v[2]` (the `remove` field) instead of `_v[3]` (the actual value type) when handling indexed-replace vtypes. Symptom: `[null] → [true]` round-tripped to `[null]` (the bool was never read out of the bool column). Fix: use `_v[3]`. `sdk/src/decoder.js`.

### 8. Mixed primitive/non-primitive array element changes
`diffArray` emitted delete-then-add ops for non-primitive replacements, but the encoder loses the parent index for complex values, so later elements got misrouted. Fix: any non-primitive change in modifications, or a length change with a complex element added/removed, falls back to a single root-level `replace` op for the array. Empty inner array → array containing any object/array also full-replaces. `sdk/src/arjson.js`.

### 9. `replace` of a complex value at a non-root path
The encoder's `_encode` loses parent-index info when descending into arrays/objects, so a delta that says "replace value at path P with this complex value" would not actually replace — it would append. Symptom: `{y:[obj], z:[]} → {y:target}` left y with the old contents plus the new ones concatenated. Fix: at the `update()` level, any `replace` op with a complex (non-null Object) target re-anchors the whole tree. `sdk/src/arjson.js`.

### 10. Builder's `init` map went stale across vrefs
The build loop's create-vs-navigate branches used `obj.arrs[k2[3]] !== true` to gate the "create new array" path. But `obj.arrs` is set during `getKey` *before* `build` runs, so the gate was always closed and we always navigated into the last existing element. Symptom: sibling arrays of complex values (e.g. `{a:[[{}], [{}]]}`) collapsed into a single nested array. Fix: drop the `obj.arrs` gate; rely on `init`/`reset`. The else-if branches that navigate into existing structure now also `set(k2)` so subsequent vrefs see consistent init state. `sdk/src/builder.js`.

### 11. Float/precision encoding edge cases
`getPrecision("1e-10".toString())` returned 0 because the function only looked for `.`, missing scientific notation. Combined with `Math.pow(10, moved)` overflowing for very-small inputs and `v % 1 === v` mis-classifying `0.1` as integer, small floats round-tripped to 0. Fix: parse mantissa/exponent in `getPrecision`, use `Number.isInteger(v)`, clamp `moved` to 308, `Math.round` before integer extraction, coerce non-finite to `null` at encoder entry. `sdk/src/encoder.js`, `sdk/src/utils.js`.

### 12. `enc()` crashed on single-character strings without a strmap
`encode(v, new Encoder())` (no strmap arg) passed `undefined` as `strmap`, then `strmap[v]` for single-char strings threw. Fix: `strmap ??= {}`. `sdk/src/encoder.js`.

### 13. `ARJSON({table})` lost primitive root values
A primitive root (`42`, `"x"`, `true`, `[]`, `{}`, etc.) gets a single-mode encoding whose decoded `table()` is empty in every column. The `{table}` constructor then called `build()` on the empty table and got `null` back, regardless of the original value. Fix: thread an optional `single` field through `decoder.table()` → `ARTable` constructor → `ARTable.build()`, and have the `{json}`/`{arj}`/`reanchor()` paths populate it when `decoder.single` is true. The primitive value is now preserved across `{table}` reconstructions. `sdk/src/arjson.js`, `sdk/src/artable.js`.

## Non-issues (working as designed, follow JSON spec)

- `undefined`, `NaN`, `Infinity` are not valid JSON. `undefined` is dropped; `NaN`/`Infinity` are coerced to `null`.
- Circular references are rejected by `JSON.stringify` upstream.
- Sparse arrays are densified.
- `-0` and `0` are equivalent.

## Remaining limitation

- Object keys containing literal `.` characters are still ambiguous with nested-key path syntax (`{"a.b": 1}` indexes into `keymap["a.b"]`, same as `{a: {b: 1}}`). This was not in the original report and would require dot-escaping in paths to fix. Out of scope for this round.
