import { describe, it } from "node:test"
import assert from "assert"
import { ARJSON } from "../src/arjson.js"

const testDelta = (from, to) => {
  const a = new ARJSON({ json: from })
  a.update(to)
  assert.deepEqual(a.json, to)
  assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
}

describe("ARJSON delta update patterns", () => {
  it("adds new fields", () => {
    testDelta({ val: 1 }, { val: 1, val2: 2, val3: "hello" })
  })

  it("deletes fields", () => {
    testDelta({ a: 1, b: 2, c: 3, d: 4 }, { b: 2, d: 4 })
  })

  it("modifies values of the same type", () => {
    testDelta(
      { str: "hello", num: 42, bool: true },
      { str: "world", num: 100, bool: false },
    )
  })

  it("changes value types", () => {
    testDelta(
      { a: 42, b: "string", c: true, d: null },
      { a: "forty-two", b: 99, c: null, d: false },
    )
  })

  it("modifies nested objects (add and delete fields)", () => {
    testDelta(
      { user: { name: "Alice", age: 30, email: "alice@example.com" } },
      { user: { name: "Alice", age: 31, city: "NYC" } },
    )
  })

  it("modifies array elements (same length)", () => {
    testDelta({ items: [1, 2, 3, 4] }, { items: [1, 5, 3, 4] })
  })

  it("grows arrays", () => {
    testDelta({ items: [1, 2] }, { items: [1, 2, 3, 4] })
  })

  it("shrinks arrays", () => {
    testDelta({ items: [1, 2, 3, 4] }, { items: [1, 2] })
  })

  it("changes element type from primitive to object", () => {
    testDelta(
      { data: [1, "two", true] },
      { data: [1, "two", { nested: "object" }] },
    )
  })

  it("handles complex nested structures with mixed changes", () => {
    testDelta(
      {
        config: {
          server: { host: "localhost", port: 3000 },
          database: { name: "mydb", pool: 10 },
        },
        users: ["alice", "bob"],
        active: true,
      },
      {
        config: {
          server: { host: "0.0.0.0", port: 8080, ssl: true },
          cache: { redis: true },
        },
        users: ["alice", "charlie", "david"],
        active: false,
        timestamp: 1234567890,
      },
    )
  })

  it("modifies arrays containing objects", () => {
    testDelta(
      {
        list: [
          { id: 1, name: "A" },
          { id: 2, name: "B" },
        ],
      },
      {
        list: [
          { id: 1, name: "A", active: true },
          { id: 3, name: "C" },
        ],
      },
    )
  })

  it("handles null transformations and field deletion", () => {
    testDelta(
      { a: "value", b: null, c: 123 },
      { a: null, b: "value" },
    )
  })

  it("handles object → array transformation", () => {
    testDelta({ data: { a: 1, b: 2 } }, { data: [1, 2, 3] })
  })

  it("handles array → object transformation", () => {
    testDelta({ data: [1, 2, 3] }, { data: { x: 1, y: 2 } })
  })

  it("handles deeply nested object modifications", () => {
    testDelta(
      { a: { b: { c: { d: { e: 1 } } } } },
      { a: { b: { c: { d: { e: 2, f: 3 } } } } },
    )
  })

  it("handles mixed-type arrays", () => {
    testDelta(
      { mixed: [1, "two", [3, 4], { five: 5 }, null, true] },
      { mixed: [10, "twenty", [30], { forty: 40 }, false, null] },
    )
  })

  it("handles keys with dashes, underscores, and special characters", () => {
    testDelta(
      { "normal-key": 1, key_with_underscores: 3 },
      {
        "normal-key": 10,
        key_with_underscores: 30,
        "new@key": 40,
      },
    )
  })

  it("handles large integers (Bug 3 fix)", () => {
    testDelta(
      { int: 1000000, big: 0 },
      { int: 9999999, big: Number.MAX_SAFE_INTEGER },
    )
  })

  it("handles single floats", () => {
    testDelta({ value: 3.5 }, { value: 2.75 })
  })

  it("preserves the original mixed-type complex case", () => {
    testDelta(
      { a: 3, e: { f: 5, t: 7 }, g: [1, 3], dc: false },
      { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }], abc: true, dc: null },
    )
  })

  it("handles chained updates", () => {
    const a = new ARJSON({ json: { x: 1 } })
    a.update({ x: 2 })
    a.update({ x: 2, y: 3 })
    a.update({ y: 3 })
    assert.deepEqual(a.json, { y: 3 })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { y: 3 })
  })
})
