import { strmap_rev, base64_rev, bits, tobits, strmap } from "./utils.js"

class Decoder {
  constructor() {
    this.c = 0
    this.json = null
  }

  n(len) {
    let result = 0
    for (let i = 0; i < len; i++) {
      const bitPos = this.c + i
      const byteIndex = Math.floor(bitPos / 8)
      const bitIndex = 7 - (bitPos % 8)
      const bit = (this.o[byteIndex] >> bitIndex) & 1
      result = (result << 1) | bit
    }
    this.c += len
    return result
  }

  leb128() {
    let n = 0
    let i = 0
    let len_len = null
    do {
      len_len = this.n(8)
      n += Math.pow(128, i) * (len_len >= 128 ? len_len - 128 : len_len)
      i++
    } while (len_len >= 128)
    return n
  }

  decode(v, count = null, update = false, query) {
    this.update = update
    if (count !== null) {
      this.nobuild = true
      this.keylen = count
      this.count = count === 0 ? 1 : bits(count + 2)
    } else {
      this.nobuild = false
      this.keylen = 0
      this.count = 1
    }
    this.kcount = this.count
    this.o = v
    this.c = 0
    this.nc = 0
    this.bc = 0
    this.len = 0
    this.str_len = 0
    this.strmap = {}
    this.str_rev = {}
    this.key_length = 0
    this.num_cache = null
    this.vflags = []
    this.kflags = []
    this.bools = []
    this.krefs = []
    this.vrefs = []
    this.ktypes = []
    this.types = []
    this.nums = []
    this.keys = []
    this.strs = []
    this.json = {}
    if (query) {
      this.op = this.n(2)
      this.col = this.short()
      this.doc = this.leb128()
      if (this.op === 2) this.update_len = this.short()
      if (this.op !== 1) return tobits(this.o, this.c)
    }
    this.single = this.n(1) === 1
    if (this.single) this.getSingle()
    else {
      this.getLen()
      this.getVflags()
      this.getVrefs()
      this.getKflags()
      this.getKrefs()
      this.getKtypes()
      this.getKeys()
      this.getTypes()
      this.getBools()
      this.getNums()
      if (!this.nobuild) this.build()
      else this.getStrs()
    }
    return tobits(this.o, this.c)
  }
  getStrs() {
    let val = null
    for (let _type of this.types) {
      let type = Array.isArray(_type) ? _type[1] : _type
      if (Array.isArray(type)) type = type[1]
      if (type === 7 || type === 2) {
        let len = this.short()
        if (type === 2 && len === 0) {
          const code = this.short().toString()
          val = this.strmap[code]
          this.strs.push(this.strmap[code])
        } else {
          val = ""
          for (let i2 = 0; i2 < len; i2++) {
            if (type === 7) val += String.fromCharCode(Number(this.leb128()))
            else val += base64_rev[this.n(6).toString()]
          }
          this.strs.push(val)
          if (typeof this.str_rev[val] === "undefined") {
            const _key = (this.str_len++).toString()
            this.strmap[_key] = val
            this.str_rev[val] = _key
          }
        }
      }
    }
  }
  getSingle() {
    const strs = [null, true, false, "", [], {}]
    const isNum = this.n(1)
    if (isNum) {
      const num = this.n(6)
      this.json = num
      if (num < 63) {
      } else {
        this.json += this.leb128()
      }
    } else {
      const code = this.n(6)
      if (code < 6) {
        this.json = strs[code]
      } else if (code < 9) {
        if (code === 7 || code === 8) {
          const moved = this.uint()
          const n = this.uint()
          const neg = code === 7 ? 1 : -1
          this.json = (n / Math.pow(10, moved)) * neg
        } else {
          const n = this.uint()
          this.json = -n
        }
      } else if (code < 61) {
        this.json = strmap_rev[(code - 9).toString()]
      } else if (code === 61) {
        this.json = String.fromCharCode(Number(this.leb128()))
      } else if (code === 62) {
        const len = this.short()
        this.json = ""
        for (let i = 0; i < len; i++) {
          this.json += base64_rev[this.n(6).toString()]
        }
      } else if (code === 63) {
        const len = this.short()
        this.json = ""
        for (let i = 0; i < len; i++) {
          this.json += String.fromCharCode(Number(this.leb128()))
        }
      }
    }
  }

  getLen() {
    this.len = this.short()
  }

