// Massive regression suite. Covers:
//   1. Primitive round-trips at every type / bit boundary.
//   2. Container round-trips: nesting, key/element counts at boundaries.
//   3. Delta-update invariants across every transition shape.
//   4. Buffer round-trip equivalence at every step.
//   5. Boundary triggers for type-pack / delta-pack thresholds.
//   6. Seeded property-based fuzzing.
//   7. Concrete cases from prior bug history.
//
// Every test uses deepEqual so JSON-spec equivalence (NaN/Inf→null, -0===0) is
// enforced. Tests are designed to be order-independent and reproducible.

import { describe, it } from "node:test"
import assert from "assert"
import { equals } from "../src/utils.js"
import { ARJSON, enc, dec } from "../src/arjson.js"
import { Encoder, Decoder, encode } from "../src/index.js"
import { parsePath, escapeKey, getPrecision } from "../src/utils.js"

// ─── helpers ────────────────────────────────────────────────────────────────

const roundTrip = (json, expected = json) =>
  assert.deepEqual(dec(enc(json)), expected)

const update = (from, to, expected = to) => {
  const a = new ARJSON({ json: from })
  a.update(to)
  assert.deepEqual(a.json, expected, "live state mismatch")
  assert.deepEqual(
    new ARJSON({ arj: a.toBuffer() }).json,
    expected,
    "buffer round-trip mismatch",
  )
}

const chain = states => {
  const a = new ARJSON({ json: states[0] })
  for (const s of states.slice(1)) {
    a.update(s)
    assert.deepEqual(a.json, s, `chain step mismatch at ${JSON.stringify(s)}`)
  }
  assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, a.json)
}

// Seeded PRNG (mulberry32) for reproducible fuzz.
const prng = seed => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const randomJSON = (rng, depth = 0, maxDepth = 4) => {
  if (depth >= maxDepth) return randomPrimitive(rng)
  const r = rng()
  if (r < 0.15) return randomPrimitive(rng)
  if (r < 0.55) {
    const n = Math.floor(rng() * 5) + 1
    const o = {}
    for (let i = 0; i < n; i++)
      o[randomKey(rng)] = randomJSON(rng, depth + 1, maxDepth)
    return o
  }
  const n = Math.floor(rng() * 5) + 1
  const a = []
  for (let i = 0; i < n; i++) a.push(randomJSON(rng, depth + 1, maxDepth))
  return a
}

const randomPrimitive = rng => {
  const r = rng()
  if (r < 0.1) return null
  if (r < 0.2) return rng() < 0.5
  if (r < 0.45) return Math.floor(rng() * 1000) - 500
  if (r < 0.6) return Math.round((rng() * 200 - 100) * 100) / 100
  return randomString(rng, 1 + Math.floor(rng() * 12))
}

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
const randomString = (rng, len) => {
  let s = ""
  for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)]
  return s
}
const randomKey = rng =>
  randomString(rng, 1 + Math.floor(rng() * 8))

// ─── 1. primitive round-trip ────────────────────────────────────────────────

describe("primitives — round-trip", () => {
  it("null/true/false/empty-string", () => {
    for (const v of [null, true, false, ""]) roundTrip(v)
  })

  it("integers 0..127 (covers 6-bit shortcut + LEB128 boundary at 63)", () => {
    for (let i = 0; i <= 127; i++) roundTrip(i)
  })

  it("integers 128..1024 step 1 (LEB128 single→multi byte)", () => {
    for (let i = 128; i <= 1024; i++) roundTrip(i)
  })

  it("negative integers -1..-1000", () => {
    for (let i = -1; i >= -1000; i--) roundTrip(i)
  })

  it("bit-width boundary integers", () => {
    const bounds = [
      0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256,
      511, 512, 1023, 1024, 2047, 2048, 4095, 4096, 16383, 16384, 65535,
      65536, 1 << 20, 1 << 24, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1,
      2 ** 32, 2 ** 40, 2 ** 53 - 1, Number.MAX_SAFE_INTEGER,
    ]
    for (const n of bounds) {
      roundTrip(n)
      roundTrip(-n)
    }
  })

  it("MAX_SAFE_INTEGER + 1, ±1e20, ±1e30", () => {
    for (const n of [
      Number.MAX_SAFE_INTEGER + 1,
      1e20,
      -1e20,
      1e30,
      -1e30,
    ]) {
      roundTrip(n)
    }
  })

  it("non-finite numbers coerce to null (JSON spec)", () => {
    for (const v of [NaN, Infinity, -Infinity]) roundTrip(v, null)
  })

  it("-0 round-trips as 0 (JSON spec)", () => {
    roundTrip(-0, 0)
  })

  it("simple floats 0.1..0.9 step 0.1", () => {
    for (let i = 1; i <= 9; i++) {
      const v = i / 10
      const back = dec(enc(v))
      assert.ok(Math.abs(back - v) < 1e-10, `${v} → ${back}`)
    }
  })

  it("small scientific 1e-1..1e-15", () => {
    for (let exp = 1; exp <= 15; exp++) {
      const v = Math.pow(10, -exp)
      const back = dec(enc(v))
      assert.ok(
        Math.abs(back - v) < v * 1e-10 + 1e-300,
        `1e-${exp}: ${v} → ${back}`,
      )
    }
  })

  it("large scientific 1e1..1e30", () => {
    for (let exp = 1; exp <= 30; exp++) {
      const v = Math.pow(10, exp)
      const back = dec(enc(v))
      assert.ok(
        Math.abs(back - v) < v * 1e-10,
        `1e${exp}: ${v} → ${back}`,
      )
    }
  })

  it("typical floats from -100 to 100 step 0.25", () => {
    for (let v = -100; v <= 100; v += 0.25) {
      const back = dec(enc(v))
      assert.ok(Math.abs(back - v) < 1e-10, `${v} → ${back}`)
    }
  })

  it("MIN_VALUE", () => {
    // 5e-324 — likely loses precision but must not hang
    const back = dec(enc(Number.MIN_VALUE))
    assert.ok(typeof back === "number")
  })
})

// ─── 2. strings ─────────────────────────────────────────────────────────────

describe("strings — round-trip", () => {
  it("every single ASCII printable char", () => {
    for (let c = 0x20; c < 0x7f; c++) {
      const s = String.fromCharCode(c)
      roundTrip(s)
    }
  })

  it("every single base64url char", () => {
    for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") {
      roundTrip(c)
    }
  })

  it("control characters", () => {
    for (const c of ["\n", "\t", "\r", "\0", "\x01", "\x1f"]) roundTrip(c)
  })

  it("strings 1..200 chars (base64-only)", () => {
    for (let n = 1; n <= 200; n++) {
      const s = "a".repeat(n)
      roundTrip(s)
    }
  })

  it("strings 1..200 chars (non-base64, mixed unicode)", () => {
    const r = prng(0x123)
    for (let n = 1; n <= 200; n++) {
      let s = ""
      for (let i = 0; i < n; i++) {
        s += String.fromCharCode(0x20 + Math.floor(r() * 0x60))
      }
      roundTrip(s)
    }
  })

  it("emoji and astral characters", () => {
    for (const s of [
      "😀",
      "🎉",
      "🚀",
      "😀🎉🚀",
      "中文",
      "日本語",
      "한국어",
      "العربية",
      "русский",
      "🇯🇵",
      "𝐇𝐞𝐥𝐥𝐨",
      "a😀b",
    ]) {
      roundTrip(s)
    }
  })

  it("string of length 10000", () => {
    const s = "x".repeat(10000)
    roundTrip(s)
  })

  it("escape-prone chars in strings", () => {
    for (const s of [
      '"',
      "'",
      "\\",
      "\\\\",
      "//",
      '"hello"',
      "{ \"a\": 1 }",
      "[ 1, 2 ]",
      "<>&",
      "${var}",
      "%s",
    ]) {
      roundTrip(s)
    }
  })
})

// ─── 3. containers ──────────────────────────────────────────────────────────

describe("containers — round-trip", () => {
  it("empty containers", () => {
    roundTrip({})
    roundTrip([])
  })

  it("single-element containers", () => {
    roundTrip({ a: 1 })
    roundTrip([1])
    roundTrip({ a: null })
    roundTrip([null])
    roundTrip({ a: {} })
    roundTrip([[]])
    roundTrip({ a: [] })
    roundTrip([{}])
  })

  it("homogeneous integer arrays at type-pack threshold (3 vs 4+ same)", () => {
    for (let n = 1; n <= 10; n++) {
      const a = []
      for (let i = 0; i < n; i++) a.push(7)
      roundTrip(a)
    }
  })

  it("delta-pack threshold (3+ consecutive same delta)", () => {
    for (let n = 1; n <= 12; n++) {
      const a = []
      for (let i = 1; i <= n; i++) a.push(i)
      roundTrip(a)
    }
  })

  it("objects with N keys (1..200)", () => {
    for (const n of [1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 100, 200]) {
      const o = {}
      for (let i = 0; i < n; i++) o[`k${i}`] = i
      roundTrip(o)
    }
  })

  it("arrays of N elements (1..1000)", () => {
    for (const n of [1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 100, 1000]) {
      const a = []
      for (let i = 0; i < n; i++) a.push(i)
      roundTrip(a)
    }
  })

  it("nested objects of varying depth", () => {
    for (const d of [1, 2, 5, 10, 25, 50, 100, 200]) {
      let o = { v: d }
      for (let i = 0; i < d; i++) o = { x: o }
      roundTrip(o)
    }
  })

  it("nested arrays of varying depth", () => {
    for (const d of [1, 2, 5, 10, 25, 50, 100, 200]) {
      let a = [d]
      for (let i = 0; i < d; i++) a = [a]
      roundTrip(a)
    }
  })

  it("array containing all 7 value types in every order", () => {
    const variants = [
      [null, true, "x", 1, -1, 1.5, [1], { a: 1 }],
      [{ a: 1 }, [1], 1.5, -1, 1, "x", true, null],
      [1, "x", null, 1.5, true, -1, { a: 1 }, [1]],
    ]
    for (const v of variants) roundTrip(v)
  })

  it("object whose values cover every type", () => {
    roundTrip({
      n: null,
      tt: true,
      ff: false,
      i: 42,
      ni: -7,
      f: 3.14,
      nf: -3.14,
      s: "hello",
      es: "",
      a: [1, 2, 3],
      o: { x: 1 },
      ea: [],
      eo: {},
    })
  })

  it("repeated keys across nested objects (strmap reuse)", () => {
    roundTrip([
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { name: "Charlie", age: 35 },
      { name: "Dave", age: 28 },
    ])
  })

  it("cross-referenced strings (key as value, value as key)", () => {
    roundTrip([{ name: "Bob" }, { Bob: "name" }])
  })

  it("same string repeated many times", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push("repeated")
    roundTrip(a)
  })

  it("sequence 1..100 in array (delta-pack opportunity)", () => {
    const a = []
    for (let i = 1; i <= 100; i++) a.push(i)
    roundTrip(a)
  })
})

