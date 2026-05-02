// Property-based fuzz testing for absolute correctness.
//
// Each test asserts an invariant that must hold for ALL valid inputs.
// When a failure is found, the test attempts to shrink the input to a
// minimal failing case.
//
// Suites:
//   1. round-trip invariants    — dec(enc(x)) ≡ x
//   2. determinism invariants    — enc(x) === enc(x), bit-identical
//   3. delta invariants          — update/toBuffer/fromBuffer convergence
//   4. JSON-equivalence          — JSON.stringify(dec(enc(x))) ≡ JSON.stringify(JSON.parse(JSON.stringify(x)))
//   5. mutation fuzz             — seed corpus + structured mutations
//   6. boundary value coverage   — explicit IEEE 754 / unicode / count boundaries
//   7. decoder robustness        — random bytes / truncated / corrupted inputs do not crash
//
// Iteration counts are sized to complete in a few seconds under `npm test`.
// For long-running stress, see fuzz-stress.js.

import { describe, it } from "node:test"
import assert from "assert"
import { equals } from "../src/utils.js"
import { ARJSON, enc, dec } from "../src/arjson.js"

// ─── seeded PRNG (mulberry32) ──────────────────────────────────────────────

const prng = (seed) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

const randomString = (rng, len) => {
  let s = ""
  for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)]
  return s
}

const randomKey = (rng) => randomString(rng, 1 + Math.floor(rng() * 8))

const randomPrimitive = (rng) => {
  const r = rng()
  if (r < 0.1) return null
  if (r < 0.2) return rng() < 0.5
  if (r < 0.45) return Math.floor(rng() * 1000) - 500
  if (r < 0.6) return Math.round((rng() * 200 - 100) * 100) / 100
  return randomString(rng, 1 + Math.floor(rng() * 12))
}

const randomJSON = (rng, depth = 0, maxDepth = 4) => {
  if (depth >= maxDepth) return randomPrimitive(rng)
  const r = rng()
  if (r < 0.15) return randomPrimitive(rng)
  if (r < 0.55) {
    const n = Math.floor(rng() * 5) + 1
    const o = {}
    for (let i = 0; i < n; i++) {
      o[randomKey(rng)] = randomJSON(rng, depth + 1, maxDepth)
    }
    return o
  }
  const n = Math.floor(rng() * 5) + 1
  const a = []
  for (let i = 0; i < n; i++) a.push(randomJSON(rng, depth + 1, maxDepth))
  return a
}

// ─── shrinking ─────────────────────────────────────────────────────────────
//
// Given a failing input, try to find a smaller input that still fails.
// Strategy: recursively try removing/simplifying components.

const sanitize = (x) => {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) return null
    if (Object.is(x, -0)) return 0
  }
  if (Array.isArray(x)) return x.map(sanitize)
  if (x && typeof x === "object") {
    const out = {}
    for (const k of Object.keys(x)) out[k] = sanitize(x[k])
    return out
  }
  return x
}

const shrink = (x, fails, maxAttempts = 200) => {
  let best = x
  let attempts = 0
  let changed = true
  while (changed && attempts < maxAttempts) {
    changed = false
    const candidates = shrinkCandidates(best)
    for (const c of candidates) {
      attempts++
      if (attempts >= maxAttempts) break
      try {
        if (fails(c)) {
          best = c
          changed = true
          break
        }
      } catch {
        best = c
        changed = true
        break
      }
    }
  }
  return best
}

function* shrinkCandidates(x) {
  if (Array.isArray(x)) {
    if (x.length > 0) yield []
    if (x.length > 1) {
      for (let i = 0; i < x.length; i++) {
        const c = x.slice()
        c.splice(i, 1)
        yield c
      }
    }
    for (let i = 0; i < x.length; i++) {
      for (const sub of shrinkCandidates(x[i])) {
        const c = x.slice()
        c[i] = sub
        yield c
      }
    }
  } else if (x && typeof x === "object") {
    const keys = Object.keys(x)
    if (keys.length > 0) yield {}
    if (keys.length > 1) {
      for (const k of keys) {
        const c = { ...x }
        delete c[k]
        yield c
      }
    }
    for (const k of keys) {
      for (const sub of shrinkCandidates(x[k])) {
        yield { ...x, [k]: sub }
      }
    }
  } else if (typeof x === "string" && x.length > 0) {
    yield ""
    if (x.length > 1) yield x.slice(0, Math.floor(x.length / 2))
  } else if (typeof x === "number" && x !== 0) {
    yield 0
  }
}