  cols() {
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
  show() {
    console.log()
    console.log("len", this.len)
    console.log("vflags", this.vflags)
    console.log("vrefs", this.vrefs)
    console.log("kflags", this.kflags)
    console.log("krefs", this.krefs)
    console.log("ktypes", this.ktypes)
    console.log("keys", this.keys)
    console.log("types", this.types)
    console.log("bools", this.bools)
    console.log("nums", this.nums)
    console.log("strs", this.strs)
    console.log("strmap", this.strmap)

    console.log()
    return this.cols()
  }

  getVflags() {
    let i = 0
    while (i < this.len) {
      const flag = this.n(1)
      this.vflags.push(flag)
      i++
    }
  }

  getKflags() {
    let i = 0
    while (i < this.key_length - 1 - this.keylen) {
      const flag = this.n(1)
      this.kflags.push(flag)
      i++
    }
  }

  getKrefs() {
    let i = 0
    let prev = 0
    while (i < this.kflags.length) {
      if (this.kflags[i] === 1) {
        let val = this.n(3)

        if (val === 0) {
          let len = this.short()
          val = this.n(3)
          let i3 = i
          for (let i2 = 0; i2 < len; i2++) {
            const diff = this.kflags[i3 + i2]
            prev = this.addKlink(diff === 1, val, prev)
            i++
          }
        } else {
          prev = this.addKlink(true, val, prev)
          i++
        }
      } else {
        let val = 0
        do {
          val = this.n(this.kcount)
          if (val === 0) this.kcount += 1
        } while (val === 0)

        if (val === 0) {
          let len = this.short()
          val = this.n(this.kcount)
          let i3 = i
          for (let i2 = 0; i2 < len; i2++) {
            const diff = this.kflags[i3 + i2]
            prev = this.addKlink(diff === 1, val, prev)
            i++
          }
        } else {
          prev = this.addKlink(false, val, prev)
          i++
        }
      }
    }
  }

  addVlink(diff, val, prev) {
    val -= 1
    if (diff) {
      if (val > 3) val = prev - (val - 3)
      else val += prev
    }
    this.vrefs.push(val)
    if (this.key_length < val) this.key_length = val
    prev = val
    return prev
  }

  addKlink(diff, val, prev) {
    val -= 1
    if (diff) {
      if (val > 3) val = prev - (val - 3)
      else val += prev
    }
    this.krefs.push(val)
    prev = val
    return prev
  }

  getVrefs() {
    let i = 0
    let prev = 0
    while (i < this.vflags.length) {
      if (this.vflags[i] === 1) {
        let val = this.n(3)
        if (val === 0) {
          let len = this.short()
          val = this.n(3)
          let i3 = i
          for (let i2 = 0; i2 < len; i2++) {
            const diff = this.vflags[i3 + i2]
            prev = this.addVlink(diff === 1, val, prev)
            i++
          }
        } else {
          prev = this.addVlink(true, val, prev)
          i++
        }
      } else {
        let val = 0
        do {
          val = this.n(this.count)
          if (val === 0) this.count += 1
        } while (val === 0)
        prev = this.addVlink(false, val, prev)
        i++
      }
    }
  }
  // 0: array, 1: map, 2: 64, 3: str | [type, strlen]
  getKtypes() {
    const plus = this.nobuild ? 0 : 1
    if (this.krefs.length === 0 && this.len === 0) return
    for (let i = 0; i < this.krefs.length + plus; i++) {
      const type = this.n(2)
      if (type < 2) {
        this.ktypes.push([type])
      } else {
        const len = this.short()
        this.ktypes.push([type, len])
      }
    }
  }

  getTypes() {
    let i2 = -1
    let len = Math.max(1, this.vrefs.length)
    let minus = this.update ? 1 : 0
    for (let i = 0; i < len - minus; i++) {
      let type = this.n(3)
      if (type === 0) {
        const count = this.short()
        if (count === 0) {
          let type2 = this.n(1)
          if (type2 === 1) this.types.push(0)
        } else {
          i += count - 1
          let type2 = this.n(3)
          for (let i2 = 0; i2 < count; i2++) this.types.push(type2)
        }
      } else this.types.push(type)
    }
    if (this.update) {
      const type = this.n(2)
      if (type === 0) {
        const op = this.short()
        this.types.push([type, op])
      } else {
        const index = type === 2 || type === 3 ? this.short() : null
        const remove = type === 3 ? this.short() : null
        this.types.push([type, index, remove])
      }
    }
  }

  short() {
    const x = this.n(2)
    return x === 3 ? this.leb128() : this.n(x === 2 ? 4 : x === 1 ? 3 : 2)
  }

  uint() {
    const x = this.n(2)
    return x === 3 ? this.leb128() : this.n(x === 2 ? 6 : x === 1 ? 4 : 3)
  }

  dint(prev = 0) {
    if (this.num_cache !== null) {
      let n = this.num_cache.diff ? prev + this.num_cache.n : this.num_cache.n
      this.num_cache.len -= 1
      if (this.num_cache.len === 0) this.num_cache = null
      return n
    }
    const x = this.n(2)
    const diff = x === 0
    let num = x === 3 ? this.leb128() : this.n(x === 2 ? 6 : x === 1 ? 4 : 3)
    if (num === 7 && diff) {
      const len = this.short()
      const x2 = this.n(2)
      let diff = x2 === 0
      let n = null
      if (x2 === 3) n = this.leb128()
      else {
        const d = x2 === 0 ? 3 : x2 === 1 ? 4 : 6
        n = this.n(d)
      }
      let n2 = n
      let _diff = 0
      if (diff) {
        if (n > 3) {
          _diff = (n - 3) * -1
        } else {
          _diff = n
        }
        n2 = prev + _diff
      }
      this.num_cache = { len: len - 1, n: _diff, diff }
      return n2
    } else if (diff) {
      if (num > 3) num = prev - (num - 3)
      else num = prev + num
    }
    return num
  }

  getBools() {
    for (let _v of this.types) {
      let v = Array.isArray(_v) ? _v[1] : _v
      if (v === 3) this.bools.push(this.n(1) === 1)
    }
  }

  getNums() {
    let prev = 0
    for (let _v of this.types) {
      let v = Array.isArray(_v) ? _v[1] : _v
      if (v >= 4 && v <= 6) {
        let num = this.dint(prev)
        prev = num
        if (v === 4) this.nums.push(num)
        else if (v === 5) this.nums.push(-num)
        else if (v === 6) {
          if (num === 0 || num === 4) {
            const moved = this.dint(prev)
            prev = moved
            const int = this.dint(prev)
            prev = int
            const neg = num === 0 ? 1 : -1
            this.nums.push((int / Math.pow(10, moved - 1)) * neg)
          } else {
            const moved = num > 4 ? num - 4 : num
            const neg = num > 4 ? -1 : 1
            if (moved === 1) this.nums.push(neg === -1 ? {} : [])
            else {
              const int = this.dint(prev)
              prev = int
              this.nums.push((int / Math.pow(10, moved - 1)) * neg)
            }
          }
        }
      }
    }
  }

  getKeys() {
    let arr = 0
    let obj = 0
    for (let i = 0; i < this.ktypes.length; i++) {
      const [type, len] = this.ktypes[i]
      if (type < 2) {
        // array or map
        this.keys.push(type === 0 ? arr++ : obj++)
      } else {
        if (type === 2) {
          if (len === 0) {
            // ktype: 2, code
            const code = this.short()
            this.keys.push([code])
          } else {
            let key = ""
            for (let i2 = 0; i2 < len - 1; i2++) key += base64_rev[this.n(6)]
            this.keys.push(key)
          }
        } else {
          if (len === 2) {
            this.keys.push("")
          } else {
            let key = ""
            for (let i2 = 0; i2 < len - 1; i2++) {
              key += String.fromCharCode(Number(this.leb128()))
            }
            this.keys.push(key)
          }
        }
      }
    }
  }

  bits() {
    console.log(this.c, tobits(this.o, this.c))
  }

  movePads() {
    if (this.c % 8 > 0) this.c += 8 - (this.c % 8)
  }

  getKey(i, keys) {
    const k = this.keys[i - 1]
    if (Array.isArray(k)) {
      keys.unshift([2, k[0]])
    } else if (typeof k === "number") {
      keys.unshift([this.ktypes[i - 1][0], k])
    } else {
      keys.unshift(k)
    }
    if (i > 1) {
      const d = this.krefs[i - 2]
      if (d > 0) this.getKey(this.krefs[d - 1], keys)
    }
    let i2 = 0
    for (let k of keys) {
      if (typeof k === "string") {
        if (typeof this.str_rev[k] === "undefined") {
          const _key = (this.str_len++).toString()
          this.strmap[_key] = k
          this.str_rev[k] = _key
        }
      } else if (Array.isArray(k) && k[0] === 2) {
        keys[i2] = this.strmap[k[1].toString()]
      }
      i2++
    }
  }

  get(i) {
    const type = this.types[i]
    let val = null
    if (type === 0) return
    if (type === 7 || type === 2) {
      let len = this.short()
      if (type === 2 && len === 0) {
        const code = this.short().toString()
        val = this.strmap[code]
        this.strs.push(this.strmap[code])
      } else {
        val = ""
        for (let i2 = 0; i2 < len; i2++) {
          if (type === 7) val += String.fromCharCode(Number(this.leb128()))
          else val += base64_rev[this.n(6).toString()]
        }
        this.strs.push(val)
        if (typeof this.str_rev[val] === "undefined") {
          const _key = (this.str_len++).toString()
          this.strmap[_key] = val
          this.str_rev[val] = _key
        }
      }
    } else if (type === 4) {
      val = this.nums[this.nc++]
    } else if (type === 5) val = this.nums[this.nc++]
    else if (type === 6) val = this.nums[this.nc++]
    else if (type === 1) val = null
    else if (type === 3) val = this.bools[this.bc++]
    return val
  }
  arr_push(json, val) {
    if (typeof val !== "object" || val === null) json.push(val)
  }
  build() {
    if (this.vrefs.length === 0) return (this.json = this.get(0))
    this.json = null
    let i = 0
    let init = [[], []]
    let type = key => (typeof key === "string" ? 2 : key[0])
    let set = k => (init[k[0]][k[1]] = true)
    let ex = k => init[k[0]][k[1]] === true
    for (let v of this.vrefs) {
      let keys = []
      this.getKey(v, keys)
      const val = this.get(i)
      i++
      let json = this.json
      for (let i2 = 0; i2 < keys.length; i2++) {
        let k = keys[i2]
        if (json === null) {
          let t = type(k)
          set(k)
          if (t === 0) {
            this.json = []
            json = this.json
            if (i2 === keys.length - 1) {
              json[0] = val
              break
            }
            if (i2 === keys.length - 2) {
              const k2 = keys[i2 + 1]
              if (type(k2) === 0) {
                set(k2)
                json.push([])
                json = json[json.length - 1]
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
            this.json = {}
            json = this.json
            if (i2 === keys.length - 2) {
              const k2 = keys[i2 + 1]
              json[k2] = val
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
              if (!ex(k2)) set(k2) && json.push([])
              json = json[json.length - 1]
              this.arr_push(json, val)
              break
            }
            const t2 = type(k2)
            if (t2 === 0) {
              if (!ex(k2)) set(k2) && json.push([])
              json = json[json.length - 1]
            } else if (t2 === 1) {
              if (!ex(k2)) set(k2) && json.push({})
              json = json[json.length - 1]
            }
          } else if (t1 === 1) {
            if (keys.length === 2) {
              json[k2] = val
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
            if (!ex(k2)) set(k2) && json.push([])
            json = json[json.length - 1]
            this.arr_push(json, val)
            break
          } else if (ctype === 1 && ntype === 2) {
            json[k2] = val
            break
          } else if (jtype === 1 && ctype === 2) {
            if (ntype === 0) {
              if (!Array.isArray(json[k])) json[k] = []
              json = json[k]
              this.arr_push(json, val)
            } else if (ntype === 1) {
              json[k] = {}
            }
            break
          } else if (ctype === 0 && ntype === 1) {
            json.push({})
            json = json[json.length - 1]
            break
          } else {
            console.log("impossible 4")
          }
        } else {
          const jtype = Array.isArray(json) ? 0 : 1
          const ctype = type(k)
          const k2 = keys[i2 + 1]
          const ntype = type(k2)
          if (jtype === 1 && ctype === 2) {
            if (ntype === 0) {
              if (!Array.isArray(json[k])) json[k] = []
              json = json[k]
            } else if (ntype === 1) {
              if (
                typeof json[k] !== "object" ||
                json[k] === null ||
                Array.isArray(json[k])
              ) {
                json[k] = {}
              }
              json = json[k]
            } else {
              //console.log("impossible 5")
            }
          } else if (jtype === 0 && ctype === 1) {
            // console.log("impossible 6")
          } else if (jtype === 0 && ctype === 0) {
            if (ntype === 0) {
              if (!ex(k2)) set(k2) && json.push([])
              json = json[json.length - 1]
            } else if (ntype === 1) {
              if (!ex(k2)) set(k2) && json.push({})
              json = json[json.length - 1]
            } else {
              // console.log("impossible 7")
            }
          } else if (jtype === 1 && ctype === 1) {
            // nothing
          } else {
            //console.log("impossible 8")
          }
        }
      }
    }
  }
}

function decode(v, d, query) {
  const left = d.decode(v, undefined, undefined, query)
  if (query) {
    return {
      op: d.op,
      col: d.col,
      doc: d.doc,
      json: d.json,
      left,
      len: d.update_len,
    }
  } else {
    return d.json
  }
}

export { Decoder, decode }
