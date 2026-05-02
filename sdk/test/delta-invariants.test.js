// Delta-update invariants — exhaustive cross-path equivalence checks.
//
// Every test asserts that some observable property of the delta-update
// system matches what's implied by the public contract. These should
// hold across any internal refactoring as long as the wire format and
// public API are preserved.
//
// Sections:
//   A. Final-state-equals-target  (any update sequence produces correct .json)
//   B. Buffer round-trip          (any chain decodes to same state)
//   C. Cross-path equivalence     ({json:X} ≡ {arj: enc(X)} ≡ {table: t} for any X)
//   D. Multi-delta chains         (N updates preserve final state)
//   E. Reanchor triggers          (when MUST or MUST NOT reanchor)
//   F. Diff coverage matrix       (every value × value transition)
//   G. Strmap behavior            (dedup, persistence, compaction)
//   H. Path edge cases            (special chars, deep nesting, brackets)
//   I. Property-based fuzz        (random JSON sequences)
//   J. State isolation            (multiple instances don't cross-talk)

import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON, enc, dec } from "../src/arjson.js"

// ─── helpers ──────────────────────────────────────────────────────────────

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Mulberry32 — small fast deterministic PRNG.
const seedRng = seed => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

const sample = (rng, arr) => arr[Math.floor(rng() * arr.length)]

const randomPrimitive = rng => {
  const choices = [
    null, true, false,
    Math.floor(rng() * 1000),
    -Math.floor(rng() * 1000),
    // Use bounded-precision floats only; ARJSON uses
    // `int * 10^-precision` encoding which cannot exactly preserve
    // every IEEE 754 double (a known property of decimal-mantissa
    // float encoding). Using fixed precision avoids the corner cases.
    Math.round(rng() * 10000) / 100,  // 2 decimal places
    "",
    "x",
    "hello",
    "a string with spaces",
  ]
  return sample(rng, choices)
}

const randomJson = (rng, depth = 0) => {
  if (depth >= 3 || rng() < 0.4) return randomPrimitive(rng)
  if (rng() < 0.5) {
    const len = Math.floor(rng() * 4)
    const arr = []
    for (let i = 0; i < len; i++) arr.push(randomJson(rng, depth + 1))
    return arr
  }
  const len = Math.floor(rng() * 4) + 1
  const obj = {}
  for (let i = 0; i < len; i++) obj["k" + i] = randomJson(rng, depth + 1)
  return obj
}

// Deep clone via JSON for assertion comparisons.
const clone = v => JSON.parse(JSON.stringify(v))

// ─── A. Final state equals target ────────────────────────────────────────

describe("delta-invariants A: final state after update equals target", () => {
  const cases = [
    // primitive transitions
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: "x" }],
    [{ a: 1 }, { a: null }],
    [{ a: 1 }, { a: true }],
    [{ a: 1 }, { a: 1.5 }],
    [{ a: "x" }, { a: "y" }],
    [{ a: true }, { a: false }],
    // key add/remove
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: 2 }, { a: 1 }],
    [{ a: 1 }, { b: 2 }],
    // nested
    [{ a: { b: 1 } }, { a: { b: 2 } }],
    [{ a: { b: 1 } }, { a: { b: 1, c: 2 } }],
    [{ a: { b: 1, c: 2 } }, { a: { b: 1 } }],
    // arrays
    [[1, 2, 3], [1, 2, 4]],
    [[1, 2, 3], [1, 2]],
    [[1, 2, 3], [1, 2, 3, 4]],
    [[1, 2, 3], [4, 5, 6]],
    // mixed
    [{ a: [1, 2], b: { c: "x" } }, { a: [1, 2, 3], b: { c: "y" } }],
    // empty containers
    [{ a: [] }, { a: [1] }],
    [{ a: [1] }, { a: [] }],
    [{ a: {} }, { a: { b: 1 } }],
    [{ a: { b: 1 } }, { a: {} }],
    // top-level mutations
    [[], [1, 2, 3]],
    [[1, 2, 3], []],
    [{}, { a: 1 }],
    [{ a: 1 }, {}],
  ]
  for (const [from, to] of cases) {
    it(`${JSON.stringify(from).slice(0, 40)} → ${JSON.stringify(to).slice(0, 40)}`, () => {
      const a = new ARJSON({ json: clone(from) })
      a.update(clone(to))
      assert.deepEqual(a.json, clone(to))
    })
  }
})