// ─── 4. keys ────────────────────────────────────────────────────────────────

describe("keys — special characters and edge cases", () => {
  it("empty string key", () => {
    roundTrip({ "": 1 })
    roundTrip({ "": "v" })
    roundTrip({ "": null })
  })

  it("keys with spaces, dashes, underscores", () => {
    roundTrip({ "a b": 1, "a-b": 2, a_b: 3, "  ": 4 })
  })

  it("keys with brackets — non-numeric content", () => {
    roundTrip({ "user[admin]": true })
    roundTrip({ "config[prod][eu]": 1 })
    roundTrip({ "a[b]c[d]e": 5 })
  })

  it("keys with brackets — numeric content (Bug 2)", () => {
    roundTrip({ "data[2020]": 100 })
    roundTrip({ "year[1999]": 1, "year[2000]": 2 })
  })

  it("keys with brackets nested", () => {
    roundTrip({ outer: { "inner[42]": "v" } })
  })

  it("keys with literal backslash", () => {
    roundTrip({ "a\\b": 1 })
  })

  it("keys with @, #, $, %, &, etc.", () => {
    roundTrip({
      "a@b": 1,
      "a#b": 2,
      "a$b": 3,
      "a%b": 4,
      "a&b": 5,
      "a*b": 6,
      "a+b": 7,
      "a=b": 8,
    })
  })

  it("non-ASCII keys", () => {
    roundTrip({ 中文: 1, العربية: 2, "🎉": 3 })
  })

  it("very long keys", () => {
    const k = "a".repeat(500)
    roundTrip({ [k]: 1 })
  })

  it("keys that collide with reserved characters in paths", () => {
    // key contains "[", "]", "."
    roundTrip({ "a.b": 1, "a[b]": 2, "a]": 3, "a[": 4 })
  })
})

// ─── 5. delta updates — comprehensive transitions ──────────────────────────

describe("delta — single-field operations", () => {
  it("add new key", () => update({ a: 1 }, { a: 1, b: 2 }))
  it("delete key", () => update({ a: 1, b: 2 }, { a: 1 }))
  it("replace value (same type)", () => update({ a: 1 }, { a: 2 }))
  it("replace value (different type)", () => {
    update({ a: 1 }, { a: "x" })
    update({ a: "x" }, { a: 1 })
    update({ a: 1 }, { a: true })
    update({ a: true }, { a: 1 })
    update({ a: 1 }, { a: null })
    update({ a: null }, { a: 1 })
    update({ a: 1 }, { a: [1] })
    update({ a: [1] }, { a: 1 })
    update({ a: 1 }, { a: { x: 1 } })
    update({ a: { x: 1 } }, { a: 1 })
  })
})

describe("delta — array operations", () => {
  it("array element replace at every index", () => {
    for (let i = 0; i < 5; i++) {
      const from = [10, 20, 30, 40, 50]
      const to = from.slice()
      to[i] = 99
      update(from, to)
    }
  })

  it("array grow by 1 at end", () => {
    for (let n = 0; n < 10; n++) {
      const from = []
      for (let i = 0; i < n; i++) from.push(i)
      const to = [...from, 99]
      update(from, to)
    }
  })

  it("array shrink by 1 at end", () => {
    for (let n = 1; n <= 10; n++) {
      const from = []
      for (let i = 0; i < n; i++) from.push(i)
      const to = from.slice(0, -1)
      update(from, to)
    }
  })

  it("array of objects — modify single object", () => {
    update(
      [{ id: 1, n: "a" }, { id: 2, n: "b" }],
      [{ id: 1, n: "A" }, { id: 2, n: "b" }],
    )
  })

  it("array of objects — append object", () => {
    update(
      [{ id: 1, n: "a" }],
      [{ id: 1, n: "a" }, { id: 2, n: "b" }],
    )
  })

  it("array of arrays — modify inner array", () => {
    update([[1, 2], [3, 4]], [[1, 2, 3], [3, 4]])
    update([[1, 2], [3, 4]], [[1], [3, 4, 5]])
  })

  it("nested array of nested arrays", () => {
    update([[[1]]], [[[2]]])
    update([[[1, 2]]], [[[1, 2, 3]]])
    update([[[1]], [[2]]], [[[10]], [[20]]])
  })
})

describe("delta — object operations", () => {
  it("modify single nested key at depth 1..5", () => {
    for (let d = 1; d <= 5; d++) {
      let from = 1
      let to = 2
      for (let i = 0; i < d; i++) {
        from = { x: from }
        to = { x: to }
      }
      update(from, to)
    }
  })

  it("add 100 keys to existing object", () => {
    const target = {}
    for (let i = 0; i < 100; i++) target[`k${i}`] = i
    update({ existing: 1 }, { existing: 1, ...target })
  })

  it("delete 99 keys, keep 1", () => {
    const from = {}
    for (let i = 0; i < 100; i++) from[`k${i}`] = i
    update(from, { k0: 0 })
  })
})

describe("delta — root structural transitions", () => {
  const types = [null, true, false, 0, 1, -1, "", "x", "long string", 1.5, [], [1], {}, { a: 1 }]
  it("every pair of root types transitions cleanly", () => {
    for (const a of types) for (const b of types) {
      if (equals(a, b)) continue
      update(a, b)
    }
  })
})

describe("delta — chains and buffer round-trip", () => {
  it("chain of 100 single-key updates", () => {
    const states = [{ count: 0 }]
    for (let i = 1; i <= 100; i++) states.push({ count: i })
    chain(states)
  })

  it("chain across structural shapes", () => {
    chain([
      null,
      true,
      false,
      1,
      -1,
      "x",
      [],
      [1],
      [1, 2, 3],
      {},
      { a: 1 },
      { a: 1, b: [1, 2] },
      [{ x: 1 }, { y: 2 }],
      "back to string",
      null,
    ])
  })

  it("alternating add and delete", () => {
    const states = [{ a: 1 }]
    for (let i = 0; i < 20; i++) {
      const prev = states[states.length - 1]
      if (Object.keys(prev).length < 5)
        states.push({ ...prev, [`k${i}`]: i })
      else
        states.push({ a: prev.a })
    }
    chain(states)
  })

  it("buffer-load-then-update preserves state", () => {
    const a = new ARJSON({ json: { a: 1 } })
    a.update({ a: 1, b: 2 })
    a.update({ a: 1, b: 2, c: 3 })
    const b = new ARJSON({ arj: a.toBuffer() })
    b.update({ a: 1, b: 2, c: 3, d: 4 })
    assert.deepEqual(b.json, { a: 1, b: 2, c: 3, d: 4 })
    const c = new ARJSON({ arj: b.toBuffer() })
    assert.deepEqual(c.json, { a: 1, b: 2, c: 3, d: 4 })
  })

  it("idempotent update (same json)", () => {
    const j = { a: 1, b: [1, 2], c: { d: "e" } }
    const a = new ARJSON({ json: j })
    a.update(j)
    assert.deepEqual(a.json, j)
  })
})

describe("delta — string fast-diff path", () => {
  it("small change in long string", () => {
    const long = "Lorem ipsum dolor sit amet, ".repeat(20)
    update({ s: long }, { s: long.replace("ipsum", "IPSUM") })
  })

  it("repeated small edits accumulate correctly", () => {
    const states = ["x".repeat(100)]
    for (let i = 0; i < 20; i++) {
      states.push(states[states.length - 1] + " more")
    }
    chain(states.map(s => ({ text: s })))
  })

  it("string grows, shrinks, replaced wholesale", () => {
    chain([
      { s: "short" },
      { s: "a slightly longer string with more chars" },
      { s: "different but also long content here yes" },
      { s: "x" },
      { s: "" },
      { s: "back" },
    ])
  })
})

// ─── 6. parsePath / escapeKey ───────────────────────────────────────────────

describe("parsePath", () => {
  const cases = [
    ["", []],
    [".", []],
    ["a", ["a"]],
    ["a.b", ["a", "b"]],
    ["a.b.c", ["a", "b", "c"]],
    ["[0]", [0]],
    ["a[0]", ["a", 0]],
    ["a[0].b", ["a", 0, "b"]],
    ["a[0][1]", ["a", 0, 1]],
    ["a[admin]", ["a[admin]"]],
    ["data\\[2020\\]", ["data[2020]"]],
    ["a\\[0\\]", ["a[0]"]],
    ["a\\\\b", ["a\\b"]],
    ["[0][1][2]", [0, 1, 2]],
    ["[unclosed", ["[unclosed"]],
    ["closed]without_open", ["closed]without_open"]],
  ]
  for (const [path, exp] of cases) {
    it(`parsePath(${JSON.stringify(path)}) → ${JSON.stringify(exp)}`, () => {
      assert.deepEqual(parsePath(path), exp)
    })
  }
})

describe("escapeKey ↔ parsePath round-trip", () => {
  const keys = [
    "plain",
    "with[bracket]",
    "with[2020]",
    "data\\backslash",
    "[justbracket]",
    "[123]",
    "x[a][b]",
    "",
    "a",
    "Z",
  ]
  for (const k of keys) {
    it(`${JSON.stringify(k)}`, () => {
      if (k === "") {
        assert.deepEqual(parsePath(escapeKey(k)), [])
      } else {
        assert.deepEqual(parsePath(escapeKey(k)), [k])
      }
    })
  }
})

describe("getPrecision", () => {
  const cases = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [100, 0],
    [0.1, 1],
    [0.5, 1],
    [0.01, 2],
    [0.001, 3],
    [1.5, 1],
    [3.14, 2],
    [3.14159, 5],
    [1e-7, 7],
    [1e-10, 10],
    [1.5e-10, 11],
    [1e10, 0],
    [1e20, 0],
  ]
  for (const [v, exp] of cases) {
    it(`getPrecision(${v}) === ${exp}`, () => {
      assert.equal(getPrecision(v), exp)
    })
  }
})

