// Matrix tests — exhaustive cartesian-product coverage.
//
// Each test combines every value type with every container position and
// every delta operation. The point is exhaustive coverage: an optimization
// that breaks any cell of the matrix is caught.

import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON, enc, dec } from "../src/arjson.js"

// ─── canonical value samples ──────────────────────────────────────────────

const values = {
  null_: null,
  true_: true,
  false_: false,
  zero: 0,
  one: 1,
  small_pos: 42,
  small_neg: -42,
  big_pos: 1000000,
  big_neg: -1000000,
  max_safe: Number.MAX_SAFE_INTEGER,
  min_safe: -Number.MAX_SAFE_INTEGER,
  float_pos: 3.14,
  float_neg: -3.14,
  float_small: 0.001,
  float_sci: 1e10,
  empty_string: "",
  one_char: "x",
  short_string: "hello",
  base64_string: "abc_XYZ-",
  long_string: "x".repeat(100),
  unicode: "中文 emoji 🎉",
  empty_array: [],
  empty_object: {},
  one_elem_arr: [1],
  one_key_obj: { a: 1 },
}

const equiv = (a, b) => {
  // JSON-equivalent: NaN→null, -0→0, undefined dropped
  return JSON.stringify(JSON.parse(JSON.stringify(a))) ===
         JSON.stringify(JSON.parse(JSON.stringify(b)))
}

// ─── round-trip: every value at every container position ──────────────────

describe("matrix: round-trip every value at every position", () => {
  for (const [vname, v] of Object.entries(values)) {
    it(`bare: enc/dec(${vname})`, () => {
      assert.deepEqual(dec(enc(v)), v)
    })
    it(`{wrap: ${vname}}`, () => {
      assert.deepEqual(dec(enc({ wrap: v })), { wrap: v })
    })
    it(`[${vname}]`, () => {
      assert.deepEqual(dec(enc([v])), [v])
    })
    it(`{a: 1, wrap: ${vname}}`, () => {
      assert.deepEqual(dec(enc({ a: 1, wrap: v })), { a: 1, wrap: v })
    })
    it(`[1, ${vname}]`, () => {
      assert.deepEqual(dec(enc([1, v])), [1, v])
    })
    it(`{nested: {wrap: ${vname}}}`, () => {
      assert.deepEqual(
        dec(enc({ nested: { wrap: v } })),
        { nested: { wrap: v } },
      )
    })
    it(`[[${vname}]]`, () => {
      assert.deepEqual(dec(enc([[v]])), [[v]])
    })
    it(`{a: [${vname}]}`, () => {
      assert.deepEqual(dec(enc({ a: [v] })), { a: [v] })
    })
    it(`[{wrap: ${vname}}]`, () => {
      assert.deepEqual(dec(enc([{ wrap: v }])), [{ wrap: v }])
    })
  }
})

// ─── delta: every transition between sample values ────────────────────────

describe("matrix: delta update from every value to every value", () => {
  const names = Object.keys(values)
  for (const fromName of names) {
    for (const toName of names) {
      if (fromName === toName) continue
      it(`{wrap: ${fromName}} → {wrap: ${toName}}`, () => {
        const from = { wrap: values[fromName] }
        const to = { wrap: values[toName] }
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to)
        assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
      })
    }
  }
})

// ─── delta: array element transitions ─────────────────────────────────────

describe("matrix: delta replace at every array index", () => {
  const sizes = [1, 2, 5, 10]
  for (const size of sizes) {
    for (let idx = 0; idx < size; idx++) {
      it(`array of ${size} integers, replace index ${idx}`, () => {
        const from = []
        for (let i = 0; i < size; i++) from.push(i * 10)
        const to = from.slice()
        to[idx] = 99
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to)
      })
    }
  }
})

describe("matrix: delta append at every array length boundary", () => {
  for (const size of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64]) {
    it(`length ${size} → ${size + 1} (append primitive)`, () => {
      const from = []
      for (let i = 0; i < size; i++) from.push(i)
      const to = [...from, 99]
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to)
    })
  }
})

describe("matrix: delta delete at every array length boundary", () => {
  for (const size of [1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64]) {
    it(`length ${size} → ${size - 1} (drop last)`, () => {
      const from = []
      for (let i = 0; i < size; i++) from.push(i)
      const to = from.slice(0, -1)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to)
    })
  }
})

// ─── delta: every object operation ────────────────────────────────────────