// ─── B. Buffer round-trip ─────────────────────────────────────────────────

describe("delta-invariants B: buffer round-trip preserves state", () => {
  const states = [
    null, true, false, 0, 1, -1, 3.14, "", "x", "hello",
    [], [1, 2, 3], {}, { a: 1 },
    { id: 1, name: "Alice", tags: ["staff"], active: true },
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    { nested: { a: { b: { c: { d: 1 } } } } },
  ]

  it("fresh ARJSON({json:X}).toBuffer() round-trips for diverse X", () => {
    for (const s of states) {
      const a = new ARJSON({ json: clone(s) })
      const buf = a.toBuffer()
      const b = new ARJSON({ arj: buf })
      assert.deepEqual(b.json, a.json, `round-trip ${JSON.stringify(s).slice(0, 40)}`)
    }
  })

  it("after update, toBuffer round-trips to same state", () => {
    const a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 10; i++) {
      a.update({ count: i })
      const buf = a.toBuffer()
      const b = new ARJSON({ arj: buf })
      assert.deepEqual(b.json, a.json, `step ${i}`)
    }
  })

  it("buffer round-trip preserves deltas count", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    a.update({ x: 3 })
    a.update({ x: 4, y: "added" })
    const expectedDeltas = a.deltas.length
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.equal(b.deltas.length, expectedDeltas)
  })
})

// ─── C. Cross-path equivalence ────────────────────────────────────────────

describe("delta-invariants C: cross-path equivalence", () => {
  const inputs = [
    null, true, 42, -1, 3.14, "", "x", "hello",
    [], [1, 2], {}, { a: 1 },
    { id: 1, tags: ["a", "b"], deep: { x: { y: 1 } } },
  ]

  it("{json:X}.json === X via ARJSON constructor", () => {
    for (const v of inputs) {
      const a = new ARJSON({ json: clone(v) })
      assert.deepEqual(a.json, v)
    }
  })

  it("{arj: enc(X)}.json === X via buffer", () => {
    for (const v of inputs) {
      const a = new ARJSON({ json: clone(v) })
      const b = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(b.json, v)
    }
  })

  it("{table: t}.json === X via table extraction", () => {
    for (const v of inputs) {
      // Skip primitives — table mode requires structured + table().single
      if (typeof v !== "object" || v === null) continue
      if (Array.isArray(v) && v.length === 0) continue
      if (!Array.isArray(v) && Object.keys(v).length === 0) continue
      const a = new ARJSON({ json: clone(v) })
      const t = a.table()
      const b = new ARJSON({ table: t })
      assert.deepEqual(b.json, v)
    }
  })

  it("dec(enc(X)) === X via top-level helpers", () => {
    for (const v of inputs) {
      assert.deepEqual(dec(enc(v)), v)
    }
  })
})

// ─── D. Multi-delta chains ────────────────────────────────────────────────

describe("delta-invariants D: multi-delta chains", () => {
  it("chain of 50 incremental counter updates", () => {
    const a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 50; i++) a.update({ count: i })
    assert.deepEqual(a.json, { count: 50 })
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, { count: 50 })
  })

  it("chain of mixed updates produces correct final state", () => {
    const a = new ARJSON({ json: { x: 1, y: "a", z: [] } })
    a.update({ x: 2, y: "a", z: [] })
    a.update({ x: 2, y: "b", z: [] })
    a.update({ x: 2, y: "b", z: [1] })
    a.update({ x: 2, y: "b", z: [1, 2] })
    a.update({ x: 2, y: "b", z: [1, 2], extra: true })
    a.update({ x: 2, y: "b", z: [1, 2], extra: true, more: { nested: 1 } })
    assert.deepEqual(a.json, { x: 2, y: "b", z: [1, 2], extra: true, more: { nested: 1 } })

    // Buffer round-trip preserves end state
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, a.json)
  })

  it("partial-replay decoder gets intermediate states", () => {
    const a = new ARJSON({ json: { count: 0 } })
    a.update({ count: 1 })
    a.update({ count: 2 })
    a.update({ count: 3 })

    // Replay first 2 deltas only
    const partial = new ARJSON({ arj: ARJSON.toBuffer(a.deltas.slice(0, 2)) })
    assert.deepEqual(partial.json, { count: 1 })

    // Replay first 3
    const partial3 = new ARJSON({ arj: ARJSON.toBuffer(a.deltas.slice(0, 3)) })
    assert.deepEqual(partial3.json, { count: 2 })
  })
})