// ─── 7. concrete cases from history ─────────────────────────────────────────

describe("regression — bugs that were fixed", () => {
  it("Bug 1: empty {} → populated", () => update({}, { a: 1 }))
  it("Bug 1: empty [] → populated", () => update([], [1, 2, 3]))
  it("Bug 1: populated → empty {}", () => update({ a: 1 }, {}))
  it("Bug 1: populated → empty []", () => update([1, 2, 3], []))
  it("Bug 1: chain through empty", () =>
    chain([{ a: 1 }, {}, { b: 2 }, [], [1, 2]]))

  it("Bug 2: numeric bracket key delta-update", () =>
    update({ "data[2020]": 100 }, { "data[2020]": 200 }))
  it("Bug 2: numeric bracket key add", () =>
    update({ x: 1 }, { x: 1, "y[2020]": 2 }))

  it("Bug 3: large numbers delta-update without hang", () => {
    update({ n: 1 }, { n: Number.MAX_SAFE_INTEGER })
    update({ n: 1 }, { n: 1e20 })
    update({ n: 1 }, { n: -1e20 })
  })

  it("Bug 3: NaN/Inf coerced to null in deltas", () =>
    update({ n: 1 }, { n: NaN }, { n: null }))

  it("Bug 4: deep nest 100 levels delta", () => {
    let from = { v: 1 }
    let to = { v: 2 }
    for (let i = 0; i < 100; i++) {
      from = { x: from }
      to = { x: to }
    }
    update(from, to)
  })

  it("regression: builder walk after sibling new-key + new-array-index", () => {
    update(
      { e: { f: 5 }, g: [1, 3] },
      { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }] },
    )
  })

  it("regression: sign-flip in object with mixed sign integers", () => {
    roundTrip({ i: 42, ni: -7 })
    roundTrip({ pos: 1, neg: -1 })
    roundTrip({ a: 1, b: -1, c: 2, d: -2, e: 3, f: -3 })
  })

  it("regression: integer-vs-float check (was: v % 1 === v bug)", () => {
    roundTrip(0.1)
    roundTrip(0.5)
    roundTrip({ a: 0.1 })
  })

  it("regression: mixed primitive/non-primitive array element changes", () => {
    update(
      { a: [1, [2, 3], 4] },
      { a: [10, [20, 30], 40] },
    )
    update(
      { mixed: [1, "two", [3, 4], { five: 5 }, null, true] },
      { mixed: [10, "twenty", [30], { forty: 40 }, false, null] },
    )
  })

  it("regression: enc(single-char) without strmap", () => {
    roundTrip("a")
    roundTrip("Z")
    roundTrip("0")
    roundTrip("_")
  })

  it("regression: re-anchor preserves history-ish via toBuffer", () => {
    const a = new ARJSON({ json: null })
    a.update({ x: 1 })
    a.update({ x: 2 })
    a.update({ x: 2, y: 3 })
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, { x: 2, y: 3 })
  })
})

// ─── 8. property-based fuzz ─────────────────────────────────────────────────

describe("fuzz — round-trip", () => {
  it("1000 seeded random round-trips (deterministic)", () => {
    const rng = prng(0xA5A5)
    for (let i = 0; i < 1000; i++) {
      const j = randomJSON(rng, 0, 3)
      assert.deepEqual(dec(enc(j)), j, `seed iter ${i}: ${JSON.stringify(j)}`)
    }
  })
})

describe("fuzz — delta", () => {
  it("500 seeded random delta transitions", () => {
    const rng = prng(0xC3C3)
    for (let i = 0; i < 500; i++) {
      const from = randomJSON(rng, 0, 3)
      const to = randomJSON(rng, 0, 3)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(
        a.json,
        to,
        `seed iter ${i}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`,
      )
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
    }
  })

  it("30 seeded long-chain transitions of 20 steps each", () => {
    const rng = prng(0xD00D)
    for (let trial = 0; trial < 30; trial++) {
      const states = [randomJSON(rng, 0, 3)]
      for (let i = 0; i < 20; i++) states.push(randomJSON(rng, 0, 3))
      chain(states)
    }
  })
})

// ─── 9. boundary triggers ───────────────────────────────────────────────────

describe("boundaries — bit/encoding thresholds", () => {
  it("array of length exactly at every short-encoding threshold", () => {
    for (const n of [1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128]) {
      const a = []
      for (let i = 0; i < n; i++) a.push(i % 2)
      roundTrip(a)
    }
  })

  it("object with exactly N keys at boundaries", () => {
    for (const n of [1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64]) {
      const o = {}
      for (let i = 0; i < n; i++) o[`k${i}`] = i
      roundTrip(o)
    }
  })

  it("3 same vs 4+ same values in a row (type-pack)", () => {
    roundTrip([1, 1, 1])
    roundTrip([1, 1, 1, 1])
    roundTrip([1, 1, 1, 1, 1])
    roundTrip(["a", "a", "a"])
    roundTrip(["a", "a", "a", "a"])
    roundTrip([true, true, true])
    roundTrip([true, true, true, true])
    roundTrip([null, null, null])
    roundTrip([null, null, null, null])
  })

  it("delta-pack threshold (3+ same delta in array)", () => {
    roundTrip([10, 11, 12])
    roundTrip([10, 11, 12, 13])
    roundTrip([10, 12, 14, 16, 18])
    roundTrip([100, 99, 98, 97, 96])
  })

  it("string at every length boundary near 64", () => {
    for (const n of [1, 2, 3, 4, 31, 32, 33, 63, 64, 65, 127, 128, 129]) {
      roundTrip("a".repeat(n))
    }
  })
})

// ─── 10. invariants ─────────────────────────────────────────────────────────

describe("invariants", () => {
  it("dec(enc(x)) === x for all primitives in our test set", () => {
    const set = [
      null, true, false, 0, 1, -1, 63, 64, 1024, -1024,
      "", "x", "ab", "ABC", "_", "0", "abc xyz",
      0.5, 3.14, -3.14, 1e-5, 1e10,
    ]
    for (const v of set) roundTrip(v)
  })

  it("update(x, x) is no-op", () => {
    const cases = [
      null,
      1,
      "x",
      [1, 2, 3],
      { a: 1, b: { c: 2 } },
      [{ a: 1 }, { b: 2 }],
    ]
    for (const x of cases) {
      const a = new ARJSON({ json: x })
      a.update(x)
      assert.deepEqual(a.json, x)
    }
  })

  it("toBuffer(); fromBuffer; toBuffer; equal", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2, 3] } })
    a.update({ x: 2, y: [1, 2, 3, 4] })
    const buf1 = a.toBuffer()
    const b = new ARJSON({ arj: buf1 })
    const buf2 = b.toBuffer()
    assert.deepEqual(b.json, a.json)
    assert.deepEqual(Array.from(buf1), Array.from(buf2))
  })

  it("encoded size is non-zero for non-undefined values", () => {
    for (const v of [null, true, false, 0, "", [], {}, "x", 1, [1], { a: 1 }]) {
      assert.ok(enc(v).length > 0, `${JSON.stringify(v)} encoded to empty buffer`)
    }
  })

  it("ARJSON({arj:buf}).toBuffer() ≅ original buf for fresh-encoded inputs", () => {
    for (const j of [
      { a: 1 },
      [1, 2, 3],
      { a: { b: { c: 1 } } },
      [{ x: 1 }, { y: 2 }],
      "hello world",
      42,
      null,
    ]) {
      const a = new ARJSON({ json: j })
      const buf1 = a.toBuffer()
      const b = new ARJSON({ arj: buf1 })
      const buf2 = b.toBuffer()
      assert.deepEqual(b.json, j)
      assert.deepEqual(Array.from(buf1), Array.from(buf2))
    }
  })

  it("update preserves equality of input json", () => {
    const orig = { a: [1, 2, 3], b: { c: "x" } }
    const a = new ARJSON({ json: orig })
    const target = { a: [1, 2, 3, 4], b: { c: "y" } }
    a.update(target)
    assert.deepEqual(a.json, target)
    // user shouldn't have to clone — but live target should still match
    assert.deepEqual(target, { a: [1, 2, 3, 4], b: { c: "y" } })
  })
})

// ─── 11. specific column / order-dependent regressions ──────────────────────

describe("regression — order-dependent column updates", () => {
  // After adding a new key to a sub-object, the parent walk in the builder
  // must use a single-deref through krefs (was: double-deref bug).
  it("new key + new array index sibling", () => {
    update(
      { e: { f: 5 }, g: [1, 3] },
      { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }] },
    )
  })
  it("new key + new array index, reverse order", () => {
    update(
      { g: [1, 3], e: { f: 5 } },
      { g: [1, 2, { y: 3 }], e: { f: 6, a: 7 } },
    )
  })
  it("delete + new key + new array index", () => {
    update(
      { e: { f: 5, t: 7 }, g: [1, 3] },
      { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }] },
    )
  })
  it("multi-level new keys + arrays", () => {
    update(
      { x: { y: { z: 1 } } },
      { x: { y: { z: 2, w: [1, 2] }, t: 3 }, q: [9, 8, 7] },
    )
  })
})

describe("regression — strmap reuse across deltas", () => {
  it("same key reused after delete and re-add", () => {
    chain([
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { age: 25 },
      { name: "Charlie", age: 25 },
    ])
  })
  it("string value reuse pattern", () => {
    chain([
      { role: "admin" },
      { role: "user" },
      { role: "admin" },
      { role: "user", note: "admin" },
    ])
  })
  it("growing dict with shared values", () => {
    let state = {}
    const states = [state]
    for (let i = 0; i < 30; i++) {
      state = { ...state, [`k${i}`]: i % 3 === 0 ? "alpha" : i % 3 === 1 ? "beta" : "gamma" }
      states.push(state)
    }
    chain(states)
  })
})

describe("regression — long-string fast-diff", () => {
  it("appending to a long string", () => {
    const states = ["The quick brown fox jumps over the lazy dog. ".repeat(5)]
    for (let i = 0; i < 10; i++) {
      states.push(states[i] + " and again ".repeat(2))
    }
    chain(states.map(s => ({ s })))
  })
  it("prepending to a long string", () => {
    const base = "The quick brown fox jumps over the lazy dog. ".repeat(5)
    const states = [{ s: base }]
    for (let i = 0; i < 10; i++) {
      states.push({ s: "x".repeat(i + 1) + " " + base })
    }
    chain(states)
  })
  it("middle-edits in long string", () => {
    const base = "abcdefghijklmnopqrstuvwxyz".repeat(20)
    const states = [{ s: base }]
    for (let i = 1; i < 15; i++) {
      const pos = i * 30
      states.push({
        s: base.slice(0, pos) + "X" + base.slice(pos),
      })
    }
    chain(states)
  })
})

