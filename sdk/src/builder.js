import { decodeFastDiff, applyDecodedOps } from "./diff.js"

// Discriminated-union kinds for the value envelope produced by getVal.
// Was previously a tagged-union of optional underscore-prefixed flags
// (__val__, __del__, __merge__, __update__, __index__, __remove__).
// The new shape is { kind: KIND.X, ...payload } — single discriminator
// makes consumers (obj_merge, arr_push, builder build) clearer.
const KIND = {
  VAL: 1,         // plain value:           { kind, val }
  DEL: 2,         // plain delete (vtype 0): { kind }
  SPLICE: 3,      // array splice replace:  { kind, index, remove, val }
  SPLICE_DEL: 4,  // array splice delete:   { kind, index, remove }
  MERGE: 5,       // object merge:          { kind, val }
  UPDATE_DEL: 6,  // delta-update delete:   { kind }
}

class Builder {
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

  constructor(table) {
    if (table) this.setTable(table)
  }

  // Reusable Builder: setTable(table) updates fields in place so a
  // single Builder instance can be reused across decode calls. Cuts
  // per-decode allocation of Builder + its embedded Uint8Array buffers.
  setTable({
    ktypes, keys, vtypes, bools, nums, strs, vrefs, krefs, strmap, strdiffs,
  }) {
    this.strmap = strmap
    this.strdiffs = strdiffs
    this.ktypes = ktypes
    this.vrefs = vrefs
    this.krefs = krefs
    this.vtypes = vtypes
    this.nums = nums
    this.strs = strs
    this.bools = bools
    this.keys = keys
  }

