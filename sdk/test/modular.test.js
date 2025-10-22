import { describe, it } from "node:test"
import { enc, dec, ARJSON } from "../src/arjson.js"
import { Decoder, decode, Encoder, encode } from "../src/index.js"
import assert from "assert"
import { genUser } from "./utils.js"

describe("ARJSON", function () {
  it("should serialize encoder", () => {
    const e = new Encoder()
    encode({ a: 1 }, e, null, true)
    const ser = e.serialize()
    const e2 = new Encoder(null, ser)
    assert.deepEqual(e.dump(), e2.dump())
  })
  it("should delta upgrade in edge cases", () => {
    const obj1 = null
    const obj2 = ["a"]
    const arj = new ARJSON({ json: obj1 })
    arj.update(obj2)
    assert.deepEqual(arj.json, obj2)
    console.log(arj.deltas)
  })
  it("should delta upgrade", () => {
    while (true) {
      const user = genUser()
      const user2 = genUser()

      try {
        const arj = new ARJSON({ json: user })
        arj.update(user2)
        assert.deepEqual(arj.json, user2)
      } catch (e) {
        console.log(
          "user......................................................",
          user,
          "user2......................................................",
          user2,
        )
        console.log(e)
        process.exit()
      }
    }
  })
  it.only("should delta upgrade", () => {
    const user = genUser()
    const arj = new ARJSON({ json: user })
    let i = 0
    let size0 = JSON.stringify(user).length
    while (true) {
      const user2 = genUser()
      size0 += JSON.stringify(user2).length
      try {
        arj.update(user2)
        assert.deepEqual(arj.json, user2)
      } catch (e) {
        console.log(e)
        process.exit()
      }
      i++
      if (i > 100) break
    }
    console.log(arj.deltas)
    let size = 0
    for (let v of arj.deltas) size += v.length
    console.log(size, size0)
    console.log(arj.buffer())
    console.log(arj.json)
    console.log(arj.artable)
  })

  it("check", () => {
    const user = { tags: 3 }
    const user2 = { skills: ["c"], projects: [{ a: "b" }, { a: "c" }] }
    const arj = new ARJSON({ json: user })
    arj.update(user2)
    console.log(arj.json)
    assert.deepEqual(arj.json, user2)
  })
})