describe("regression — repeated load / save cycle", () => {
  it("round-trip 20× same data preserves it", () => {
    let json = { a: [1, 2, 3], b: { c: "x", d: [true, null] } }
    for (let i = 0; i < 20; i++) {
      const a = new ARJSON({ json })
      const buf = a.toBuffer()
      const b = new ARJSON({ arj: buf })
      assert.deepEqual(b.json, json)
      json = b.json
    }
  })
  it("save / load / mutate / save / load preserves chain semantics", () => {
    let a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 20; i++) {
      const buf = a.toBuffer()
      a = new ARJSON({ arj: buf })
      a.update({ count: i })
      assert.deepEqual(a.json, { count: i })
    }
  })
})

// ─── 12. all-types cartesian fuzz ───────────────────────────────────────────

describe("delta — cartesian product of small typed values", () => {
  const samples = [
    null,
    true,
    false,
    0,
    1,
    -1,
    63,
    64,
    "",
    "x",
    "longer string",
    1.5,
    -1.5,
    [],
    [1],
    [1, 2],
    {},
    { a: 1 },
    { a: 1, b: 2 },
  ]
  it("update(any, any) over cartesian product", () => {
    for (const a of samples) for (const b of samples) {
      const arj = new ARJSON({ json: a })
      arj.update(b)
      assert.deepEqual(arj.json, b)
      assert.deepEqual(new ARJSON({ arj: arj.toBuffer() }).json, b)
    }
  })
})

// ─── 13. wide / shallow stress ──────────────────────────────────────────────

describe("scale", () => {
  it("object with 500 keys all integers", () => {
    const o = {}
    for (let i = 0; i < 500; i++) o[`k${i}`] = i
    roundTrip(o)
  })
  it("array of 500 small integers", () => {
    const a = []
    for (let i = 0; i < 500; i++) a.push(i)
    roundTrip(a)
  })
  it("array of 500 strings (high strmap reuse)", () => {
    const a = []
    for (let i = 0; i < 500; i++) a.push(["alpha", "beta", "gamma"][i % 3])
    roundTrip(a)
  })
  it("array of 500 objects same shape", () => {
    const a = []
    for (let i = 0; i < 500; i++) a.push({ id: i, name: `n${i}`, on: i % 2 === 0 })
    roundTrip(a)
  })
  it("delta growth from 0 to 200 keys", () => {
    let s = {}
    const states = [s]
    for (let i = 0; i < 200; i++) {
      s = { ...s, [`k${i}`]: i }
      states.push(s)
    }
    chain(states)
  })
  it("delta in-place modify of 200-key object", () => {
    const from = {}
    const to = {}
    for (let i = 0; i < 200; i++) {
      from[`k${i}`] = i
      to[`k${i}`] = i * 10
    }
    update(from, to)
  })
})

// ─── 14. heavy fuzz (small inputs) ─────────────────────────────────────────

describe("heavy fuzz — small JSON", () => {
  it("10000 small-input round-trips", () => {
    const rng = prng(0xBEEF)
    for (let i = 0; i < 10000; i++) {
      const j = randomJSON(rng, 0, 2)
      assert.deepEqual(dec(enc(j)), j, `iter ${i}: ${JSON.stringify(j)}`)
    }
  })
  it("3000 small delta transitions with buffer round-trip", () => {
    const rng = prng(0xCAFE)
    for (let i = 0; i < 3000; i++) {
      const from = randomJSON(rng, 0, 2)
      const to = randomJSON(rng, 0, 2)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to, `iter ${i}: from=${JSON.stringify(from)} to=${JSON.stringify(to)}`)
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
    }
  })
})

// ─── 15. encoder/decoder isolation ──────────────────────────────────────────

describe("Encoder/Decoder direct API", () => {
  it("encode + decode for primitives", () => {
    for (const v of [null, true, false, 0, 1, -1, "", "x", "abc", 1.5]) {
      const u = new Encoder()
      const buf = encode(v, u)
      const d = new Decoder()
      d.decode(buf)
      assert.deepEqual(d.json, v)
    }
  })
  it("encode + decode for structures", () => {
    for (const v of [{}, [], { a: 1 }, [1, 2], { a: [1, 2] }, [{ x: 1 }]]) {
      const u = new Encoder()
      const buf = encode(v, u)
      const d = new Decoder()
      d.decode(buf)
      assert.deepEqual(d.json, v)
    }
  })
  it("Encoder can be reused across calls", () => {
    const u = new Encoder()
    for (const v of [{ a: 1 }, [1, 2, 3], "x", 42]) {
      const buf = encode(v, u)
      const d = new Decoder()
      d.decode(buf)
      assert.deepEqual(d.json, v)
    }
  })
})

// ─── 16. hostile patterns ──────────────────────────────────────────────────

describe("hostile patterns", () => {
  it("array of all booleans", () => {
    roundTrip([true, false, true, false, true])
    roundTrip([false, false, false, false])
    roundTrip([true])
    roundTrip([false])
  })

  it("delta-update array of booleans", () => {
    update([true, false], [false, true])
    update([true], [false])
    update([false, false, false], [true, true, true])
    update([true, false, true], [false, true, false, true])
  })

  it("object with all-boolean values", () => {
    roundTrip({ a: true, b: false, c: true, d: false })
    update(
      { a: true, b: false },
      { a: false, b: true, c: true },
    )
  })

  it("alternating types in array (no type-pack)", () => {
    roundTrip([1, "a", 2, "b", 3, "c"])
    roundTrip([true, 1, "x", null, false, -1])
  })

  it("keys that look like JSON paths/numbers", () => {
    roundTrip({
      "0": "zero",
      "1": "one",
      "[0]": "bracket-zero",
      "a.b": "dotted",
      "a[0]": "bracket-key",
    })
  })

  it("many duplicate object shapes (high strmap pressure)", () => {
    const a = []
    for (let i = 0; i < 100; i++)
      a.push({ id: i, name: "alpha", role: "user", active: i % 2 === 0 })
    roundTrip(a)
  })

  it("strings that look like UTF-8 boundaries", () => {
    for (const s of ["", "", "ÿ", "Ā", "߿", "ࠀ", "￿"]) {
      roundTrip(s)
    }
  })

  it("path of arrays of arrays with non-primitive interior", () => {
    update(
      { a: [[{ b: 1 }]] },
      { a: [[{ b: 2 }]] },
    )
    update(
      { a: [[{ b: 1 }, { c: 2 }]] },
      { a: [[{ b: 2 }, { c: 3 }]] },
    )
  })

  it("bool replace at every index of long array", () => {
    for (let n = 1; n <= 8; n++) {
      const from = []
      for (let i = 0; i < n; i++) from.push(false)
      for (let target = 0; target < n; target++) {
        const to = from.slice()
        to[target] = true
        update(from, to)
      }
    }
  })

  it("type cycling in same array slot", () => {
    chain([
      [null],
      [true],
      [1],
      ["x"],
      [1.5],
      [[1]],
      [{ a: 1 }],
      [null],
    ])
  })

  it("rapid object schema evolution", () => {
    chain([
      { v: 1 },
      { v: 1, u: 2 },
      { v: 1, u: 2, w: 3 },
      { u: 2, w: 3 },
      { w: 3 },
      { x: 4, y: 5 },
      {},
      { z: 6 },
    ])
  })

  it("array length oscillates", () => {
    chain([
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [1, 2],
      [],
      [10],
      [10, 20, 30],
    ])
  })

  it("identical updates back-to-back", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 1 })
    a.update({ x: 1 })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { x: 1 })
  })

  it("very heavy nested update (5 deltas)", () => {
    const a = new ARJSON({
      json: {
        users: [
          { id: 1, name: "Alice", scores: [10, 20] },
          { id: 2, name: "Bob", scores: [30, 40] },
        ],
        config: { theme: "dark", lang: "en" },
      },
    })
    a.update({
      users: [
        { id: 1, name: "Alice", scores: [10, 20, 30] },
        { id: 2, name: "Bob", scores: [30, 40] },
      ],
      config: { theme: "dark", lang: "en" },
    })
    a.update({
      users: [
        { id: 1, name: "Alice", scores: [10, 20, 30] },
        { id: 2, name: "Bob", scores: [30, 40] },
        { id: 3, name: "Charlie", scores: [] },
      ],
      config: { theme: "dark", lang: "en" },
    })
    a.update({
      users: [{ id: 3, name: "Charlie", scores: [] }],
      config: { theme: "light", lang: "fr" },
    })
    a.update({ users: [], config: {} })
    assert.deepEqual(a.json, { users: [], config: {} })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, a.json)
  })
})

// ─── 17. value-type matrix (all 7 × all 7) ──────────────────────────────────

describe("type-transition matrix", () => {
  const samples = {
    null_: null,
    bool_t: true,
    bool_f: false,
    int_pos: 42,
    int_neg: -42,
    float_pos: 3.14,
    float_neg: -3.14,
    string: "hello",
    base64: "abcXYZ",
    long_string: "x".repeat(50),
    empty_array: [],
    array: [1, 2, 3],
    empty_object: {},
    object: { a: 1 },
  }
  it("every (a, b) pair: update from {wrap:a} to {wrap:b}", () => {
    for (const ka of Object.keys(samples)) {
      for (const kb of Object.keys(samples)) {
        const from = { wrap: samples[ka] }
        const to = { wrap: samples[kb] }
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to, `${ka} → ${kb}`)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      }
    }
  })
  it("every (a, b) pair: update from [a] to [b]", () => {
    for (const ka of Object.keys(samples)) {
      for (const kb of Object.keys(samples)) {
        const from = [samples[ka]]
        const to = [samples[kb]]
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to, `${ka} → ${kb}`)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      }
    }
  })
})

// ─── 18. strdiff fast-path stress ───────────────────────────────────────────

