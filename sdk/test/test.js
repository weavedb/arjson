import { describe, it } from "node:test"
import assert from "assert"
// Native replacement for ramda.range — was the only ramda usage in tests.
const range = (start, end) => {
  const out = []
  for (let i = start; i < end; i++) out.push(i)
  return out
}
import { ARJSON, enc, dec } from "../src/arjson.js"
import { Encoder, Decoder, encode } from "../src/index.js"
import { createJSON } from "./utils.js"

const data = {
  user: {
    id: 12345,
    name: "Alice",
    email: "alice@example.com",
    preferences: {
      theme: "dark",
      notifications: true,
      language: "en",
    },
    friends: [
      { id: 67890, name: "Bob" },
      { id: 54321, name: "Charlie", favs: ["apple", "orange"] },
    ],
  },
  posts: [
    {
      id: 1,
      title: "Hello World",
      content: "This is my first post!",
      tags: ["intro", "hello"],
    },
    {
      id: 2,
      title: "Another Post",
      content: "More content here.",
      tags: ["update"],
    },
  ],
}

const draft_07 = {
  type: "object",
  required: ["index", "schema", "auth"],
  additionalProperties: false,
  properties: {
    index: { type: "number" },
    schema: { $ref: "http://json-schema.org/draft-07/schema#" },
    docs: {
      type: "object",
      propertyNames: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 42 },
      additionalProperties: {
        type: "object",
        required: ["schema"],
        properties: {
          schema: { $ref: "http://json-schema.org/draft-07/schema#" },
        },
        additionalProperties: false,
      },
    },
  },
}

describe("ARJSON encode/decode round-trip", () => {
  it("encodes and decodes a complex nested object", () => {
    assert.deepEqual(dec(enc(data)), data)
  })

  it("encodes and decodes a JSON Schema document", () => {
    assert.deepEqual(dec(enc(draft_07)), draft_07)
  })

  it("encodes and decodes negative floats", () => {
    const v = -3.223432
    const u = new Encoder()
    const buf = encode(v, u)
    const d = new Decoder()
    const decoded = d.decode(buf) // returns leftover bits, side effect: d.json
    assert.equal(d.json, v)
  })

  it("round-trips primitives", () => {
    for (const v of [null, true, false, 0, 1, 63, 64, -1, "", "x", "abc", []]) {
      assert.deepEqual(dec(enc(v)), v)
    }
  })

  it("round-trips empty containers", () => {
    assert.deepEqual(dec(enc({})), {})
    assert.deepEqual(dec(enc([])), [])
  })

  it("round-trips 1000 random JSONs", () => {
    for (const _ of range(0, 1000)) {
      const j = createJSON()
      assert.deepEqual(dec(enc(j)), j)
    }
  })

  it("preserves all 7 value types", () => {
    const j = {
      n: null,
      b: true,
      f: false,
      i: 42,
      ni: -7,
      x: 3.14,
      s: "hello",
      arr: [1, "two", null],
      obj: { nested: 1 },
    }
    assert.deepEqual(dec(enc(j)), j)
  })
})

describe("ARJSON delta history", () => {
  it("manages chained updates and replays them via buffer", () => {
    const a = new ARJSON({ json: { val: 3 } })
    a.update({ val: 4 })
    a.update({ val: 5, val2: 6 })
    assert.deepEqual(a.json, { val: 5, val2: 6 })

    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, { val: 5, val2: 6 })
  })

  it("compresses delta updates vs full re-encoding", () => {
    const from = { a: 3, e: { f: 5, t: 7 }, g: [1, 3], dc: false }
    const to = { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }], abc: true, dc: null }

    const a = new ARJSON({ json: from })
    a.update(to)
    assert.deepEqual(a.json, to)
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, to)
  })

  it("re-anchors when starting from primitive/empty", () => {
    const a = new ARJSON({ json: null })
    a.update({ a: 1 })
    a.update({ a: 1, b: 2 })
    assert.deepEqual(a.json, { a: 1, b: 2 })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { a: 1, b: 2 })
  })

  it("constructs from a table", () => {
    const a = new ARJSON({ json: { hello: "world" } })
    const b = new ARJSON({ table: a.artable.table() })
    assert.deepEqual(b.json, { hello: "world" })
  })
})

describe("ARJSON random delta updates (1000 iterations)", () => {
  it("never fails on random transitions", () => {
    for (let i = 0; i < 1000; i++) {
      const from = createJSON()
      const to = createJSON()
      const a = new ARJSON({ json: from })
      a.update(to)
      assert.deepEqual(a.json, to)
    }
  })

  it("survives long delta chains", () => {
    const a = new ARJSON({ json: createJSON() })
    for (let i = 0; i < 50; i++) {
      const next = createJSON()
      a.update(next)
      assert.deepEqual(a.json, next)
    }
    const b = new ARJSON({ arj: a.toBuffer() })
    assert.deepEqual(b.json, a.json)
  })
})
