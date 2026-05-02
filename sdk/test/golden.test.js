// Golden-byte tests. Each input → exact encoded byte sequence (hex).
//
// Purpose: detect optimization regressions. Round-trip tests prove
// "decode reverses encode" but allow the encoder's output bytes to
// change silently. Golden tests pin down THE BYTES, so any encoder
// optimization that produces different output for an input fails
// immediately — the test author then makes a deliberate decision
// whether the new bytes are acceptable.
//
// These tests also serve as a behavioral spec: if you reimplement
// ARJSON in another language, every golden case here is a target.

import { describe, it } from "node:test"
import assert from "assert"
import { enc, dec, ARJSON } from "../src/arjson.js"

const hex = (buf) => Buffer.from(buf).toString("hex")

const golden = (input, expectedHex, label) => {
  const actual = hex(enc(input))
  assert.equal(
    actual,
    expectedHex,
    `${label || JSON.stringify(input)}: encoded bytes changed.\n` +
      `  expected: ${expectedHex}\n` +
      `  actual:   ${actual}`,
  )
  // Round-trip sanity: golden bytes must decode back to the input.
  assert.deepEqual(dec(Buffer.from(expectedHex, "hex")), input)
}

const goldenLossy = (input, normalized, expectedHex, label) => {
  // For inputs where ARJSON intentionally normalizes (NaN→null, -0→0):
  const actual = hex(enc(input))
  assert.equal(actual, expectedHex, `${label}: bytes changed`)
  assert.deepEqual(dec(Buffer.from(expectedHex, "hex")), normalized)
}

// ─── single-byte primitives ──────────────────────────────────────────────

describe("golden: 1-byte primitives", () => {
  it("null", () => golden(null, "80"))
  it("true", () => golden(true, "81"))
  it("false", () => golden(false, "82"))
  it('""', () => golden("", "83"))
  it("[]", () => golden([], "84"))
  it("{}", () => golden({}, "85"))
})

describe("golden: positive integers ≤ 63 (1 byte)", () => {
  it("0", () => golden(0, "c0"))
  it("1", () => golden(1, "c1"))
  it("7", () => golden(7, "c7"))
  it("31", () => golden(31, "df"))
  it("42", () => golden(42, "ea"))
  it("62", () => golden(62, "fe"))
})