describe("strdiff stress", () => {
  it("100 sequential micro-edits", () => {
    let s = "Initial content of the document. "
    s = s.repeat(5) // ~165 chars, threshold for fast-diff
    const states = [{ doc: s }]
    for (let i = 0; i < 100; i++) {
      const pos = (i * 7) % s.length
      s = s.slice(0, pos) + (i % 10).toString() + s.slice(pos + 1)
      states.push({ doc: s })
    }
    chain(states)
  })
  it("array of long strings with edits", () => {
    const long = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)
    chain([
      { items: [long, long, long] },
      { items: [long.replace("Lorem", "LOREM"), long, long] },
      { items: [long.replace("Lorem", "LOREM"), long.replace("ipsum", "IPSUM"), long] },
      { items: [long, long, long] },
    ])
  })
})

// ─── 19. edge boundary bit-pack ─────────────────────────────────────────────

describe("type-pack run-length boundaries", () => {
  // Type-pack is supposed to compress 4+ consecutive same-type values.
  // Test that we round-trip correctly at every length around the threshold.
  for (let n = 1; n <= 12; n++) {
    it(`array of ${n} identical ints`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(7)
      roundTrip(a)
    })
    it(`array of ${n} identical strings`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push("alpha")
      roundTrip(a)
    })
    it(`array of ${n} identical booleans`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(true)
      roundTrip(a)
    })
    it(`array of ${n} identical nulls`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(null)
      roundTrip(a)
    })
  }
})

describe("delta-pack run-length boundaries", () => {
  for (let n = 1; n <= 12; n++) {
    it(`sequential ints of length ${n}`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(100 + i)
      roundTrip(a)
    })
    it(`reverse-sequential ints of length ${n}`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(100 - i)
      roundTrip(a)
    })
  }
})

// ─── 20. heavy fuzz round 2 ────────────────────────────────────────────────

describe("heavy fuzz — large coverage", () => {
  it("5000 round-trips, depth 3, multiple seeds", () => {
    for (const seed of [0x1, 0x100, 0x10000, 0x1000000, 0x12345]) {
      const rng = prng(seed)
      for (let i = 0; i < 1000; i++) {
        const j = randomJSON(rng, 0, 3)
        assert.deepEqual(dec(enc(j)), j, `seed ${seed} iter ${i}: ${JSON.stringify(j)}`)
      }
    }
  })
  it("2000 small-input deltas with buffer round-trip", () => {
    const rng = prng(0xFEED)
    for (let i = 0; i < 2000; i++) {
      const from = randomJSON(rng, 0, 2)
      const to = randomJSON(rng, 0, 2)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to, `iter ${i}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`)
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
    }
  })
})

// ─── 21. ARJSON({table}) constructor ───────────────────────────────────────

describe("ARJSON construction modes", () => {
  it("from json and from table produce equivalent state", () => {
    const cases = [
      { a: 1 },
      [1, 2, 3],
      { a: { b: { c: 1 } } },
      [{ id: 1 }, { id: 2 }],
      { mixed: [1, "x", true, null] },
    ]
    for (const j of cases) {
      const a = new ARJSON({ json: j })
      const b = new ARJSON({ table: a.artable.table() })
      assert.deepEqual(b.json, j)
    }
  })

  it("from json and from arj-buf produce equivalent state", () => {
    const cases = [
      { a: 1 },
      [1, 2, 3],
      "hello",
      42,
      null,
      true,
      [],
      {},
    ]
    for (const j of cases) {
      const a = new ARJSON({ json: j })
      const b = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(b.json, j)
    }
  })

  it("from table allows continued updates", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    const b = new ARJSON({ table: a.artable.table() })
    b.update({ x: 1, y: 2, z: 3 })
    assert.deepEqual(b.json, { x: 1, y: 2, z: 3 })
  })

  it("ARJSON.fromBuffer extracts deltas list", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    a.update({ x: 3 })
    const buf = a.toBuffer()
    const deltas = ARJSON.fromBuffer(buf)
    assert.equal(deltas.length, a.deltas.length)
  })

  it("ARJSON.toBuffer / fromBuffer are inverses", () => {
    const original = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6, 7, 8]),
      new Uint8Array([9]),
    ]
    const buf = ARJSON.toBuffer(original)
    const recovered = ARJSON.fromBuffer(buf)
    assert.equal(recovered.length, original.length)
    for (let i = 0; i < original.length; i++) {
      assert.deepEqual(Array.from(recovered[i]), Array.from(original[i]))
    }
  })
})

// ─── 22. real-world patterns ────────────────────────────────────────────────

describe("real-world-ish workflows", () => {
  it("schema migration over many versions", () => {
    chain([
      { name: "Alice", age: 30 },
      { name: "Alice", age: 30, email: "a@b.com" },
      { name: "Alice", age: 31, email: "a@b.com" },
      { name: "Alice", age: 31, email: "a@b.com", roles: ["user"] },
      { name: "Alice", age: 31, email: "a@b.com", roles: ["user", "admin"] },
      { name: "Alice", age: 31, email: "a@b.com", roles: ["admin"], lastLogin: 1234567890 },
      { id: "alice", name: "Alice", age: 31, email: "a@b.com", roles: ["admin"], lastLogin: 1234567890 },
    ])
  })

  it("counter increments many times", () => {
    const states = []
    for (let i = 0; i < 100; i++) states.push({ count: i })
    chain(states)
  })

  it("appending to log-like array", () => {
    const states = [{ entries: [] }]
    for (let i = 0; i < 50; i++) {
      const prev = states[states.length - 1].entries.slice()
      prev.push({ ts: i, msg: `event ${i}` })
      states.push({ entries: prev })
    }
    chain(states)
  })

  it("deeply nested config tweaks", () => {
    const base = {
      server: { host: "localhost", port: 8080, ssl: false },
      cache: { ttl: 3600, size: 1000 },
      log: { level: "info", outputs: ["stdout"] },
    }
    chain([
      base,
      { ...base, server: { ...base.server, port: 9090 } },
      { ...base, server: { ...base.server, port: 9090, ssl: true } },
      { ...base, server: { ...base.server, port: 9090, ssl: true }, cache: { ttl: 7200, size: 1000 } },
      { ...base, log: { level: "debug", outputs: ["stdout", "file"] } },
    ])
  })

  it("user activity feed (mixed structure churn)", () => {
    const states = []
    let s = { users: [], posts: [] }
    states.push(s)
    for (let i = 0; i < 20; i++) {
      const newUser = { id: i, name: `user${i}`, posts: 0 }
      s = { users: [...s.users, newUser], posts: s.posts }
      states.push(s)
      if (i % 3 === 0) {
        const newPost = { id: i, author: i, text: `post ${i}`.repeat(3) }
        s = { users: s.users, posts: [...s.posts, newPost] }
        states.push(s)
      }
    }
    chain(states)
  })
})

// ─── 23. directly-targeted shape tests ──────────────────────────────────────

describe("specific shapes that have caused trouble", () => {
  it("array starting with primitive ending with object", () => {
    update([1, 2], [1, { a: 1 }])
    update([1, 2, 3], [1, 2, { a: 1 }])
    update([{ a: 1 }, 2], [{ a: 2 }, 3])
  })

  it("array transitioning all-primitive ↔ all-object", () => {
    update([1, 2, 3], [{ x: 1 }, { x: 2 }, { x: 3 }])
    update([{ x: 1 }, { x: 2 }, { x: 3 }], [1, 2, 3])
  })

  it("array of arrays at every nesting depth 1..5", () => {
    let inner = [1]
    for (let d = 1; d <= 5; d++) {
      inner = [inner]
      roundTrip(inner)
    }
  })

  it("alternating object/array elements", () => {
    roundTrip([{ a: 1 }, [1], { b: 2 }, [2], { c: 3 }, [3]])
    update(
      [{ a: 1 }, [1], { b: 2 }],
      [{ a: 2 }, [10], { b: 3 }],
    )
  })

  it("identical neighbors in arrays", () => {
    roundTrip([1, 1, 1, 2, 2, 2, 3])
    roundTrip(["a", "a", "a", "b"])
    roundTrip([null, null, true, true, false, false])
    update([1, 1, 1], [2, 2, 2])
    update([1, 2, 1, 2], [2, 1, 2, 1])
  })

  it("very long unique-string array", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(`unique_string_${i}`)
    roundTrip(a)
  })

  it("very long key-collision array", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push("same")
    roundTrip(a)
  })

  it("object with values matching its own keys", () => {
    roundTrip({ a: "a", b: "b", c: "c" })
    roundTrip({ a: "b", b: "a", c: "d", d: "c" })
  })

  it("object whose keys all share a prefix", () => {
    const o = {}
    for (let i = 0; i < 50; i++) o[`prefix_${i}`] = i
    roundTrip(o)
  })

  it("object whose keys are sequential integers as strings", () => {
    const o = {}
    for (let i = 0; i < 50; i++) o[i.toString()] = i
    roundTrip(o)
  })
})

// ─── 24. invariants under chained operations ────────────────────────────────

describe("chained invariants", () => {
  it("update(a,b); update(b,c) === update(a,c) [via two chains]", () => {
    const cases = [
      [{ x: 1 }, { x: 2 }, { x: 3 }],
      [{ a: 1 }, { a: 1, b: 2 }, { b: 2 }],
      [[1], [1, 2], [1, 2, 3]],
      [null, { x: 1 }, [1, 2]],
    ]
    for (const [a, b, c] of cases) {
      const x = new ARJSON({ json: a })
      x.update(b)
      x.update(c)

      const y = new ARJSON({ json: a })
      y.update(c)

      assert.deepEqual(x.json, y.json)
      assert.deepEqual(x.json, c)
    }
  })

  it("toBuffer doesn't mutate state", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    const json1 = JSON.parse(JSON.stringify(a.json))
    const buf1 = a.toBuffer()
    const json2 = JSON.parse(JSON.stringify(a.json))
    assert.deepEqual(json1, json2)
    const buf2 = a.toBuffer()
    assert.deepEqual(Array.from(buf1), Array.from(buf2))
  })

  it("toBuffer caches result (identity preserved when no change)", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    const buf1 = a.toBuffer()
    const buf2 = a.toBuffer()
    assert.equal(buf1, buf2, "expected identical buffer reference (cached)")
  })

  it("toBuffer invalidates cache after update", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const buf1 = a.toBuffer()
    a.update({ x: 2 })
    const buf2 = a.toBuffer()
    assert.notDeepEqual(Array.from(buf1), Array.from(buf2))
  })
})

// ─── 25. extreme nesting ────────────────────────────────────────────────────

