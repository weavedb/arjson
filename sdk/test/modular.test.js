import { describe, it } from "node:test"
import { enc, dec, ARJSON } from "../src/arjson.js"
import { ARTable, Decoder, Encoder } from "../src/index.js"
import assert from "assert"
import { genUser } from "./utils.js"

describe("ARJSON", function () {
  it("should remove id field", () => {
    const json = { a: [] }
    assert.deepEqual(dec(enc(json)), json)
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
      const arj = new ARJSON({ json: users[0] })
      arj.update(users[1])
      assert.deepEqual(arj.json, users[1])
      i++
    }
  })

  it("should remove id field", () => {
    let cases = [
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
    for (let users of cases.slice(0, 1)) {
      const arj = new ARJSON({ json: users[0] })
      arj.update(users[1])
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

  it("should delta upgrade #2", () => {
    const json = [{ a: ["d"] }, { a: ["e"] }, { c: "f" }]
    const arj = new ARJSON({ json: json[0] })
    arj.update(json[1])
    arj.update(json[2])
    //assert.deepEqual(arj.json, json[2])
    const arj2 = new ARJSON({ arj: arj.toBuffer() })
    arj2.update({ abc: 123, ghi: 789 })
    const arj3 = new ARJSON({ table: arj2.artable.table() })
    assert.deepEqual(arj2.json, arj3.json)
    arj3.update({ abc: 123, ghi: 789, xyz: 999 })
    assert.deepEqual(arj3.json, { abc: 123, ghi: 789, xyz: 999 })
  })

  it.only("check", () => {
    const user = {
      id: "Vyr2ohGFYbs3VSH0 gfHZL7YhBUe",
      username: "s7Zeb3aU5yDOo",
      name: "Eve Jones",
      email: "Jzvtkn8FXq@example.com",
      bio: "Bly2FSwWRCQJPhPS XNHDnBGPyXWNEfH Bp0OFAU1C6ddYgF 1NbwHqzNVGdkdwX I5XYLJjgNz7dQOSXxH4Ex4S",
      description:
        "XsPLkG8TcFUhPhYn yGec6mVTXMLDf6Q xs4tanfUhqkTwol YsHhsXPLz8UBvXE wwI1qWeiTKEGVOI qDHGxU9Thl7Woaj MBkgDcaEuuza5Sg cG73ImxmD17c0iIKJ19OmJraAOY43t by9Dto39F16aRcD Fq8ZKhppn",
      age: 21,
      role: "engineer",
      experience: 2,
      active: false,
      verified: true,
      metadata: {
        department: "manager",
        level: 10,
        certified: false,
        joined: 1759238052405,
      },
      skills: ["user", "admin", "analyst"],
      projects: [
        { name: "DgMOsFTxxd6rzn28uz", status: "pending", progress: 41 },
        { name: "lCsZZCOCAGESS", status: "active", progress: 52 },
        { name: "WkWgbTy5g0WWjr", status: "active", progress: 13 },
      ],
    }
    const user2 = {
      id: "GVuoPZwdXu686rT8IOAl",
      username: "ldi1Eu3d6xylj",
      name: "Henry Jones",
      email: "amqOoqYP0@example.com",
      bio: "T5nad4QeEmNon1im 9mVmu7Wyhh46fCB Srwahz8NVEuJfft PkqufnoGlKYNgkM5wA9l4El1VxuYcA twfyoK",
      description:
        "GpzwCpPnGQ5dKxzV bkJdbpDuLTAGsqT tBrqQKxoa0EftVe RaSvI7uqfl6NKJg bntm0CuKhaVaaFTJxmbsw1t6haCAgcAtR3gOu4RaGIF26 4PUfcdbaUY19mVvxSUoYDzQTYQhiVj eMp9KCE53CqW1QK tzFUfjagJ5x",
      age: 75,
      role: "guest",
      experience: 5,
      active: true,
      verified: true,
      metadata: {
        department: "member",
        level: 10,
        certified: true,
        joined: 1759892242897,
      },
      skills: ["engineer", "analyst", "admin"],
      projects: [{ name: "kWd9fSHpJynzH8Y", status: "active", progress: 84 }],
    }

    const arj = new ARJSON({ json: user })
    arj.update(user2)
    assert.deepEqual(arj.json, user2)
  })
})
