// Public API surface tests.
//
// Pins down the observable behavior of every exported function, class,
// constructor mode, and method. An optimization that silently changes
// any of these contracts fails here.

import { describe, it } from "node:test"
import assert from "assert"
import {
  Encoder,
  encode,
  Decoder,
  Builder,
  ARJSON,
  ARTable,
  enc,
  dec,
  _encode,
} from "../src/index.js"

// ─── module exports ────────────────────────────────────────────────────────

describe("module exports", () => {
  it("exports Encoder, Decoder, Builder, ARJSON, ARTable as functions", () => {
    assert.equal(typeof Encoder, "function")
    assert.equal(typeof Decoder, "function")
    assert.equal(typeof Builder, "function")
    assert.equal(typeof ARJSON, "function")
    assert.equal(typeof ARTable, "function")
  })
  it("exports encode, _encode, enc, dec as functions", () => {
    assert.equal(typeof encode, "function")
    assert.equal(typeof _encode, "function")
    assert.equal(typeof enc, "function")
    assert.equal(typeof dec, "function")
  })
})

// ─── enc(json) ─────────────────────────────────────────────────────────────

describe("enc(json) — top-level convenience encoder", () => {
  it("returns a Uint8Array (or compatible)", () => {
    const r = enc({ a: 1 })
    assert.ok(r instanceof Uint8Array || r.length !== undefined)
  })
  it("returns a 1-byte buffer for null", () => {
    assert.equal(enc(null).length, 1)
  })
  it("returns a non-zero buffer for undefined (non-spec, treated as structured)", () => {
    assert.ok(enc(undefined).length > 0)
  })
  it("non-mutating: enc(x) doesn't change x", () => {
    const x = { a: 1, b: [1, 2] }
    const snapshot = JSON.stringify(x)
    enc(x)
    assert.equal(JSON.stringify(x), snapshot)
  })
  it("safe to call repeatedly with the same input", () => {
    const x = { hello: "world" }
    const a = enc(x)
    const b = enc(x)
    assert.deepEqual(Array.from(a), Array.from(b))
  })
})

// ─── dec(buffer) ───────────────────────────────────────────────────────────

describe("dec(buffer) — top-level convenience decoder", () => {
  it("accepts Uint8Array", () => {
    const buf = new Uint8Array(enc({ a: 1 }))
    assert.deepEqual(dec(buf), { a: 1 })
  })
  it("accepts Buffer", () => {
    const buf = Buffer.from(enc({ a: 1 }))
    assert.deepEqual(dec(buf), { a: 1 })
  })
  it("accepts a sub-buffer view", () => {
    const orig = enc({ a: 1 })
    const view = new Uint8Array(orig.buffer, orig.byteOffset, orig.byteLength)
    assert.deepEqual(dec(view), { a: 1 })
  })
  it("returns the same value across multiple decode calls (no shared mutation)", () => {
    const buf = enc({ a: [1, 2, 3] })
    const a = dec(buf)
    const b = dec(buf)
    a.a.push(99)
    assert.deepEqual(b.a, [1, 2, 3])
  })
})

// ─── ARJSON constructor ────────────────────────────────────────────────────

describe("ARJSON({json: x})", () => {
  it("sets .json to the input", () => {
    const x = { a: 1 }
    const a = new ARJSON({ json: x })
    assert.deepEqual(a.json, x)
  })
  it("normalizes JSON-spec coercions", () => {
    const a = new ARJSON({ json: { x: NaN } })
    assert.deepEqual(a.json, { x: NaN })
    // NaN is preserved in .json (live state) but coerced on encode
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, { x: null })
  })
  it("creates a 1-element deltas array", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.equal(a.deltas.length, 1)
  })
  it("primitive root values work", () => {
    for (const v of [null, true, 42, "hello", []]) {
      const a = new ARJSON({ json: v })
      assert.deepEqual(a.json, v)
    }
  })
})

