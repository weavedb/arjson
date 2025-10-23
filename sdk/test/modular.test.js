import { describe, it } from "node:test"
import { enc, dec, ARJSON } from "../src/arjson.js"
import { ARTable, Decoder, decode, Encoder, encode } from "../src/index.js"
import assert from "assert"
import { genUser } from "./utils.js"

describe("ARJSON", function () {
  it("should delta upgrade in edge cases", () => {
    const obj1 = null
    const obj2 = ["a"]
    const arj = new ARJSON({ json: obj1 })
    arj.update(obj2)
    assert.deepEqual(arj.json, obj2)
  })
  it("should delta upgrade", () => {
    let i = 0
    while (true) {
      const user = genUser()
      const user2 = genUser()

      try {
        const arj = new ARJSON({ json: user })
        arj.update(user2)
        assert.deepEqual(arj.json, user2)
        i++
        if (i > 100) break
      } catch (e) {
        console.log("[user]", user, "[user2]", user2)
        console.log(e)
        process.exit()
      }
    }
  })
  it("should delta upgrade #2", () => {
    const json = { abc: 123 }
    const arj = new ARJSON({ json })
    arj.update({ abc: 123, def: 456 })
    arj.update({ abc: 123, def: 456, ghi: 789 })

    const arj2 = new ARJSON({ arj: arj.buffer() })
    arj2.update({ abc: 123, ghi: 789 })

    const arj3 = new ARJSON({ table: arj2.artable.table() })
    assert.deepEqual(arj2.json, arj3.json)
    arj3.update({ abc: 123, ghi: 789, xyz: 999 })
    assert.deepEqual(arj3.json, { abc: 123, ghi: 789, xyz: 999 })
  })
  it("should delta upgrade #3", () => {
    const user = genUser()
    const arj = new ARJSON({ json: user })
    let i = 0
    let size0 = JSON.stringify(user).length
    let user2 = null
    while (true) {
      user2 = genUser()
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
    let size = 0
    for (let v of arj.deltas) size += v.length
    assert.deepEqual(arj.json, user2)
  })

  it("check", () => {
    const user = { tags: 3 }
    const user2 = { skills: ["c"], projects: [{ a: "b" }, { a: "c" }] }
    const arj = new ARJSON({ json: user })
    arj.update(user2)
    assert.deepEqual(arj.json, user2)
  })
})