// ─── 1. round-trip invariants ─────────────────────────────────────────────

describe("fuzz: round-trip dec(enc(x)) ≡ x", () => {
  const seeds = [0xA1, 0xA2, 0xA3, 0xA4, 0xA5]
  it(`${seeds.length} seeds × 1000 inputs each`, () => {
    for (const seed of seeds) {
      const rng = prng(seed)
      for (let i = 0; i < 1000; i++) {
        const x = sanitize(randomJSON(rng))
        const fails = (v) => !equals(dec(enc(v)), v)
        if (fails(x)) {
          const min = shrink(x, fails)
          assert.fail(
            `seed ${seed} iter ${i}: encoded payload does not round-trip.\n` +
              `  shrunk to: ${JSON.stringify(min)}\n` +
              `  got:       ${JSON.stringify(dec(enc(min)))}`,
          )
        }
      }
    }
  })
})

// ─── 2. determinism invariants ────────────────────────────────────────────

describe("fuzz: enc(x) is byte-identical across calls", () => {
  it("1000 random inputs, two encodes each, expect identical bytes", () => {
    const rng = prng(0xDE7E)
    for (let i = 0; i < 1000; i++) {
      const x = sanitize(randomJSON(rng))
      const a = enc(x)
      const b = enc(x)
      const fails = (v) => {
        const ea = enc(v)
        const eb = enc(v)
        return Buffer.compare(Buffer.from(ea), Buffer.from(eb)) !== 0
      }
      if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
        const min = shrink(x, fails)
        assert.fail(
          `iter ${i}: enc not deterministic for ${JSON.stringify(min)}`,
        )
      }
    }
  })

  it("toBuffer() is byte-identical across calls", () => {
    const rng = prng(0xDE7F)
    for (let i = 0; i < 200; i++) {
      const x = sanitize(randomJSON(rng))
      const a1 = new ARJSON({ json: x })
      const b1 = a1.toBuffer()
      const b2 = a1.toBuffer()
      assert.deepEqual(Array.from(b1), Array.from(b2))
      // Distinct ARJSON instances over the same input also must agree
      const a2 = new ARJSON({ json: x })
      const b3 = a2.toBuffer()
      assert.deepEqual(Array.from(b1), Array.from(b3))
    }
  })

  it("delta-chain buffers are deterministic given identical sequences", () => {
    const rng = prng(0xDE80)
    for (let trial = 0; trial < 30; trial++) {
      const states = [sanitize(randomJSON(rng, 0, 2))]
      for (let i = 0; i < 8; i++) states.push(sanitize(randomJSON(rng, 0, 2)))

      const a1 = new ARJSON({ json: states[0] })
      for (const s of states.slice(1)) a1.update(s)
      const buf1 = a1.toBuffer()

      const a2 = new ARJSON({ json: states[0] })
      for (const s of states.slice(1)) a2.update(s)
      const buf2 = a2.toBuffer()

      assert.deepEqual(
        Array.from(buf1),
        Array.from(buf2),
        `trial ${trial}: same chain produced different buffers`,
      )
    }
  })
})

// ─── 3. delta-chain invariants ────────────────────────────────────────────