describe("extreme nesting", () => {
  it("encode 500 levels deep", () => {
    let o = { v: 1 }
    for (let i = 0; i < 500; i++) o = { x: o }
    roundTrip(o)
  })

  it("encode 500 levels of arrays", () => {
    let a = [1]
    for (let i = 0; i < 500; i++) a = [a]
    roundTrip(a)
  })

  it("encode mixed 200-level deep", () => {
    let o = { v: 1 }
    for (let i = 0; i < 200; i++) {
      o = i % 2 === 0 ? { x: o } : [o]
    }
    roundTrip(o)
  })
})

// ─── 26. accumulated pressure ───────────────────────────────────────────────

describe("accumulated pressure over many updates", () => {
  it("100-update chain with random small mutations of a fixed-shape object", () => {
    const rng = prng(0xACAC)
    let s = {
      counter: 0,
      flag: false,
      tags: ["a", "b", "c"],
      meta: { created: 1, updated: 1 },
    }
    const states = [s]
    for (let i = 1; i <= 100; i++) {
      s = JSON.parse(JSON.stringify(s))
      const choice = Math.floor(rng() * 5)
      if (choice === 0) s.counter = i
      else if (choice === 1) s.flag = !s.flag
      else if (choice === 2) s.tags.push(`t${i}`)
      else if (choice === 3) s.meta.updated = i
      else s = { ...s, [`extra${i}`]: i }
      states.push(s)
    }
    chain(states)
  })

  it("250-update chain growing a single-counter object", () => {
    const states = []
    for (let i = 0; i < 250; i++) states.push({ count: i })
    chain(states)
  })

  it("100-update chain with multiple buffer round-trips", () => {
    let a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 100; i++) {
      a.update({ count: i })
      if (i % 10 === 0) {
        a = new ARJSON({ arj: a.toBuffer() })
        assert.deepEqual(a.json, { count: i })
      }
    }
  })
})

// ─── 27. comprehensive shape-transition coverage ────────────────────────────

describe("regression — empty-inner-array transitions (Bug 7+)", () => {
  it("{e:[]} → {e:[<various>]}", () => {
    for (const target of [
      [1], [1, 2, 3], ["x"], [true], [null], [1.5],
      [[1]], [[1], [2]], [[]],
      [{}], [{}, {}],
      [{ a: 1 }], [{ a: 1 }, { b: 2 }],
      [1, { x: 1 }], [{ x: 1 }, 2],
      [[1], { y: 2 }], [[{ a: 1 }]], [{ a: [1] }],
    ]) {
      update({ e: [] }, { e: target })
    }
  })

  it("array of empty containers", () => {
    update({}, { x: [], y: {} })
    update({ x: [], y: {} }, { x: [1], y: { a: 1 } })
    update({ x: [1], y: { a: 1 } }, { x: [], y: {} })
  })

  it("nested empty arrays grow", () => {
    update({ a: { b: [] } }, { a: { b: [1, 2] } })
    update({ a: { b: [] } }, { a: { b: [{ c: 1 }] } })
    update({ a: { b: { c: [] } } }, { a: { b: { c: [{ d: 1 }] } } })
  })
})

describe("delta — values in different positions", () => {
  it("last element replace at every position 0..6", () => {
    const base = [10, 20, 30, 40, 50, 60, 70]
    for (let i = 0; i < base.length; i++) {
      const target = base.slice()
      target[i] = 99
      update(base, target)
    }
  })

  it("insert object at every position 0..3 of small array", () => {
    for (let i = 0; i <= 3; i++) {
      const from = [1, 2, 3]
      const to = from.slice()
      to.splice(i, 0, { x: i })
      update(from, to)
    }
  })

  it("delete at every position 0..3 of small array", () => {
    for (let i = 0; i < 4; i++) {
      const from = [10, 20, 30, 40]
      const to = from.slice()
      to.splice(i, 1)
      update(from, to)
    }
  })
})

// ─── 28. deltas as a stream ─────────────────────────────────────────────────

describe("delta as stream — ARJSON.fromBuffer/toBuffer round-trip", () => {
  it("deltas list survives serialization", () => {
    const deltas = []
    for (let i = 0; i < 5; i++) {
      deltas.push(new Uint8Array([1 + i, 2 + i, 3 + i, 4 + i]))
    }
    const buf = ARJSON.toBuffer(deltas)
    const recovered = ARJSON.fromBuffer(buf)
    assert.equal(recovered.length, deltas.length)
    for (let i = 0; i < deltas.length; i++) {
      assert.deepEqual(Array.from(recovered[i]), Array.from(deltas[i]))
    }
  })

  it("LEB128 length encoding handles >127-byte deltas", () => {
    const deltas = [
      new Uint8Array(new Array(300).fill(0).map((_, i) => i % 256)),
      new Uint8Array(new Array(50).fill(7)),
    ]
    const buf = ARJSON.toBuffer(deltas)
    const recovered = ARJSON.fromBuffer(buf)
    assert.equal(recovered.length, 2)
    assert.equal(recovered[0].length, 300)
    assert.equal(recovered[1].length, 50)
  })

  it("LEB128 length handles a real 5KB delta", () => {
    const big = {}
    for (let i = 0; i < 200; i++) big[`key${i}`] = `value${i}`.repeat(3)
    const a = new ARJSON({ json: big })
    const buf = a.toBuffer()
    const b = new ARJSON({ arj: buf })
    assert.deepEqual(b.json, big)
  })
})

// ─── 29. heavier fuzz for the specific pattern that broke ──────────────────

describe("regression — empty-inner-array fuzz", () => {
  it("1000 random transitions involving empty inner arrays", () => {
    const rng = prng(0xE007)
    for (let i = 0; i < 1000; i++) {
      // construct a from-state with at least one empty array
      const base = randomJSON(rng, 0, 2)
      const wrapper = { x: [], y: base, z: [] }
      const target = randomJSON(rng, 0, 2)
      const a = new ARJSON({ json: wrapper })
      a.update({ x: target, y: target, z: base })
      assert.deepEqual(
        a.json,
        { x: target, y: target, z: base },
        `iter ${i}: target=${JSON.stringify(target)}`,
      )
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, a.json)
    }
  })
})

// ─── 30. final very-aggressive fuzz ────────────────────────────────────────

describe("aggressive fuzz with deeper trees", () => {
  it("3000 round-trips depth 4", () => {
    const rng = prng(0xDEAD)
    for (let i = 0; i < 3000; i++) {
      const j = randomJSON(rng, 0, 4)
      assert.deepEqual(dec(enc(j)), j, `iter ${i}: ${JSON.stringify(j).slice(0, 100)}`)
    }
  })

  it("1000 deltas depth 4 with buffer round-trip", () => {
    const rng = prng(0xC0FF)
    for (let i = 0; i < 1000; i++) {
      const from = randomJSON(rng, 0, 4)
      const to = randomJSON(rng, 0, 4)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(
        a.json,
        to,
        `iter ${i}: ${JSON.stringify(from).slice(0, 80)} → ${JSON.stringify(to).slice(0, 80)}`,
      )
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
    }
  })

  it("50 long chains of 50 steps each", () => {
    const rng = prng(0xCAB1)
    for (let trial = 0; trial < 50; trial++) {
      const states = [randomJSON(rng, 0, 3)]
      for (let i = 0; i < 50; i++) states.push(randomJSON(rng, 0, 3))
      chain(states)
    }
  })

  it("100 mixed buffer-and-update sequences", () => {
    const rng = prng(0xBABE)
    for (let trial = 0; trial < 100; trial++) {
      let a = new ARJSON({ json: randomJSON(rng, 0, 2) })
      for (let i = 0; i < 10; i++) {
        const next = randomJSON(rng, 0, 2)
        a.update(next)
        if (i % 3 === 1) {
          a = new ARJSON({ arj: a.toBuffer() })
        }
        assert.deepEqual(a.json, next, `trial ${trial} step ${i}`)
      }
    }
  })
})

// ─── 31. final stress — multi-seed deeper fuzz ─────────────────────────────

describe("final stress — fuzz with many seeds", () => {
  const seeds = [0x1, 0x2, 0x42, 0x100, 0x1000, 0x10000, 0xCAFE, 0xBEEF, 0xFACE, 0xDEAD]

  it("round-trip 200 random JSON × 10 seeds (depth 4)", () => {
    for (const seed of seeds) {
      const rng = prng(seed)
      for (let i = 0; i < 200; i++) {
        const j = randomJSON(rng, 0, 4)
        assert.deepEqual(dec(enc(j)), j, `seed ${seed} iter ${i}`)
      }
    }
  })

  it("delta 100 random transitions × 10 seeds (depth 3)", () => {
    for (const seed of seeds) {
      const rng = prng(seed)
      for (let i = 0; i < 100; i++) {
        const from = randomJSON(rng, 0, 3)
        const to = randomJSON(rng, 0, 3)
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to, `seed ${seed} iter ${i}`)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      }
    }
  })

  it("chain 20 steps × 10 seeds × 5 trials (depth 3)", () => {
    for (const seed of seeds) {
      const rng = prng(seed)
      for (let trial = 0; trial < 5; trial++) {
        const states = [randomJSON(rng, 0, 3)]
        for (let i = 0; i < 20; i++) states.push(randomJSON(rng, 0, 3))
        chain(states)
      }
    }
  })

  it("monster fuzz: 10000 round-trips spanning 20 seeds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = prng(seed * 0x12345)
      for (let i = 0; i < 500; i++) {
        const j = randomJSON(rng, 0, 3)
        assert.deepEqual(dec(enc(j)), j, `seed ${seed} iter ${i}: ${JSON.stringify(j).slice(0, 100)}`)
      }
    }
  })

  it("monster fuzz: 5000 deltas spanning 20 seeds", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = prng(seed * 0x67890)
      for (let i = 0; i < 250; i++) {
        const from = randomJSON(rng, 0, 3)
        const to = randomJSON(rng, 0, 3)
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to, `seed ${seed} iter ${i}`)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      }
    }
  })
})

// ─── 32. specific delta-pack patterns ───────────────────────────────────────

describe("delta-pack triggers", () => {
  it("array of 100 sequential ints", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(i)
    roundTrip(a)
  })

  it("array of 100 reversed ints", () => {
    const a = []
    for (let i = 99; i >= 0; i--) a.push(i)
    roundTrip(a)
  })

  it("array of 100 step-2 ints", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(i * 2)
    roundTrip(a)
  })

  it("array with delta-pack run interrupted", () => {
    roundTrip([1, 2, 3, 4, 5, 100, 6, 7, 8, 9, 10])
    roundTrip([1, 1, 1, 1, 5, 1, 1, 1, 1])
    roundTrip([1, 2, 3, 100, 1, 2, 3])
  })
})

