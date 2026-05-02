// Interface lock — pins down the public API surface so refactors
// cannot inadvertently change shape, signature, or contract.
//
// These tests are NOT about correctness of values; they're about the
// SHAPES of what's exported, what methods exist, what they accept, and
// what they return. If a refactor breaks any of these, the public API
// has changed and external consumers will break.

import { describe, it } from "node:test"
import assert from "assert"
import * as arjson from "../src/arjson.js"
import { ARJSON, enc, dec } from "../src/arjson.js"
import { Encoder, encode } from "../src/encoder.js"
import { Decoder } from "../src/decoder.js"
import { ARTable } from "../src/artable.js"
import { Builder, getVal } from "../src/builder.js"

// ─── module exports ───────────────────────────────────────────────────────

describe("interface lock: arjson.js module exports", () => {
  it("ARJSON, enc, dec are all defined and the right kind", () => {
    assert.equal(typeof ARJSON, "function", "ARJSON is a class/constructor")
    assert.equal(typeof enc, "function", "enc is a function")
    assert.equal(typeof dec, "function", "dec is a function")
  })

  it("ARJSON has expected static methods", () => {
    assert.equal(typeof ARJSON.fromBuffer, "function")
    assert.equal(typeof ARJSON.toBuffer, "function")
  })

  it("ARJSON instance has expected methods", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.equal(typeof a.update, "function")
    assert.equal(typeof a.reanchor, "function")
    assert.equal(typeof a.load, "function")
    assert.equal(typeof a.toBuffer, "function")
    assert.equal(typeof a.table, "function")
  })

  it("ARJSON instance exposes expected fields", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.ok("json" in a, "json field exposed")
    assert.ok("deltas" in a, "deltas field exposed")
    assert.ok("artable" in a, "artable field exposed")
    assert.ok(Array.isArray(a.deltas), "deltas is an array")
  })
})

describe("interface lock: encoder/decoder/artable/builder exports", () => {
  it("Encoder/Decoder/ARTable/Builder are constructors", () => {
    assert.equal(typeof Encoder, "function")
    assert.equal(typeof Decoder, "function")
    assert.equal(typeof ARTable, "function")
    assert.equal(typeof Builder, "function")
  })

  it("encode is a top-level function", () => {
    assert.equal(typeof encode, "function")
  })

  it("getVal is exported from builder", () => {
    assert.equal(typeof getVal, "function")
  })
})

// ─── ARJSON constructor modes ─────────────────────────────────────────────

describe("interface lock: ARJSON constructor — mode {json}", () => {
  it("accepts plain JSON value", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.deepEqual(a.json, { x: 1 })
    assert.equal(a.deltas.length, 1, "one delta after fresh construction")
    assert.ok(a.deltas[0] instanceof Uint8Array, "delta is Uint8Array")
  })

  it("accepts primitive json", () => {
    for (const v of [null, true, false, 0, 1, -1, "x", ""]) {
      const a = new ARJSON({ json: v })
      assert.deepEqual(a.json, v, `value ${JSON.stringify(v)}`)
    }
  })

  it("accepts arrays and objects", () => {
    for (const v of [[], {}, [1, 2, 3], { a: { b: { c: 1 } } }]) {
      const a = new ARJSON({ json: v })
      assert.deepEqual(a.json, v)
    }
  })
})

describe("interface lock: ARJSON constructor — mode {arj}", () => {
  it("accepts buffer from toBuffer()", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2] } })
    a.update({ x: 2, y: [1, 2] })
    a.update({ x: 2, y: [1, 2, 3] })
    const buf = a.toBuffer()
    const b = new ARJSON({ arj: buf })
    assert.deepEqual(b.json, a.json)
    assert.equal(b.deltas.length, a.deltas.length)
  })

  it("works with single-mode buffers", () => {
    for (const v of [null, true, "hello", 42]) {
      const buf = new ARJSON({ json: v }).toBuffer()
      const b = new ARJSON({ arj: buf })
      assert.deepEqual(b.json, v)
    }
  })
})

describe("interface lock: ARJSON constructor — mode {table}", () => {
  it("accepts table from another instance", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const t = a.table()
    const b = new ARJSON({ table: t })
    assert.deepEqual(b.json, a.json)
  })
})

// ─── ARJSON.update() return type ──────────────────────────────────────────

describe("interface lock: update() return value", () => {
  it("returns an array (of buffer deltas or fresh re-encode)", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const r = a.update({ x: 2 })
    assert.ok(Array.isArray(r), "returns array")
    assert.ok(r.length >= 1, "non-empty")
    for (const item of r) {
      assert.ok(item instanceof Uint8Array, "items are Uint8Array")
    }
  })

  it("update mutates this.json to new value", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    assert.deepEqual(a.json, { x: 2 })
  })

  it("update appends to this.deltas (or re-anchors)", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const before = a.deltas.length
    a.update({ x: 2 })
    assert.ok(a.deltas.length >= before, "deltas grew or stayed")
  })

  it("update with same value is a no-op for json", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
  })
})