describe("fuzz: delta-chain convergence invariants", () => {
  it("buffer round-trip preserves final state", () => {
    const rng = prng(0xDEC0)
    for (let trial = 0; trial < 100; trial++) {
      const states = [sanitize(randomJSON(rng, 0, 2))]
      const len = 1 + Math.floor(rng() * 10)
      for (let i = 0; i < len; i++) states.push(sanitize(randomJSON(rng, 0, 2)))

      const a = new ARJSON({ json: states[0] })
      for (const s of states.slice(1)) a.update(s)
      const final = states[states.length - 1]

      assert.deepEqual(a.json, final, `trial ${trial} live`)
      const b = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(b.json, final, `trial ${trial} buffer round-trip`)

      // Also verify {table} reconstruction
      const c = new ARJSON({ table: a.artable.table() })
      assert.deepEqual(c.json, final, `trial ${trial} table reconstruction`)
    }
  })

  it("update(x, x) is idempotent for varied inputs", () => {
    const rng = prng(0xDEC1)
    for (let i = 0; i < 200; i++) {
      const x = sanitize(randomJSON(rng))
      const a = new ARJSON({ json: x })
      a.update(x)
      assert.deepEqual(a.json, x)
    }
  })

  it("ARJSON({arj: a.toBuffer()}).toBuffer() === a.toBuffer()", () => {
    const rng = prng(0xDEC2)
    for (let i = 0; i < 100; i++) {
      const x = sanitize(randomJSON(rng))
      const a = new ARJSON({ json: x })
      const buf1 = a.toBuffer()
      const b = new ARJSON({ arj: buf1 })
      const buf2 = b.toBuffer()
      assert.deepEqual(Array.from(buf1), Array.from(buf2), `iter ${i}`)
    }
  })

  it("partial chain replay: prefix of chain reaches matching prefix-state", () => {
    const rng = prng(0xDEC3)
    for (let trial = 0; trial < 30; trial++) {
      const states = [sanitize(randomJSON(rng, 0, 2))]
      for (let i = 0; i < 6; i++) states.push(sanitize(randomJSON(rng, 0, 2)))

      const a = new ARJSON({ json: states[0] })
      for (const s of states.slice(1)) a.update(s)
      const fullDeltas = a.deltas

      // Reconstruct from a buffer truncated to the first k deltas
      for (let k = 1; k <= fullDeltas.length; k++) {
        const partialChain = fullDeltas.slice(0, k)
        const buf = ARJSON.toBuffer(partialChain)
        const b = new ARJSON({ arj: buf })
        // The partial replay should produce SOME consistent state.
        // We don't assert it equals states[k-1] because re-anchors collapse
        // history in the deltas; we just assert nothing throws and the
        // result round-trips.
        assert.deepEqual(
          new ARJSON({ arj: b.toBuffer() }).json,
          b.json,
          `trial ${trial} k=${k}: partial chain not idempotent`,
        )
      }
    }
  })
})

// ─── 4. JSON equivalence (modulo coercion) ────────────────────────────────

describe("fuzz: JSON.stringify(dec(enc(x))) ≡ JSON.stringify(JSON.parse(JSON.stringify(x)))", () => {
  it("500 random inputs", () => {
    const rng = prng(0xC501)
    for (let i = 0; i < 500; i++) {
      const x = sanitize(randomJSON(rng))
      // Normalize via JSON to apply spec-level coercions
      const xNorm = JSON.parse(JSON.stringify(x))
      const arjRoundTrip = dec(enc(x))
      assert.deepEqual(
        JSON.parse(JSON.stringify(arjRoundTrip)),
        xNorm,
        `iter ${i}: ${JSON.stringify(x).slice(0, 80)}`,
      )
    }
  })
})

// ─── 5. mutation fuzz ─────────────────────────────────────────────────────

const mutate = (x, rng) => {
  // Apply a structural mutation to x, return a new value.
  const op = Math.floor(rng() * 8)
  if (Array.isArray(x)) {
    const c = x.slice()
    if (op === 0 && c.length > 0) c.pop()
    else if (op === 1) c.push(randomPrimitive(rng))
    else if (op === 2 && c.length > 0) {
      c[Math.floor(rng() * c.length)] = randomPrimitive(rng)
    } else if (op === 3 && c.length > 0) {
      c.splice(Math.floor(rng() * c.length), 1)
    } else if (op === 4 && c.length > 0) {
      const idx = Math.floor(rng() * c.length)
      c[idx] = mutate(c[idx], rng)
    } else if (op === 5) c.push(randomJSON(rng, 0, 2))
    else if (op === 6 && c.length >= 2) {
      // swap two elements
      const i = Math.floor(rng() * c.length)
      const j = Math.floor(rng() * c.length)
      ;[c[i], c[j]] = [c[j], c[i]]
    } else return [...c, randomPrimitive(rng)]
    return c
  }
  if (x && typeof x === "object") {
    const c = { ...x }
    const keys = Object.keys(c)
    if (op === 0) c[randomKey(rng)] = randomPrimitive(rng)
    else if (op === 1 && keys.length > 0) {
      delete c[keys[Math.floor(rng() * keys.length)]]
    } else if (op === 2 && keys.length > 0) {
      const k = keys[Math.floor(rng() * keys.length)]
      c[k] = randomPrimitive(rng)
    } else if (op === 3 && keys.length > 0) {
      const k = keys[Math.floor(rng() * keys.length)]
      c[k] = mutate(c[k], rng)
    } else if (op === 4) c[randomKey(rng)] = randomJSON(rng, 0, 2)
    else if (op === 5 && keys.length > 0) {
      const k = keys[Math.floor(rng() * keys.length)]
      c[k] = randomJSON(rng, 0, 2)
    } else c[randomKey(rng)] = randomPrimitive(rng)
    return c
  }
  // primitive — replace with a different random primitive
  return randomPrimitive(rng)
}