describe("ARJSON({arj: buffer})", () => {
  it("reconstructs from a single-document buffer", () => {
    const x = { a: 1, b: [1, 2] }
    const orig = new ARJSON({ json: x })
    const round = new ARJSON({ arj: orig.toBuffer() })
    assert.deepEqual(round.json, x)
  })
  it("reconstructs from a delta-chain buffer", () => {
    const a = new ARJSON({ json: { x: 0 } })
    a.update({ x: 1 })
    a.update({ x: 1, y: 2 })
    const round = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(round.json, { x: 1, y: 2 })
  })
  it("works for primitive root values", () => {
    for (const v of [null, true, 42, "hello", [], {}]) {
      const a = new ARJSON({ json: v })
      const r = new ARJSON({ arj: a.toBuffer() })
      assert.deepEqual(r.json, v)
    }
  })
  it("populated deltas array matches what was written", () => {
    const a = new ARJSON({ json: { x: 0 } })
    a.update({ x: 1 })
    a.update({ x: 2 })
    const r = new ARJSON({ arj: a.toBuffer() })
    assert.equal(r.deltas.length, a.deltas.length)
  })
})

describe("ARJSON({table: artable_table})", () => {
  it("reconstructs from an artable.table()", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    const r = new ARJSON({ table: a.artable.table() })
    assert.deepEqual(r.json, { x: 1, y: 2 })
  })
  it("primitive root values survive table reconstruction", () => {
    for (const v of [null, true, 42, "hello", [], {}]) {
      const a = new ARJSON({ json: v })
      const r = new ARJSON({ table: a.artable.table() })
      assert.deepEqual(r.json, v)
    }
  })
  it("table-reconstructed instance can be updated", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const b = new ARJSON({ table: a.artable.table() })
    b.update({ x: 2 })
    assert.deepEqual(b.json, { x: 2 })
  })
})

// ─── ARJSON instance methods ───────────────────────────────────────────────

describe("ARJSON.update(json)", () => {
  it("updates .json to the new value", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2, y: 3 })
    assert.deepEqual(a.json, { x: 2, y: 3 })
  })
  it("returns an array of delta buffers", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const r = a.update({ x: 2 })
    assert.ok(Array.isArray(r))
    assert.ok(r.length > 0)
  })
  it("appends to .deltas (or replaces if reanchor)", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const before = a.deltas.length
    a.update({ x: 2 })
    assert.ok(a.deltas.length >= before)
  })
  it("update(x, x) is idempotent", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    a.update({ x: 1, y: 2 })
    assert.deepEqual(a.json, { x: 1, y: 2 })
  })
  it("does not mutate the input json", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const target = { x: 2, y: [1, 2] }
    const snapshot = JSON.stringify(target)
    a.update(target)
    assert.equal(JSON.stringify(target), snapshot)
  })
  it("update from primitive to structured re-anchors", () => {
    const a = new ARJSON({ json: null })
    a.update({ x: 1 })
    assert.deepEqual(a.json, { x: 1 })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { x: 1 })
  })
  it("update from structured to primitive works", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update(null)
    assert.equal(a.json, null)
  })
})

describe("ARJSON.toBuffer()", () => {
  it("returns a Buffer", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.ok(Buffer.isBuffer(a.toBuffer()))
  })
  it("is byte-identical across calls when state hasn't changed", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const b1 = a.toBuffer()
    const b2 = a.toBuffer()
    assert.deepEqual(Array.from(b1), Array.from(b2))
  })
  it("changes after update", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const b1 = a.toBuffer()
    a.update({ x: 2 })
    const b2 = a.toBuffer()
    assert.notDeepEqual(Array.from(b1), Array.from(b2))
  })
  it("buffer round-trips through fromBuffer", () => {
    const a = new ARJSON({ json: { x: 1, y: [1, 2] } })
    a.update({ x: 2, y: [1, 2, 3] })
    const buf = a.toBuffer()
    const deltas = ARJSON.fromBuffer(buf)
    assert.deepEqual(deltas.length, a.deltas.length)
  })
})

describe("ARJSON.table()", () => {
  it("returns the artable's table", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const t = a.table()
    assert.ok(t.vrefs)
    assert.ok(t.krefs)
    assert.ok(t.keys)
  })
  it("table is reconstructible into an equivalent ARJSON", () => {
    const a = new ARJSON({ json: { x: 1, y: 2 } })
    const b = new ARJSON({ table: a.table() })
    assert.deepEqual(b.json, a.json)
  })
})