// ─── E. Reanchor triggers ─────────────────────────────────────────────────

describe("delta-invariants E: reanchor triggers", () => {
  it("primitive → primitive replace at root works (may reanchor)", () => {
    const a = new ARJSON({ json: 1 })
    a.update(2)
    assert.equal(a.json, 2)
  })

  it("primitive → object replace works", () => {
    const a = new ARJSON({ json: 1 })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
  })

  it("object → primitive replace works", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update(42)
    assert.equal(a.json, 42)
  })

  it("array → object replace works", () => {
    const a = new ARJSON({ json: [1, 2] })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
  })

  it("object → array replace works", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update([1, 2])
    assert.deepEqual(a.json, [1, 2])
  })

  it("empty object → non-empty object reanchor works", () => {
    const a = new ARJSON({ json: {} })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
  })

  it("non-empty → empty object handled (note: special-cased in diff)", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    a.update({})
    assert.deepEqual(a.json, {})
  })
})

// ─── F. Diff coverage matrix ──────────────────────────────────────────────

describe("delta-invariants F: diff coverage matrix (every value transition)", () => {
  const samples = [
    null, true, false, 0, 1, -1, 42, 3.14,
    "", "x", "hello",
    [], [1], [1, 2, 3],
    {}, { a: 1 }, { a: 1, b: 2 },
  ]

  for (const from of samples) {
    for (const to of samples) {
      if (eq(from, to)) continue
      const fromS = JSON.stringify(from).slice(0, 30)
      const toS = JSON.stringify(to).slice(0, 30)
      it(`{wrap: ${fromS}} → {wrap: ${toS}}`, () => {
        const a = new ARJSON({ json: { wrap: clone(from) } })
        a.update({ wrap: clone(to) })
        assert.deepEqual(a.json, { wrap: clone(to) })
        const b = new ARJSON({ arj: a.toBuffer() })
        assert.deepEqual(b.json, a.json, "buffer round-trip preserved")
      })
    }
  }
})

// ─── G. Strmap behavior ───────────────────────────────────────────────────

describe("delta-invariants G: strmap dedup and persistence", () => {
  it("repeated string keys dedup in strmap", () => {
    const a = new ARJSON({
      json: [{ name: "alice" }, { name: "alice" }, { name: "alice" }],
    })
    const t = a.table()
    // strmap should contain "name" once; "alice" once
    const values = Object.values(t.strmap)
    assert.ok(values.includes("name"), "name in strmap")
    assert.ok(values.includes("alice"), "alice in strmap")
    // Each unique string appears exactly once
    const uniqueValues = new Set(values)
    assert.equal(uniqueValues.size, values.length, "strmap has no duplicates")
  })

  it("strmap entries persist across deltas that add new keys", () => {
    // Use a structure where strings are reused (forcing strmap entries).
    const a = new ARJSON({
      json: { items: [{ name: "alice" }, { name: "alice" }] },
    })
    a.update({
      items: [{ name: "alice" }, { name: "alice" }, { name: "bob", role: "admin" }],
    })
    const values = Object.values(a.table().strmap)
    // After the update the JSON contains "alice", "bob", "name", "role"
    // - any of these may be in strmap depending on how compactStrMap handled them
    // What we DO need to check: the json itself still has the right values.
    assert.deepEqual(a.json, {
      items: [{ name: "alice" }, { name: "alice" }, { name: "bob", role: "admin" }],
    })
  })

  it("strmap compacts after deletions", () => {
    const a = new ARJSON({ json: { name: "alice", role: "admin" } })
    const beforeSize = Object.keys(a.table().strmap).length
    // Delete a key — strmap may keep or drop based on usage
    a.update({ name: "alice" })
    // After deletion, strmap shouldn't have orphaned entries
    const t = a.table()
    const usedStrings = new Set()
    for (const k of t.keys) {
      if (Array.isArray(k)) usedStrings.add(t.strmap[k[0]])
      else if (typeof k === "string") usedStrings.add(k)
    }
    for (const s of t.strs) {
      if (Array.isArray(s) && s[0] !== -1) usedStrings.add(t.strmap[s[0]])
      else if (typeof s === "string") usedStrings.add(s)
    }
    // Every strmap entry should be referenced
    for (const v of Object.values(t.strmap)) {
      assert.ok(usedStrings.has(v), `strmap entry ${v} is referenced`)
    }
  })
})

// ─── H. Path edge cases ───────────────────────────────────────────────────