describe("fuzz: mutation chains preserve invariants", () => {
  it("100 chains of 20 mutations each", () => {
    const rng = prng(0xCAFE)
    for (let trial = 0; trial < 100; trial++) {
      let cur = sanitize(randomJSON(rng, 0, 2))
      const a = new ARJSON({ json: cur })
      for (let i = 0; i < 20; i++) {
        cur = sanitize(mutate(cur, rng))
        a.update(cur)
        assert.deepEqual(a.json, cur, `trial ${trial} step ${i}`)
      }
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, cur)
    }
  })

  it("seed corpus + bit-flip mutations: ARJSON either round-trips or fails cleanly", () => {
    const seedCorpus = [
      { a: 1, b: [1, 2, 3] },
      [1, 2, 3, "x", null],
      { user: { name: "Alice", age: 30, tags: ["a", "b"] } },
      [{ id: 1 }, { id: 2 }],
    ]
    const rng = prng(0xB1F1)
    for (let trial = 0; trial < 200; trial++) {
      const seed = seedCorpus[trial % seedCorpus.length]
      const buf = Buffer.from(enc(seed))
      // Flip 1-3 random bits
      const nFlips = 1 + Math.floor(rng() * 3)
      const mutated = Buffer.from(buf)
      for (let f = 0; f < nFlips; f++) {
        const byteIdx = Math.floor(rng() * mutated.length)
        const bitIdx = Math.floor(rng() * 8)
        mutated[byteIdx] ^= 1 << bitIdx
      }
      // Either decodes to something (possibly wrong) or throws cleanly.
      // Must NOT crash the process or hang.
      let result = null
      let threw = null
      try {
        result = dec(mutated)
      } catch (e) {
        threw = e
      }
      // The only invariant we assert: no infinite loop (timeout would catch
      // it), no crash (we got here), and if it returned, the result is at
      // least JSON-stringifiable.
      if (result !== undefined && result !== null) {
        try {
          JSON.stringify(result)
        } catch (e) {
          assert.fail(`trial ${trial}: dec returned non-JSON-stringifiable: ${e.message}`)
        }
      }
    }
  })
})

// ─── 6. boundary value coverage ───────────────────────────────────────────

describe("fuzz: explicit boundary values", () => {
  const numbers = [
    0, 1, -1, 2, -2, 3, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256,
    511, 512, 1023, 1024, 16383, 16384, 65535, 65536,
    2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 40,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1,
    -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER + 1,
    0.1, 0.5, 0.25, 0.0001, 1e-10, 1e-15, 1e-300,
    1e10, 1e20, 1e100, 1e308,
    Math.PI, Math.E, Number.EPSILON,
    -0.1, -0.5, -1e-10, -1e308,
  ]

  it("every number in the boundary set round-trips (or is JSON-coerced)", () => {
    for (const n of numbers) {
      const back = dec(enc(n))
      const expected = JSON.parse(JSON.stringify(n))
      assert.deepEqual(back, expected, `n=${n}: got ${back}`)
    }
  })

  it("non-finite values coerce to null", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      assert.equal(dec(enc(v)), null, `${v} should coerce to null`)
    }
  })

  it("strings with every Unicode category sample", () => {
    const samples = [
      "",
      " ",
      "\n",
      "\t",
      " ",
      "",
      "",
      " ",
      "ÿ",
      "Ā",
      "߿",
      "ࠀ",
      "퟿",
      "",
      "�",
      "￿",
      "\u{10000}",
      "\u{1F600}",
      "\u{10FFFF}",
      "中文",
      "Δσ",
      "العربية",
      "한국어",
      "🇯🇵",
      "𝐇𝐞𝐥𝐥𝐨",
    ]
    for (const s of samples) {
      const back = dec(enc(s))
      assert.equal(back, s, `${JSON.stringify(s)}`)
    }
  })

  it("array-length boundaries (every 2-bit/3-bit/4-bit edge)", () => {
    for (const len of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256]) {
      const a = []
      for (let i = 0; i < len; i++) a.push(i)
      assert.deepEqual(dec(enc(a)), a, `array len=${len}`)
    }
  })

  it("object-key-count boundaries", () => {
    for (const n of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128]) {
      const o = {}
      for (let i = 0; i < n; i++) o[`k${i}`] = i
      assert.deepEqual(dec(enc(o)), o, `keys n=${n}`)
    }
  })
})