  build() {
    // The build pass only reads columns (vrefs, krefs, vtypes, keys, strs,
    // strmap, strdiffs, etc.) — it mutates obj.arrs / obj.objs / counters.
    // structuredClone was a deep copy of all columns, multi-MB on big
    // inputs. Shallow object reference is correct and dramatically cheaper.
    const t = this.table()
    // Sparse "set of small ints" → Uint8Array-backed bitmap. Faster than
    // Set (which has hash table lookup overhead, ~2.6% in profile) and
    // faster than plain-object dictionary (which goes megamorphic).
    // Sized to krefs.length + 2 to cover all possible ci values; build
    // never indexes beyond that. Reuse instance-level buffers to avoid
    // per-call allocation (was 4.2% as CreateTypedArray in profile).
    const arrLen = (t.krefs?.length ?? 0) + 2
    if (!this._arrs || this._arrs.length < arrLen) {
      let cap = 16
      while (cap < arrLen) cap <<= 1
      this._arrs = new Uint8Array(cap)
      this._objs = new Uint8Array(cap)
    } else {
      this._arrs.fill(0, 0, arrLen)
      this._objs.fill(0, 0, arrLen)
    }
    const obj = {
      vrefs: t.vrefs,
      krefs: t.krefs,
      ktypes: t.ktypes,
      keys: t.keys,
      vtypes: t.vtypes,
      bools: t.bools,
      nums: t.nums,
      strs: t.strs,
      strmap: t.strmap,
      strdiffs: t.strdiffs,
      arrs: this._arrs,
      objs: this._objs,
      nc: 0,
      bc: 0,
      sc: 0,
    }

    let _json = null
    if (obj.vrefs.length === 0) {
      const r = getVal(0, this)
      return r.val
    }

    // Fast paths: flat array of primitives, flat object of primitives.
    // Both bypass the conditional inner loop and pre-allocate the
    // result for direct index/key writes.
    if (obj.vrefs.length >= 2) {
      const _vrefs = obj.vrefs
      const _vtypes = obj.vtypes
      const _vlen = _vrefs.length
      const root = _vrefs[0]

      // ── Try flat array path ────────────────────────────────────
      const rootKt = root >= 1 ? obj.ktypes[root - 1] : null
      if (rootKt && rootKt[0] === 0 && (obj.krefs[root - 2] | 0) === 0) {
        let allFlat = true
        for (let vi = 0; vi < _vlen; vi++) {
          if (_vrefs[vi] !== root) { allFlat = false; break }
          const vt = _vtypes[vi]
          if (vt !== 1 && vt !== 3 && vt !== 4 && vt !== 5 && vt !== 7) {
            allFlat = false; break
          }
        }
        if (allFlat) {
          // Inline the value extraction (was getVal+wrapper-object alloc).
          const out = new Array(_vlen)
          const _bools = obj.bools
          const _nums = obj.nums
          const _strs = obj.strs
          const _strmap = obj.strmap
          const _strdiffs = obj.strdiffs
          let nc = obj.nc, bc = obj.bc, sc = obj.sc
          for (let vi = 0; vi < _vlen; vi++) {
            const vt = _vtypes[vi]
            // nums column has already-negated value for vt=5 (decoder
            // pushes -num for type 5). vt=4/5/6 all read identically.
            if (vt === 4 || vt === 5 || vt === 6) out[vi] = _nums[nc++]
            else if (vt === 7) {
              let str = _strs[sc++]
              if (Array.isArray(str)) {
                if (str[0] === -1) str = _strdiffs[str[1]]
                else str = _strmap[str[0]]
              }
              out[vi] = str
            }
            else if (vt === 3) out[vi] = _bools[bc++]
            else /* vt === 1 */ out[vi] = null
          }
          obj.nc = nc
          obj.bc = bc
          obj.sc = sc
          return out
        }
      }

      // ── Try array-of-flat-objects path ──────────────────────────
      // Pattern: root is array, each element is an object whose values
      // are primitives (depth-3 chain: leaf → key → obj → root).
      // Covers redundant_users, time_series_100, arr_obj_100_homog.
      if (rootKt && rootKt[0] === 0 && (obj.krefs[root - 2] | 0) === 0) {
        const _krefs = obj.krefs
        const _ktypes = obj.ktypes
        const _keys = obj.keys
        let isAoO = true
        // Each leaf vref must resolve to a chain of: key → obj → root
        // where obj's parent is root, and obj's ktype is [1].
        for (let vi = 0; vi < _vlen; vi++) {
          const keyKr = _vrefs[vi]
          if (keyKr < 1) { isAoO = false; break }
          const objKr = _krefs[keyKr - 2]
          if (objKr === undefined || objKr < 1 || objKr === root) {
            isAoO = false; break
          }
          const objParent = _krefs[objKr - 2] | 0
          if (objParent !== root) { isAoO = false; break }
          // Object's ktype must be [1] (object marker).
          const objKt = _ktypes[objKr - 1]
          if (!objKt || objKt[0] !== 1) { isAoO = false; break }
          // Key's ktype must be 2 (string).
          const keyKt = _ktypes[keyKr - 1]
          if (!keyKt || keyKt[0] !== 2) { isAoO = false; break }
          const vt = _vtypes[vi]
          if (vt !== 1 && vt !== 3 && vt !== 4 && vt !== 5 && vt !== 7) {
            isAoO = false; break
          }
        }
        if (isAoO) {
          const _bools = obj.bools
          const _nums = obj.nums
          const _strs = obj.strs
          const _strmap = obj.strmap
          const _strdiffs = obj.strdiffs
          let nc = obj.nc, bc = obj.bc, sc = obj.sc
          // Map obj kref → object index in result (allocated in encounter order).
          const objIndex = {}
          let nextIdx = 0
          // Pre-pass: assign indices in vref-order. Inner objects are
          // typically encountered in array order, but the structural check
          // doesn't enforce that — discover via the index map.
          const out = []
          for (let vi = 0; vi < _vlen; vi++) {
            const keyKr = _vrefs[vi]
            const objKr = _krefs[keyKr - 2]
            let oi = objIndex[objKr]
            if (oi === undefined) {
              oi = nextIdx++
              objIndex[objKr] = oi
              out[oi] = {}
            }
            // Resolve key: keys[keyKr - 1] is string OR [strmap_idx].
            const k = _keys[keyKr - 1]
            const kStr = typeof k === "string" ? k : _strmap[k[0]]
            const vt = _vtypes[vi]
            let val
            if (vt === 4 || vt === 5 || vt === 6) val = _nums[nc++]
            else if (vt === 7) {
              let str = _strs[sc++]
              if (Array.isArray(str)) {
                if (str[0] === -1) str = _strdiffs[str[1]]
                else str = _strmap[str[0]]
              }
              val = str
            }
            else if (vt === 3) val = _bools[bc++]
            else val = null
            out[oi][kStr] = val
          }
          obj.nc = nc
          obj.bc = bc
          obj.sc = sc
          return out
        }
      }

      // ── Try flat object path ───────────────────────────────────
      // Object root: ktypes[0] = [1]. Keys are string-typed (ktype 2).
      // krefs all point to root. vrefs sequential pointing to each key.
      if (rootKt && rootKt[0] === 1 && (obj.krefs[root - 2] | 0) === 0) {
        const _krefs = obj.krefs
        let allFlat = _vlen === _krefs.length
        for (let i = 0; i < _krefs.length && allFlat; i++) {
          if (_krefs[i] !== root) { allFlat = false; break }
        }
        if (allFlat) {
          for (let vi = 0; vi < _vlen; vi++) {
            const vt = _vtypes[vi]
            if (vt !== 1 && vt !== 3 && vt !== 4 && vt !== 5 && vt !== 7) {
              allFlat = false; break
            }
            // Skip type-2 string-ref keys (they need strmap resolve).
            const keyEntry = obj.keys[vi + 1]
            if (typeof keyEntry !== "string") { allFlat = false; break }
            // Verify key ktype is direct string (type 2 in ktypes), not
            // an int/array marker.
            const kt = obj.ktypes[vi + 1]
            if (!kt || kt[0] !== 2) { allFlat = false; break }
          }
        }
        if (allFlat) {
          const out = {}
          const _bools = obj.bools
          const _nums = obj.nums
          const _strs = obj.strs
          const _strmap = obj.strmap
          const _strdiffs = obj.strdiffs
          const _keys = obj.keys
          let nc = obj.nc, bc = obj.bc, sc = obj.sc
          for (let vi = 0; vi < _vlen; vi++) {
            const vt = _vtypes[vi]
            const k = _keys[vi + 1]
            if (vt === 4 || vt === 5 || vt === 6) out[k] = _nums[nc++]
            else if (vt === 7) {
              let str = _strs[sc++]
              if (Array.isArray(str)) {
                if (str[0] === -1) str = _strdiffs[str[1]]
                else str = _strmap[str[0]]
              }
              out[k] = str
            }
            else if (vt === 3) out[k] = _bools[bc++]
            else /* vt === 1 */ out[k] = null
          }
          obj.nc = nc
          obj.bc = bc
          obj.sc = sc
          return out
        }
      }
    }

    let i = 0
    // init is a 2-bucket marker table — bucket 0 (arrays) and 1 (objects).
    // k[1] can be an array index OR a strmap index; max is unknown up
    // front, so use Set rather than a fixed-size typed array.
    const init0 = new Set()
    const init1 = new Set()
    const type = k => (typeof k[0] === "string" ? 2 : k[0])
    const set = k => {
      if (k && k[0] !== null && k[0] !== undefined && k[1] !== undefined) {
        if (k[0] === 0) init0.add(k[1])
        else init1.add(k[1])
        return true
      }
      return false
    }
    const ex = k =>
      k && k[0] !== null && k[0] !== undefined && k[1] !== undefined
        ? k[0] === 0 ? init0.has(k[1]) : init1.has(k[1])
        : false

    // Reuse a single `keys` array across vref iterations — was a fresh
    // [] per iteration. For wide inputs this saves an allocation per
    // vref. Truncating with length=0 keeps the backing capacity.
    const keys = []
    for (let vi = 0; vi < obj.vrefs.length; vi++) {
      const v = obj.vrefs[vi]
      keys.length = 0
      getKey(v, keys, obj)
      const val = getVal(i, obj)
      i++

      let json = _json
      for (let i2 = 0; i2 < keys.length; i2++) {
        const k = keys[i2]

        if (k[0] === null) {
          _json = val.val
          continue
        }

        if (json === null) {
          const t = type(k)
          set(k)
          if (t === 0) {
            _json = []
            json = _json
            if (i2 === keys.length - 1) {
              json[0] = val.val
              break
            }

            if (i2 === keys.length - 2) {
              const k2 = keys[i2 + 1]
              if (type(k2) === 0) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
                arr_push(json, val, obj)
                break
              }
            } else {
              const k2 = keys[i2 + 1]
              const k2t = type(k2)
              if (k2t === 0) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              } else if (k2t === 1) {
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
              obj_merge(json, k2[0], val, obj)
              break
            }
          }
          if (i2 !== keys.length - 2) continue
        } else if (i2 === 0) {
          const k2 = keys[i2 + 1]
          if (!k2) {
            arr_push(json, val, obj)
            break
          }
          const t1 = type(k)
          const t2 = type(k2)
          if (t1 === 0) {
            if (keys.length === 1) {
              arr_push(json, val, obj)
              break
            } else if (keys.length === 2) {
              if (t2 === 0) {
                if (k2[2] === true) {
                  set(k2)
                  json.push([])
                }
                json = json[json.length - 1]
                arr_push(json, val, obj)
                break
              } else {
                if (!ex(k2) || k2[2] === true) {
                  set(k2)
                  json.push({})
                }
                json = json[json.length - 1]
                arr_push(json, val, obj)
                break
              }
            }

            if (t2 === 0) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push([])
              } else if (
                json.length > 0 &&
                !Array.isArray(json[json.length - 1])
              ) {
                json.push([])
              }
              json = json[json.length - 1]
            } else if (t2 === 1) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push({})
              }
              json = json[json.length - 1]
            }
          } else if (t1 === 1) {
            if (keys.length === 2) {
              if (val.kind === KIND.DEL) delete json[k2[0]]
              else obj_merge(json, k2[0], val, obj)
              break
            } else if (keys.length === 3 && t2 === 1) {
              const k3 = keys[i2 + 2]
              const t3 = type(k3)
              if (typeof k2[3] !== "undefined") {
                const parentPos = obj.krefs[k2[3] - 2]
                if (parentPos && parentPos > 0) {
                  const parentKey = obj.keys[parentPos - 1]
                  if (typeof parentKey === "string") {
                    if (
                      typeof json[parentKey] !== "object" ||
                      json[parentKey] === null ||
                      Array.isArray(json[parentKey])
                    ) {
                      json[parentKey] = {}
                    }
                    json = json[parentKey]
                  }
                }
              }
            }
          }
          continue
        }
        if (i2 > 0 && i2 < keys.length - 2) {
          const jtype = Array.isArray(json) ? 0 : 1
          const ctype = type(k)
          const k2 = keys[i2 + 1]
          const ntype = type(k2)

          if (jtype === 1 && ctype === 1) {
            // Skip object-index keys in the middle of the chain — we're
            // already at the right object level. Actual navigation
            // happens when we encounter string keys (type 2).
            continue
          }

          if (jtype === 1 && ctype === 2) {
            if (ntype === 0) {
              if (!Array.isArray(json[k[0]]) || k2?.[2] === true) {
                json[k[0]] = []
              }
              json = json[k[0]]
            } else if (ntype === 1) {
              if (
                typeof json[k[0]] !== "object" ||
                json[k[0]] === null ||
                Array.isArray(json[k[0]])
              )
                json[k[0]] = {}
              json = json[k[0]]
            } else if (ntype === 2) {
              if (
                typeof json[k[0]] !== "object" ||
                json[k[0]] === null ||
                Array.isArray(json[k[0]])
              )
                json[k[0]] = {}
              json = json[k[0]]
            }
          } else if (jtype === 0 && ctype === 0) {
            if (ntype === 0) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              } else if (
                json &&
                json.length > 0 &&
                !Array.isArray(json[json.length - 1])
              ) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              } else if (json && json.length > 0) {
                set(k2)
                json = json[json.length - 1]
              } else if (json) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              }
            } else if (ntype === 1) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push({})
              }
              json = json[json.length - 1]
            } else if (ntype === 2) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push({})
              }
              json = json[json.length - 1]
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
            // Note: was guarded by `typeof val.__push__ === "undefined"`
            // — that flag was never set anywhere, so the alternative
            // branch was dead. Removed the dead branch, keeping the
            // setup-then-arr_push path that was always taken.
            if (!ex(k2) || k2[2] === true) {
              set(k2)
              json.push([])
            }
            json = json[json.length - 1]
            arr_push(json, val, obj)
            break
          } else if (ctype === 1 && ntype === 2) {
            if (val.kind === KIND.DEL) delete json[k2[0]]
            else {
              if (k2[1] === true) for (let kk in json) delete json[kk[0]]
              obj_merge(json, k2[0], val, obj)
            }
            break
          } else if (ctype === 2 && jtype === 1) {
            if (ntype === 0) {
              if (!Array.isArray(json[k[0]]) || k2?.[2] === true) {
                json[k[0]] = []
              }
              json = json[k[0]]
              arr_push(json, val, obj)
            } else if (ntype === 1) {
              if (
                typeof json[k[0]] !== "object" ||
                json[k[0]] === null ||
                Array.isArray(json[k[0]])
              ) {
                json[k[0]] = {}
              }
              json = json[k[0]]
              break
            } else if (ntype === 2) {
              if (
                typeof json[k[0]] !== "object" ||
                json[k[0]] === null ||
                Array.isArray(json[k[0]])
              ) {
                json[k[0]] = {}
              }
              obj_merge(json[k[0]], k2[0], val, obj)
            }
            break
          } else if (ctype === 0 && ntype === 1) {
            json.push({})
            json = json[json.length - 1]
            break
          }
        }
      }
      _json ??= json
    }
    return _json
  }
}

