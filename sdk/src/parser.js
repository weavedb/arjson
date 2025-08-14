import {
  parsePath,
  strmap_rev,
  base64_rev,
  bits,
  tobits,
  frombits,
  strmap,
  base64,
  getPrecision,
} from "./utils.js"

import { Encoder, encode, _encode, pushPathStr } from "./encoder.js"
import { decode, Decoder } from "./decoder.js"

import { is, equals, keys, uniq, compose, concat } from "ramda"

class Parser {
  fastBits(n) {
    return n < 17 ? this.bitsLookup[n] : bits(n)
  }
  show() {
    console.log()
    //console.log("len", this.len)
    console.log("vrefs", this.vrefs)
    //console.log("vflags", this.vflags)
    //console.log("kflags", this.kflags)
    console.log("krefs", this.krefs)
    console.log("ktypes", this.ktypes)
    console.log("keys", this.keys)
    console.log("types", this.types)
    console.log("bools", this.bools)
    console.log("nums", this.nums)
    console.log("strs", this.strs)
    console.log("strmap", this.strmap)

    console.log()
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
    this.bitsLookup = new Uint8Array(17)
    for (let i = 0; i < 17; i++) {
      this.bitsLookup[i] = i === 0 ? 1 : 32 - Math.clz32(i)
    }
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
    this.imap = {}
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
      const val = this.get(i3)
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
        } else {
        }
        _prev = p
        prev = p
        i4++
      }
      if (this.kmap[prev]?.type === "arr") {
        if (typeof val.__index__ !== "undefined") {
          path += `[${val.__index__}]`
        } else {
          path += `[${this.kmap[prev].count}]`
        }
      } else {
      }
      if (typeof val.__val__ === "object" && val.__val__ !== null) {
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
      if (typeof km.path !== "undefined") {
      } else if (km.type === "arr" || km.type === "map") {
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
    return
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

  query(path, v, op = null, n) {
    const u = new Encoder(n)
    u.reset()
    u.single = false
    u.query = true
    u.dcount = this.krefs.length + 1
    u.prev_bits = bits(u.dcount + 1)
    u.prev_kbits = bits(u.dcount + 1)
    const getIndex = (paths, last = 1) => {
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
    const paths = parsePath(path)
    let q = null
    let last = paths[paths.length - 1]
    if (typeof last === "undefined") {
      const t = _encode(null, u, -1, null, null, null, true, op)
      u.push_type(t)
      q = u.dump()
    } else if (typeof last === "number") {
      const index = getIndex(paths)
      if (index !== null) {
        const t = _encode(null, u, index, null, last, null, true, op)
        u.push_type(t)
        q = u.dump()
      }
    } else {
      const index = getIndex(paths, 0)
      if (index !== null) {
        u.push_type(_encode(null, u, index - 1, null, null, null, true, op))
        q = u.dump()
      } else {
        const index = getIndex(paths)
        if (index === null) return null
        const prev = u.dcount
        pushPathStr(u, last, index)
        u.push_type(_encode(null, u, prev, null, null, null, true, op))
        q = u.dump()
      }
    }
    if (q) {
      const u2 = new Encoder(n)
      const q2 = encode(v, u2)
      const bits1 = u.todump()
      const bits2 = u2.todump()
      const bits = [bits2, bits1]
      return { bits, query: u2._dump(bits) }
    }
    return null
  }
  _update(obj, q) {
    const d = new Decoder()
    d.decode(obj)
    const d2 = new Decoder()
    const left = d2.decode(q, null)
    let json = d2.json
    const q2 = frombits(left)
    const d3 = new Decoder()
    const left2 = d3.decode(q2, d.krefs.length, true)
    const d4 = new Parser(d.cols())
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
    }
    const _json = d4.build(json, typeof json === "undefined")
    return { left: frombits(left2), json: _json }
  }
  update(obj, q, len, n) {
    if (!q) return null
    const d = new Decoder()
    let res = null
    let _json = null
    let i = 0
    let left = null
    do {
      res = this._update(obj, q)
      _json = res.json
      q = res.left
      left = res.left
      let u = new Encoder(n)
      obj = encode(res.json, u)
      i++
    } while (q.length > 0 && typeof len === "number" && i < len)
    return { json: _json, left }
  }
  getKey(i, keys) {
    const k = this.keys[i - 1]
    if (typeof k === "undefined") {
      keys.unshift([null])
    } else if (Array.isArray(k)) {
      keys.unshift([2, k[0], undefined, i])
    } else if (typeof k === "number") {
      let reset = false
      if (this.arrs[i] !== true) {
        reset = true
        this.arrs[i] = true
      }
      keys.unshift([this.ktypes[i - 1][0], k, reset, i])
    } else {
      let reset = false
      if (this.objs[i] !== true) {
        reset = true
        this.objs[i] = true
      }
      keys.unshift([k, undefined, reset, i])
    }
    if (i > 1) {
      const d = this.krefs[i - 2]
      if (d > 0) this.getKey(this.krefs[d - 1], keys, i)
    }
    let i2 = 0
    for (let k of keys) {
      if (typeof k === "string") {
      } else if (Array.isArray(k) && k[0] === 2) {
        let reset = false
        if (this.objs[i] !== true) {
          reset = true
          this.objs[i] = true
        }
        keys[i2] = [this.strmap[k[1].toString()], undefined, reset, i]
      }
      i2++
    }
  }

  get(i) {
    let type = this.types[i]
    let val = null
    let replace = null
    let push = null
    if (Array.isArray(type)) {
      val = { __update__: true }
      if (type[0] === 2) {
        val.__index__ = type[1]
      } else if (type[0] === 3) {
        val.__index__ = type[1]
        val.__remove__ = type[2]
      } else if (type[0] === 0) {
        val.__merge__ = true
      }
    } else if (type === 0) {
      val = { __del__: true }
    } else if (type === 7 || type === 2) {
      val = { __val__: this.strs[this.sc++] }
    } else if (type === 4) {
      val = { __val__: this.nums[this.nc++] }
    } else if (type === 5) val = { __val__: this.nums[this.nc++] }
    else if (type === 6) val = { __val__: this.nums[this.nc++] }
    else if (type === 1) val = { __val__: null }
    else if (type === 3) val = { __val__: this.bools[this.bc++] }
    return val
  }
  obj_merge(json, k, val) {
    if (val.__merge__) {
      for (let k2 in val.__val__) {
        if (typeof val.__val__[k2] === "undefined") delete json[k][k2]
        else json[k][k2] = val.__val__[k2]
      }
    } else json[k] = val.__val__
  }
  arr_push(json, val) {
    if (
      val.__update__ ||
      typeof val.__val__ !== "object" ||
      val.__val__ === null
    ) {
      if (typeof val.__push__ !== "undefined") {
        json[val.__push__].push(val.__val__)
      } else if (typeof val.__index__ !== "undefined") {
        if (typeof val.__remove__ !== "undefined") {
          if (val.__del__) json.splice(val.__index__, val.__remove__)
          else json.splice(val.__index__, val.__remove__, ...val.__val__)
        } else if (val.__del__) json.splice(val.__index__, 1)
        else json.splice(val.__index__, 1, val.__val__)
      } else json.push(val.__val__)
    }
  }

  build(_val, del = false) {
    this.indexes = {}
    this.arrs = {}
    this.objs = {}
    this.nc = 0
    this.bc = 0
    this.sc = 0
    this.imap = {}
    let _json = null
    if (this.vrefs.length === 0) return (_json = this.get(0))
    let i = 0
    let init = [[], []]
    let type = key => (typeof key[0] === "string" ? 2 : key[0])

    let set = k => {
      if (k && k[0] !== null && k[0] !== undefined && k[1] !== undefined) {
        init[k[0]][k[1]] = true
        return true
      }
      return false
    }
    let ex = k => {
      if (k && k[0] !== null && k[0] !== undefined && k[1] !== undefined) {
        return init[k[0]][k[1]] === true
      }
      return false
    }
    let i3 = -1
    for (let v of this.vrefs) {
      let recIndex = null
      i3++
      let keys = []
      this.getKey(v, keys)
      let val = this.get(i)
      if (val?.__update__ === true) {
        val.__val__ = _val
        if (typeof _val === "undefined") val.__del__ = true
      }
      if (Array.isArray(val.__val__) && val.__val__.length === 0) {
        this.arrs[v + 1] = true
        recIndex = v + 1
      }
      i++
      let json = _json
      for (let i2 = 0; i2 < keys.length; i2++) {
        let k = keys[i2]
        if (k[0] === null) {
          _json = val.__val__
          continue
        }
        if (json === null) {
          let t = type(k)
          set(k)
          if (t === 0) {
            _json = []
            json = _json
            if (i2 === keys.length - 1) {
              json[0] = val.__val__
              break
            }
            if (i2 === keys.length - 2) {
              const k2 = keys[i2 + 1]
              if (type(k2) === 0) {
                this.arr_push(json, val)
                break
              }
            } else {
              const k2 = keys[i2 + 1]
              if (type(k2) === 0) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              } else if (type(k2) === 1) {
                set(k2)
                json.push({})
                json = json[json.length - 1]
              }
            }
          } else {
            _json = {}
            json = _json
            if (i2 === keys.length - 2) {
              const k2 = keys[i2 + 1]
              this.obj_merge(json, k2[0], val)
              break
            }
          }
          if (i2 !== keys.length - 2) continue
        } else if (i2 === 0) {
          const k2 = keys[i2 + 1]
          const t1 = type(k)
          if (t1 === 0) {
            if (keys.length === 1) {
              this.arr_push(json, val)
              break
            } else if (keys.length === 2) {
              if (!ex(k2) || k2[2] === true) set(k2) && json.push([])
              json = json[json.length - 1]
              this.arr_push(json, val)
              break
            }
            const t2 = type(k2)
            if (t2 === 0) {
              if (!ex(k2) || k2[2] === true) set(k2) && json.push([])
              json = json[json.length - 1]
            } else if (t2 === 1) {
              if (!ex(k2) || k2[2] === true) set(k2) && json.push({})
              json = json[json.length - 1]
            }
          } else if (t1 === 1) {
            if (keys.length === 2) {
              if (val.__del__) delete json[k2[0]]
              else this.obj_merge(json, k2[0], val)
              break
            }
          }
          continue
        }
        if (i2 === keys.length - 2) {
          const jtype = Array.isArray(json) ? 0 : 1
          const ctype = type(k)
          const k2 = keys[i2 + 1]
          const ntype = type(k2)
          if (ctype === 0 && ntype === 0) {
            if (typeof val.__push__ === "undefined") {
              if (!ex(k2) || k2[2] === true) set(k2) && json.push([])
              json = json[json.length - 1]
              this.arr_push(json, val)
            } else {
              this.arr_push(json, val)
            }

            break
          } else if (ctype === 1 && ntype === 2) {
            if (val.__del__) delete json[k2[0]]
            else {
              if (k2[1] === true) for (let k in json) delete json[k[0]]
              this.obj_merge(json, k2[0], val)
            }
            break
          } else if (ctype === 2 && jtype === 1) {
            if (ntype === 0) {
              if (!Array.isArray(json[k[0]]) || k2?.[2] === true) {
                json[k[0]] = []
              }
              json = json[k[0]]
              this.arr_push(json, val)
            } else if (ntype === 1) {
              json[k[0]] = {}
            }
            break
          } else if (ctype === 0 && ntype === 1) {
            json.push({})
            json = json[json.length - 1]
            break
          }
        } else {
          const jtype = Array.isArray(json) ? 0 : 1
          const ctype = type(k)
          const k2 = keys[i2 + 1]
          const ntype = type(k2)
          if (jtype === 1 && ctype === 2) {
            if (ntype === 0) {
              if (!Array.isArray(json[k[0]]) || k2?.[2] === true)
                json[k[0]] = []
              json = json[k[0]]
            } else if (ntype === 1) {
              if (
                typeof json[k[0]] !== "object" ||
                json[k[0]] === null ||
                Array.isArray(json[k[0]])
              ) {
                json[k[0]] = {}
              }
              json = json[k[0]]
            }
          } else if (jtype === 0 && ctype === 0) {
            if (ntype === 0) {
              if ((!ex(k2) || k2[2] === true) && this.arrs[k2[3]] !== true) {
                set(k2) && json.push([])
                json = json[json.length - 1]
              } else {
                json = json[json.length - 1]
              }
            } else if (ntype === 1) {
              if (!ex(k2) || k2[2] === true) set(k2) && json.push({})
              json = json[json.length - 1]
            }
          }
        }
      }
    }
    return _json
  }
}

