// Direct unit tests for utility helpers in src/utils.js.
//
// These exist alongside the round-trip tests so an optimization that
// changes a helper's behavior (without going through full round-trip)
// fails immediately with a localized error.

import { describe, it } from "node:test"
import assert from "assert"
import {
  parsePath,
  parsePathStrict,
  escapeKey,
  getPrecision,
  bits,
  tobits,
  frombits,
  strmap,
  base64,
  base64_rev,
  strmap_rev,
} from "../src/utils.js"

describe("bits(n) — minimum bits to represent n", () => {
  const cases = [
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [7, 3],
    [8, 4],
    [15, 4],
    [16, 5],
    [31, 5],
    [32, 6],
    [63, 6],
    [64, 7],
    [127, 7],
    [128, 8],
    [255, 8],
    [256, 9],
    [65535, 16],
    [65536, 17],
    [2 ** 30, 31],
    [2 ** 31 - 1, 31],
    [2 ** 31, 32],
    [2 ** 32 - 1, 32],
  ]
  for (const [n, expected] of cases) {
    it(`bits(${n}) === ${expected}`, () => {
      assert.equal(bits(n), expected)
    })
  }
})

describe("tobits(byteArray) — convert bytes to bit-string chunks", () => {
  it("empty array → empty array", () => {
    assert.deepEqual(tobits([]), [])
  })
  it("single byte 0x00 → ['00000000']", () => {
    assert.deepEqual(tobits([0]), ["00000000"])
  })
  it("single byte 0xff → ['11111111']", () => {
    assert.deepEqual(tobits([0xff]), ["11111111"])
  })
  it("two bytes preserve order", () => {
    assert.deepEqual(tobits([0xab, 0xcd]), ["10101011", "11001101"])
  })
  it("with cursor offset, returns chunks from offset", () => {
    // cursor=4 means start reading from bit 4 of byte 0
    const r = tobits([0xab, 0xcd], 4)
    assert.equal(r.join(""), "10111100" + "1101")
  })
})

describe("frombits(bitArray) — convert bit-string chunks to Uint8Array", () => {
  it("empty bit array → empty Uint8Array", () => {
    assert.equal(frombits([]).length, 0)
  })
  it("['00000000'] → [0]", () => {
    assert.deepEqual(Array.from(frombits(["00000000"])), [0])
  })
  it("['11111111'] → [255]", () => {
    assert.deepEqual(Array.from(frombits(["11111111"])), [255])
  })
  it("padded with zeros to byte boundary", () => {
    // 5 bits "10101" padded to 8: 10101000 = 0xa8
    assert.deepEqual(Array.from(frombits(["10101"])), [0xa8])
  })
  it("multiple chunks concatenate", () => {
    assert.deepEqual(Array.from(frombits(["1010", "1010"])), [0xaa])
  })
  it("frombits(tobits(arr)) round-trips", () => {
    for (const arr of [[0], [0xff], [0xab, 0xcd], [1, 2, 3, 4, 5]]) {
      const back = frombits(tobits(arr))
      assert.deepEqual(Array.from(back), arr)
    }
  })
})

describe("getPrecision(v) — decimal places after dot", () => {
  const cases = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [100, 0],
    [-100, 0],
    [0.1, 1],
    [0.5, 1],
    [-0.5, 1],
    [0.01, 2],
    [0.001, 3],
    [0.0001, 4],
    [1.5, 1],
    [3.14, 2],
    [-3.14, 2],
    [3.14159, 5],
    [1e-7, 7],
    [1e-10, 10],
    [1.5e-10, 11],
    [1e-15, 15],
    [1e10, 0],
    [1e20, 0],
    [1e100, 0],
    [-1e-10, 10],
  ]
  for (const [v, expected] of cases) {
    it(`getPrecision(${v}) === ${expected}`, () => {
      assert.equal(getPrecision(v), expected)
    })
  }
})