const getKey = (i, keys, obj) => {
  // Walk the kref chain leaf-to-root iteratively, then reverse —
  // avoids unshift's O(n²) per-call cost. Tracks a flag for whether
  // any type-2 (strmap-ref) key was added; if not, skip the resolve
  // post-pass entirely (most chains for primitive arrays/objects).
  // Reuse a chain stack on obj across calls.
  const chain = obj._chain ?? (obj._chain = [])
  chain.length = 0
  let cur = i
  while (true) {
    chain.push(cur)
    if (cur > 1) {
      const d = obj.krefs[cur - 2]
      if (d > 0) {
        cur = d
        continue
      }
    }
    break
  }
  // Emit in root-to-leaf order.
  let hasRef = false
  const baseLen = keys.length
  for (let n = chain.length - 1; n >= 0; n--) {
    const ci = chain[n]
    const k = obj.keys[ci - 1]
    if (typeof k === "undefined") keys.push([null])
    else if (Array.isArray(k)) {
      keys.push([2, k[0], undefined, ci])
      hasRef = true
    } else if (typeof k === "number") {
      const reset = obj.arrs[ci] === 0
      if (reset) obj.arrs[ci] = 1
      keys.push([obj.ktypes[ci - 1][0], k, reset, ci])
    } else {
      const reset = obj.objs[ci] === 0
      if (reset) obj.objs[ci] = 1
      keys.push([k, undefined, reset, ci])
    }
  }
  // Resolve type-2 (strmap reference) keys to strings only if any
  // were emitted. Skip the loop entirely otherwise.
  if (hasRef) {
    const klen = keys.length
    for (let i2 = baseLen; i2 < klen; i2++) {
      const k = keys[i2]
      if (Array.isArray(k) && k[0] === 2) {
        const reset = obj.objs[i] === 0
        if (reset) obj.objs[i] = 1
        keys[i2] = [obj.strmap[k[1]], undefined, reset, i]
      }
    }
  }
}

