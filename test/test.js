const { describe, it } = require("node:test")
const assert = require("assert")
const { createJSON } = require("./utils.js")
const { encode: enc, decode: dec } = require("@msgpack/msgpack")
const { encode_x, u8 } = require("../sdk/encoder-v2.js")
const { decode_x, decoder } = require("../sdk/decoder-v2.js")
const { Parser, calcDiff } = require("../sdk/parser.js")
const { range } = require("ramda")

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

let data_x = { a: 3, e: { u: 9, f: 6, a: 7, b: 4 }, g: [1] } //{ abc: ["abc", { def: [4, 3, 5] }] }

const path_x = "g" //"abc[1]"
const val_x = undefined //{ abc: "def" }

// empty object
describe("zkJSON v2", function () {
  it.only("should calculate delta of 2 objects", () => {
    let d = new decoder()
    const a = { a: 3, e: { f: 5, t: 7 }, g: [1, 3], dc: false }
    const q = calcDiff(a, {
      e: { f: 6, a: 7 },
      g: [1, 2, { y: 3 }],
      abc: true,
      dc: null,
    })
    let u = new u8()
    const e = encode_x(a, u)
    const decoded = decode_x(e, d)
    let p = new Parser(d.cols())
    const res = p.update(e, q)
    console.log(res)
  })

  it("should delta upgrade JSON", () => {
    let d = new decoder()
    let u = new u8()
    const _e = encode_x(data_x, u)
    console.log(JSON.stringify(data_x).length, _e)
    const decoded = decode_x(_e, d)
    assert.deepEqual(data_x, decoded)
    let meta = d.show()
    let p = new Parser(meta)
    let { query: q } = p.query(path_x, val_x)
    console.log(q)
    console.log(p.update(_e, q))
    return
  })

  it("should delta upgrade JSON", () => {
    data = { c: 1 }
    let d = new decoder()
    let u = new u8()
    const _e = encode_x(data, u)
    const decoded = decode_x(_e, d)

    console.log("decoded:", decoded)
    console.log(data)
    d.show()

    assert.deepEqual(data, decoded)
    let meta = d.show()
    console.log(meta)
    let p = new Parser(meta)
    /*
    let q = p.query("abc", 1)
    console.log(p.update(q))
    */
    //let q = p.query("b[1]", 10)

    let { query: q } = p.query("c", [1, 2])
    console.log("query", q)
    const res = p.update(q)
    const data2 = res.json
    console.log(data2)
    let d2 = new decoder()
    let u2 = new u8()
    const _e2 = encode_x(data2, u2)
    const decoded2 = decode_x(_e2, d2)
    console.log("decoded:", decoded2)
    let meta2 = d.show()
    console.log(meta2)
    let p2 = new Parser(meta2)
    let { query: q2 } = p2.query("c[0]", 100)
    console.log(p2.update(q2))
    return
    ;({ query: q } = p.query("c[0]", 100))
    console.log(q)
    console.log("query", q)
    //console.log(p.update(q))
    return
    ;({ query: q } = p.query("b[0]", "create", 20))
    console.log(p.update(q))
    ;({ query: q } = p.query("b[2]", "create", 5))
    console.log(p.update(q))
    ;({ query: q } = p.query("c", "create", 8))
    console.log(q)
    return

    // update
    meta.vrefs.push(2)
    meta.types.push(4)
    meta.nums.push(5)
    console.log(p.build())

    // add field
    meta.krefs.push(1)
    meta.ktypes.push([2, 2])
    meta.keys.push("b")
    meta.vrefs.push(3)
    meta.types.push(4)
    meta.nums.push(6)

    // delete field
    meta.vrefs.push(2)
    meta.types.push(null)
    console.log(p.build())

    console.log(meta)

    // update object
    meta.krefs.push(1)
    meta.ktypes.push([2, 2])
    meta.keys.push("c")

    meta.vrefs.push(4)
    meta.types.push(6)
    meta.nums.push({})

    // update object 2
    meta.krefs.push(1)
    meta.ktypes.push([2, 2])
    meta.keys.push("e")

    meta.krefs.push(5)
    meta.ktypes.push([1])
    meta.keys.push(1)
    console.log(meta)

    meta.krefs.push(6)
    meta.ktypes.push([2, 2])
    meta.keys.push("f")

    meta.vrefs.push(7)
    meta.types.push(6)
    meta.nums.push(4)

    console.log(meta)

    console.log(p.build())

    // delete object
    meta.vrefs.push(5)
    meta.types.push(null)
    console.log(p.build())

    process.exit()
  })

  it("should compare sizes", () => {
    let d = new decoder()
    let u = new u8()
    let wins = 0
    console.log()
    for (let v of range(1, 101)) {
      console.log()
      data = createJSON()
      const _e = encode_x(data, u)
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

  it("should encode with v2", () => {
    console.log()
    data = createJSON()

    console.log()
    let d = new decoder()
    let u = new u8()

    const _e = encode_x(data, u)
    const msg = enc(data)
    const decoded = decode_x(_e, d)
    console.log("decoded:", decoded)
    console.log(data)
    assert.deepEqual(data, decoded)
    d.show()
    console.log()
    console.log("zk", _e)
    console.log("msg", msg)
    console.log()
    console.log("[json size]", Buffer.from(JSON.stringify(data), "utf8").length)
    console.log("[zkjson v2 size]", Buffer.from(_e).length)
    console.log("[msgpack size]", Buffer.from(msg).length)
  })

  it("should benchmark", () => {
    const count = 100000
    let d = new decoder()
    let u = new u8()
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
    const _e = encode_x(data, u)
    console.log("[zkjson v2 size]", Buffer.from(_e).length)

    console.log()
    const start0 = Date.now()
    for (let i = 0; i < count; i++) enc(data)
    console.log("[msgpack encode]", Date.now() - start0)

    const start1 = Date.now()
    for (let i = 0; i < count; i++) encode_x(data, u)
    console.log("[zkjson v2 encode]", Date.now() - start1)

    const start5 = Date.now()
    for (let i = 0; i < count; i++) JSON.stringify(data)
    console.log("[json stringify]", Date.now() - start5)
    console.log()

    const start2 = Date.now()
    for (let i = 0; i < count; i++) dec(msg)
    console.log("[msgpack decode]", Date.now() - start2)

    const start3 = Date.now()
    for (let i = 0; i < count; i++) decode_x(_e, d)
    console.log("[zkjson decode]", Date.now() - start3)

    const str = JSON.stringify(data)
    const start4 = Date.now()
    for (let i = 0; i < count; i++) JSON.parse(str)
    console.log("[json parse]", Date.now() - start4)
    console.log()

    console.log(data)
    console.log()
  })

  it("should encode and decode random json", () => {
    let d = new decoder()
    let u = new u8()
    for (let v of range(0, 1000)) {
      let data0 = createJSON()
      const res0 = encode_x(data0, u)
      const decoded = decode_x(res0, d)
      assert.deepEqual(decoded, data0)
    }
  })

  it("should encode and decode", () => {
    let data0 = createJSON()
    data0 = -3.223432
    console.log()
    console.log(data0)
    console.log()
    let u = new u8()
    const res0 = encode_x(data0, u)
    let d = new decoder()
    console.log()
    const decoded = decode_x(res0, d)
    console.log(decoded)
    console.log("decoded", JSON.stringify(decoded))
    console.log()
    assert.deepEqual(decoded, data0)
    return
    const msg = enc(data0)
    console.log()
    console.log(
      "size: [json]",
      Buffer.from(JSON.stringify(data0), "utf8").length,
      "[msg]",
      Buffer.from(msg).length,
      "[zkj]",
      Buffer.from(res0).length,
    )
    console.log()
    return

    const num = 100000
    const start = Date.now()
    for (let i = 0; i < num; i++) encode_x(data0, u)
    const dur = Date.now() - start
    const start0 = Date.now()
    for (let i = 0; i < num; i++) enc(data0)
    const dur0 = Date.now() - start0
    console.log("speed: [msg]", dur0, "[zkj]", dur)
    console.log()
    console.log("[msg]", msg)
    console.log("[zkj]", res0)
    console.log()
    return
    console.log(decode(res0))
    console.log(encode(data0, { offset: false, sort: false, dict: false }))
  })

  it("should encode and decode", () => {
    console.log("size comparison..............................................")
    console.log("[json size]", Buffer.from(JSON.stringify(data), "utf8").length)
    const msg = enc(data)
    console.log("[msgpack size]", Buffer.from(msg).length)
    const _e0 = encode1(data)
    console.log("zkjson v1 size", Buffer.from(_e0).length)

    const _e = encode(data, { offset: false, sort: false })
    console.log("zkjson(dic) size", Buffer.from(_e).length)
    const _e2 = encode(data, { dict: false, sort: false })
    console.log("zkjson(offset) size", Buffer.from(_e2).length)
    assert.deepEqual(decode(_e2), data)
    const _e3 = encode(data)
    console.log("zkjson(dic + offset) size", Buffer.from(_e3).length)
    console.log()
    console.log(
      "encode comparison..............................................",
    )
    const start0 = Date.now()
    for (let i = 0; i < 1000; i++) enc(data)
    console.log("[msgpack encode]", Date.now() - start0)

    const start91 = Date.now()
    for (let i = 0; i < 1000; i++)
      encode(data, { dict: false, offset: false, sort: false })
    console.log("[zkjson encode no dict]", Date.now() - start91)

    const start9 = Date.now()
    for (let i = 0; i < 1000; i++) encode(data)
    console.log("[zkjson encode]", Date.now() - start9)

    const start11 = Date.now()
    for (let i = 0; i < 1000; i++) encode1(data)
    console.log("[zkjson v1 encode]", Date.now() - start11)

    console.log()
    console.log("get comparison..............................................")
    let a = null
    const start0_2 = Date.now()
    for (let i = 0; i < 1000; i++) a = dec(msg).user.name
    console.log("[msgpack get]", Date.now() - start0_2, a)

    const start0_3 = Date.now()
    for (let i = 0; i < 1000; i++) a = decode1(_e0).user.name
    console.log("[zkjson v1 get]", Date.now() - start0_3, a)

    const start0_4 = Date.now()
    for (let i = 0; i < 1000; i++) a = get(_e3, "user.name")
    console.log("[zkjson v2 get]", Date.now() - start0_4, a)
    console.log(get(_e3, "user.name"))
    return
  })
})