describe("escapeKey(k) — escape brackets and backslashes", () => {
  const cases = [
    ["", ""],
    ["plain", "plain"],
    ["a", "a"],
    ["abc", "abc"],
    ["data[2020]", "data\\[2020\\]"],
    ["user[admin]", "user\\[admin\\]"],
    ["a[b]c", "a\\[b\\]c"],
    ["[only]", "\\[only\\]"],
    ["a\\b", "a\\\\b"],
    ["a\\\\b", "a\\\\\\\\b"],
    ["a\\[b", "a\\\\\\[b"],
    ["a.b", "a.b"],
    ["a b", "a b"],
    ["@#$%", "@#$%"],
  ]
  for (const [input, expected] of cases) {
    it(`escapeKey(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(escapeKey(input), expected)
    })
  }
})

describe("parsePath(p) — split path string into segments", () => {
  const cases = [
    ["", []],
    [".", []],
    ["..", []],
    ["...", []],
    ["a", ["a"]],
    ["a.b", ["a", "b"]],
    ["a.b.c", ["a", "b", "c"]],
    ["a..b", ["a", "b"]],
    [".a", ["a"]],
    ["a.", ["a"]],
    ["[0]", [0]],
    ["[42]", [42]],
    ["a[0]", ["a", 0]],
    ["a[0].b", ["a", 0, "b"]],
    ["a[0][1]", ["a", 0, 1]],
    ["[0][1][2]", [0, 1, 2]],
    ["a.b[3].c", ["a", "b", 3, "c"]],
    // Bracket content non-numeric → part of key
    ["user[admin]", ["user[admin]"]],
    ["a[b]c", ["a[b]c"]],
    ["config[prod][eu-west]", ["config[prod][eu-west]"]],
    // Escape sequences
    ["data\\[2020\\]", ["data[2020]"]],
    ["a\\[0\\]", ["a[0]"]],
    ["a\\\\b", ["a\\b"]],
    // Mixed
    ["a\\[2020\\].b[3]", ["a[2020]", "b", 3]],
    // Unmatched brackets
    ["[unclosed", ["[unclosed"]],
    ["closed]without_open", ["closed]without_open"]],
    ["[]", ["[]"]],
  ]
  for (const [input, expected] of cases) {
    it(`parsePath(${JSON.stringify(input)})`, () => {
      assert.deepEqual(parsePath(input), expected)
    })
  }
})

describe("parsePath ↔ escapeKey round-trip", () => {
  const keys = [
    "plain",
    "with[bracket]",
    "with[2020]",
    "data\\backslash",
    "[justbracket]",
    "[123]",
    "x[a][b]",
    "a",
    "Z",
    "_",
    "-",
    "a b",
    "@#$%",
  ]
  for (const k of keys) {
    it(`parsePath(escapeKey(${JSON.stringify(k)})) === [${JSON.stringify(k)}]`, () => {
      assert.deepEqual(parsePath(escapeKey(k)), [k])
    })
  }
})

describe("strmap (alphabetical charmap)", () => {
  it("contains every uppercase letter A–Z at indices 0–25", () => {
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i)
      assert.equal(strmap[c], i, `${c} should be at index ${i}`)
    }
  })
  it("contains every lowercase letter a–z at indices 26–51", () => {
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(97 + i)
      assert.equal(strmap[c], 26 + i, `${c} should be at index ${26 + i}`)
    }
  })
  it("does not contain digits", () => {
    assert.equal(strmap["0"], undefined)
    assert.equal(strmap["9"], undefined)
  })
  it("does not contain punctuation", () => {
    for (const c of " !@#$%^&*()-_=+") {
      assert.equal(strmap[c], undefined, `${c} unexpectedly mapped`)
    }
  })
})

describe("strmap_rev (reverse charmap, indexed by string-of-int)", () => {
  it("reverse-maps strmap correctly for every entry", () => {
    for (const c in strmap) {
      assert.equal(strmap_rev[strmap[c].toString()], c)
    }
  })
})

describe("base64 / base64_rev (URL-safe base64 charmap)", () => {
  it("contains all alphabetical letters", () => {
    for (let i = 0; i < 26; i++) {
      const upper = String.fromCharCode(65 + i)
      const lower = String.fromCharCode(97 + i)
      assert.notEqual(base64[upper], undefined, `${upper} missing`)
      assert.notEqual(base64[lower], undefined, `${lower} missing`)
    }
  })
  it("contains digits 0–9", () => {
    for (let i = 0; i < 10; i++) {
      assert.notEqual(base64[i.toString()], undefined, `${i} missing`)
    }
  })
  it("contains URL-safe replacements - and _", () => {
    assert.notEqual(base64["-"], undefined)
    assert.notEqual(base64["_"], undefined)
  })
  it("does not contain + or /", () => {
    assert.equal(base64["+"], undefined)
    assert.equal(base64["/"], undefined)
  })
  it("base64_rev round-trips with base64", () => {
    for (const c in base64) {
      assert.equal(base64_rev[base64[c].toString()], c)
    }
  })
  it("64 total entries", () => {
    assert.equal(Object.keys(base64).length, 64)
    assert.equal(Object.keys(base64_rev).length, 64)
  })
})