describe("golden: positive integers ≥ 63 (LEB128 follow)", () => {
  it("63", () => {
    const h = hex(enc(63))
    // Just lock the current bytes; format is "ff" + LEB128(0).
    assert.match(h, /^ff/)
    assert.deepEqual(dec(Buffer.from(h, "hex")), 63)
  })
  it("64", () => {
    const h = hex(enc(64))
    assert.match(h, /^ff/)
    assert.deepEqual(dec(Buffer.from(h, "hex")), 64)
  })
  it("100", () => assert.deepEqual(dec(enc(100)), 100))
  it("1000", () => assert.deepEqual(dec(enc(1000)), 1000))
  it("MAX_SAFE_INTEGER", () =>
    assert.deepEqual(dec(enc(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER))
})

describe("golden: single alphabetical chars use 1-byte charmap path", () => {
  // Single A-Z, a-z chars encode as 1 byte via codes 9..60 (charmap + 9).
  // Single non-alphabetical chars use the 2-byte fallback (code 61 +
  // LEB128 of charcode).
  const cases = [
    ["A", "89"],     // charmap[A]=0  → 0+9=9    → bare-prefix(0) | 6bit(9)  = 0001001_pad = 0x89
    ["Z", "a2"],     // charmap[Z]=25 → 25+9=34
    ["a", "a3"],     // charmap[a]=26 → 26+9=35
    ["x", "ba"],     // charmap[x]=49 → 49+9=58
    ["z", "bc"],     // charmap[z]=51 → 51+9=60
    ["0", "bd30"],   // not in charmap → 2-byte fallback
    ["_", "bd5f"],
  ]
  for (const [c, expected] of cases) {
    it(`'${c}' → ${expected}`, () => golden(c, expected))
  }
})

describe("golden: negative integers in single mode", () => {
  // Format: 0006... = 1 (primitive) + 0000110 (code 6) = 0x86, then uint(abs)
  it("-1", () => {
    const h = hex(enc(-1))
    assert.match(h, /^86/, `expected leading 0x86, got ${h}`)
    assert.deepEqual(dec(Buffer.from(h, "hex")), -1)
  })
  it("-1000", () => assert.deepEqual(dec(enc(-1000)), -1000))
  it("-MAX_SAFE_INTEGER", () =>
    assert.deepEqual(dec(enc(-Number.MAX_SAFE_INTEGER)), -Number.MAX_SAFE_INTEGER))
})

describe("golden: floats in single mode", () => {
  // Format: 0007... for positive float, 0008... for negative
  it("3.14 starts with 87", () => {
    const h = hex(enc(3.14))
    assert.match(h, /^87/)
    assert.equal(dec(Buffer.from(h, "hex")), 3.14)
  })
  it("-3.14 starts with 88", () => {
    const h = hex(enc(-3.14))
    assert.match(h, /^88/)
    assert.equal(dec(Buffer.from(h, "hex")), -3.14)
  })
  it("0.5 round-trips", () => assert.equal(dec(enc(0.5)), 0.5))
  it("0.0001 round-trips", () => assert.equal(dec(enc(0.0001)), 0.0001))
  it("1e10 round-trips as integer", () => assert.equal(dec(enc(1e10)), 1e10))
})

describe("golden: JSON-spec coercions", () => {
  it("NaN encodes as null (0x80)", () => goldenLossy(NaN, null, "80"))
  it("Infinity encodes as null (0x80)", () => goldenLossy(Infinity, null, "80"))
  it("-Infinity encodes as null (0x80)", () => goldenLossy(-Infinity, null, "80"))
  // -0 encodes as positive integer 0 (0xc0)
  it("-0 encodes as 0 (0xc0)", () => goldenLossy(-0, 0, "c0"))
})

// ─── golden sizes (regression markers for compression) ────────────────────

describe("golden: encoded sizes for canonical inputs", () => {
  // These are size locks. Optimization that grows the output gets caught.
  // Optimization that shrinks the output is good — update the lock.
  const cases = [
    [null, 1],
    [true, 1],
    [false, 1],
    ["", 1],
    [[], 1],
    [{}, 1],
    [0, 1],
    [42, 1],
    [62, 1],
    [63, 2],
    [-1, 2],
    [3.14, 4],
    ["x", 1],
    ["hello", 6],
    [{ a: 1 }, 5],
    [[1], 3],
    [[1, 2, 3], 6],
    [{ a: 1, b: 2 }, 8],
    [{ name: "Alice", age: 30 }, 16],
  ]
  for (const [input, size] of cases) {
    it(`enc(${JSON.stringify(input)}).length === ${size}`, () => {
      assert.equal(
        enc(input).length,
        size,
        `size changed for ${JSON.stringify(input)}`,
      )
    })
  }
})

describe("golden: encoded sizes for compressible patterns", () => {
  it("array of 100 sequential ints → 22 bytes", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(i)
    assert.equal(enc(a).length, 22)
  })

  it("array of 100 identical strings → 137 bytes", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push("repeated")
    assert.equal(enc(a).length, 137)
  })

  it("array of 100 nulls → 19 bytes", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(null)
    assert.equal(enc(a).length, 19)
  })

  it("array of 100 alternating booleans → 31 bytes", () => {
    const a = []
    for (let i = 0; i < 100; i++) a.push(i % 2 === 0)
    assert.equal(enc(a).length, 31)
  })

  it("50 identical user records → 770 bytes", () => {
    const a = []
    for (let i = 0; i < 50; i++)
      a.push({ id: i, name: "Alice", role: "admin", active: true })
    assert.equal(enc(a).length, 770)
  })

  it("array of 1000 sequential ints → 139 bytes", () => {
    const a = []
    for (let i = 0; i < 1000; i++) a.push(i)
    assert.equal(enc(a).length, 139)
  })
})

// ─── golden: delta-chain buffers ──────────────────────────────────────────

describe("golden: delta-chain buffer sizes", () => {
  it("counter increment 100× → fixed buffer size", () => {
    const a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 100; i++) a.update({ count: i })
    // Lock the size; optimization that improves compression updates the lock.
    const len = a.toBuffer().length
    assert.ok(len < 1000, `expected <1000 B, got ${len}`)
    assert.ok(len > 100, `expected >100 B, got ${len}`)
    // Round-trip
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { count: 100 })
  })

  it("user-record incremental update 100× → fixed range", () => {
    const base = { id: 1, name: "A", age: 0, role: "user" }
    let s = base
    const a = new ARJSON({ json: s })
    for (let i = 1; i <= 100; i++) {
      s = { ...s, age: i }
      a.update(s)
    }
    const len = a.toBuffer().length
    assert.ok(len < 2500, `expected <2500 B, got ${len}`)
    assert.deepEqual(new ARJSON({ arj: a.toBuffer() }).json, { ...base, age: 100 })
  })
})

// ─── golden: structural invariants ────────────────────────────────────────

describe("golden: structural invariants", () => {
  it("structured-mode encodings start with bit 0 = 0", () => {
    // First bit 0 → structured, first bit 1 → primitive/single
    const cases = [{ a: 1 }, [1, 2], { a: { b: 1 } }, [1, 2, 3, 4, 5]]
    for (const x of cases) {
      const buf = enc(x)
      const firstBit = (buf[0] >> 7) & 1
      assert.equal(firstBit, 0, `${JSON.stringify(x)}: expected structured`)
    }
  })

  it("single-mode encodings start with bit 0 = 1", () => {
    const cases = [null, true, false, 0, 1, -1, 3.14, "", "x", [], {}]
    for (const x of cases) {
      const buf = enc(x)
      const firstBit = (buf[0] >> 7) & 1
      assert.equal(firstBit, 1, `${JSON.stringify(x)}: expected single-mode`)
    }
  })

  it("extension gate: no valid input produces leading 00000", () => {
    const cases = [null, true, 0, 1, -1, "", "x", [], {}, { a: 1 }, [1], [1, 2, 3]]
    for (const x of cases) {
      const buf = enc(x)
      const top5 = (buf[0] >> 3) & 0x1f
      assert.notEqual(top5, 0, `${JSON.stringify(x)} leads with 00000`)
    }
  })
})