const _calcDiff = (a, b, path = "", depth = 0) => {
  let q = []
  const keys_a = keys(a)
  const keys_b = keys(b)
  const _keys = uniq([...keys_a, ...keys_b])
  if (equals(a, b)) return []
  if (!is(Object, a) || !is(Object, b))
    return [{ path, op: "replace", from: a, to: b }]
  if (Array.isArray(a) && Array.isArray(b)) {
    // If arrays have different lengths, just replace the whole array
    if (a.length !== b.length) {
      return [{ path, op: "replace", from: a, to: b }]
    }

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
      return _calcDiff(a[diff], b[diff], _path, depth + 1)
    } else {
      if (typeof a[diff] === "undefined") {
        return [{ path: _path, op: "new", to: b[diff] }]
      } else if (typeof b[diff] === "undefined") {
        return [{ path: _path, op: "delete", from: a[diff] }]
      } else {
        return [{ path: _path, op: "replace", from: a[diff], to: b[diff] }]
      }
    }
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
        q = concat(q, _calcDiff(a[v], b[v], _path, depth + 1))
      }
    }
  }
  return q
}

const delta = (a, b, query, n) => {
  if (query && query.op === 3) {
    let u = new Encoder(n)
    return [[u._query(query)]]
  }
  let json = a
  const diffs = _calcDiff(a, b)
  let q = []
  for (let v of diffs) {
    let u = new Encoder(n)
    let d = new Decoder()
    const _e = encode(json, u)
    const decoded = decode(_e, d)
    let p = new Parser(d.cols())
    let { bits, query: q2 } = p.query(v.path, v.to)
    q = concat(q, bits)
    const res = p.update(_e, q2)
    json = res.json
  }
  let u = new Encoder(n)
  if (query) {
    query.len = diffs.length
    let u2 = new Encoder(n)
    let q2 = u2._query({
      op: 2,
      col: query.col,
      doc: query.doc,
      len: query.len,
    })
    q.unshift([q2])
  }
  return { len: diffs.length, q }
}

class Bundle {
  constructor(data, db) {
    this.q = []
    this.data = data
    this.db = db
  }
  async send() {
    await this.db.query(this)
  }
  c(data, col, doc, n) {
    this.data[col] ??= {}
    let u2 = new Encoder(n)
    let q = u2._query({ op: 1, col, doc })
    this.q.push([q])
    let u = new Encoder(n)
    encode(data, u)
    this.q.push(u.todump())
    this.data[col][doc] = data
    return this
  }
  u(b, col, doc, n) {
    const a = this.data[col][doc]
    const { len, q } = delta(a, b, { op: 2, col, doc }, n)
    this.q = concat(this.q, q)
    this.data[col][doc] = b
    return this
  }
  d(col, doc, n) {
    const q = delta(null, null, { op: 3, col, doc }, n)
    this.q = concat(this.q, q)
    delete this.data[col][doc]
    return this
  }
  dump(n) {
    let u = new Encoder(n)
    return u._dump(this.q)
  }
}
export { Parser, delta, Bundle }