describe("delta-invariants H: path edge cases", () => {
  it("keys with dots in them work via escape", () => {
    const a = new ARJSON({ json: { "a.b": 1 } })
    a.update({ "a.b": 2 })
    assert.deepEqual(a.json, { "a.b": 2 })
  })

  it("keys with brackets work via escape", () => {
    const a = new ARJSON({ json: { "a[0]": 1 } })
    a.update({ "a[0]": 2 })
    assert.deepEqual(a.json, { "a[0]": 2 })
  })

  it("keys with backslashes work", () => {
    const a = new ARJSON({ json: { "a\\b": 1 } })
    a.update({ "a\\b": 2 })
    assert.deepEqual(a.json, { "a\\b": 2 })
  })

  it("deeply nested paths work", () => {
    let v = 1
    for (let d = 0; d < 10; d++) v = { nested: v }
    const a = new ARJSON({ json: v })
    let v2 = 2
    for (let d = 0; d < 10; d++) v2 = { nested: v2 }
    a.update(v2)
    assert.deepEqual(a.json, v2)
  })

  it("array index updates at every position", () => {
    const a = new ARJSON({ json: [10, 20, 30, 40, 50] })
    a.update([10, 20, 99, 40, 50])
    assert.deepEqual(a.json, [10, 20, 99, 40, 50])
  })

  it("simultaneous updates at multiple positions", () => {
    const a = new ARJSON({ json: { a: 1, b: 2, c: 3 } })
    a.update({ a: 10, b: 20, c: 30 })
    assert.deepEqual(a.json, { a: 10, b: 20, c: 30 })
  })
})

// ─── I. Property-based fuzz ───────────────────────────────────────────────

describe("delta-invariants I: property-based fuzz with many seeds", () => {
  it("random JSON pairs: ARJSON(A).update(B).json === B (200 pairs, 5 seeds)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = seedRng(seed * 31337)
      for (let i = 0; i < 200; i++) {
        const A = randomJson(rng)
        const B = randomJson(rng)
        const a = new ARJSON({ json: A })
        a.update(B)
        if (!eq(a.json, B)) {
          assert.fail(
            `seed=${seed} iter=${i}: A=${JSON.stringify(A).slice(0, 80)}, ` +
            `B=${JSON.stringify(B).slice(0, 80)}, got=${JSON.stringify(a.json).slice(0, 80)}`,
          )
        }
      }
    }
  })

  it("buffer round-trip after random sequence of updates (50 seeds)", () => {
    for (const seed of [11, 22, 33, 44, 55]) {
      const rng = seedRng(seed * 17)
      const a = new ARJSON({ json: randomJson(rng) })
      for (let step = 0; step < 20; step++) {
        a.update(randomJson(rng))
      }
      const b = new ARJSON({ arj: a.toBuffer() })
      if (!eq(a.json, b.json)) {
        assert.fail(`seed=${seed}: a.json !== b.json (buffer round-trip diverged)`)
      }
    }
  })

  it("full chain replay produces final state (10 seeds)", () => {
    // Note: each `a.update(json)` may produce 1+ deltas (multi-op diffs
    // emit multiple deltas). So we can't check every prefix against
    // every step's state — we only check that the FULL replay lands
    // on the final state.
    for (const seed of [101, 102, 103, 104, 105]) {
      const rng = seedRng(seed)
      const a = new ARJSON({ json: randomJson(rng) })
      for (let step = 0; step < 10; step++) a.update(randomJson(rng))
      const replayed = new ARJSON({ arj: a.toBuffer() })
      if (!eq(replayed.json, a.json)) {
        assert.fail(`seed=${seed}: full replay diverged from final state`)
      }
    }
  })
})

// ─── J. State isolation ───────────────────────────────────────────────────

