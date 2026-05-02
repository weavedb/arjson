import { Encoder, encode } from "./encoder.js"
import { Decoder } from "./decoder.js"
import { ARTable } from "./artable.js"
import { escapeKey, equals, isObject } from "./utils.js"
import fastDiff from "fast-diff"
import { encodeFastDiff } from "./diff.js"

// Tiny native helpers replacing the ramda functions we used:
//   uniq(arr)  → Array.from(new Set(arr))
//   is(Object, v) → typeof v === "object" && v !== null  (exposed as isObject)
//   equals(a, b) → utils.equals (deep, NaN-aware, primitive-strict)
const uniq = arr => Array.from(new Set(arr))
const is = (ctor, v) => ctor === Object ? isObject(v) : v instanceof ctor

// Shared singletons reused across calls to avoid Uint32Array reallocation
// per call. Both `encode()` and `decode()` reset internal state at entry,
// and JS's single-threaded execution model means a sync call can't be
// interrupted by another sync call. Async/concurrent callers that want
// isolation can construct their own Encoder/Decoder.
const _sharedEnc = new Encoder()
const _sharedDec = new Decoder()
export const enc = json => encode(json, _sharedEnc)
export const dec = arj => {
  _sharedDec.decode(arj)
  return _sharedDec.json
}

// ── diff helpers ─────────────────────────────────────────────────────────

const isPrimitive = v => !is(Object, v) || v === null
const hasNonPrimitive = arr => arr.some(v => !isPrimitive(v))

// shouldUseDiff: decide whether a string change is worth encoding as a
// fast-diff (Myers diff) op vs a full replace. Threshold: both sides
// must be ≥ 20 chars and the change-size must be < 60% of `to` length.
// Below threshold the overhead of encoding the diff outweighs the
// savings of not re-emitting the full new string.
function shouldUseDiff(from, to) {
  if (typeof from !== "string" || typeof to !== "string") return false
  if (from.length < 20 || to.length < 20) return false
  const diffs = fastDiff(from, to)
  let changeSize = 0
  for (const [op, text] of diffs) {
    if (op !== fastDiff.EQUAL) changeSize += text.length
  }
  return changeSize < to.length * 0.6
}

// Build a single-element op list — used for several "fall back to full
// replace" cases that detect this pair can't be incrementally diffed.
const replaceOp = (path, from, to) => [{ path, op: "replace", from, to }]

// Emit the right shape for a primitive-element scalar change: a "diff"
// op when the strings are big enough to benefit from Myers, else a
// "replace" op.
function primitiveChangeOp(path, from, to) {
  if (shouldUseDiff(from, to)) {
    return { path, op: "diff", from, to, diffs: fastDiff(from, to) }
  }
  return { path, op: "replace", from, to }
}

// ── diffArray: per-element diff for two same-shape arrays ────────────────
//
// Special cases that fall back to full-array replace:
//   - an empty-to-non-empty or non-empty-to-empty transition with
//     non-primitive elements (in either side)
//   - any modified position whose `a` or `b` is non-primitive
//   - a length change where the head/tail overhang contains non-primitives
//
// Otherwise the per-element delta is structured as: deletes from the
// tail (high index → low), per-position replaces (high → low), then
// per-position adds (low → high), then appends to fill new length.
function diffArray(a, b, path = "") {
  // Empty-to-non-empty: per-index add unless any element is non-primitive.
  if (a.length === 0 && b.length > 0) {
    if (hasNonPrimitive(b)) return replaceOp(path, a, b)
    return b.map((v, i) => ({ path: `${path}[${i}]`, to: v }))
  }
  // Non-empty-to-empty: per-index remove (high → low for stable indexing).
  if (b.length === 0 && a.length > 0) {
    const ops = []
    for (let i = a.length - 1; i >= 0; i--) {
      ops.push({ path: `${path}[${i}]`, op: "remove", from: a[i] })
    }
    return ops
  }

  // Find changed positions in the common prefix.
  const commonLen = Math.min(a.length, b.length)
  const modifications = []
  for (let i = 0; i < commonLen; i++) {
    if (!equals(a[i], b[i])) modifications.push(i)
  }

  // If any modified position has a non-primitive on either side, fall
  // back to whole-array replace — partial diffs of nested objects/arrays
  // within an array slot are too brittle.
  for (const i of modifications) {
    if (!isPrimitive(b[i]) || !isPrimitive(a[i])) return replaceOp(path, a, b)
  }

  // Length-change fallback: if the head/tail overhang carries any
  // non-primitive, replace the whole array.
  if (a.length !== b.length) {
    const overhang = a.length < b.length
      ? b.slice(a.length)
      : a.slice(b.length)
    if (hasNonPrimitive(overhang)) return replaceOp(path, a, b)
  }

  const ops = []

  // Pass 1: tail removes (stable: high → low so prior indices don't shift).
  if (a.length > b.length) {
    for (let i = a.length - 1; i >= b.length; i--) {
      ops.push({ path: `${path}[${i}]`, op: "remove", from: a[i] })
    }
  }

  // Pass 2: per-position primitive changes (high → low).
  for (let i = modifications.length - 1; i >= 0; i--) {
    const idx = modifications[i]
    if (isPrimitive(b[idx])) {
      ops.push({ path: `${path}[${idx}]`, ...primitiveChangeOp("", a[idx], b[idx]) })
    } else {
      ops.push({ path: `${path}[${idx}]`, op: "remove", from: a[idx] })
    }
  }

  // Pass 3: re-insert non-primitives at modified positions (low → high).
  for (const idx of modifications) {
    if (!isPrimitive(b[idx])) {
      ops.push({ path: `${path}[${idx}]`, to: b[idx] })
    }
  }

  // Pass 4: appends to grow the array.
  if (a.length < b.length) {
    for (let i = a.length; i < b.length; i++) {
      ops.push({ path: `${path}[${i}]`, to: b[i] })
    }
  }

  return ops
}

