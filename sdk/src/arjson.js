import { frombits } from "./utils.js"
import { Encoder, encode } from "./encoder.js"
import { Decoder } from "./decoder.js"
import { ARTable } from "./artable.js"
import { mergeLeft, uniq, keys, is, equals, concat } from "ramda"

export const enc = json => encode(json, new Encoder())
export const dec = arj => new Decoder().decode(arj)

// Helpers
const bytes = v => Buffer.byteLength(JSON.stringify(v), "utf8")

// LCS length table for equality via Ramda.equals
function lcsTable(A, B, eq) {
  const n = A.length,
    m = B.length
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = eq(A[i - 1], B[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp
}

// Recover a minimal edit script consisting of 'keep' | 'del' | 'ins'
function lcsEditScript(A, B, eq) {
  const dp = lcsTable(A, B, eq)
  let i = A.length,
    j = B.length
  const rev = []
  while (i > 0 && j > 0) {
    if (eq(A[i - 1], B[j - 1])) {
      rev.push({ t: "keep", a: i - 1, b: j - 1 })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev.push({ t: "del", a: i - 1 })
      i--
    } else {
      rev.push({ t: "ins", b: j - 1 })
      j--
    }
  }
  while (i-- > 0) rev.push({ t: "del", a: i })
  while (j-- > 0) rev.push({ t: "ins", b: j })
  return rev.reverse()
}

function diffArray(a, b, path = "") {
  const ops = []

  // Handle complete array replacement for different types or when more efficient
  if (a.length === 0 && b.length > 0) {
    // Empty to non-empty: just add all elements
    for (let i = 0; i < b.length; i++) {
      ops.push({ path: path + `[${i}]`, to: b[i] })
    }
    return ops
  }

  if (b.length === 0 && a.length > 0) {
    // Non-empty to empty: delete all from back to front
    for (let i = a.length - 1; i >= 0; i--) {
      ops.push({ path: path + `[${i}]`, op: "delete", from: a[i] })
    }
    return ops
  }

  // Find the minimal edit sequence
  const commonLength = Math.min(a.length, b.length)

  // Build operation list by comparing indices
  // First, collect all differences in the overlapping region
  const modifications = []
  for (let i = 0; i < commonLength; i++) {
    if (!equals(a[i], b[i])) {
      modifications.push(i)
    }
  }

  // If the arrays are the same length and we have modifications,
  // just generate delete + insert pairs
  if (a.length === b.length && modifications.length > 0) {
    // Delete from back to front
    for (let i = modifications.length - 1; i >= 0; i--) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, op: "delete", from: a[idx] })
    }
    // Insert from front to back
    for (let i = 0; i < modifications.length; i++) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, to: b[idx] })
    }
    return ops
  }

  // Handle length differences
  if (a.length < b.length) {
    // Array grew: handle modifications in existing region, then add new elements
    for (let i = modifications.length - 1; i >= 0; i--) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, op: "delete", from: a[idx] })
    }
    for (let i = 0; i < modifications.length; i++) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, to: b[idx] })
    }
    // Add new elements at the end
    for (let i = a.length; i < b.length; i++) {
      ops.push({ path: path + `[${i}]`, to: b[i] })
    }
  } else {
    // Array shrank: delete extras first, then handle modifications
    // Delete from back to front
    for (let i = a.length - 1; i >= b.length; i--) {
      ops.push({ path: path + `[${i}]`, op: "delete", from: a[i] })
    }
    // Then handle modifications in remaining region
    for (let i = modifications.length - 1; i >= 0; i--) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, op: "delete", from: a[idx] })
    }
    for (let i = 0; i < modifications.length; i++) {
      const idx = modifications[i]
      ops.push({ path: path + `[${idx}]`, to: b[idx] })
    }
  }

  return ops
}

