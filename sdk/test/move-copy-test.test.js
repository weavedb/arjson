// Tests for the explicit move/copy/test ops + json() factory.
//
// These add a JSON Patch RFC 6902-aligned API surface to ARJSON.
// The wire format encoding for move/copy is currently a translation
// to the existing remove+add primitives; a future v2 wire format
// would encode them as single ops without re-emitting value bytes.

import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON, json } from "../src/arjson.js"

// ─── arj.move(from, to) ───────────────────────────────────────────────────

describe("ARJSON.move", () => {
  it("renames an object key, value preserved", () => {
    const a = new ARJSON({ json: { oldName: 42 } })
    a.move("oldName", "newName")
    assert.deepEqual(a.json, { newName: 42 })
  })

  it("renames a deeply nested object key", () => {
    const a = new ARJSON({ json: { user: { profile: { fullName: "Alice" } } } })
    a.move("user.profile.fullName", "user.profile.name")
    assert.deepEqual(a.json, { user: { profile: { name: "Alice" } } })
  })

  it("moves a value from one container to another", () => {
    const a = new ARJSON({ json: { src: { value: 1 }, dst: {} } })
    a.move("src.value", "dst.value")
    assert.deepEqual(a.json, { src: {}, dst: { value: 1 } })
  })

  it("buffer round-trips after a move", () => {
    const a = new ARJSON({ json: { x: { a: 1, b: 2 }, y: {} } })
    a.move("x.b", "y.moved")
    const restored = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(restored.json, a.json)
  })

  it("throws when the from path doesn't exist", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.throws(() => a.move("nonexistent", "target"))
  })
})

// ─── arj.copy(from, to) ───────────────────────────────────────────────────

describe("ARJSON.copy", () => {
  it("duplicates a value at a new path", () => {
    const a = new ARJSON({ json: { src: 42 } })
    a.copy("src", "dst")
    assert.deepEqual(a.json, { src: 42, dst: 42 })
  })

  it("copies a complex value (object)", () => {
    const a = new ARJSON({ json: { template: { name: "default", level: 1 } } })
    a.copy("template", "instance")
    assert.deepEqual(a.json, {
      template: { name: "default", level: 1 },
      instance: { name: "default", level: 1 },
    })
  })

  it("buffer round-trips after a copy", () => {
    const a = new ARJSON({ json: { config: { debug: true } } })
    a.copy("config", "config_backup")
    const restored = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(restored.json, a.json)
  })

  it("throws when the from path doesn't exist", () => {
    const a = new ARJSON({ json: { x: 1 } })
    assert.throws(() => a.copy("nonexistent", "target"))
  })
})

// ─── arj.test(path, expected) ─────────────────────────────────────────────

describe("ARJSON.test", () => {
  it("passes when value matches", () => {
    const a = new ARJSON({ json: { user: { role: "admin" } } })
    assert.equal(a.test("user.role", "admin"), true)
  })

  it("throws when value does not match", () => {
    const a = new ARJSON({ json: { user: { role: "admin" } } })
    assert.throws(() => a.test("user.role", "guest"))
  })

  it("works for primitive values", () => {
    const a = new ARJSON({ json: { count: 42 } })
    assert.equal(a.test("count", 42), true)
    assert.throws(() => a.test("count", 43))
  })

  it("works for object values via deep equality", () => {
    const a = new ARJSON({ json: { config: { a: 1, b: 2 } } })
    assert.equal(a.test("config", { a: 1, b: 2 }), true)
    assert.throws(() => a.test("config", { a: 1, b: 3 }))
  })

  it("does NOT mutate state or append to the chain", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const beforeDeltas = a.deltas.length
    a.test("x", 1)
    assert.equal(a.deltas.length, beforeDeltas, "test does not append delta")
    assert.deepEqual(a.json, { x: 1 }, "test does not mutate")
  })

  it("can be used as an optimistic-concurrency precondition", () => {
    const a = new ARJSON({ json: { user: { role: "admin", count: 0 } } })
    a.test("user.role", "admin")
    a.update({ user: { role: "admin", count: 1 } })
    assert.deepEqual(a.json, { user: { role: "admin", count: 1 } })
  })
})

// ─── json() factory function ──────────────────────────────────────────────

describe("json() factory", () => {
  it("json(initJson) produces an ARJSON-like object", () => {
    const arj = json({ x: 1 })
    assert.deepEqual(arj.json, { x: 1 })
    assert.ok(Array.isArray(arj.deltas))
  })

  it("json(buffer) reconstructs from a serialized chain", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    const buf = a.toBuffer()
    const arj = json(buf)
    assert.deepEqual(arj.json, a.json)
  })

  it("json(deltasArray) reconstructs from an array of deltas", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    a.update({ x: 3 })
    const arj = json(a.deltas)
    assert.deepEqual(arj.json, a.json)
  })

  it("json(table) reconstructs from a table cache", () => {
    const a = new ARJSON({ json: { x: 1, y: "hello" } })
    const arj = json(a.table())
    assert.deepEqual(arj.json, a.json)
  })

  it("json(null, info) accepts the (null, json) form per docs", () => {
    const arj = json(null, { x: 42 })
    assert.deepEqual(arj.json, { x: 42 })
  })

  it("supports update() like the class", () => {
    const arj = json({ count: 0 })
    arj.update({ count: 1 })
    arj.update({ count: 2 })
    assert.equal(arj.json.count, 2)
    assert.equal(arj.deltas.length, 3)
  })

  it("supports move/copy/test via the wrapped instance", () => {
    const arj = json({ src: 100 })
    arj.copy("src", "dst")
    assert.deepEqual(arj.json, { src: 100, dst: 100 })
    arj.move("dst", "moved")
    assert.deepEqual(arj.json, { src: 100, moved: 100 })
    assert.equal(arj.test("src", 100), true)
  })
})