describe("matrix: object key operations", () => {
  it("add key (new) for every value type", () => {
    for (const [name, v] of Object.entries(values)) {
      const a = new ARJSON({ json: { x: 1 } })
      a.update({ x: 1, fresh: v })
      assert.deepEqual(a.json, { x: 1, fresh: v }, `failed for ${name}`)
    }
  })

  it("delete key from various-shape objects", () => {
    const cases = [
      { a: 1 },
      { a: 1, b: 2 },
      { a: 1, b: 2, c: 3 },
      { a: { b: 1 }, c: 2 },
      { a: [1, 2], b: 3 },
    ]
    for (const obj of cases) {
      const keys = Object.keys(obj)
      const dropKey = keys[keys.length - 1]
      const target = { ...obj }
      delete target[dropKey]
      const a = new ARJSON({ json: obj })
      a.update(target)
      assert.deepEqual(a.json, target)
    }
  })

  it("replace key value for every (from, to) value pair", () => {
    const samples = ["null_", "small_pos", "short_string", "one_elem_arr", "one_key_obj"]
    for (const fromName of samples) {
      for (const toName of samples) {
        if (fromName === toName) continue
        const from = { x: values[fromName] }
        const to = { x: values[toName] }
        const a = new ARJSON({ json: from })
        a.update(to)
        assert.deepEqual(a.json, to)
      }
    }
  })
})

// ─── delta: nested update at every depth ──────────────────────────────────

describe("matrix: nested updates at depths 1-10", () => {
  for (let depth = 1; depth <= 10; depth++) {
    it(`update at depth ${depth}`, () => {
      const buildPath = (val) => {
        let o = val
        for (let i = 0; i < depth; i++) o = { x: o }
        return o
      }
      const from = buildPath(1)
      const to = buildPath(2)
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to)
    })
  }
})

// ─── chain: state evolution through every value class ────────────────────

describe("matrix: chain of states cycling through every value class", () => {
  it("chain through all primitives at the root", () => {
    const states = [null, true, false, 0, 1, -1, "", "x", "hello", 3.14, [], {}]
    const a = new ARJSON({ json: states[0] })
    for (let i = 1; i < states.length; i++) {
      a.update(states[i])
      assert.deepEqual(a.json, states[i], `step ${i}`)
    }
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, states[states.length - 1])
  })

  it("chain through all primitives wrapped in object", () => {
    const states = Object.values(values).map(v => ({ x: v }))
    const a = new ARJSON({ json: states[0] })
    for (let i = 1; i < states.length; i++) {
      a.update(states[i])
      assert.deepEqual(a.json, states[i], `step ${i}: ${JSON.stringify(states[i]).slice(0, 60)}`)
    }
  })

  it("chain through all primitives wrapped in array", () => {
    const states = Object.values(values).map(v => [v])
    const a = new ARJSON({ json: states[0] })
    for (let i = 1; i < states.length; i++) {
      a.update(states[i])
      assert.deepEqual(a.json, states[i], `step ${i}: ${JSON.stringify(states[i]).slice(0, 60)}`)
    }
  })
})

// ─── boundary matrix: all bit-width edges across number types ─────────────

describe("matrix: number bit-width boundaries", () => {
  // Every integer at +/- (2^k - 1, 2^k, 2^k + 1) for k = 1..52.
  it("every (2^k - 1, 2^k, 2^k + 1) for k = 1..52", () => {
    for (let k = 1; k <= 52; k++) {
      const base = Math.pow(2, k)
      for (const offset of [-1, 0, 1]) {
        const n = base + offset
        if (Number.isSafeInteger(n)) {
          const r = dec(enc(n))
          assert.equal(r, n, `+${n} round-trip`)
          const r2 = dec(enc(-n))
          assert.equal(r2, -n, `-${n} round-trip`)
        }
      }
    }
  })
})

// ─── string-length boundary matrix ────────────────────────────────────────

describe("matrix: string-length boundaries", () => {
  const lengths = [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256, 1023, 1024]
  it("ascii string at every length boundary", () => {
    for (const len of lengths) {
      const s = "x".repeat(len)
      assert.equal(dec(enc(s)), s, `length ${len}`)
    }
  })
  it("base64url string at every length boundary", () => {
    for (const len of lengths.filter(l => l > 0)) {
      const s = "abc-_XYZ".repeat(Math.ceil(len / 8)).slice(0, len)
      assert.equal(dec(enc(s)), s, `length ${len}`)
    }
  })
  it("non-base64 string at every length boundary", () => {
    for (const len of lengths.filter(l => l > 0)) {
      const s = "Hi! ".repeat(Math.ceil(len / 4)).slice(0, len)
      assert.equal(dec(enc(s)), s, `length ${len}`)
    }
  })
})

// ─── object-key-count and array-length matrix ─────────────────────────────

describe("matrix: object key count boundaries", () => {
  for (const n of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256]) {
    it(`object with ${n} keys`, () => {
      const o = {}
      for (let i = 0; i < n; i++) o[`k${i}`] = i
      assert.deepEqual(dec(enc(o)), o)
    })
  }
})

describe("matrix: array length boundaries", () => {
  for (const n of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256]) {
    it(`array of ${n} ints`, () => {
      const a = []
      for (let i = 0; i < n; i++) a.push(i)
      assert.deepEqual(dec(enc(a)), a)
    })
  }
})
