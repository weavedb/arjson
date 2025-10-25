import { describe, it } from "node:test"
import { enc, dec, ARJSON } from "../src/arjson.js"
import { ARTable, Decoder, Encoder } from "../src/index.js"
import assert from "assert"
import { genUser } from "./utils.js"

describe("ARJSON", function () {
  it("should remove id field", () => {
    assert.deepEqual(dec(enc({ a: [] })), [])
    return
  })
  it("should remove id field", () => {
    const cases = [
      // Nested arrays
      [{ a: [[1, 2]] }, { a: [[1, 2, 3]] }],
      [
        {
          a: [
            [1, 2],
            [3, 4],
          ],
        },
        { a: [[1], [3, 4, 5]] },
      ],
    ]
    let i = 0
    for (let users of cases) {
      console.log(
        i,
        "[..............................................]",
        users[0],
        users[1],
      )
      const arj = new ARJSON({ json: users[0] })
      arj.update(users[1])
      console.log(arj.json)
      assert.deepEqual(arj.json, users[1])
      i++
    }
  })

  it("should remove id field", () => {
    const cases = [
      // Basic array operations
      [{ a: [1, 3] }, { a: [1, 2, 3, 4], b: 3 }],
      [{ a: [1, 3] }, { a: [1, 2, 3] }],
      [{ a: [1, 3] }, { a: [1, 4] }],
      [{ a: [1, 2, 3] }, { a: [1, 3] }],
      [{ a: [1, 2, 3] }, { a: [4, 5, 6] }],

      // Empty arrays
      [{ a: [] }, { a: [1, 2, 3] }],
      [{ a: [1, 2, 3] }, { a: [] }],
      [{ a: [] }, { a: [] }],

      // Array with objects
      [{ a: [{ x: 1 }] }, { a: [{ x: 2 }] }],
      [{ a: [{ x: 1 }] }, { a: [{ x: 1 }, { y: 2 }] }],

      // Mixed operations
      [
        { a: [1, 2, 3], b: 5 },
        { a: [1, 4, 3], c: 6 },
      ],
      [{ a: [1, 2] }, { a: [2, 3, 4] }],

      // Replace entire array
      [{ a: [1, 2, 3] }, { a: ["x", "y"] }],

      // Single element changes
      [{ a: [1] }, { a: [2] }],
      [{ a: [1] }, { a: [1, 2] }],

      // Multiple arrays
      [
        { a: [1, 2], b: [3, 4] },
        { a: [1], b: [3, 4, 5] },
      ],

      // Object to array
      [{ a: 5 }, { a: [1, 2, 3] }],

      // Array to primitive
      [{ a: [1, 2, 3] }, { a: 5 }],
    ]
    let i = 0
    for (let users of cases) {
      console.log(
        i,
        "[..............................................]",
        users[0],
        users[1],
      )
      const arj = new ARJSON({ json: users[0] })
      arj.update(users[1])
      console.log(arj.json)
      assert.deepEqual(arj.json, users[1])
      i++
    }
  })
  it("should compact vtable", () => {
    const obj1 = { a: [1, 2, 3] }
    const arj = new ARJSON({ json: obj1 })
    let obj2 = null
    obj2 = { b: 4 }
    arj.update(obj2)
    obj2 = { c: 5 }
    arj.update(obj2)
    assert.deepEqual(obj2, arj.json)
  })

  it("should compact vtable", () => {
    let count = 0
    const obj1 = { a: count }
    const arj = new ARJSON({ json: obj1 })
    let obj2 = null
    while (count < 10) {
      obj2 = { a: ++count }
      arj.update(obj2)
    }
    obj2 = { b: ++count }
    arj.update(obj2)
    obj2 = { b: ++count }
    arj.update(obj2)
    assert.deepEqual(obj2, arj.json)
  })

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
        if (i > 1000) break
      } catch (e) {
        console.log("[user]", user, "[user2]", user2)
        console.log(e)
        process.exit()
      }
    }
  })
  it("should delta upgrade #3", () => {
    const user = genUser()
    const arj = new ARJSON({ json: user })
    let i = 0
    let user2 = null
    let users = [user]
    while (true) {
      user2 = genUser()
      users.push(user2)
      try {
        arj.update(user2)
        assert.deepEqual(arj.json, user2)
      } catch (e) {
        console.log(e)
        console.log(users)
        process.exit()
      }
      i++
      if (i > 1000) break
    }
    assert.deepEqual(arj.json, user2)
  })

  it.only("should delta upgrade #2", () => {
    const json = [{ a: ["d"] }, { a: ["e"] }, { c: "f" }]
    const arj = new ARJSON({ json: json[0] })
    arj.update(json[1])
    arj.update(json[2])
    //assert.deepEqual(arj.json, json[2])
    console.log("lets rebuild.................................")
    const arj2 = new ARJSON({ arj: arj.toBuffer() })
    arj2.update({ abc: 123, ghi: 789 })
    const arj3 = new ARJSON({ table: arj2.artable.table() })
    assert.deepEqual(arj2.json, arj3.json)
    arj3.update({ abc: 123, ghi: 789, xyz: 999 })
    assert.deepEqual(arj3.json, { abc: 123, ghi: 789, xyz: 999 })
    console.log(arj3.toBuffer())
  })

  it("check", () => {
    const user = {
      pr: [
        { a: "c", e: "f" },
        { a: "d", e: "g" },
      ],
    }
    const user2 = {
      pr: [{ a: "d", e: "x" }],
    }
    const arj = new ARJSON({ json: user })
    arj.update(user2)
    assert.deepEqual(arj.json, user2)
  })
})