// ─── 33. specific type-pack triggers ───────────────────────────────────────

describe("type-pack triggers", () => {
  it("repeated booleans across 100 elements", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(true)
    roundTrip(a)
  })

  it("repeated nulls", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(null)
    roundTrip(a)
  })

  it("repeated identical strings", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push("repeated")
    roundTrip(a)
  })

  it("repeated identical objects (shared shape)", () => {
    const a = []
    for (let i = 0; i < 50; i++) a.push({ a: 1, b: 2 })
    roundTrip(a)
  })

  it("type-pack interrupted", () => {
    roundTrip([1, 1, 1, 1, "x", 1, 1, 1])
    roundTrip([true, true, false, true, true])
    roundTrip([null, null, "x", null, null])
  })
})

// ─── 34. mixed update patterns ─────────────────────────────────────────────

describe("nested chained updates", () => {
  it("multi-step: outer obj evolves, inner obj evolves", () => {
    chain([
      { user: { name: "A", age: 1 } },
      { user: { name: "A", age: 2 } },
      { user: { name: "A", age: 2 }, ts: 1 },
      { user: { name: "B", age: 2 }, ts: 1 },
      { user: { name: "B", age: 2, role: "admin" }, ts: 2 },
      { user: { name: "B", role: "admin" }, ts: 2 },
      { ts: 2 },
    ])
  })

  it("multi-step: outer arr evolves, inner items evolve", () => {
    chain([
      { items: [{ id: 1, n: "a" }] },
      { items: [{ id: 1, n: "A" }] },
      { items: [{ id: 1, n: "A" }, { id: 2, n: "b" }] },
      { items: [{ id: 1, n: "A" }, { id: 2, n: "B" }] },
      { items: [{ id: 2, n: "B" }] },
      { items: [] },
      { items: [{ id: 99, n: "x" }] },
    ])
  })

  it("nesting depth changes mid-chain", () => {
    chain([
      { v: 1 },
      { v: { x: 1 } },
      { v: { x: { y: 1 } } },
      { v: { x: { y: { z: 1 } } } },
      { v: { x: { y: 2 } } },
      { v: { x: 3 } },
      { v: 4 },
      { v: [1, 2, 3] },
      { v: [[1, 2, 3]] },
    ])
  })
})

// ─── 35. surrogate pairs and string boundaries ─────────────────────────────

describe("unicode and surrogate edges", () => {
  it("astral characters round-trip", () => {
    for (const s of ["\u{1F600}", "\u{1F607}", "\u{2A6B0}", "\u{1F1FA}\u{1F1F8}"]) {
      roundTrip(s)
    }
  })

  it("strings with mixed BMP and astral", () => {
    roundTrip("hello 🌍 world")
    roundTrip("Test 🚀 emoji 👨‍👩‍👧‍👦 family")
  })

  it("strings at byte-boundary lengths (UTF-16 surrogate aware)", () => {
    const emoji = "🎉"
    for (let n = 1; n <= 50; n++) {
      roundTrip(emoji.repeat(n))
    }
  })

  it("delta edits in unicode strings", () => {
    update({ s: "hello" }, { s: "🌍 hello" })
    update({ s: "🌍 hello" }, { s: "🌍 hello world" })
    update({ s: "中文" }, { s: "中文测试" })
  })

  it("strings with BOM and zero-width chars", () => {
    roundTrip("﻿hello")
    roundTrip("a​b")
    roundTrip("a­b")
  })
})

// ─── 36. strmap reuse stress ───────────────────────────────────────────────

describe("strmap stress", () => {
  it("100 distinct keys, then add and delete repeatedly", () => {
    const base = {}
    for (let i = 0; i < 100; i++) base[`key${i}`] = i
    const arj = new ARJSON({ json: base })

    for (let i = 100; i < 130; i++) {
      const next = { ...arj.json, [`key${i}`]: i }
      arj.update(next)
      assert.deepEqual(arj.json, next)
    }

    let cur = arj.json
    for (let i = 100; i < 130; i++) {
      cur = { ...cur }
      delete cur[`key${i}`]
      arj.update(cur)
      assert.deepEqual(arj.json, cur)
    }
  })

  it("rotating string values across keys", () => {
    chain([
      { a: "alpha", b: "beta", c: "gamma" },
      { a: "beta", b: "gamma", c: "alpha" },
      { a: "gamma", b: "alpha", c: "beta" },
      { a: "alpha", b: "beta", c: "gamma" },
    ])
  })

  it("100 array elements with rotating string set", () => {
    const arr1 = []
    const arr2 = []
    const opts = ["red", "green", "blue", "yellow"]
    for (let i = 0; i < 100; i++) {
      arr1.push(opts[i % 4])
      arr2.push(opts[(i + 1) % 4])
    }
    update({ items: arr1 }, { items: arr2 })
  })
})

// ─── 37. integer precision boundaries ──────────────────────────────────────

describe("integer precision boundaries", () => {
  it("MAX_SAFE_INTEGER ± small offsets", () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const v = Number.MAX_SAFE_INTEGER + offset
      const r = dec(enc(v))
      assert.equal(r, v, `${v} → ${r}`)
    }
  })

  it("integers near 2^31 boundary", () => {
    for (const v of [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, -(2 ** 31), -(2 ** 31) - 1]) {
      assert.equal(dec(enc(v)), v)
    }
  })

  it("delta-update from small int to MAX_SAFE_INTEGER and back", () => {
    chain([
      { n: 1 },
      { n: 100 },
      { n: 10000 },
      { n: Number.MAX_SAFE_INTEGER },
      { n: -Number.MAX_SAFE_INTEGER },
      { n: 0 },
    ])
  })
})

// ─── 38. JSON.parse equivalence ────────────────────────────────────────────

describe("JSON equivalence", () => {
  it("dec(enc(JSON.parse(JSON.stringify(x)))) === x for typed JSON", () => {
    const cases = [
      { a: 1, b: "hello", c: [1, 2, 3], d: null, e: true, f: { g: false } },
      [1, "two", null, [3, [4, 5]], { six: 6 }],
      "just a string",
      42,
      null,
    ]
    for (const x of cases) {
      const j = JSON.parse(JSON.stringify(x))
      assert.deepEqual(dec(enc(j)), j)
    }
  })

  it("JSON.parse(JSON.stringify(dec(enc(x)))) === x", () => {
    const cases = [
      { a: 1, b: [1, 2] },
      [{ x: 1 }, { y: 2 }],
      "x",
      0,
    ]
    for (const x of cases) {
      assert.deepEqual(JSON.parse(JSON.stringify(dec(enc(x)))), x)
    }
  })
})

// ─── 39. malformed/edge buffer handling ────────────────────────────────────

describe("buffer / serialization edges", () => {
  it("empty deltas list serializes round-trip", () => {
    const buf = ARJSON.toBuffer([])
    assert.equal(buf.length, 0)
    assert.deepEqual(ARJSON.fromBuffer(buf), [])
  })

  it("single-byte delta", () => {
    const deltas = [new Uint8Array([0x42])]
    const buf = ARJSON.toBuffer(deltas)
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r.length, 1)
    assert.equal(r[0][0], 0x42)
  })

  it("delta exactly 127 bytes (LEB128 1-byte length)", () => {
    const d = new Uint8Array(127).map((_, i) => i)
    const buf = ARJSON.toBuffer([d])
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r[0].length, 127)
  })

  it("delta exactly 128 bytes (LEB128 2-byte length)", () => {
    const d = new Uint8Array(128).map((_, i) => i)
    const buf = ARJSON.toBuffer([d])
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r[0].length, 128)
  })

  it("delta exactly 16383 bytes (LEB128 2-byte boundary)", () => {
    const d = new Uint8Array(16383).map((_, i) => i % 256)
    const buf = ARJSON.toBuffer([d])
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r[0].length, 16383)
  })

  it("delta exactly 16384 bytes (LEB128 3-byte length)", () => {
    const d = new Uint8Array(16384).map((_, i) => i % 256)
    const buf = ARJSON.toBuffer([d])
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r[0].length, 16384)
  })

  it("100 small deltas serialize and round-trip", () => {
    const deltas = []
    for (let i = 0; i < 100; i++) {
      deltas.push(new Uint8Array([i, i * 2, i * 3, i * 5]))
    }
    const buf = ARJSON.toBuffer(deltas)
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r.length, 100)
    for (let i = 0; i < 100; i++) {
      assert.deepEqual(Array.from(r[i]), Array.from(deltas[i]))
    }
  })
})

// ─── 40. extreme depth & width ─────────────────────────────────────────────

describe("extreme depth and width", () => {
  it("1000 deeply nested levels", () => {
    let o = { v: 0 }
    for (let i = 0; i < 1000; i++) o = { x: o }
    roundTrip(o)
  })

  it("array of 5000 small ints", () => {
    const a = []
    for (let i = 0; i < 5000; i++) a.push(i % 100)
    roundTrip(a)
  })

  it("object with 1000 keys", () => {
    const o = {}
    for (let i = 0; i < 1000; i++) o[`k${i}`] = i
    roundTrip(o)
  })

  it("array of 500 nested objects (deep strmap reuse)", () => {
    const a = []
    for (let i = 0; i < 500; i++) {
      a.push({ id: i, name: "user", role: "admin", active: i % 2 === 0 })
    }
    roundTrip(a)
  })
})

// ─── 41. final truly aggressive fuzz ───────────────────────────────────────

describe("final truly aggressive fuzz", () => {
  it("20000 round-trips × 5 seeds (depth 2)", () => {
    for (const seed of [0xA1, 0xB2, 0xC3, 0xD4, 0xE5]) {
      const rng = prng(seed)
      for (let i = 0; i < 4000; i++) {
        const j = randomJSON(rng, 0, 2)
        assert.deepEqual(dec(enc(j)), j, `seed ${seed} iter ${i}`)
      }
    }
  })

  it("5000 deltas × 5 seeds (depth 2)", () => {
    for (const seed of [0xF1, 0xF2, 0xF3, 0xF4, 0xF5]) {
      const rng = prng(seed)
      for (let i = 0; i < 1000; i++) {
        const from = randomJSON(rng, 0, 2)
        const to = randomJSON(rng, 0, 2)
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to, `seed ${seed} iter ${i}`)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      }
    }
  })

  it("100 deeper trees (depth 5) round-trip", () => {
    const rng = prng(0xDEEF)
    for (let i = 0; i < 100; i++) {
      const j = randomJSON(rng, 0, 5)
      assert.deepEqual(dec(enc(j)), j, `iter ${i}`)
    }
  })
})

