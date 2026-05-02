import { parsePath, escapeKey, bits } from "./utils.js"
import { Encoder, _encode, pushPathStr } from "./encoder.js"
import { Decoder } from "./decoder.js"
import { Builder, getVal } from "./builder.js"
import { mergeLeft, includes, sortBy } from "ramda"

class ARTable {
  table() {
    const t = {
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
    if ("single" in this) t.single = this.single
    return t
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
    single,
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
    if (typeof single !== "undefined") this.single = single
    this.compactStrMap()
    this.buildMap()
  }
  // ── compact() — apply delta table t2 onto base table t1 ────────────────
  //
  // The delta semantics: vtypes in t2 may carry deletion markers
  // (vtype === 0 or vtype[0] === 3) that should remove corresponding
  // entries in t1. Plain values in t2 are concatenated. Cascading
  // deletions propagate up the kref chain when an entire subtree is
  // dropped.
  //
  // Implementation is split into 5 helpers (was a 100-line god function):
  //   1. _buildParentMap  — for each vref in t1, map kref index → ancestor set
  //   2. _buildValueStats — for each vref index, stash (column, position, val)
  //   3. _markRemovals    — find deletions in t2 and t1, propagate cascades
  //   4. _filterColumns   — drop removed entries from t1 columns
  //   5. _mergeTables     — concat/merge t2 into t1 (then assign to this)
  //
  // The ordering matters: stats must be computed before removals (to know
  // which column slot to remove); removals must be marked before filtering;
  // filtering must happen before merging (otherwise concat appends to the
  // pre-removal column).
  compact(t1, t2) {
    const pmap = this._buildParentMap(t1)
    const { stats, imap } = this._buildValueStats(t1)
    const removal = this._markRemovals(t1, t2, pmap, imap, stats)
    this._filterColumns(t1, removal)
    this._mergeTables(t1, t2)
    this.compactKeys()
  }

  _buildParentMap(t1) {
    // For each vref v in t1: pmap[v] = {
    //   indexes: { vrefIndex → true } — every vrefs[i] === v
    //   arr:     [{ i: kref_idx, v: parent }] — chain from v up to root
    //   vs:      { kref_idx → true } — set view of arr's i values
    // }
    const pmap = {}
    const walkUp = (v, arr) => {
      arr.push({ i: v - 2, v: t1.krefs[v - 2] ?? null })
      if (t1.krefs[v - 2]) walkUp(t1.krefs[v - 2], arr)
    }
    let vi = 0
    for (const v of t1.vrefs) {
      if (!pmap[v]) {
        const arr = []
        walkUp(v, arr)
        pmap[v] = { indexes: {}, arr }
      }
      pmap[v].indexes[vi] = true
      vi++
    }
    for (const k in pmap) {
      pmap[k].vs = {}
      for (const v of pmap[k].arr) pmap[k].vs[v.i] = true
    }
    return pmap
  }

  _buildValueStats(t1) {
    // For each vref index i, compute which column slot stores its value.
    //   stats[i] = { vtype: "nums"|"strs"|"bools"|"delete", i: slot, val }
    // Also returns imap: { vref → [vrefIndex] } for cascade removal.
    const stats = {}
    const imap = {}
    let nc = 0, sc = 0, bc = 0
    let i = 0
    for (const v of t1.vrefs) {
      imap[v] ??= []
      imap[v].push(i)
      const vtype = t1.vtypes[i]
      if (typeof vtype === "number") {
        if (vtype === 4 || vtype === 5 || vtype === 6) {
          stats[i] = { vtype: "nums", i: nc, val: t1.nums[nc++] }
        } else if (vtype === 2 || vtype === 7) {
          stats[i] = { vtype: "strs", i: sc, val: t1.strs[sc++] }
        } else if (vtype === 3) {
          stats[i] = { vtype: "bools", i: bc, val: t1.bools[bc++] }
        } else if (vtype === 0) {
          stats[i] = { vtype: "delete" }
        }
      } else if (Array.isArray(vtype)) {
        if (vtype[0] === 3) {
          stats[i] = { vtype: "delete" }
        } else if (vtype[0] === 2) {
          const inner = vtype[3]
          if (inner === 4 || inner === 5 || inner === 6) {
            stats[i] = { vtype: "nums", i: nc, val: t1.nums[nc++] }
          } else if (inner === 2 || inner === 7) {
            stats[i] = { vtype: "strs", i: sc, val: t1.strs[sc++] }
          } else if (inner === 3) {
            stats[i] = { vtype: "bools", i: bc, val: t1.bools[bc++] }
          }
        }
      }
      i++
    }
    return { stats, imap }
  }

  _markRemovals(t1, t2, pmap, imap, stats) {
    // First pass (t2 deletions): vtype === 0 in t2 means "delete the t1
    // entries that share my vref."
    // Second pass (t1 cascade): vtype === 0 in t1 means "remove this and
    // every other index whose chain shares my kref ancestor."
    const removal = { vrefs: {}, vtypes: {} }
    const removed = {}
    const remove = i2 => {
      removal.vrefs[i2] = true
      removal.vtypes[i2] = true
      const s = stats[i2]
      if (s && s.vtype !== "delete") {
        removal[s.vtype] ??= {}
        removal[s.vtype][s.i] = true
      }
      removed[i2] = true
    }
    let i = 0
    for (const v of t2.vrefs) {
      if (t2.vtypes[i] === 0) {
        const targets = imap[v] ?? []
        for (const i2 of targets) remove(i2)
      }
      i++
    }
    let j = 0
    for (const v of t1.vtypes) {
      if (v === 0) {
        remove(j)
        const ki = t1.vrefs[j] - 2
        // Cascade: any vref whose chain contains ki gets removed too.
        for (const k in pmap) {
          if (pmap[k].vs[ki]) {
            for (const k2 in pmap[k].indexes) {
              if (removed[k2] !== true) remove(k2)
            }
          }
        }
      }
      j++
    }
    return removal
  }

  _filterColumns(t1, removal) {
    // Drop entries from t1.{vrefs, vtypes, nums, strs, bools} where
    // removal.X[i] === true.
    for (const k in removal) {
      if (!t1[k]) continue
      const arr = []
      let i = 0
      for (const v of t1[k]) {
        if (!removal[k][i]) arr.push(v)
        i++
      }
      t1[k] = arr
    }
  }

  _mergeTables(t1, t2) {
    // Array fields: concat (t1 first, then t2). Object fields: shallow
    // merge with t2's keys taking precedence over t1.
    for (const v in t2) {
      if (Array.isArray(t2[v])) this[v] = t1[v].concat(t2[v])
      else this[v] = mergeLeft(t2[v], t1[v])
    }
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
          k = this.strmap[k[0]]
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
          path += escapeKey(k)
          this.kmap[p].path = path
        } else if (this.kmap[_prev]?.type === "arr") {
          path += `[${this.kmap[p].index}]`
          this.kmap[p].path = path
        }
        _prev = p
        prev = p
        i4++
      }
      // val from getVal: SPLICE/SPLICE_DEL kinds carry an `index` field.
      // For these the path uses the explicit splice index; for other
      // kinds we use the running count of array slots seen.
      const hasIndex =
        typeof val.index !== "undefined" && typeof val.kind !== "undefined"
      if (this.kmap[prev]?.type === "arr") {
        if (hasIndex) path += `[${val.index}]`
        else path += `[${this.kmap[prev].count}]`
      }
      if (
        prev !== null &&
        this.kmap[prev]?.type === "arr" &&
        !hasIndex
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
        _path += escapeKey(v)
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
    u.push_type(_encode(v, u, prev, null, index, push, diff))
    return { delta: u.dump(), strmap: u.strMap }
  }
  compactStrMap() {
    let strs = {}
    // strs entries shaped [-1, k] are string-diff references, not strmap
    // refs — exclude them when computing reachable strmap entries below.
    for (let v of this.keys) if (Array.isArray(v)) strs[v[0]] = true
    for (let v of this.strs) {
      if (Array.isArray(v) && v[0] !== -1) strs[v[0]] = true
    }
    let strs_arr = []
    for (let k in this.strmap) {
      if (strs[k] !== true) delete this.strmap[k]
      else strs_arr.push({ from: +k, v: this.strmap[k] })
    }
    strs_arr = sortBy(v => v.from, strs_arr)
    const smap = {}
    const imap = {}
    let i = 0
    for (const v of strs_arr) {
      v.to = i++
      smap[v.to] = v.v
      imap[v.from] = v.to
    }
    this.strmap = smap
    for (const v of this.keys) if (Array.isArray(v)) v[0] = imap[v[0]]
    for (const v of this.strs) {
      if (Array.isArray(v) && v[0] !== -1) v[0] = imap[v[0]]
    }
  }

  encode(q) {
    const d3 = new Decoder()
    const left = d3.decode(q, this.krefs.length, this.strmap, this.strdiffs)

    // Handle single value replacements (like null)
    if (d3.single) {
      // When the entire root is replaced with a single value, return it directly
      return { left, json: d3.json }
    }

    const table = d3.table()
    this.compact(this.table(), table)
    const json = this.build()
    this.buildMap()
    return { left, json }
  }

  build() {
    if ("single" in this) return this.single
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
