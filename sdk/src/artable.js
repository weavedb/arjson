import { parsePath, bits, frombits } from "./utils.js"
import { Encoder, _encode, pushPathStr } from "./encoder.js"
import { Decoder } from "./decoder.js"
import { Builder, getVal } from "./builder.js"
import { mergeLeft, includes, sortBy } from "ramda"

class ARTable {
  table() {
    return {
      vrefs: this.vrefs,
      krefs: this.krefs,
      ktypes: this.ktypes,
      keys: this.keys,
      vtypes: this.vtypes,
      bools: this.bools,
      nums: this.nums,
      strs: this.strs,
      strmap: this.strmap,
      strdiffs: this.strdiffs,
    }
  }

  constructor({
    ktypes,
    keys,
    vtypes,
    bools,
    nums,
    strs,
    vrefs,
    krefs,
    strmap,
    strdiffs,
  }) {
    this.strmap = strmap
    this.ktypes = ktypes
    this.vrefs = vrefs
    this.krefs = krefs
    this.vtypes = vtypes
    this.nums = nums
    this.strs = strs
    this.bools = bools
    this.keys = keys
    this.strdiffs = strdiffs
    this.buildMap()
  }
  compact(t1, t2) {
    const stats = {}
    let i = 0
    let nc = 0
    let sc = 0
    let bc = 0
    const pmap = {}
    const getP = (t1, v, arr) => {
      arr.push({ i: v - 2, v: t1.krefs[v - 2] ?? null })
      if (t1.krefs[v - 2]) getP(t1, t1.krefs[v - 2], arr)
    }
    let i3 = 0
    for (const v of t1.vrefs) {
      if (!pmap[v]) {
        pmap[v] = { indexes: {} }
        let arr = []
        getP(t1, v, arr)
        pmap[v].arr = arr
      }
      pmap[v].indexes[i3] = true
      i3++
    }
    for (let k in pmap) {
      pmap[k].vs = {}
      for (let v of pmap[k].arr) pmap[k].vs[v.i] = true
    }
    const imap = {}
    for (const v of t1.vrefs) {
      imap[v] ??= []
      imap[v].push(i)
      const vtype = t1.vtypes[i]
      if (typeof vtype === "number") {
        if (includes(vtype, [4, 5, 6]))
          stats[i] = { vtype: "nums", i: nc, val: t1.nums[nc++] }
        else if (includes(vtype, [2, 7]))
          stats[i] = { vtype: "strs", i: sc, val: t1.strs[sc++] }
        else if (vtype === 3)
          stats[i] = { vtype: "bools", i: bc, val: t1.bools[bc++] }
        else if (vtype === 0) {
          stats[i] = { vtype: "delete" }
        }
      } else if (Array.isArray(vtype)) {
        if (vtype[0] === 3) {
          stats[i] = { vtype: "delete" }
        } else if (vtype[0] === 2) {
          if (includes(vtype[3], [4, 5, 6]))
            stats[i] = { vtype: "nums", i: nc, val: t1.nums[nc++] }
          else if (includes(vtype[3], [2, 7]))
            stats[i] = { vtype: "strs", i: sc, val: t1.strs[sc++] }
          else if (vtype[3] === 3)
            stats[i] = { vtype: "bools", i: bc, val: t1.bools[bc++] }
        }
      }
      i++
    }

    const removal = { vrefs: {}, vtypes: {} }
    let removed = {}
    const remove = i2 => {
      removal.vrefs[i2] = true
      removal.vtypes[i2] = true
      if (stats[i2] && stats[i2].vtype !== "delete") {
        removal[stats[i2].vtype] ??= {}
        removal[stats[i2].vtype][stats[i2].i] = true
      }
      removed[i2] = true
    }
    i = 0
    for (const v of t2.vrefs) {
      const _imap = imap[v] ?? []
      if (t2.vtypes[i] === 0) for (const i2 of _imap) remove(i2)
      i++
    }
    let i2 = 0

    for (const v of t1.vtypes) {
      if (v === 0) {
        remove(i2)
        const ki = t1.vrefs[i2] - 2
        for (let k in pmap) {
          if (pmap[k].vs[ki]) {
            for (let k2 in pmap[k].indexes) if (removed[k2] !== true) remove(k2)
          }
        }
      }
      i2++
    }
    for (let k in removal) {
      let arr = []
      let i = 0
      if (t1[k]) {
        for (let v of t1[k]) {
          if (!removal[k][i]) arr.push(v)
          i++
        }
        t1[k] = arr
      }
    }
    for (const v in t2) {
      if (Array.isArray(t2[v])) this[v] = t1[v].concat(t2[v])
      else this[v] = mergeLeft(t2[v], t1[v])
    }
    this.compactKeys()
  }
  compactKeys() {
    let t = this.table()
    const _keys = {}
    const getP = (t1, v) => {
      if (typeof t1.krefs[v - 2] !== "undefined") {
        _keys[v - 2] = true
        getP(t1, t1.krefs[v - 2])
      }
    }
    for (const v of t.vrefs) getP(t, v)

    const indexMap = {}
    let newIndex = 0

    if (t.ktypes.length > 0) {
      indexMap[-1] = -1
      newIndex = 0
    }

    for (let i = 0; i < t.krefs.length; i++) {
      if (_keys[i]) {
        indexMap[i] = newIndex
        newIndex++
      }
    }

    let i = 0
    let krefs = []
    let ktypes = []
    let keys = []

    if (t.ktypes.length > 0) {
      ktypes.push(t.ktypes[0])
      keys.push(t.keys[0])
    }

    for (const v of t.krefs) {
      if (_keys[i]) {
        const remappedRef =
          typeof indexMap[v - 2] !== "undefined" ? indexMap[v - 2] + 2 : v
        krefs.push(remappedRef)
        ktypes.push(t.ktypes[i + 1])
        keys.push(t.keys[i + 1])
      }
      i++
    }

    const vrefs = t.vrefs.map(v => {
      const oldIndex = v - 2
      return typeof indexMap[oldIndex] !== "undefined"
        ? indexMap[oldIndex] + 2
        : v
    })

    this.krefs = krefs
    this.ktypes = ktypes
    this.keys = keys
    this.vrefs = vrefs
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
        let k = this.keys[p - 1]
        if (Array.isArray(k) && k.length === 1 && typeof k[0] === "number") {
          k = this.strmap[k[0].toString()]
        }
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

  delta(path, v, op = null, n, diff) {
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
    const push = includes(op, ["delete", "diff", "replace"]) ? 1 : 0
    u.push_type(_encode(v, u, prev, null, index, push, true, op, null, diff))
    return { delta: u.dump(), strmap: u.strMap }
  }
  compactStrMap() {
    let strs = {}
    for (let v of this.keys) if (Array.isArray(v)) strs[v[0]] = true
    for (let v of this.strs) {
      if (Array.isArray(v) && v[0] !== -1) {
        // <-- Add check: ignore diff entries
        strs[v[0]] = true
      }
    }
    let strs_arr = []
    for (let k in this.strmap) {
      if (strs[k] !== true) {
        delete this.strmap[k]
      } else {
        strs_arr.push({ from: +k, v: this.strmap[k] })
      }
    }
    strs_arr = sortBy(v => v.from, strs_arr)
    let i = 0
    let smap = {}
    let imap = {}
    for (let v of strs_arr) {
      v.to = i++
      smap[v.to] = v.v
      imap[v.from] = v.to
    }
    this.strmap = smap
    for (let v of this.keys) if (Array.isArray(v)) v[0] = imap[v[0]]
    for (let v of this.strs) {
      if (Array.isArray(v) && v[0] !== -1) {
        // <-- Add check: ignore diff entries
        v[0] = imap[v[0]]
      }
    }
  }
  compactStrMap2() {
    let strs = {}
    for (let v of this.keys) if (Array.isArray(v)) strs[v[0]] = true
    for (let v of this.strs) if (Array.isArray(v)) strs[v[0]] = true
    let strs_arr = []
    for (let k in this.strmap) {
      if (strs[k] !== true) {
        delete this.strmap[k]
      } else {
        strs_arr.push({ from: +k, v: this.strmap[k] })
      }
    }
    strs_arr = sortBy(v => v.from, strs_arr)
    let i = 0
    let smap = {}
    let imap = {}
    for (let v of strs_arr) {
      v.to = i++
      smap[v.to] = v.v
      imap[v.from] = v.to
    }
    this.strmap = smap
    for (let v of this.keys) if (Array.isArray(v)) v[0] = imap[v[0]]
    for (let v of this.strs) if (Array.isArray(v)) v[0] = imap[v[0]]
  }

  encode(q) {
    const d3 = new Decoder()
    const left = d3.decode(q, this.krefs.length, this.strmap, this.strdiffs)
    const table = d3.table()
    this.compact(this.table(), table)
    const json = this.build()
    this.buildMap()
    return { left: frombits(left), json }
  }

  build() {
    return new Builder(this.table()).build()
  }

  update(left) {
    let json = null
    while (left.length > 0) ({ left, json } = this.encode(left))
    this.compactStrMap()
    this.buildMap()
    return { json, left }
  }
}

export { ARTable }
