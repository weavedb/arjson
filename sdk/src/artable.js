import { parsePath, bits, frombits } from "./utils.js"
import { Encoder, encode, _encode, pushPathStr } from "./encoder.js"
import { decode, Decoder } from "./decoder.js"
import { Builder, getVal } from "./builder.js"
import { mergeLeft } from "ramda"

class ARTable {
  table() {
    return {
      vrefs: this.vrefs,
      krefs: this.krefs,
      ktypes: this.ktypes,
      keys: this.keys,
      types: this.types,
      bools: this.bools,
      nums: this.nums,
      strs: this.strs,
      strmap: this.strmap,
    }
  }

  constructor({
    ktypes,
    keys,
    types,
    bools,
    nums,
    strs,
    vrefs,
    krefs,
    strmap,
  }) {
    this.strmap = strmap
    this.ktypes = ktypes
    this.vrefs = vrefs
    this.krefs = krefs
    this.types = types
    this.nums = nums
    this.strs = strs
    this.bools = bools
    this.keys = keys
    this.buildMap()
  }

  buildMap() {
    this.keymap = {}
    this.nc = 0
    this.bc = 0
    this.sc = 0
    this.kmap = {}
    this.vk = []
    let vi = -1
    for (const v of this.vrefs) {
      vi++
      let vk = []
      let p = v
      do {
        vk.unshift(p)
        p = this.krefs[p - 2]
      } while (typeof p !== "undefined")
      this.vk.push(vk)
    }
    let prev = null
    let i3 = 0
    for (const v of this.vk) {
      const val = getVal(i3, this)
      let path = ""
      let i4 = 0
      let _prev = null
      for (const p of v) {
        let type = null
        const k = this.keys[p - 1]
        if (Array.isArray(k)) type = "op"
        else if (typeof k === "number")
          type = this.ktypes[p - 1][0] === 0 ? "arr" : "map"
        else type = "str"
        if (typeof this.kmap[p] === "undefined") {
          this.kmap[p] = {
            count: 0,
            type,
            index: this.kmap[prev]?.count ?? null,
            parent: _prev,
          }
          if (
            prev !== null &&
            (this.kmap[prev]?.type === "arr" || this.kmap[prev]?.type === "map")
          ) {
            this.kmap[prev].count++
          }
        }
        if (type === "str") {
          if (path !== "") path += "."
          path += k
          this.kmap[p].path = path
        } else if (this.kmap[_prev]?.type === "arr") {
          path += `[${this.kmap[p].index}]`
          this.kmap[p].path = path
        }
        _prev = p
        prev = p
        i4++
      }
      if (this.kmap[prev]?.type === "arr") {
        if (typeof val.__index__ !== "undefined") path += `[${val.__index__}]`
        else path += `[${this.kmap[prev].count}]`
      }

      if (
        prev !== null &&
        this.kmap[prev]?.type === "arr" &&
        typeof val.__index__ === "undefined"
      ) {
        this.kmap[prev].count++
      }
      i3++
    }
    for (let k in this.kmap) {
      const km = this.kmap[k]
      if (km.type === "arr" || km.type === "map") {
        if (typeof this.kmap[km.parent] !== "undefined") {
          this.kmap[km.parent].val_type = km.type
        }
      }
    }

    for (let k in this.kmap) {
      const km = this.kmap[k]
      if (typeof km.path !== "undefined") {
        this.keymap[km.path] = {
          index: k * 1,
          type: km.type,
          val_type: km.val_type,
          parent: km.parent,
        }
      }
    }
  }

  getPath(paths, last = 1) {
    let _path = ""
    for (let i = 0; i < paths.length - last; i++) {
      const v = paths[i]
      if (typeof v === "string") {
        if (i !== 0) _path += "."
        _path += v
      } else _path += `[${v}]`
    }
    return _path
  }

  getIndex(paths, last = 1) {
    let p = this.getPath(paths, last)
    let index = null
    if (p === "") index = 0
    else {
      const km = this.keymap[p]
      if (typeof km === "undefined") return null
      index = km.index
    }
    return index
  }

  query(path, v, op = null, n) {
    const u = new Encoder(n)
    u.reset(this.strmap)
    u.single = false
    u.dcount = this.krefs.length + 1
    u.prev_bits = bits(u.dcount + 1)
    u.prev_kbits = bits(u.dcount + 1)
    const paths = parsePath(path)
    let last = paths[paths.length - 1]
    let index = null
    let prev = null
    if (typeof last === "undefined") prev = -1
    else if (typeof last === "number") {
      prev = this.getIndex(paths)
      if (prev === null) return null
      index = last
    } else {
      prev = this.getIndex(paths, 0)
      if (prev !== null) prev -= 1
      else {
        const i = this.getIndex(paths)
        if (i === null) return null
        prev = u.dcount
        pushPathStr(u, last, i)
      }
    }
    u.push_type(_encode(v, u, prev, null, index, null, true, op))
    return { query: u.dump(), strmap: u.strMap }
  }

  encode(obj, q) {
    const d3 = new Decoder()
    const left2 = d3.decode(q, obj.krefs.length, null, this.strmap)
    const d4 = new ARTable(obj)
    let artable = []
    for (const v of [
      "vrefs",
      "krefs",
      "ktypes",
      "keys",
      "types",
      "bools",
      "nums",
      "strs",
    ]) {
      d4[v] = d4[v].concat(d3[v])
      artable[v] = d4[v]
      this[v] = d4[v]
    }
    d4.strmap = mergeLeft(d3.strmap, d4.strmap)
    artable.strmap = d4.strmap
    this.strmap = d4.strmap
    const builder = new Builder(this.table())
    const json = builder.build()
    artable = builder.table()
    return { left: frombits(left2), json, artable }
  }
  build() {
    const builder = new Builder(this.table())
    return builder.build()
  }

  update(q, artable, len, n) {
    artable ??= this.table()
    if (!q) return null
    let res = null
    let _json = null
    let i = 0
    let left = null
    do {
      res = this.encode(artable, q)
      _json = res.json
      q = res.left
      left = res.left
      artable = res.artable
      i++
    } while (q.length > 0 && typeof len === "number" && i < len)
    this.buildMap()
    return { json: _json, left, artable }
  }
}

export { ARTable }