describe("ARJSON static methods", () => {
  it("ARJSON.toBuffer(deltas) packs an array of Uint8Arrays", () => {
    const ds = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
    const buf = ARJSON.toBuffer(ds)
    assert.ok(Buffer.isBuffer(buf) || buf instanceof Uint8Array)
    assert.ok(buf.length >= 5) // at least the data, plus length prefixes
  })
  it("ARJSON.fromBuffer(buf) is the inverse of ARJSON.toBuffer(deltas)", () => {
    const ds = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
      new Uint8Array([5, 6, 7, 8, 9]),
    ]
    const r = ARJSON.fromBuffer(ARJSON.toBuffer(ds))
    assert.equal(r.length, ds.length)
    for (let i = 0; i < ds.length; i++) {
      assert.deepEqual(Array.from(r[i]), Array.from(ds[i]))
    }
  })
  it("toBuffer/fromBuffer handles delta of length > 127", () => {
    const big = new Uint8Array(200)
    for (let i = 0; i < 200; i++) big[i] = i & 0xff
    const buf = ARJSON.toBuffer([big])
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r.length, 1)
    assert.equal(r[0].length, 200)
  })
  it("toBuffer/fromBuffer handles empty list", () => {
    assert.deepEqual(ARJSON.fromBuffer(ARJSON.toBuffer([])), [])
  })
})

// ─── encode / decode (low-level) ───────────────────────────────────────────

describe("encode(v, encoder) — low-level encoder API", () => {
  it("works with a fresh Encoder", () => {
    const u = new Encoder()
    const buf = encode({ a: 1 }, u)
    assert.ok(buf.length > 0)
  })
  it("Encoder is reusable across multiple calls", () => {
    const u = new Encoder()
    for (const v of [{ a: 1 }, [1, 2], "x", null, 42]) {
      const buf = encode(v, u)
      const d = new Decoder()
      d.decode(buf)
      assert.deepEqual(d.json, v)
    }
  })
})

describe("Decoder", () => {
  it("decode populates .json", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    assert.deepEqual(d.json, { a: 1 })
  })
  it("decode populates .single for primitives", () => {
    const d = new Decoder()
    d.decode(enc(null))
    assert.equal(d.single, true)
  })
  it("decode populates .single = false for structures", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    assert.equal(d.single, false)
  })
  it("Decoder.table() returns column data", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    const t = d.table()
    assert.ok(t.vrefs)
    assert.ok(t.keys)
  })
})

describe("Builder.build()", () => {
  it("reconstructs JSON from a decoder's table", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    const b = new Builder(d.table())
    assert.deepEqual(b.build(), { a: 1 })
  })
})

describe("ARTable", () => {
  it("constructs from a decoder's table", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    const t = new ARTable(d.table())
    assert.ok(t.table())
  })
  it("table().build() reconstructs JSON", () => {
    const d = new Decoder()
    d.decode(enc({ a: 1 }))
    const t = new ARTable(d.table())
    assert.deepEqual(t.build(), { a: 1 })
  })
  it("delta() generates a delta buffer for an op", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const r = a.artable.delta("x", 2, "replace", 1, null)
    assert.ok(r)
    assert.ok(r.delta)
  })
})

// ─── invariant: encoder round-trip from any source ────────────────────────

describe("encoder/decoder round-trip from every entry point", () => {
  const cases = [null, true, false, 0, 1, -1, "hello", 3.14, [1, 2, 3], { a: 1 }]
  for (const v of cases) {
    it(`enc/dec(${JSON.stringify(v)}) round-trips`, () => {
      assert.deepEqual(dec(enc(v)), v)
    })
    it(`encode(v, new Encoder()) + Decoder.decode round-trips for ${JSON.stringify(v)}`, () => {
      const u = new Encoder()
      const buf = encode(v, u)
      const d = new Decoder()
      d.decode(buf)
      assert.deepEqual(d.json, v)
    })
    it(`new ARJSON({json: x}).json === x for ${JSON.stringify(v)}`, () => {
      assert.deepEqual(new ARJSON({ json: v }).json, v)
    })
    it(`new ARJSON({arj: a.toBuffer()}).json === x for ${JSON.stringify(v)}`, () => {
      const a = new ARJSON({ json: v })
      assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, v)
    })
    it(`new ARJSON({table: a.table()}).json === x for ${JSON.stringify(v)}`, () => {
      const a = new ARJSON({ json: v })
      assert.deepEqual(new ARJSON({ table: a.table() }).json, v)
    })
  }
})