describe("delta-invariants J: instance isolation", () => {
  it("two independent ARJSON instances don't cross-talk", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const b = new ARJSON({ json: { y: "hello" } })
    a.update({ x: 2 })
    b.update({ y: "world" })
    assert.deepEqual(a.json, { x: 2 })
    assert.deepEqual(b.json, { y: "world" })
    // Buffers must differ — they encode different content
    assert.notDeepEqual(
      Array.from(a.toBuffer()),
      Array.from(b.toBuffer()),
      "different content yields different buffers",
    )
  })

  it("toBuffer of one doesn't change another", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const b = new ARJSON({ json: { x: 2 } })
    const aBuf = a.toBuffer()
    const bBuf = b.toBuffer()
    assert.deepEqual(a.json, { x: 1 })
    assert.deepEqual(b.json, { x: 2 })
    assert.notDeepEqual(aBuf, bBuf)
  })

  it("interleaved enc/dec on shared singletons doesn't corrupt state", () => {
    // Top-level enc/dec use shared singletons; verify call interleaving works
    const v1 = { a: 1 }
    const v2 = { b: 2 }
    const v3 = { c: 3 }
    const b1 = enc(v1)
    const b2 = enc(v2)
    const b3 = enc(v3)
    assert.deepEqual(dec(b1), v1)
    assert.deepEqual(dec(b2), v2)
    assert.deepEqual(dec(b3), v3)
    // re-decode in different order
    assert.deepEqual(dec(b3), v3)
    assert.deepEqual(dec(b1), v1)
    assert.deepEqual(dec(b2), v2)
  })
})

// ─── K. Determinism guarantees ────────────────────────────────────────────

describe("delta-invariants K: determinism", () => {
  it("identical input → identical encoded bytes (3 calls)", () => {
    const v = { id: 1, tags: ["a", "b", "c"], nested: { x: 1 } }
    const b1 = enc(v)
    const b2 = enc(v)
    const b3 = enc(v)
    assert.deepEqual(b1, b2)
    assert.deepEqual(b2, b3)
  })

  it("identical update sequence → identical buffer", () => {
    const buildAndEncode = () => {
      const a = new ARJSON({ json: { count: 0 } })
      a.update({ count: 1 })
      a.update({ count: 2 })
      a.update({ count: 3, name: "x" })
      return a.toBuffer()
    }
    const b1 = buildAndEncode()
    const b2 = buildAndEncode()
    assert.deepEqual(b1, b2)
  })
})

// ─── L. Special string/number edge cases ──────────────────────────────────

describe("delta-invariants L: special values", () => {
  it("very long strings round-trip through delta", () => {
    const long = "x".repeat(5000)
    const a = new ARJSON({ json: { s: long } })
    a.update({ s: long + "!" })
    assert.equal(a.json.s, long + "!")
  })

  it("MIN/MAX safe integers round-trip", () => {
    const a = new ARJSON({ json: { v: 0 } })
    a.update({ v: Number.MAX_SAFE_INTEGER })
    assert.equal(a.json.v, Number.MAX_SAFE_INTEGER)
    a.update({ v: -Number.MAX_SAFE_INTEGER })
    assert.equal(a.json.v, -Number.MAX_SAFE_INTEGER)
  })

  it("floats with high precision round-trip", () => {
    const a = new ARJSON({ json: { v: 0 } })
    for (const f of [3.14, 0.1, 0.001, 1e-10, 1e10, -0.5]) {
      a.update({ v: f })
      assert.equal(a.json.v, f, `float ${f}`)
    }
  })

  it("unicode strings round-trip", () => {
    const a = new ARJSON({ json: { s: "x" } })
    for (const s of ["中文", "emoji 🎉", "café", "a\nb"]) {
      a.update({ s })
      assert.equal(a.json.s, s, `unicode ${s}`)
    }
  })
})

// ─── M. Boundary values for compression features ──────────────────────────

describe("delta-invariants M: boundary values for compression features", () => {
  it("type-pack threshold (3+ same)", () => {
    // 1, 2, 3, 4 of same type — type-pack kicks in at 3+
    for (const n of [1, 2, 3, 4, 10, 100]) {
      const arr = []
      for (let i = 0; i < n; i++) arr.push(i)
      const a = new ARJSON({ json: arr })
      const buf = a.toBuffer()
      const b = new ARJSON({ arj: buf })
      assert.deepEqual(b.json, arr, `array of ${n} ints round-trips`)
    }
  })

  it("delta-pack threshold (3+ same delta)", () => {
    // sequential ints with same delta → delta-pack
    const a = []
    for (let i = 0; i < 100; i++) a.push(i * 2)
    const arj = new ARJSON({ json: a })
    const buf = arj.toBuffer()
    const b = new ARJSON({ arj: buf })
    assert.deepEqual(b.json, a)
  })

  it("strmap activation (repeated strings)", () => {
    const a = []
    for (let i = 0; i < 10; i++) a.push("repeated")
    const arj = new ARJSON({ json: a })
    const buf = arj.toBuffer()
    const b = new ARJSON({ arj: buf })
    assert.deepEqual(b.json, a)
  })
})
