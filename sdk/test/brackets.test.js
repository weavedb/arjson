import { describe, it } from "node:test"
import assert from "assert"
import { parsePath, escapeKey } from "../src/utils.js"
import { ARJSON, enc, dec } from "../src/arjson.js"

describe("parsePath", () => {
  it("parses simple dot/bracket paths", () => {
    assert.deepEqual(parsePath(""), [])
    assert.deepEqual(parsePath("user.name"), ["user", "name"])
    assert.deepEqual(parsePath("array[0]"), ["array", 0])
    assert.deepEqual(parsePath("array[42].item"), ["array", 42, "item"])
    assert.deepEqual(parsePath("[0]"), [0])
  })

  it("treats brackets with non-numeric content as part of the key", () => {
    assert.deepEqual(parsePath("user[admin]"), ["user[admin]"])
    assert.deepEqual(parsePath("key[with]brackets"), ["key[with]brackets"])
    assert.deepEqual(parsePath("user[admin].role"), ["user[admin]", "role"])
    assert.deepEqual(parsePath("config[prod][eu-west]"), [
      "config[prod][eu-west]",
    ])
  })

  it("treats brackets with numeric content as array indices unless escaped", () => {
    assert.deepEqual(parsePath("data[2020]"), ["data", 2020])
    assert.deepEqual(parsePath("data\\[2020\\]"), ["data[2020]"])
    assert.deepEqual(parsePath("a.b\\[2020\\].c"), ["a", "b[2020]", "c"])
  })

  it("handles unclosed/unmatched brackets as literal characters", () => {
    assert.deepEqual(parsePath("[leadingBracket"), ["[leadingBracket"])
    assert.deepEqual(parsePath("trailing]bracket"), ["trailing]bracket"])
    assert.deepEqual(parsePath("[]"), ["[]"])
  })

  it("collapses bare dot separators", () => {
    assert.deepEqual(parsePath("."), [])
    assert.deepEqual(parsePath("..."), [])
  })
})

describe("escapeKey", () => {
  it("escapes brackets and backslashes only", () => {
    assert.equal(escapeKey("plain"), "plain")
    assert.equal(escapeKey("data[2020]"), "data\\[2020\\]")
    assert.equal(escapeKey("a\\b"), "a\\\\b")
    assert.equal(escapeKey("a.b"), "a.b")
  })

  it("round-trips with parsePath as a single key segment", () => {
    for (const key of [
      "data[2020]",
      "user[admin]",
      "config[prod][eu]",
      "x\\y",
      "plain",
    ]) {
      assert.deepEqual(parsePath(escapeKey(key)), [key])
    }
  })
})

describe("ARJSON delta updates with bracket keys", () => {
  const roundTrip = (json) => new ARJSON({ arj: new ARJSON({ json }).toBuffer() }).json

  it("encodes/decodes objects with bracket keys", () => {
    const cases = [
      { "user[admin]": true },
      { "data[2020]": 100, "data[2021]": 200 },
      { "config[prod][eu]": "active" },
      { normal: 1, "key[bracket]": 2 },
    ]
    for (const c of cases) assert.deepEqual(roundTrip(c), c)
  })

  it("delta-updates values at bracket keys", () => {
    const a = new ARJSON({ json: { "user[admin]": false, "user[guest]": false } })
    a.update({ "user[admin]": true, "user[guest]": false })
    assert.deepEqual(a.json, { "user[admin]": true, "user[guest]": false })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, a.json)
  })

  it("delta-updates values at numeric-bracket keys (Bug 2 fix)", () => {
    const a = new ARJSON({ json: { "data[2020]": 100 } })
    a.update({ "data[2020]": 200 })
    assert.deepEqual(a.json, { "data[2020]": 200 })
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { "data[2020]": 200 })
  })

  it("adds new bracket keys via delta", () => {
    const a = new ARJSON({ json: { normal: 1 } })
    a.update({ normal: 1, "key[bracket]": 2 })
    assert.deepEqual(a.json, { normal: 1, "key[bracket]": 2 })
  })

  it("deletes bracket keys via delta", () => {
    const a = new ARJSON({ json: { "user[a]": 1, "user[b]": 2 } })
    a.update({ "user[a]": 1 })
    assert.deepEqual(a.json, { "user[a]": 1 })
  })

  it("handles mixed paths: arrays + bracket keys at the same level", () => {
    const a = new ARJSON({
      json: { items: [1, 2, 3], "key[x]": "v1" },
    })
    a.update({ items: [1, 2, 4], "key[x]": "v2" })
    assert.deepEqual(a.json, { items: [1, 2, 4], "key[x]": "v2" })
  })

  it("handles bracket keys nested inside objects", () => {
    const a = new ARJSON({ json: { x: { "data[2020]": 100 } } })
    a.update({ x: { "data[2020]": 200 } })
    assert.deepEqual(a.json, { x: { "data[2020]": 200 } })
  })
})
