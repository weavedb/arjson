function frombits(bitArray) {
  // Join all bit strings
  const bitStr = bitArray.join("")

  // Calculate how many bytes we need
  const byteCount = Math.ceil(bitStr.length / 8)

  // Create a new Uint8Array
  const result = new Uint8Array(byteCount)

  // Fill the Uint8Array
  for (let i = 0; i < byteCount; i++) {
    // Get the next 8 bits (or fewer for the last byte)
    const start = i * 8
    const end = Math.min(start + 8, bitStr.length)
    const bits = bitStr.substring(start, end).padEnd(8, "0")

    // Convert the bits to a byte
    result[i] = parseInt(bits, 2)
  }

  return result
}

function tobits(arr, cursor = 0) {
  let bitStr = ""
  for (let i = 0; i < arr.length; i++) {
    bitStr += arr[i].toString(2).padStart(8, "0")
  }
  let remaining = bitStr.slice(cursor)

  let result = []
  let offset = cursor % 8
  if (offset !== 0) {
    let firstChunkSize = 8 - offset
    result.push(remaining.slice(0, firstChunkSize))
    remaining = remaining.slice(firstChunkSize)
  }
  while (remaining.length >= 8) {
    result.push(remaining.slice(0, 8))
    remaining = remaining.slice(8)
  }
  if (remaining.length > 0) result.push(remaining)
  return result
}

function bits(n) {
  return n === 0 ? 1 : 32 - Math.clz32(n)
}

let str = "abcdefghijklmnopqrstuvwxyz".toUpperCase()
str += str.toLowerCase()
let strmap = {}
let i = 0
for (const s of str.split("")) strmap[s] = i++
let strmap_rev = {}
i = 0
for (const s of str.split("")) {
  strmap_rev[i.toString()] = s
  i++
}
let base64 = {}
let base64_rev = {}
str += "0123456789-_"
i = 0
for (const s of str.split("")) {
  base64_rev[i.toString()] = s
  base64[s] = i++
}

// charCode-indexed lookup table for base64url chars.
// 0..63 = base64 value, 0xff = not a base64url char.
// Indexed by charCode 0..127. base64url chars are all ASCII.
const base64_byte = new Uint8Array(128).fill(0xff)
for (const s in base64) base64_byte[s.charCodeAt(0)] = base64[s]

// charCode-indexed strmap lookup for A-Za-z. 0..51 valid, 0xff invalid.
const strmap_byte = new Uint8Array(128).fill(0xff)
for (const s in strmap) strmap_byte[s.charCodeAt(0)] = strmap[s]

// Reverse lookup: index 0..63 → charCode of the base64url character at
// that position. Used by decoder to avoid object dictionary lookup +
// string allocation per char.
const base64_rev_byte = new Uint8Array(64)
for (const k in base64_rev) base64_rev_byte[parseInt(k, 10)] = base64_rev[k].charCodeAt(0)

// Reverse lookup: index 0..51 → charCode of the strmap character at that
// position. Used by single-char decode path.
const strmap_rev_byte = new Uint8Array(52)
for (const k in strmap_rev) strmap_rev_byte[parseInt(k, 10)] = strmap_rev[k].charCodeAt(0)

// 4-slot rotating cache for getPrecision. Float-array workloads have
// many distinct values; a 2-slot cache had ~50% hit rate, 4 slots hits
// closer to 90% for typical sequences.
let _gp_v0 = NaN, _gp_p0 = 0
let _gp_v1 = NaN, _gp_p1 = 0
let _gp_v2 = NaN, _gp_p2 = 0
let _gp_v3 = NaN, _gp_p3 = 0
function getPrecision(v) {
  if (v === _gp_v0) return _gp_p0
  if (v === _gp_v1) return _gp_p1
  if (v === _gp_v2) return _gp_p2
  if (v === _gp_v3) return _gp_p3
  let p
  if (v === 0) p = 0
  else {
    const s = v.toString()
    const e = s.indexOf("e")
    if (e !== -1) {
      const mantissa = s.slice(0, e)
      const exp = parseInt(s.slice(e + 1), 10)
      const dot = mantissa.indexOf(".")
      const mantissaPrec = dot === -1 ? 0 : mantissa.length - dot - 1
      p = Math.max(0, mantissaPrec - exp)
    } else {
      const dot = s.indexOf(".")
      if (dot === -1) p = 0
      else {
        const frac = s.slice(dot + 1).replace(/0+$/, "")
        p = frac.length
      }
    }
  }
  // Rotate: evict slot 3, shift 0→1→2→3, write fresh to slot 0.
  _gp_v3 = _gp_v2; _gp_p3 = _gp_p2
  _gp_v2 = _gp_v1; _gp_p2 = _gp_p1
  _gp_v1 = _gp_v0; _gp_p1 = _gp_p0
  _gp_v0 = v; _gp_p0 = p
  return p
}

