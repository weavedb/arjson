import { strmap_rev, base64_rev, base64_rev_byte, bits } from "./utils.js"
import { Builder } from "./builder.js"

// Precomputed pow10 table. Decoding floats does `int / Math.pow(10, n)`
// where n is small (precision, typically ≤ 20). Math.pow goes through
// a slow path for non-integer second arg — even for integer second arg
// it dispatches to a generic exponentiation routine. Direct table
// lookup is much faster.
const POW10 = new Float64Array(310)
for (let i = 0; i < 310; i++) POW10[i] = Math.pow(10, i)

class Decoder {
  constructor() {
    this.c = 0
    this.json = null
  }

  n(len) {
    const c = this.c
    const o = this.o
    const byteIdx = c >>> 3
    const bitOff = c & 7
    this.c = c + len
    if (this.c > o.length * 8 + 64) {
      throw new Error("ARJSON decoder: read past end of buffer")
    }
    // Fast path: any read of ≤ 24 bits fits in a 32-bit window over up to
    // 4 bytes. Out-of-range bytes coerce to undefined → 0 (zero-extend),
    // matching the bit-by-bit fallback's behavior past the buffer end.
    if (len <= 24) {
      const w =
        ((o[byteIdx] << 24) |
          ((o[byteIdx + 1] | 0) << 16) |
          ((o[byteIdx + 2] | 0) << 8) |
          (o[byteIdx + 3] | 0)) >>> 0
      return (w >>> (32 - bitOff - len)) & ((1 << len) - 1)
    }
    // Slow path: > 24 bits, reassemble bit-by-bit.
    let result = 0
    for (let i = 0; i < len; i++) {
      const bitPos = c + i
      const bit = (o[bitPos >> 3] >> (7 - (bitPos & 7))) & 1
      result = (result << 1) | bit
    }
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

  // Shared scratch buffer for charcodes during string decode.
  // Plain JS array (length-truncatable) lets us pass it directly to
  // String.fromCharCode.apply without a Uint16Array.subarray allocation
  // per string (was 2-4% as CreateTypedArray + TypedArrayPrototypeSubArray).
  _scratch(len) {
    if (!this._scratchArr) this._scratchArr = []
    this._scratchArr.length = len
    return this._scratchArr
  }

  decode(v, count = null, strmap, strdiffs = []) {
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
    this.dc = strdiffs.length
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
    // Reuse arrays across calls when possible; truncating with length=0
    // is dramatically cheaper than allocating fresh arrays + GC pressure
    // (avoids GrowFastSmiOrObjectElements re-grows on the first pushes).
    if (this.vflags === undefined) {
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
      this.strdiffs = []
    } else {
      this.vflags.length = 0
      this.kflags.length = 0
      this.bools.length = 0
      this.krefs.length = 0
      this.vrefs.length = 0
      this.ktypes.length = 0
      this.vtypes.length = 0
      this.nums.length = 0
      this.keys.length = 0
      this.strs.length = 0
      this.strdiffs.length = 0
    }
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
      this.getStrDiffs()
      this.buildStrMap()
      if (!this.nobuild) this.build()
    }
    if (this.c & 7) this.c += 8 - (this.c & 7)
    return this.o.subarray(this.c >>> 3)
  }