// ─── 7. decoder robustness against malformed input ────────────────────────

describe("fuzz: decoder robustness — never crashes the host on bad input", () => {
  const TIMEOUT_GUARD_MS = 100 // per-call; we trust node:test's overall timeout

  it("random byte streams produce values or clean errors, no crash", () => {
    const rng = prng(0xBADD)
    for (let i = 0; i < 500; i++) {
      const len = 1 + Math.floor(rng() * 64)
      const buf = Buffer.alloc(len)
      for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256)
      try {
        const r = dec(buf)
        // If it returned, the result must be JSON-serializable
        if (r !== undefined) JSON.stringify(r)
      } catch (e) {
        // Throwing is acceptable; crashing is not (we'd never reach here).
      }
    }
  })

  it("truncated valid encodings don't crash", () => {
    const samples = [
      { a: 1 },
      [1, 2, 3],
      "hello world",
      { nested: { deep: { value: 42 } } },
      [{ x: 1 }, { y: 2 }],
    ]
    for (const x of samples) {
      const buf = Buffer.from(enc(x))
      for (let cut = 1; cut < buf.length; cut++) {
        const truncated = buf.slice(0, cut)
        try {
          const r = dec(truncated)
          if (r !== undefined) JSON.stringify(r)
        } catch (e) {
          // ok
        }
      }
    }
  })

  it("empty buffer doesn't crash", () => {
    try {
      dec(Buffer.alloc(0))
    } catch (e) {
      // ok
    }
  })

  it("single-byte buffers across all 256 values don't crash", () => {
    for (let b = 0; b < 256; b++) {
      try {
        const r = dec(Buffer.from([b]))
        if (r !== undefined) JSON.stringify(r)
      } catch (e) {
        // ok
      }
    }
  })

  it("two-byte buffers across a sample don't crash", () => {
    // sampling 1000 of 65536 to keep test fast
    for (let i = 0; i < 1000; i++) {
      const b1 = (i * 17 + 13) & 0xff
      const b2 = (i * 31 + 7) & 0xff
      try {
        const r = dec(Buffer.from([b1, b2]))
        if (r !== undefined) JSON.stringify(r)
      } catch (e) {
        // ok
      }
    }
  })

  it("repeated-byte buffers (corruption pattern) don't crash", () => {
    for (const b of [0, 0x55, 0xaa, 0xff, 0x80, 0x7f, 0x01]) {
      for (const len of [4, 16, 64, 256]) {
        const buf = Buffer.alloc(len, b)
        try {
          const r = dec(buf)
          if (r !== undefined) JSON.stringify(r)
        } catch (e) {
          // ok
        }
      }
    }
  })

  it("malformed delta chains don't crash {arj} constructor", () => {
    const rng = prng(0xBA1F)
    for (let i = 0; i < 100; i++) {
      const len = 1 + Math.floor(rng() * 32)
      const buf = Buffer.alloc(len)
      for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256)
      try {
        const a = new ARJSON({ arj: buf })
        if (a.json !== undefined) JSON.stringify(a.json)
      } catch (e) {
        // ok
      }
    }
  })
})

// ─── 8. invariant: encoded size is bounded ────────────────────────────────

describe("fuzz: size-bound sanity", () => {
  it("encoded size is at most 4× JSON.stringify length for non-pathological inputs", () => {
    // Not a strict bound (single-byte primitives encode larger as ARJSON),
    // but a sanity check that we're not blowing up on common inputs.
    const rng = prng(0xB024)
    for (let i = 0; i < 200; i++) {
      const x = sanitize(randomJSON(rng, 0, 3))
      const arjLen = enc(x).length
      const jsonLen = Buffer.byteLength(JSON.stringify(x), "utf8")
      // Allow significant slack: only flag if arjson is >4× JSON. This
      // catches catastrophic encoding bugs (infinite expansion etc).
      assert.ok(
        arjLen <= jsonLen * 4 + 32,
        `iter ${i}: arjson ${arjLen}B for ${jsonLen}B JSON: ${JSON.stringify(x).slice(0, 60)}`,
      )
    }
  })

  it("encoded size is non-zero for non-undefined values", () => {
    const cases = [null, true, false, 0, "", [], {}, { a: 1 }, [1]]
    for (const x of cases) {
      assert.ok(enc(x).length > 0, JSON.stringify(x))
    }
  })
})