function escapeKey(k) {
  return String(k).replace(/[\\\[\]]/g, "\\$&")
}

function parsePath(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0

  while (i < path.length) {
    const char = path[i]

    if (char === "\\" && i + 1 < path.length) {
      const next = path[i + 1]
      if (next === "[" || next === "]" || next === "\\") {
        currentKey += next
        i += 2
        continue
      }
    }

    if (char === ".") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }

    if (char === "[") {
      let j = i + 1
      let content = ""
      while (j < path.length && path[j] !== "]") {
        content += path[j]
        j++
      }

      if (j < path.length && path[j] === "]" && /^\d+$/.test(content)) {
        if (currentKey) {
          result.push(currentKey)
          currentKey = ""
        }
        result.push(parseInt(content, 10))
        i = j + 1
        continue
      }

      currentKey += char
      i++
      continue
    }

    currentKey += char
    i++
  }

  if (currentKey) result.push(currentKey)
  return result
}

// Alternative implementation that's more explicit about escaping
function parsePathStrict(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0
  let escaped = false

  while (i < path.length) {
    const char = path[i]

    if (escaped) {
      // Add the escaped character literally
      currentKey += char
      escaped = false
      i++
      continue
    }

    if (char === "\\") {
      // Next character is escaped
      escaped = true
      i++
      continue
    }

    if (char === ".") {
      // End of a key segment
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }

    if (char === "[") {
      // Only treat as array index if we have a complete key before it
      // and the content is numeric
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }

      // Find the closing bracket
      let j = i + 1
      let indexStr = ""

      while (j < path.length && path[j] !== "]") {
        indexStr += path[j]
        j++
      }

      if (j >= path.length) {
        // No closing bracket found, treat [ as part of key
        currentKey += char
        i++
        continue
      }

      // Check if it's a valid number
      if (/^\d+$/.test(indexStr)) {
        result.push(parseInt(indexStr, 10))
        i = j + 1 // Skip past ]
      } else {
        // Not a valid array index, treat as part of key name
        currentKey += path.substring(i, j + 1)
        i = j + 1
      }
      continue
    }

    // Regular character
    currentKey += char
    i++
  }

  // Add the last segment if any
  if (currentKey) {
    result.push(currentKey)
  }

  return result
}

// ── Native replacements for ramda functions used in arjson/artable ──────

// isObject(v): true for non-null objects (including arrays). Matches
// ramda's `is(Object, v)` semantics.
const isObject = v => typeof v === "object" && v !== null

// equals(a, b): deep structural equality with primitive-strict matching.
// Handles arrays, plain objects, dates, regexps, NaN. Does NOT do
// special-case Map/Set/typed-array handling (matches the prior ramda
// behavior that arjson relied on; full ramda parity not required).
const equals = (a, b) => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a !== a && b !== b) return true  // both NaN
  if (a === null || b === null) return false
  if (typeof a !== "object") return false
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i], b[i])) return false
    }
    return true
  }
  // Plain object — compare own enumerable keys.
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!equals(a[k], b[k])) return false
  }
  return true
}

// deepClone(v): JSON-friendly deep copy. Uses structuredClone when
// available (Node 17+), otherwise falls back to JSON round-trip
// (loses Date/regexp; matches the previous ramda.clone behavior for
// the JSON-only data ARJSON encodes).
const deepClone = typeof structuredClone === "function"
  ? structuredClone
  : v => JSON.parse(JSON.stringify(v))

// mergeLeft(a, b): right-biased shallow merge — b's keys take precedence
// when present, falling back to a's. Matches ramda's mergeLeft semantics
// (the "left" is the priority side, which is `a` in ramda's argument
// order). Only used for object-shaped tables in artable.compact.
const mergeLeft = (a, b) => ({ ...b, ...a })

export {
  parsePath,
  parsePathStrict,
  escapeKey,
  getPrecision,
  bits,
  tobits,
  strmap,
  strmap_byte,
  base64,
  base64_byte,
  base64_rev,
  base64_rev_byte,
  strmap_rev,
  strmap_rev_byte,
  frombits,
  isObject,
  equals,
  deepClone,
  mergeLeft,
}