  buildStrMap() {
    const plus = this.initial_count
    const plus2 = this.initial_count ? 0 : 1
    const offset = 2 + plus
    const krefs = this.krefs
    const seen = new Uint8Array(krefs.length)
    const vrefs = this.vrefs
    const vlen = vrefs.length

    // Walk each vref's chain of krefs. Inline traversal avoids the closure,
    // unshift, ramda flatten, and intermediate { t, i } object allocation.
    // The flat output is stored as parallel arrays: kinds (0=v, 1=k) and
    // indices, so we don't allocate {t,i} per node.
    const kinds = []
    const indices = []
    // Local stack for the krefs chain (so we can reverse them in-place
    // without unshift's O(n²)).
    const stack = []
    for (let i = 0; i < vlen; i++) {
      let kIdx = vrefs[i] - offset
      stack.length = 0
      while (kIdx >= 0 && kIdx < krefs.length && !seen[kIdx]) {
        const k = krefs[kIdx]
        if (k === undefined) break
        seen[kIdx] = 1
        stack.push(kIdx)
        kIdx = k - offset
      }
      // emit reversed (root-to-leaf) krefs first, then the v
      for (let j = stack.length - 1; j >= 0; j--) {
        kinds.push(1)
        indices.push(stack[j])
      }
      kinds.push(0)
      indices.push(i)
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
    const flatLen = kinds.length
    for (let n = 0; n < flatLen; n++) {
      if (kinds[n] === 1) toMap(this.keys[indices[n] + plus2])
      else {
        const t = this.vtypes[indices[n]]
        if (t === 2 || t === 7) toMap(this.strs[str++])
      }
    }
  }
  getStrDiffs() {
    let diffCount = 0
    for (let _type of this.strs) {
      if (Array.isArray(_type) && _type[0] === -1) {
        diffCount++
      }
    }

    for (let i = 0; i < diffCount; i++) {
      const startPos = this.c
      const totalBits = this.leb128()
      const varintBits = this.c - startPos
      const varintBytes = varintBits / 8
      const dataBytes = Math.ceil(totalBits / 8)
      const totalBytes = varintBytes + dataBytes

      // Bound allocation: a string diff can't be larger than the buffer.
      // Malformed input could otherwise request multi-GB Uint8Array.
      if (totalBytes > this.o.length) {
        throw new Error("ARJSON decoder: strdiff length exceeds buffer")
      }

      this.c = startPos
      const diffData = new Uint8Array(totalBytes)

      for (let j = 0; j < totalBytes; j++) {
        diffData[j] = this.n(8)
      }

      this.strdiffs.push(diffData)
    }
  }
  getStrs() {
    let val = null
    const maxBits = this.o.length * 8
    for (let _type of this.vtypes) {
      let type = Array.isArray(_type) ? _type[3] : _type
      if (Array.isArray(type)) type = type[2]
      if (type === 7 || type === 2) {
        let len = this.short()
        if (type === 2 && len === 0) {
          let stype = this.n(1)
          if (stype === 0) this.strs.push([this.short()])
          else this.strs.push([-1, this.dc++])
        } else {
          // Each char takes ≥ 6 bits; reject lengths that can't fit in
          // the remaining buffer.
          if (len > maxBits) {
            throw new Error("ARJSON decoder: string length exceeds buffer")
          }
          // Build into the shared Uint16Array scratch buffer, then a
          // single String.fromCharCode.apply call. Reuses the buffer
          // across strings within one decode, and across decode calls.
          const codes = this._scratch(len)
          if (type === 7) {
            for (let i2 = 0; i2 < len; i2++) codes[i2] = Number(this.leb128())
          } else {
            // Inline n(6) for hot 6-bit reads (one per base64 char).
            const o = this.o
            let c = this.c
            for (let i2 = 0; i2 < len; i2++) {
              const byteIdx = c >>> 3
              const bitOff = c & 7
              const w =
                ((o[byteIdx] << 24) |
                  ((o[byteIdx + 1] | 0) << 16) |
                  ((o[byteIdx + 2] | 0) << 8) |
                  (o[byteIdx + 3] | 0)) >>> 0
              codes[i2] = base64_rev_byte[(w >>> (26 - bitOff)) & 0x3f]
              c += 6
            }
            this.c = c
            if (this.c > o.length * 8 + 64) {
              throw new Error("ARJSON decoder: read past end of buffer")
            }
          }
          // Use subarray to limit fromCharCode to the actual length
          // (scratch may be larger). For >16K chars, chunk to stay
          // under the engine's apply() arg limit.
          let val
          if (len <= 16384) {
            val = String.fromCharCode.apply(null, codes)
          } else {
            val = ""
            for (let off = 0; off < len; off += 16384) {
              val += String.fromCharCode.apply(null, codes.slice(off, Math.min(off + 16384, len)))
            }
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
          this.json = (n / (moved < 310 ? POW10[moved] : Math.pow(10, moved))) * neg
        } else {
          const n = this.uint()
          this.json = -n
        }
      } else if (code < 61) {
        this.json = strmap_rev[code - 9]
      } else if (code === 61) {
        this.json = String.fromCharCode(Number(this.leb128()))
      } else if (code === 62) {
        const len = this.short()
        const codes = this._scratch(len)
        for (let i = 0; i < len; i++) codes[i] = base64_rev_byte[this.n(6)]
        if (len <= 16384) {
          this.json = String.fromCharCode.apply(null, codes)
        } else {
          let s = ""
          for (let off = 0; off < len; off += 16384) {
            s += String.fromCharCode.apply(null, codes.slice(off, Math.min(off + 16384, len)))
          }
          this.json = s
        }
      } else if (code === 63) {
        const len = this.short()
        const codes = this._scratch(len)
        for (let i = 0; i < len; i++) codes[i] = Number(this.leb128())
        if (len <= 16384) {
          this.json = String.fromCharCode.apply(null, codes)
        } else {
          let s = ""
          for (let off = 0; off < len; off += 16384) {
            s += String.fromCharCode.apply(null, codes.slice(off, Math.min(off + 16384, len)))
          }
          this.json = s
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
      strdiffs: this.strdiffs,
    }
  }

  getVflags() {
    const maxBits = this.o.length * 8 - this.c
    if (this.len > maxBits) {
      throw new Error("ARJSON decoder: vflags length exceeds remaining buffer")
    }
    // Inline n(1) for the hot bit-by-bit flag read. Avoids 1721 method
    // calls + function-frame allocation for each 1-bit read.
    const o = this.o
    const len = this.len
    const vflags = this.vflags
    let c = this.c
    for (let i = 0; i < len; i++) {
      vflags.push((o[c >>> 3] >> (7 - (c & 7))) & 1)
      c++
    }
    this.c = c
  }

  getKflags() {
    const need = this.key_length - 1 - this.keylen
    const maxBits = this.o.length * 8 - this.c
    if (need > maxBits) {
      throw new Error("ARJSON decoder: kflags length exceeds remaining buffer")
    }
    const o = this.o
    const kflags = this.kflags
    let c = this.c
    for (let i = 0; i < need; i++) {
      kflags.push((o[c >>> 3] >> (7 - (c & 7))) & 1)
      c++
    }
    this.c = c
  }

  getKrefs() {
    let i = 0
    let prev = 0
    const flagsLen = this.kflags.length
    while (i < flagsLen) {
      if (this.kflags[i] === 1) {
        let val = this.n(3)

        if (val === 0) {
          let len = this.short()
          if (len > flagsLen - i) {
            throw new Error("ARJSON decoder: krefs run-length exceeds remaining flags")
          }
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
          if (len > flagsLen - i) {
            throw new Error("ARJSON decoder: krefs run-length exceeds remaining flags")
          }
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
    const flagsLen = this.vflags.length
    while (i < flagsLen) {
      if (this.vflags[i] === 1) {
        let val = this.n(3)
        if (val === 0) {
          let len = this.short()
          if (len > flagsLen - i) {
            throw new Error("ARJSON decoder: vrefs run-length exceeds remaining flags")
          }
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
      if (type < 2) this.ktypes.push([type])
      else this.ktypes.push([type, this.short()])
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
            if (type3 === 0) this.vtypes.push([3, index, remove])
            else this.vtypes.push([2, index, remove, type3])
          } else if (type2 === 0) this.vtypes.push(0)
        } else {
          if (count > len - i) {
            throw new Error("ARJSON decoder: vtypes run-length exceeds remaining slots")
          }
          i += count - 1
          let type2 = this.n(3)
          for (let i2 = 0; i2 < count; i2++) this.vtypes.push(type2)
        }
      } else this.vtypes.push(type)
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
      let v = Array.isArray(_v) ? _v[3] : _v
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
            const m1 = moved - 1
            const denom = m1 < 310 ? POW10[m1] : Math.pow(10, m1)
            this.nums.push((int / denom) * neg)
          } else {
            const moved = num > 4 ? num - 4 : num
            const neg = num > 4 ? -1 : 1
            if (moved === 1) this.nums.push(neg === -1 ? {} : [])
            else {
              const int = this.dint(prev)
              prev = int
              const m1 = moved - 1
              const denom = m1 < 310 ? POW10[m1] : Math.pow(10, m1)
              this.nums.push((int / denom) * neg)
            }
          }
        }
      }
    }
  }

  getKeys() {
    let arr = 0
    let obj = 0
    const maxBits = this.o.length * 8
    for (let i = 0; i < this.ktypes.length; i++) {
      const [type, len] = this.ktypes[i]
      if (type < 2) this.keys.push(type === 0 ? arr++ : obj++)
      else {
        if (type === 2) {
          if (len === 0) this.keys.push([this.short()])
          else {
            if (len > maxBits) {
              throw new Error("ARJSON decoder: key length exceeds buffer")
            }
            const klen = len - 1
            const codes = this._scratch(klen)
            // Inline n(6) — same pattern as getStrs.
            const o = this.o
            let c = this.c
            for (let i2 = 0; i2 < klen; i2++) {
              const byteIdx = c >>> 3
              const bitOff = c & 7
              const w =
                ((o[byteIdx] << 24) |
                  ((o[byteIdx + 1] | 0) << 16) |
                  ((o[byteIdx + 2] | 0) << 8) |
                  (o[byteIdx + 3] | 0)) >>> 0
              codes[i2] = base64_rev_byte[(w >>> (26 - bitOff)) & 0x3f]
              c += 6
            }
            this.c = c
            if (c > o.length * 8 + 64) {
              throw new Error("ARJSON decoder: read past end of buffer")
            }
            this.keys.push(String.fromCharCode.apply(null, codes))
          }
        } else {
          if (len === 2) this.keys.push("")
          else {
            if (len > maxBits) {
              throw new Error("ARJSON decoder: key length exceeds buffer")
            }
            const klen = len - 1
            const codes = this._scratch(klen)
            for (let i2 = 0; i2 < klen; i2++) codes[i2] = Number(this.leb128())
            this.keys.push(String.fromCharCode.apply(null, codes))
          }
        }
      }
    }
  }

  build() {
    // Shared Builder instance — avoids per-decode allocation of
    // Builder + the Uint8Array buffers it owns for arrs/objs.
    const b = this._builder ?? (this._builder = new Builder())
    b.setTable(this.table())
    this.json = b.build()
    // Direct field copy — was `for (k in artable)` which is
    // megamorphic (StoreIC_Megamorphic in profile). The set of fields
    // is fixed and known.
    this.strmap = b.strmap
    this.strdiffs = b.strdiffs
    this.ktypes = b.ktypes
    this.vrefs = b.vrefs
    this.krefs = b.krefs
    this.vtypes = b.vtypes
    this.nums = b.nums
    this.strs = b.strs
    this.bools = b.bools
    this.keys = b.keys
    if (this.c & 7) this.c += 8 - (this.c & 7)
    return this.json
  }
}
export { Decoder }
