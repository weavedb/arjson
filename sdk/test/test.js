import { describe, it } from "node:test"
import assert from "assert"
import { createJSON } from "./utils.js"
import { encode as enc, decode as dec } from "@msgpack/msgpack"
import { encode, Encoder, decode, Decoder, Parser } from "../src/index.js"
import { Bundle, delta } from "../src/parser.js"
import { range } from "ramda"

let data = {
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

let data_x = { a: 3, e: { u: 9, f: 6, a: 7, b: 4 }, g: [1] }

const path_x = "g"
const val_x = undefined

describe("ARJSON", function () {
  it("should calculate delta of 2 objects", () => {
    let d = new Decoder()
    const a = { a: 3, e: { f: 5, t: 7 }, g: [1, 3], dc: false }
    const b = { e: { f: 6, a: 7 }, g: [1, 2, { y: 3 }], abc: true, dc: null }
    const { len, q } = delta(a, b)
    let u = new Encoder()
    const e = encode(a, u)
    const decoded = decode(e, d)
    let p = new Parser(d.cols())
    const q2 = u._dump(q)
    const res = p.update(e, q2, len)
    assert.deepEqual(res.json, b)
  })

  it("should delta upgrade JSON", () => {
    let d = new Decoder()
    let u = new Encoder()
    const _e = encode(data_x, u)
    console.log(JSON.stringify(data_x).length, _e)
    const decoded = decode(_e, d)
    assert.deepEqual(data_x, decoded)
    let meta = d.show()
    let p = new Parser(meta)
    let { query: q } = p.query(path_x, val_x)
    console.log(q)
    console.log(p.update(_e, q))
  })

  it("should compare sizes", () => {
    let d = new Decoder()
    let u = new Encoder()
    let wins = 0
    console.log()
    for (let v of range(1, 101)) {
      console.log()
      data = createJSON()
      const _e = encode(data, u)
      const msg = enc(data)
      let jsize = Buffer.from(JSON.stringify(data), "utf8").length
      let msize = Buffer.from(msg).length
      let zksize = Buffer.from(_e).length
      console.log(
        v,
        "[j]",
        jsize,
        "[z]",
        zksize,
        "[m]",
        msize,
        "[d]",
        zksize - msize,
        "==========================================",
      )
      console.log(data)
      if (msize > zksize) wins++
    }
    console.log()
    console.log("[wins]", wins)
    console.log()
  })

  it("should encode with arjson", () => {
    console.log()
    data = createJSON()

    console.log()
    let d = new Decoder()
    let u = new Encoder()

    const _e = encode(data, u)
    const msg = enc(data)
    const decoded = decode(_e, d)
    console.log("decoded:", decoded)
    console.log(data)
    assert.deepEqual(data, decoded)
    d.show()
    console.log()
    console.log("zk", _e)
    console.log("msg", msg)
    console.log()
    console.log("[json size]", Buffer.from(JSON.stringify(data), "utf8").length)
    console.log("[arjson size]", Buffer.from(_e).length)
    console.log("[msgpack size]", Buffer.from(msg).length)
  })

  it("should benchmark", () => {
    const count = 100000
    let d = new Decoder()
    let u = new Encoder()
    data = createJSON()
    /*
    data = {
      HmOjTx: {
        I0: { Mgo: true, c: "Pl13CG8", e: 93, PWUtvM: "KdOl" },
        uiE5: { ZMD: 62, MrOl: 82, lxMJx: true, iKaXW: "hXZ8hVKxU" },
      },
      AM1: [
        [null, null],
        { f: false, BYfLR: "PTs87Nt" },
        { OZrnk: "6GL2JrqLKz", uaDS: false },
        { UiFU: "52l6yvMn", bNF: "5TNV" },
      ],
      "9kVj": [{ o1: 9, W: "LF1cyALKyi" }, [null, 11]],
      Cgbz: {
        67: [null, true],
        OF9Rn: { aoIf3f: 23, Gp: true, rYlN: 7, Xnfo: null },
        Kc0QD: { v: false, U: true },
        Pr: { t: "xhoND0UG", LNkT1L: null, A87h: 26, "2f4F6": 88 },
      },
    }
    */
    console.log("[json size]", Buffer.from(JSON.stringify(data), "utf8").length)
    const msg = enc(data)
    console.log("[msgpack size]", Buffer.from(msg).length)
    const _e = encode(data, u)
    console.log("[arjson size]", Buffer.from(_e).length)

    console.log()
    const start0 = Date.now()
    for (let i = 0; i < count; i++) enc(data)
    console.log("[msgpack encode]", Date.now() - start0)

    const start1 = Date.now()
    for (let i = 0; i < count; i++) encode(data, u)
    console.log("[arjson encode]", Date.now() - start1)

    const start5 = Date.now()
    for (let i = 0; i < count; i++) JSON.stringify(data)
    console.log("[json stringify]", Date.now() - start5)
    console.log()

    const start2 = Date.now()
    for (let i = 0; i < count; i++) dec(msg)
    console.log("[msgpack decode]", Date.now() - start2)

    const start3 = Date.now()
    for (let i = 0; i < count; i++) decode(_e, d)
    console.log("[arjson decode]", Date.now() - start3)

    const str = JSON.stringify(data)
    const start4 = Date.now()
    for (let i = 0; i < count; i++) JSON.parse(str)
    console.log("[json parse]", Date.now() - start4)
    console.log()

    console.log(data)
    console.log()
  })

  it("should encode and decode random json", () => {
    let d = new Decoder()
    let u = new Encoder()
    for (let v of range(0, 1000)) {
      let data0 = createJSON()
      const res0 = encode(data0, u)
      const decoded = decode(res0, d)
      assert.deepEqual(decoded, data0)
    }
  })

  it("should encode and decode", () => {
    let data0 = createJSON()
    data0 = -3.223432
    console.log()
    console.log(data0)
    console.log()
    let u = new Encoder()
    const res0 = encode(data0, u)
    let d = new Decoder()
    console.log()
    const decoded = decode(res0, d)
    console.log(decoded)
    console.log("decoded", JSON.stringify(decoded))
    console.log()
    assert.deepEqual(decoded, data0)

    const msg = enc(data0)
    console.log()
    console.log(
      "size: [json]",
      Buffer.from(JSON.stringify(data0), "utf8").length,
      "[msg]",
      Buffer.from(msg).length,
      "[arj]",
      Buffer.from(res0).length,
    )
    console.log()

    const num = 100000
    const start = Date.now()
    for (let i = 0; i < num; i++) encode(data0, u)
    const dur = Date.now() - start
    const start0 = Date.now()
    for (let i = 0; i < num; i++) enc(data0)
    const dur0 = Date.now() - start0
    console.log("speed: [msg]", dur0, "[arj]", dur)
    console.log()
    console.log("[msg]", msg)
    console.log("[arj]", res0)
  })
})
