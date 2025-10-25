import { strmap_rev, base64_rev, bits, tobits } from "./utils.js"
import { includes, flatten } from "ramda"
import { Builder } from "./builder.js"

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
    let result = 0
    let shift = 0
    let byte
    do {
      byte = this.n(8)
      result += (byte & 0x7f) * Math.pow(2, shift)
      shift += 7
    } while (byte & 0x80)
    return result
  }

  decode(v, count = null, strmap) {
    this.initial_count = 0
    if (count !== null) {
      this.initial_count = count
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
    this.sc = 0
    this.bc = 0
    this.len = 0
    this.str_len = 0
    this.strmap = strmap ?? {}
    this.str_rev = {}
    for (let k in strmap) {
      this.str_len++
      this.str_rev[strmap[k]] = k
    }
    this.key_length = 0
    this.num_cache = null
    this.vflags = []
    this.kflags = []
    this.bools = []
    this.krefs = []
    this.vrefs = []
    this.ktypes = []
    this.vtypes = []
    this.nums = []
    this.keys = []
    this.strs = []
    this.json = {}
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
      this.getVtypes()
      this.getBools()
      this.getNums()
      this.getStrs()
      this.buildStrMap()
      if (!this.nobuild) this.build()
    }
    if (this.c % 8 !== 0) this.c += 8 - (this.c % 8)
    return tobits(this.o, this.c)
  }

  buildStrMap() {
    const plus = this.initial_count
    const plus2 = this.initial_count ? 0 : 1
    let seen = {}
    const keys = (i, arr = []) => {
      const k = this.krefs[i]
      if (typeof k === "undefined" || seen[i]) return
      else {
        seen[i] = true
        arr.unshift({ t: "k", i })
        return keys(k - (2 + plus), arr)
      }
    }
    let _arr = []
    let i = 0
    for (const v of this.vrefs) {
      let arr = [{ t: "v", i }]
      keys(v - (2 + plus), arr)
      _arr.push(arr)
      i++
    }
    const toMap = kv => {
      if (typeof kv === "string") {
        if (typeof this.str_rev[kv] === "undefined") {
          const ind = (this.str_len++).toString()
          ;((this.str_rev[kv] = ind), (this.strmap[ind] = kv))
        }
      }
    }

    let str = 0
    for (const v of flatten(_arr)) {
      if (v.t === "k") toMap(this.keys[v.i + plus2])
      else if (includes(this.vtypes[v.i], [2, 7])) toMap(this.strs[str++])
    }
  }

  getStrs() {
    let val = null
    for (let _type of this.vtypes) {
      let type = Array.isArray(_type)
        ? _type[0] === 2
          ? _type[3]
          : _type[2]
        : _type
      if (Array.isArray(type)) type = type[2]
      if (type === 7 || type === 2) {
        let len = this.short()
        if (type === 2 && len === 0) this.strs.push([this.short()])
        else {
          val = ""
          for (let i2 = 0; i2 < len; i2++) {
            if (type === 7) val += String.fromCharCode(Number(this.leb128()))
            else val += base64_rev[this.n(6).toString()]
          }
          this.strs.push(val)
        }
      }
    }
  }

  getSingle() {
    const strs = [null, true, false, "", [], {}]
    const isNum = this.n(1)
    if (isNum) {
      const num = this.n(6)
      if (num < 63) this.json = num
      else this.json = 63 + this.leb128()
    } else {
      const code = this.n(6)
      if (code < 6) this.json = strs[code]
      else if (code < 9) {
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
        for (let i = 0; i < len; i++) this.json += base64_rev[this.n(6)]
      } else if (code === 63) {
        this.json = ""
        for (let i = 0; i < this.short(); i++) {
          this.json += String.fromCharCode(Number(this.leb128()))
        }
      }
    }
  }

  getLen() {
    this.len = this.short()
  }

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

  getVtypes() {
    let i2 = -1
    let len = Math.max(1, this.vrefs.length)
    for (let i = 0; i < len; i++) {
      let type = this.n(3)
      if (type === 0) {
        const count = this.short()
        if (count === 0) {
          let type2 = this.n(1)
          if (type2 === 1) {
            let index = this.short()
            let remove = this.short()
            let type3 = this.n(3)
            if (type3 === 0) {
              this.vtypes.push([3, index, remove])
            } else {
              this.vtypes.push([2, index, remove, type3])
            }
          } else if (type2 === 0) this.vtypes.push(0)
        } else {
          i += count - 1
          let type2 = this.n(3)
          for (let i2 = 0; i2 < count; i2++) this.vtypes.push(type2)
        }
      } else {
        this.vtypes.push(type)
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
    for (let _v of this.vtypes) {
      let v = Array.isArray(_v) ? _v[2] : _v
      if (v === 3) this.bools.push(this.n(1) === 1)
    }
  }

  getNums() {
    let prev = 0
    for (let _v of this.vtypes) {
      let v = Array.isArray(_v) ? _v[3] : _v
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
      if (type < 2) this.keys.push(type === 0 ? arr++ : obj++)
      else {
        if (type === 2) {
          if (len === 0) this.keys.push([this.short()])
          else {
            let key = ""
            for (let i2 = 0; i2 < len - 1; i2++) key += base64_rev[this.n(6)]
            this.keys.push(key)
          }
        } else {
          if (len === 2) this.keys.push("")
          else {
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

  build() {
    const builder = new Builder(this.table())
    this.json = builder.build()
    const artable = builder.table()
    for (let k in artable) this[k] = artable[k]
    if (this.c % 8 !== 0) this.c += 8 - (this.c % 8)
    return this.json
  }
}
export { Decoder }