// ── diff: top-level recursive diff (objects/arrays/primitives) ───────────
const diff = (a, b, path = "") => {
  if (equals(a, b)) return []

  // Primitive on either side → full replace (or string-diff if eligible).
  if (isPrimitive(a) || isPrimitive(b)) {
    if (shouldUseDiff(a, b)) {
      return [{ path, op: "diff", from: a, to: b, diffs: fastDiff(a, b) }]
    }
    return replaceOp(path, a, b)
  }

  // Two arrays → per-element diff.
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path)

  // Array vs object (mixed types) → full replace.
  if (Array.isArray(a) || Array.isArray(b)) return replaceOp(path, a, b)

  // Object → empty {} transition: emit replace rather than per-key
  // removes. Otherwise compactKeys() in the artable would drop the
  // parent key along with its drained subtree, making "key with empty-
  // object value" indistinguishable from "no key at all" — fragile
  // under subsequent updates.
  if (Object.keys(b).length === 0 && Object.keys(a).length > 0) {
    return replaceOp(path, a, b)
  }

  // Per-key object diff: union of keys, dispatch per-key.
  const allKeys = uniq([...Object.keys(a), ...Object.keys(b)])
  const ops = []
  for (const v of allKeys) {
    const _path = path === "" ? escapeKey(v) : `${path}.${escapeKey(v)}`
    if (typeof a[v] === "undefined") {
      ops.push({ path: _path, op: "add", to: b[v] })
    } else if (typeof b[v] === "undefined") {
      ops.push({ path: _path, op: "remove", from: a[v] })
    } else if (!equals(a[v], b[v])) {
      const sub = diff(a[v], b[v], _path)
      for (const op of sub) ops.push(op)
    }
  }
  return ops
}

function isNonStructural(v) {
  if (v === null) return true
  if (typeof v !== "object") return true
  if (Array.isArray(v)) return v.length === 0
  return Object.keys(v).length === 0
}

export class ARJSON {
  constructor({ json, arj, table }) {
    this.buflen = 0
    const d = new Decoder()
    if (table) {
      this.artable = new ARTable(table)
      this.json = this.artable.build()
      this.deltas = []
    } else if (arj) {
      this.deltas = ARJSON.fromBuffer(arj)
      d.decode(this.deltas[0])
      const table = d.table()
      if (d.single) table.single = d.json
      this.artable = new ARTable(table)
      this.json = d.single ? d.json : this.artable.build()
      if (this.deltas.length > 0) {
        for (const v of this.deltas.slice(1)) {
          ;({ json } = this.artable.update(v))
          this.json = json
        }
      }
    } else {
      this.json = json
      arj = enc(json)
      d.decode(arj)
      const table = d.table()
      if (d.single) table.single = d.json
      this.artable = new ARTable(table)
      this.deltas = [arj]
    }
  }
  table() {
    return this.artable.table()
  }
  update(json) {
    if (isNonStructural(this.json) && !equals(this.json, json)) {
      return this.reanchor(json)
    }
    let deltas = []
    const diffs = diff(this.json, json)
    for (const v of diffs) {
      let _diff =
        v.op === "diff" ? encodeFastDiff(v.diffs, this.artable.strmap) : null
      if (v.path === "") {
        return this.reanchor(json)
      }
      if (
        v.op === "replace" &&
        is(Object, v.to) &&
        v.to !== null
      ) {
        return this.reanchor(json)
      }
      const delta = this.load(
        this.artable.delta(v.path, v.to, v.op, 1, _diff).delta,
      )
      deltas.push(delta)
    }
    return deltas
  }

  reanchor(json) {
    const fresh = enc(json)
    const d = new Decoder()
    d.decode(fresh)
    const table = d.table()
    if (d.single) table.single = d.json
    this.artable = new ARTable(table)
    this.json = d.json
    this.deltas = [fresh]
    this.buflen = 0
    delete this.cache
    return [fresh]
  }
  load(delta) {
    this.json = this.artable.update(delta).json
    this.deltas.push(delta)
    delete this.cache
    return delta
  }
  static fromBuffer(buffer) {
    const buf = new Uint8Array(buffer)
    let offset = 0
    const deltas = []

    while (offset < buf.length) {
      let len = 0
      let shift = 0
      let byte
      do {
        byte = buf[offset++]
        len += (byte & 0x7f) * Math.pow(2, shift)
        shift += 7
      } while (byte & 0x80)

      const delta = buf.slice(offset, offset + len)
      deltas.push(delta)
      offset += len
    }

    return deltas
  }
  static toBuffer(deltas) {
    let totalSize = 0
    const lenBytesArray = []

    for (const delta of deltas) {
      const lenBytes = []
      let len = delta.length
      while (len >= 128) {
        lenBytes.push((len & 0x7f) | 0x80)
        len = Math.floor(len / 128)
      }
      lenBytes.push(len)
      lenBytesArray.push(lenBytes)
      totalSize += lenBytes.length + delta.length
    }

    const buffer = Buffer.allocUnsafe(totalSize)
    let offset = 0

    for (let i = 0; i < deltas.length; i++) {
      for (const byte of lenBytesArray[i]) buffer[offset++] = byte
      buffer.set(deltas[i], offset)
      offset += deltas[i].length
    }

    return buffer
  }
  toBuffer() {
    if (this.buflen !== this.deltas.length) {
      this.cache = ARJSON.toBuffer(this.deltas)
      this.buflen = this.deltas.length
    }
    return this.cache
  }
}