// ─── 42. string-diff fast-path coverage ────────────────────────────────────

describe("string fast-diff path", () => {
  it("strings exactly at threshold (length 20)", () => {
    update({ s: "a".repeat(20) }, { s: "b".repeat(20) })
    update({ s: "a".repeat(19) }, { s: "b".repeat(19) })
    update({ s: "a".repeat(21) }, { s: "b".repeat(21) })
  })

  it("very small change in 2KB string", () => {
    const long = "x".repeat(2000)
    update({ s: long }, { s: long.replace("x", "Y") })
    update({ s: long }, { s: "Y" + long.slice(1) })
    update({ s: long }, { s: long.slice(0, -1) + "Y" })
  })

  it("many small edits to same long string", () => {
    let s = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10)
    const states = [{ s }]
    for (let i = 0; i < 50; i++) {
      const idx = (i * 17) % s.length
      s = s.slice(0, idx) + "X" + s.slice(idx + 1)
      states.push({ s })
    }
    chain(states)
  })

  it("string diff in array element", () => {
    const long = "abcdefghijklmnopqrstuvwxyz".repeat(5)
    update({ items: ["x", long, "y"] }, { items: ["x", long.replace("abc", "ABC"), "y"] })
  })

  it("string diff in nested object", () => {
    const long = "Hello, world! ".repeat(20)
    update(
      { config: { description: long } },
      { config: { description: long.replace("Hello", "HELLO") } },
    )
  })

  it("appending small chunks repeatedly", () => {
    let s = "initial content. ".repeat(5)
    const states = [{ doc: s }]
    for (let i = 0; i < 30; i++) {
      s += `chunk${i} `
      states.push({ doc: s })
    }
    chain(states)
  })
})

// ─── 43. Buffer (Node Buffer) compatibility ────────────────────────────────

describe("Buffer compatibility", () => {
  it("ARJSON({arj: Buffer}) accepts Node Buffer", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2] } })
    const buf = a.toBuffer() // Node Buffer
    assert.ok(Buffer.isBuffer(buf))
    const b = new ARJSON({ arj: buf })
    assert.deepEqual(b.json, { x: 1, y: [1, 2] })
  })

  it("ARJSON({arj: Uint8Array}) accepts plain Uint8Array", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2] } })
    const buf = a.toBuffer()
    const u = new Uint8Array(buf)
    const b = new ARJSON({ arj: u })
    assert.deepEqual(b.json, { x: 1, y: [1, 2] })
  })

  it("ARJSON({arj: ArrayBuffer.slice}) on a sub-region", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    const buf = a.toBuffer()
    const u = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    const b = new ARJSON({ arj: u })
    assert.deepEqual(b.json, { x: 1, y: 2 })
  })
})

// ─── 44. delta accumulation patterns ───────────────────────────────────────

describe("delta accumulation patterns", () => {
  it("buffer grows monotonically as updates apply", () => {
    const a = new ARJSON({ json: { count: 0 } })
    let prevLen = a.toBuffer().length
    for (let i = 1; i <= 30; i++) {
      a.update({ count: i })
      const len = a.toBuffer().length
      assert.ok(len >= prevLen, `iter ${i}: ${len} < ${prevLen}`)
      prevLen = len
    }
  })

  it("100 micro-updates compress smaller than 100 full re-encodings", () => {
    const a = new ARJSON({ json: { count: 0 } })
    let totalFull = enc({ count: 0 }).length
    for (let i = 1; i <= 100; i++) {
      a.update({ count: i })
      totalFull += enc({ count: i }).length
    }
    const accumulated = a.toBuffer().length
    assert.ok(
      accumulated < totalFull / 2,
      `delta accumulation (${accumulated}) should be much less than naive sum (${totalFull})`,
    )
  })

  it("artable.table is stable after many updates", () => {
    const a = new ARJSON({ json: { x: 1 } })
    for (let i = 0; i < 50; i++) {
      a.update({ x: i, y: `value${i}` })
    }
    const t = a.artable.table()
    assert.ok(t.vrefs)
    assert.ok(t.krefs)
    assert.ok(t.keys)
    // building from this table should match
    const b = new ARJSON({ table: t })
    assert.deepEqual(b.json, a.json)
  })
})

// ─── 45. tricky mixed-type chains ──────────────────────────────────────────

describe("tricky mixed-type chains", () => {
  it("alternating array ↔ object at same key", () => {
    chain([
      { v: 1 },
      { v: [1] },
      { v: { x: 1 } },
      { v: [1, 2] },
      { v: { x: 1, y: 2 } },
      { v: [{ a: 1 }] },
      { v: { a: [1] } },
      { v: 0 },
    ])
  })

  it("primitive type cycling", () => {
    chain([1, "1", true, false, null, 1, "two", 2, null, "null"])
  })

  it("array contents type cycling", () => {
    chain([
      [1, 2, 3],
      ["1", "2", "3"],
      [true, false, true],
      [null, null, null],
      [1.5, 2.5, 3.5],
      [{ a: 1 }, { a: 2 }, { a: 3 }],
      [[1], [2], [3]],
    ])
  })

  it("object values type cycling", () => {
    chain([
      { x: 1, y: 2 },
      { x: "a", y: "b" },
      { x: true, y: false },
      { x: null, y: null },
      { x: [1], y: [2] },
      { x: { a: 1 }, y: { b: 2 } },
      { x: 1, y: 2 },
    ])
  })
})

// ─── 46. equality predicates ────────────────────────────────────────────────

describe("equality predicates and idempotence", () => {
  it("update(x, x) is no-op for many shapes", () => {
    const cases = [
      null,
      true,
      0,
      "",
      [],
      {},
      [1, 2, 3],
      { a: { b: { c: 1 } } },
      [{ x: 1 }, [1, 2], "y"],
    ]
    for (const x of cases) {
      const a = new ARJSON({ json: x })
      const beforeBuf = a.toBuffer()
      a.update(x)
      assert.deepEqual(a.json, x)
      // Buffer may grow with no-op deltas, but state should match
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, x)
    }
  })

  it("update applied to clone equals original target", () => {
    const orig = { x: 1, y: [1, 2, 3] }
    const target = { x: 2, y: [1, 2, 3, 4] }
    const targetClone = JSON.parse(JSON.stringify(target))
    const a = new ARJSON({ json: orig })
    a.update(target)
    assert.deepEqual(a.json, targetClone)
  })

  it("two independent ARJSONs with identical inputs produce identical buffers", () => {
    const j = { a: 1, b: [1, 2], c: "hello" }
    const a = new ARJSON({ json: j })
    const b = new ARJSON({ json: j })
    const bufA = a.toBuffer()
    const bufB = b.toBuffer()
    assert.deepEqual(Array.from(bufA), Array.from(bufB))
  })
})

// ─── 47. brutal cross-product fuzz ─────────────────────────────────────────

describe("cross-product brutal fuzz", () => {
  it("interleave 200 random updates with random buffer reloads", () => {
    const rng = prng(0xBABA)
    let a = new ARJSON({ json: randomJSON(rng, 0, 2) })
    for (let i = 0; i < 200; i++) {
      const next = randomJSON(rng, 0, 2)
      a.update(next)
      assert.deepEqual(a.json, next, `step ${i}`)
      if (rng() < 0.3) {
        // reload through buffer
        a = new ARJSON({ arj: a.toBuffer() })
        assert.deepEqual(a.json, next, `reload at step ${i}`)
      }
    }
  })

  it("interleave 100 random updates with table-construct cycles", () => {
    const rng = prng(0xCBCB)
    let a = new ARJSON({ json: randomJSON(rng, 0, 2) })
    for (let i = 0; i < 100; i++) {
      const next = randomJSON(rng, 0, 2)
      a.update(next)
      assert.deepEqual(a.json, next)
      if (rng() < 0.2) {
        a = new ARJSON({ table: a.artable.table() })
        assert.deepEqual(a.json, next, `table-reload at ${i}`)
      }
    }
  })

  it("primitive root values round-trip through {table}", () => {
    for (const v of [null, true, false, 0, 1, -1, 42, 3.14, "", "x", "hello", []]) {
      const a = new ARJSON({ json: v })
      const b = new ARJSON({ table: a.artable.table() })
      assert.deepEqual(b.json, v, `${JSON.stringify(v)}`)
    }
  })

  it("primitive root re-anchor through {arj} preserves value", () => {
    for (const v of [null, true, false, 0, 1, -1, 42, "x", "hello", []]) {
      const a = new ARJSON({ json: v })
      const b = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(b.json, v, `${JSON.stringify(v)}`)
      const c = new ARJSON({ table: b.artable.table() })
      assert.deepEqual(c.json, v, `${JSON.stringify(v)} via table after arj`)
    }
  })
})

// ─── 48. cross-validation: {arj} ≡ {table} from same source ────────────────

describe("ARJSON construction cross-validation", () => {
  it("from json and from arj-buf produce equivalent table content", () => {
    const cases = [
      { a: 1 },
      { a: 1, b: 2 },
      [1, 2, 3],
      { x: { y: { z: [1, 2, 3] } } },
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    ]
    for (const j of cases) {
      const a = new ARJSON({ json: j })
      const b = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(b.json, a.json)
      // Both should produce same json for {table} construction
      const fromTableA = new ARJSON({ table: a.artable.table() })
      const fromTableB = new ARJSON({ table: b.artable.table() })
      assert.deepEqual(fromTableA.json, j)
      assert.deepEqual(fromTableB.json, j)
    }
  })
})

// ─── 49. final huge fuzz ────────────────────────────────────────────────────

describe("FINAL HUGE FUZZ", () => {
  it("50000 round-trips × 5 seeds (depth 2)", () => {
    for (const seed of [0xA0, 0xA1, 0xA2, 0xA3, 0xA4]) {
      const rng = prng(seed)
      for (let i = 0; i < 10000; i++) {
        const j = randomJSON(rng, 0, 2)
        assert.deepEqual(dec(enc(j)), j, `seed ${seed} iter ${i}`)
      }
    }
  })
})