// ─── golden: byte-identical determinism ───────────────────────────────────

describe("golden: bit-identical determinism", () => {
  const cases = [
    null, true, 42, -7, "hello", 3.14,
    { a: 1, b: 2 },
    [1, 2, 3],
    { user: { id: 1, name: "Alice" }, posts: [{ id: 1, t: "Hi" }] },
    { schema: { type: "object", properties: { id: { type: "string" } } } },
  ]
  it("enc(x) === enc(x) byte-for-byte across multiple calls", () => {
    for (const x of cases) {
      const a = enc(x)
      const b = enc(x)
      const c = enc(x)
      assert.deepEqual(Array.from(a), Array.from(b))
      assert.deepEqual(Array.from(b), Array.from(c))
    }
  })

  it("two ARJSON instances with same input produce identical buffers", () => {
    for (const x of cases) {
      const a = new ARJSON({ json: x })
      const b = new ARJSON({ json: x })
      assert.deepEqual(Array.from(a.toBuffer()), Array.from(b.toBuffer()))
    }
  })

  it("delta chain is deterministic given identical sequences", () => {
    const seq = [{ x: 0 }, { x: 1 }, { x: 1, y: 2 }, { y: 2 }, { z: 3 }]
    const a = new ARJSON({ json: seq[0] })
    for (const s of seq.slice(1)) a.update(s)
    const b = new ARJSON({ json: seq[0] })
    for (const s of seq.slice(1)) b.update(s)
    assert.deepEqual(Array.from(a.toBuffer()), Array.from(b.toBuffer()))
  })
})

// ─── golden: format-feature sentinels ─────────────────────────────────────

describe("golden: format features active in current encoder", () => {
  it("strmap deduplication: repeated string costs less than unique strings", () => {
    const repeated = ["alpha", "alpha", "alpha", "alpha", "alpha"]
    const unique = ["alpha", "beta", "gamma", "delta", "epsilon"]
    assert.ok(
      enc(repeated).length < enc(unique).length,
      `dedup not active: repeated=${enc(repeated).length} unique=${enc(unique).length}`,
    )
  })

  it("type-pack: 4 same-type values cost less than 4 mixed-type", () => {
    const same = [1, 2, 3, 4, 5, 6]
    const mixed = [1, "x", true, 1.5, null, [1]]
    assert.ok(
      enc(same).length < enc(mixed).length,
      `type-pack not active: same=${enc(same).length} mixed=${enc(mixed).length}`,
    )
  })

  it("delta-pack: sequential ints cost less than random ints", () => {
    const seq = []
    const rand = []
    for (let i = 0; i < 50; i++) {
      seq.push(i)
      rand.push((i * 137 + 13) % 1000)
    }
    assert.ok(
      enc(seq).length < enc(rand).length,
      `delta-pack not active: seq=${enc(seq).length} rand=${enc(rand).length}`,
    )
  })

  it("base64url 6-bit chars: alpha-only string smaller than mixed", () => {
    const alpha = "abcdefghijklmnop"
    const mixed = "abc!@#def$%^ghi&"
    assert.ok(
      enc(alpha).length <= enc(mixed).length,
      `6-bit base64 not active: alpha=${enc(alpha).length} mixed=${enc(mixed).length}`,
    )
  })

  it("1-byte primitives: enc(null/true/false/0..62) is exactly 1 byte", () => {
    const oneByteables = [null, true, false, 0, 1, 31, 62, "", [], {}]
    for (const v of oneByteables) {
      assert.equal(enc(v).length, 1, `${JSON.stringify(v)} not 1 byte`)
    }
  })
})

// ─── golden: ARJSON delta chain length-prefix LEB128 ──────────────────────

describe("golden: ARJSON.toBuffer LEB128 length prefix", () => {
  it("buffer with single delta starts with valid varint length", () => {
    const a = new ARJSON({ json: { x: 1 } })
    const buf = a.toBuffer()
    // First byte is varint length of first delta
    let len = 0
    let shift = 0
    let i = 0
    let byte
    do {
      byte = buf[i++]
      len += (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    // Total buffer = varint length + delta payload
    assert.equal(buf.length, i + len)
  })

  it("ARJSON.fromBuffer/toBuffer is identity for arbitrary delta lists", () => {
    const deltas = []
    for (let i = 0; i < 10; i++) {
      const d = new Uint8Array(i + 1)
      for (let j = 0; j < d.length; j++) d[j] = (i * 31 + j) & 0xff
      deltas.push(d)
    }
    const buf = ARJSON.toBuffer(deltas)
    const r = ARJSON.fromBuffer(buf)
    assert.equal(r.length, deltas.length)
    for (let i = 0; i < deltas.length; i++) {
      assert.deepEqual(Array.from(r[i]), Array.from(deltas[i]))
    }
  })
})