// ─── ARJSON.toBuffer() / fromBuffer() invariants ──────────────────────────

describe("interface lock: toBuffer / fromBuffer round-trip", () => {
  it("toBuffer returns a Buffer (Uint8Array subclass)", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const buf = a.toBuffer()
    assert.ok(buf instanceof Uint8Array, "Uint8Array compatible")
  })

  it("fromBuffer returns an array of Uint8Array deltas", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    a.update({ x: 3 })
    const buf = a.toBuffer()
    const deltas = ARJSON.fromBuffer(buf)
    assert.ok(Array.isArray(deltas), "returns array")
    assert.equal(deltas.length, a.deltas.length)
    for (const d of deltas) assert.ok(d instanceof Uint8Array)
  })

  it("fromBuffer is inverse of toBuffer for any chain", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2, y: "added" })
    a.update({ x: 3, y: "added" })
    const buf = a.toBuffer()
    const restored = new ARJSON({ arj: buf })
    assert.deepEqual(restored.json, a.json)
    assert.equal(restored.deltas.length, a.deltas.length)
  })
})

// ─── ARJSON.table() shape ─────────────────────────────────────────────────

describe("interface lock: table() shape", () => {
  it("returns object with expected fields", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2] } })
    const t = a.table()
    const expectedFields = [
      "vrefs", "krefs", "ktypes", "keys", "vtypes", "bools", "nums",
      "strs", "strmap", "strdiffs",
    ]
    for (const f of expectedFields) {
      assert.ok(f in t, `${f} field present`)
    }
  })

  it("vrefs / krefs / vtypes / nums / bools / strs are arrays", () => {
    const a = new ARJSON({ json: { x: 1, y: true, z: "s" } })
    const t = a.table()
    for (const f of ["vrefs", "krefs", "vtypes", "ktypes", "keys", "nums", "bools", "strs", "strdiffs"]) {
      assert.ok(Array.isArray(t[f]), `${f} is array`)
    }
  })

  it("strmap is a plain object (numeric-keyed)", () => {
    const a = new ARJSON({ json: { username: "alice", role: "admin" } })
    a.update({ username: "alice", role: "admin", x: 1 })
    const t = a.table()
    assert.equal(typeof t.strmap, "object")
    // Strmap keys are stringified non-negative integers
    for (const k in t.strmap) {
      assert.ok(/^\d+$/.test(k), `strmap key ${k} is numeric string`)
    }
  })
})

// ─── enc/dec invariants ───────────────────────────────────────────────────

describe("interface lock: enc/dec invariants", () => {
  it("enc accepts any JSON value", () => {
    for (const v of [null, true, false, 0, "x", [], {}, [1], { a: 1 }]) {
      const buf = enc(v)
      assert.ok(buf instanceof Uint8Array)
      assert.ok(buf.length >= 1)
    }
  })

  it("dec(enc(v)) is structurally equal to v for non-special values", () => {
    const cases = [
      null, true, false, 0, 1, -1, 42, "", "x", "hello",
      [], [1, 2, 3], { a: 1 }, { a: { b: [1, 2] } },
    ]
    for (const v of cases) {
      assert.deepEqual(dec(enc(v)), v, `round-trip ${JSON.stringify(v)}`)
    }
  })

  it("enc is deterministic — same input always produces same bytes", () => {
    const v = { id: 1, name: "Alice", tags: ["a", "b"] }
    const a = enc(v)
    const b = enc(v)
    const c = enc(v)
    assert.deepEqual(a, b)
    assert.deepEqual(b, c)
  })
})

// ─── ARTable interface ────────────────────────────────────────────────────

describe("interface lock: ARTable", () => {
  it("ARTable has expected methods", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const t = a.artable
    assert.equal(typeof t.compact, "function")
    assert.equal(typeof t.compactKeys, "function")
    assert.equal(typeof t.compactStrMap, "function")
    assert.equal(typeof t.buildMap, "function")
    assert.equal(typeof t.delta, "function")
    assert.equal(typeof t.encode, "function")
    assert.equal(typeof t.update, "function")
    assert.equal(typeof t.build, "function")
    assert.equal(typeof t.table, "function")
    assert.equal(typeof t.getPath, "function")
    assert.equal(typeof t.getIndex, "function")
  })

  it("ARTable.delta returns { delta, strmap }", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const r = a.artable.delta("x", 2, "replace", 1, null)
    assert.ok(r !== null)
    assert.ok("delta" in r)
    assert.ok(r.delta instanceof Uint8Array)
  })
})
