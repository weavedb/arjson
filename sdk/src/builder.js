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
  }
  obj_merge(json, k, val) {
    if (val.__del__) {
      delete json[k]
      return
    }
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
        else {
          json.splice(val.__index__, 0, val.__val__)
          //json.splice(val.__index__, 1, val.__val__)
        }
      } else json.push(val.__val__)
    }
  }

  build() {
    console.log(this.table())
    this.arrs = {}
    this.objs = {}
    this.nc = 0
    this.bc = 0
    this.sc = 0

    let _json = null
    if (this.vrefs.length === 0) {
      const r = getVal(0, this)
      return r.__val__
    }

    let i = 0
    const init = [[], []]
    const type = k => (typeof k[0] === "string" ? 2 : k[0])
    const set = k => {
      if (k && k[0] !== null && k[0] !== undefined && k[1] !== undefined) {
        init[k[0]][k[1]] = true
        return true
      }
      return false
    }

    const ex = k =>
      k && k[0] !== null && k[0] !== undefined && k[1] !== undefined
        ? init[k[0]][k[1]] === true
        : false

    for (let vi = 0; vi < this.vrefs.length; vi++) {
      const v = this.vrefs[vi]
      const keys = []
      getKey(v, keys, this)
      const val = getVal(i, this)
      if (Array.isArray(val.__val__) && val.__val__.length === 0) {
        this.arrs[v + 1] = true
      }
      i++

      let json = _json
      for (let i2 = 0; i2 < keys.length; i2++) {
        const k = keys[i2]
        if (k[0] === null) {
          _json = val.__val__
          continue
        }

        if (json === null) {
          const t = type(k)
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
              this.obj_merge(json, k2[0], val)
              break
            }
          }
          if (i2 !== keys.length - 2) continue
        } else if (i2 === 0) {
          const k2 = keys[i2 + 1]
          const t1 = type(k)
          const t2 = type(k2)
          if (t1 === 0) {
            if (keys.length === 1) {
              this.arr_push(json, val)
              break
            } else if (keys.length === 2) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push([])
              }
              json = json[json.length - 1]
              this.arr_push(json, val)
              break
            }

            if (t2 === 0) {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
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
              if (val.__del__) delete json[k2[0]]
              else this.obj_merge(json, k2[0], val)
              break
            } else if (keys.length === 3 && t2 === 1) {
              const k3 = keys[i2 + 2]
              const t3 = type(k3)
              if (typeof k2[3] !== "undefined") {
                const parentPos = this.krefs[k2[3] - 2]
                if (parentPos && parentPos > 0) {
                  const parentKey = this.keys[parentPos - 1]
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
            let targetKey = null
            for (let j = i2 - 1; j >= 0; j--) {
              if (type(keys[j]) === 2) {
                targetKey = keys[j][0]
                break
              }
            }
            if (targetKey !== null) {
              if (
                typeof json[targetKey] !== "object" ||
                json[targetKey] === null ||
                Array.isArray(json[targetKey])
              ) {
                json[targetKey] = {}
              }
              json = json[targetKey]
            }
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
              if ((!ex(k2) || k2[2] === true) && this.arrs[k2[3]] !== true) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
              } else json = json[json.length - 1]
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
            if (typeof val.__push__ === "undefined") {
              if (!ex(k2) || k2[2] === true) {
                set(k2)
                json.push([])
              }
              json = json[json.length - 1]
              this.arr_push(json, val)
            } else this.arr_push(json, val)

            break
          } else if (ctype === 1 && ntype === 2) {
            if (val.__del__) delete json[k2[0]]
            else {
              if (k2[1] === true) for (let kk in json) delete json[kk[0]]
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
              this.obj_merge(json[k[0]], k2[0], val)
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
    console.log("final value...............", _json)
    return _json
  }
}

const getKey = (i, keys, obj) => {
  const k = obj.keys[i - 1]
  if (typeof k === "undefined") keys.unshift([null])
  else if (Array.isArray(k)) keys.unshift([2, k[0], undefined, i])
  else if (typeof k === "number") {
    let reset = false
    if (obj.arrs[i] !== true) {
      reset = true
      obj.arrs[i] = true
    }
    keys.unshift([obj.ktypes[i - 1][0], k, reset, i])
  } else {
    let reset = false
    if (obj.objs[i] !== true) {
      reset = true
      obj.objs[i] = true
    }
    keys.unshift([k, undefined, reset, i])
  }
  if (i > 1) {
    const d = obj.krefs[i - 2]
    if (d > 0) getKey(obj.krefs[d - 1], keys, obj)
  }
  let i2 = 0
  for (let k of keys) {
    if (Array.isArray(k) && k[0] === 2) {
      let reset = false
      if (obj.objs[i] !== true) {
        reset = true
        obj.objs[i] = true
      }
      keys[i2] = [obj.strmap[k[1].toString()], undefined, reset, i]
    }
    i2++
  }
}

const get = (obj, type) => {
  let val = null
  if (type === 7 || type === 2) {
    let str = obj.strs[obj.sc++]
    if (Array.isArray(str)) str = obj.strmap[str[0].toString()]
    val = str
  } else if (type === 4) val = obj.nums[obj.nc++]
  else if (type === 5) val = obj.nums[obj.nc++]
  else if (type === 6) val = obj.nums[obj.nc++]
  else if (type === 1) val = null
  else if (type === 3) val = obj.bools[obj.bc++]
  return val
}
const getVal = (i, obj) => {
  let type = obj.vtypes[i]
  let val = null
  let replace = null
  let push = null
  if (Array.isArray(type)) {
    val = { __update__: true }
    if (type[0] === 2) {
      val.__index__ = type[1]
      val.__val__ = get(obj, type[2])
    } else if (type[0] === 3) {
      val.__index__ = type[1]
      val.__remove__ = 1
      val.__del__ = true
    } else if (type[0] === 0) {
      if (type[1] === 0) {
        val.__del__ = true
      } else if (type[1] === 1) {
        val.__merge__ = true
      }
    } else console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxx")
  } else if (type === 0) val = { __del__: true }
  else val = { __val__: get(obj, type) }
  return val
}

export { Builder, getKey, getVal }
