import { Encoder, encode } from "./encoder.js"
import { Decoder } from "./decoder.js"
import { ARTable } from "./artable.js"
import { escapeKey } from "./utils.js"
import { mergeLeft, uniq, keys, is, equals, concat } from "ramda"
import fastDiff from "fast-diff"
import { encodeFastDiff } from "./diff.js"

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

function diffArray(a, b, path = "") {
  const ops = []

  if (a.length === 0 && b.length > 0) {
    const hasComplex = b.some(v => is(Object, v) && v !== null)
    if (hasComplex) {
      return [{ path, op: "replace", from: a, to: b }]
    }
    for (let i = 0; i < b.length; i++) {
      ops.push({ path: path + `[${i}]`, to: b[i] })
    }
    return ops
  }

  if (b.length === 0 && a.length > 0) {
    for (let i = a.length - 1; i >= 0; i--) {
      ops.push({ path: path + `[${i}]`, op: "remove", from: a[i] })
    }
    return ops
  }

  const commonLength = Math.min(a.length, b.length)
  const modifications = []

  for (let i = 0; i < commonLength; i++) {
    if (!equals(a[i], b[i])) {
      modifications.push(i)
    }
  }

  const hasNonPrim = modifications.some(
    i => (is(Object, b[i]) && b[i] !== null) || (is(Object, a[i]) && a[i] !== null),
  )
  if (hasNonPrim) {
    return [{ path, op: "replace", from: a, to: b }]
  }

  if (a.length !== b.length) {
    const tail = a.length < b.length ? b.slice(a.length) : []
    const head = a.length > b.length ? a.slice(b.length) : []
    const hasComplex = [...tail, ...head].some(
      v => is(Object, v) && v !== null,
    )
    if (hasComplex) {
      return [{ path, op: "replace", from: a, to: b }]
    }
  }

  if (a.length > b.length) {
    for (let i = a.length - 1; i >= b.length; i--) {
      ops.push({ path: path + `[${i}]`, op: "remove", from: a[i] })
    }
  }

  for (let i = modifications.length - 1; i >= 0; i--) {
    const idx = modifications[i]
    const isPrimitive = !is(Object, b[idx]) || b[idx] === null

    if (isPrimitive) {
      if (shouldUseDiff(a[idx], b[idx])) {
        ops.push({
          path: path + `[${idx}]`,
          op: "diff",
          from: a[idx],
          to: b[idx],
          diffs: fastDiff(a[idx], b[idx]),
        })
      } else {
        ops.push({
          path: path + `[${idx}]`,
          op: "replace",
          from: a[idx],
          to: b[idx],
        })
      }
    } else {
      ops.push({ path: path + `[${idx}]`, op: "remove", from: a[idx] })
    }
  }

  for (let i = 0; i < modifications.length; i++) {
    const idx = modifications[i]
    const isPrimitive = !is(Object, b[idx]) || b[idx] === null
    if (!isPrimitive) {
      ops.push({ path: path + `[${idx}]`, to: b[idx] })
    }
  }

  if (a.length < b.length) {
    for (let i = a.length; i < b.length; i++) {
      ops.push({ path: path + `[${i}]`, to: b[i] })
    }
  }

  return ops
}

const diff = (a, b, path = "", depth = 0) => {
  let q = []
  if (equals(a, b)) return q

  if (!is(Object, a) || !is(Object, b)) {
    if (shouldUseDiff(a, b)) {
      return [{ path, op: "diff", from: a, to: b, diffs: fastDiff(a, b) }]
    }
    return [{ path, op: "replace", from: a, to: b }]
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return diffArray(a, b, path)
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return [{ path, op: "replace", from: a, to: b }]
  }

  // Object → empty {} transition: emit a replace rather than a sequence of
  // deletes. Otherwise the artable's compactKeys() removes the parent key
  // along with its drained sub-tree, leaving "key with empty-object value"
  // indistinguishable from "no key at all" — fragile under subsequent
  // updates.
  if (Object.keys(b).length === 0 && Object.keys(a).length > 0) {
    return [{ path, op: "replace", from: a, to: b }]
  }

  const keys_a = keys(a)
  const keys_b = keys(b)
  const _keys = uniq([...keys_a, ...keys_b])
  for (let v of _keys) {
    let _path = path
    if (_path !== "") _path += "."
    _path += escapeKey(v)
    if (typeof a[v] === "undefined") {
      q.push({ path: _path, op: "add", to: b[v] })
    } else if (typeof b[v] === "undefined") {
      q.push({ path: _path, op: "remove", from: a[v] })
    } else if (!equals(a[v], b[v])) {
      q = q.concat(diff(a[v], b[v], _path, depth + 1))
    }
  }
  return q
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