const get = (obj, type) => {
  let val = null
  if (type === 7 || type === 2) {
    let str = obj.strs[obj.sc++]
    if (Array.isArray(str)) {
      if (str[0] === -1) str = obj.strdiffs[str[1]]
      else str = obj.strmap[str[0]]
    }
    val = str
  } else if (type === 4) val = obj.nums[obj.nc++]
  else if (type === 5) val = obj.nums[obj.nc++]
  else if (type === 6) val = obj.nums[obj.nc++]
  else if (type === 1) val = null
  else if (type === 3) val = obj.bools[obj.bc++]
  return val
}
const getVal = (i, obj) => {
  const type = obj.vtypes[i]
  if (Array.isArray(type)) {
    if (type[0] === 2) {
      // Array splice replacement at type[1], remove count type[2], with
      // value of inner type type[3].
      return {
        kind: KIND.SPLICE,
        index: type[1],
        remove: type[2],
        val: get(obj, type[3]),
      }
    }
    if (type[0] === 3) {
      // Array splice delete at type[1], remove count type[2].
      return { kind: KIND.SPLICE_DEL, index: type[1], remove: type[2] }
    }
    if (type[0] === 0) {
      if (type[1] === 0) return { kind: KIND.UPDATE_DEL }
      if (type[1] === 1) return { kind: KIND.MERGE, val: undefined }
      // type[1] outside {0, 1} is unreachable from any valid encode.
      // The decoder's size-sanity guards reject corrupt delta payloads
      // before this point; if we somehow arrive here, fall through to
      // a no-op MERGE which the build pass interprets benignly.
      return { kind: KIND.MERGE, val: undefined }
    }
    throw new Error(
      `ARJSON builder: unhandled vtype shape [${type[0]}, ...]`,
    )
  }
  if (type === 0) return { kind: KIND.DEL }
  return { kind: KIND.VAL, val: get(obj, type) }
}

