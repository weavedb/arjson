import { frombits } from "./utils.js"
import { Encoder, encode } from "./encoder.js"
import { Decoder, decode } from "./decoder.js"
import { ARTable } from "./artable.js"
import { mergeLeft, uniq, keys, is, equals, concat } from "ramda"

export const enc = json => encode(json, new Encoder())
export const dec = arj => decode(arj, new Decoder())

const diff = (a, b, path = "", depth = 0) => {
  let q = []
  const keys_a = keys(a)
  const keys_b = keys(b)
  const _keys = uniq([...keys_a, ...keys_b])
  if (equals(a, b)) return []
  if (!is(Object, a) || !is(Object, b)) {
    return [{ path, op: "replace", from: a, to: b }]
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return [{ path, op: "replace", from: a, to: b }]

    /* ORIGINAL CODE - commented out
    if (a.length !== b.length) return [{ path, op: "replace", from: a, to: b }]
    const max = Math.max(a.length, b.length)
    let count = 0
    let diff = null
    for (let i = 0; i < max; i++) {
      if (!equals(a[i], b[i])) {
        diff = i
        count++
      }
      if (count > 1) return [{ path, op: "replace", from: a, to: b }]
    }
    const _path = path + `[${diff}]`
    if (is(Object, a[diff]) && is(Object, b[diff])) {
      return diff(a[diff], b[diff], _path, depth + 1)
    } else {
      if (typeof a[diff] === "undefined") {
        return [{ path: _path, op: "new", to: b[diff] }]
      } else if (typeof b[diff] === "undefined") {
        return [{ path: _path, op: "delete", from: a[diff] }]
      } else {
        return [{ path: _path, op: "replace", from: a[diff], to: b[diff] }]
      }
    }
    */
  } else if (Array.isArray(a) || Array.isArray(b))
    return [{ path, op: "replace", from: a, to: b }]
  else {
    for (let v of _keys) {
      let _path = path
      if (_path !== "") _path += "."
      _path += v
      if (typeof a[v] === "undefined") {
        q.push({ path: _path, op: "new", to: b[v] })
      } else if (typeof b[v] === "undefined") {
        q.push({ path: _path, op: "delete", from: a[v] })
      } else if (!equals(a[v], b[v])) {
        q = concat(q, diff(a[v], b[v], _path, depth + 1))
      }
    }
  }
  return q
}

export class ARJSON {
  constructor({ json, arj, table }) {
    const d = new Decoder()
    if (table) {
      this.artable = new ARTable(table)
      this.json = this.artable.build()
    } else if (arj) {
      let left = frombits(d.decode(arj))
      this.artable = new ARTable(d.table())
      while (left.length > 0) {
        ;({ left, json } = this.artable.update(left))
        this.json = json
      }
    } else {
      this.json = json
      arj = enc(json)
      decode(arj, d)
      this.artable = new ARTable(d.table())
    }
    this.deltas = [arj]
  }
  update(new_json) {
    let deltas = []
    for (const v of diff(this.json, new_json)) {
      if (
        v.path === "" &&
        (!is(Object, v.from) ||
          !is(Object, v.to) ||
          Array.isArray(v.from) ||
          Array.isArray(v.to))
      ) {
        const u = new Encoder()
        u.reset(this.artable.strmap)
        const newArj = encode(new_json, u, null, this.artable.strmap)
        deltas.push(newArj)
        const d = new Decoder()
        decode(newArj, d, null, this.artable.strmap)
        this.artable.strmap = mergeLeft(u.strMap, this.artable.strmap)
        this.json = d.json
        this.artable.strmap = this.artable.strmap
        continue
      }
      const { query } = this.artable.query(v.path, v.to)
      this.load(query)
    }
  }
  load(query) {
    const { json } = this.artable.update(query)
    this.json = json
    this.deltas.push(query)
  }
  buffer() {
    return Buffer.concat(this.deltas.map(arr => Buffer.from(arr)))
  }
  table() {
    return this.artable.table()
  }
}