const diff = (a, b, path = "", depth = 0) => {
  let q = []
  if (equals(a, b)) return q

  // Primitives / non-objects → replace
  if (!is(Object, a) || !is(Object, b)) {
    return [{ path, op: "replace", from: a, to: b }]
  }

  // Arrays → LCS-based diffing
  if (Array.isArray(a) && Array.isArray(b)) {
    return diffArray(a, b, path)
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    // Array vs non-array → replace
    return [{ path, op: "replace", from: a, to: b }]
  }

  // Objects → recurse on keys (unchanged)
  const keys_a = keys(a)
  const keys_b = keys(b)
  const _keys = uniq([...keys_a, ...keys_b])
  for (let v of _keys) {
    let _path = path
    if (_path !== "") _path += "."
    _path += v
    if (typeof a[v] === "undefined") {
      q.push({ path: _path, op: "new", to: b[v] })
    } else if (typeof b[v] === "undefined") {
      q.push({ path: _path, op: "delete", from: a[v] })
    } else if (!equals(a[v], b[v])) {
      q = q.concat(diff(a[v], b[v], _path, depth + 1))
    }
  }
  return q
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
      this.deltas = this.fromBuffer(arj)
      d.decode(this.deltas[0])
      this.artable = new ARTable(d.table())
      this.json = this.artable.build()
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
      this.artable = new ARTable(d.table())
      this.deltas = [arj]
    }
  }
  update(json) {
    let deltas = []
    const diffs = diff(this.json, json)
    console.log("diffs", diffs)
    for (const v of diffs) {
      console.log()
      console.log("[new op]", v, "====================================")
      if (
        v.path === "" &&
        (!is(Object, v.from) ||
          !is(Object, v.to) ||
          Array.isArray(v.from) ||
          Array.isArray(v.to))
      ) {
        const u = new Encoder()
        u.reset(this.artable.strmap)
        const newArj = encode(json, u, null, this.artable.strmap)
        deltas.push(newArj)
        const d = new Decoder()
        d.decode(newArj, null, this.artable.strmap)
        this.artable.strmap = mergeLeft(u.strMap, this.artable.strmap)
        this.json = d.json
        this.artable.strmap = this.artable.strmap
        continue
      }
      const result = this.artable.delta(v.path, v.to, v.op, v.push)
      this.load(result.delta)
    }
  }
  load(delta) {
    this.json = this.artable.update(delta).json
    this.deltas.push(delta)
    delete this.cache
  }
  fromBuffer(buffer) {
    const buf = new Uint8Array(buffer)
    let offset = 0
    const deltas = []

    // Read LEB128 length-prefixed deltas
    while (offset < buf.length) {
      // Decode LEB128 length
      let len = 0
      let shift = 0
      let byte
      do {
        byte = buf[offset++]
        len += (byte & 0x7f) * Math.pow(2, shift)
        shift += 7
      } while (byte & 0x80)

      // Extract delta
      const delta = buf.slice(offset, offset + len)
      deltas.push(delta)
      offset += len
    }

    return deltas
  }
  toBuffer() {
    if (this.buflen !== this.deltas.length) {
      const parts = []

      // Add LEB128 length prefix for EVERY delta (including initial at index 0)
      for (const delta of this.deltas) {
        let len = delta.length
        const lenBytes = []
        while (len >= 128) {
          lenBytes.push((len & 0x7f) | 0x80)
          len = Math.floor(len / 128)
        }
        lenBytes.push(len)

        parts.push(new Uint8Array(lenBytes))
        parts.push(delta)
      }

      this.cache = Buffer.concat(parts.map(arr => Buffer.from(arr)))
      this.buflen = this.deltas.length
    }
    return this.cache
  }
  buffer2() {
    if (this.buflen !== this.deltas.length) {
      this.cache = Buffer.concat(this.deltas.map(arr => Buffer.from(arr)))
      this.buflen = this.deltas.length
    }
    return this.cache
  }
  table() {
    return this.artable.table()
  }
}