const obj_merge = (json, k, val, obj) => {
  if (val.kind === KIND.DEL || val.kind === KIND.UPDATE_DEL) {
    delete json[k]
    return
  }
  if (val.kind === KIND.MERGE) {
    // Merge each property of val.val into json[k]; undefined values delete.
    for (const k2 in val.val) {
      if (typeof val.val[k2] === "undefined") delete json[k][k2]
      else json[k][k2] = val.val[k2]
    }
    return
  }
  // KIND.VAL or KIND.SPLICE — the latter shouldn't reach here in practice
  // (splices target arrays), but if val is a string-diff Uint8Array we
  // apply the patch; otherwise plain assign.
  if (val.val instanceof Uint8Array) {
    json[k] = applyDecodedOps(json[k], decodeFastDiff(val.val, obj.strmap))
  } else {
    json[k] = val.val
  }
}

const arr_push = (json, val, obj) => {
  // Skip plain object/array values without an update wrapper — those
  // are handled separately by the build pass that recursively descends.
  if (val.kind === KIND.VAL && typeof val.val === "object" && val.val !== null) {
    return
  }
  if (val.kind === KIND.SPLICE_DEL) {
    json.splice(val.index, val.remove)
    return
  }
  if (val.kind === KIND.SPLICE) {
    let _val = val.val
    if (
      val.remove &&
      typeof json[val.index] === "string" &&
      val.val instanceof Uint8Array
    ) {
      _val = applyDecodedOps(
        json[val.index],
        decodeFastDiff(val.val, obj.strmap),
      )
    }
    json.splice(val.index, val.remove, _val)
    return
  }
  if (val.kind === KIND.VAL) {
    json.push(val.val)
  }
  // KIND.DEL / KIND.MERGE / KIND.UPDATE_DEL: no-op in array context.
}

export { Builder, getKey, getVal }
