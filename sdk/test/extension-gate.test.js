// Asserts the structural reservation: no encodable JSON value produces a
// payload beginning with five or more zero bits.
//
// Background: the byte-stream prefix `00000` would mean
//   bit 0 = 0       → structured mode
//   bits 1–2 = 00   → "short" encoding selector for value count (2 bits)
//   bits 3–4 = 00   → value count = 0
// which is contradictory: empty `{}` and `[]` use the single-mode primitive
// codes, and any non-empty object or array has ≥ 1 value. The encoder is
// therefore expected to never emit a stream starting with `00000`.
//
// This test enumerates many representative inputs and seeded fuzz, checking
// that the first byte's top 5 bits are never all zero.

import { describe, it } from "node:test"
import assert from "assert"
import { enc, ARJSON } from "../src/arjson.js"
import W from "./bench-workloads.js"

function topFiveBits(buf) {
  if (!buf || buf.length === 0) return -1
  return (buf[0] >> 3) & 0x1f
}

function assertGateInvariant(json, label) {
  const buf = Buffer.from(enc(json))
  const top5 = topFiveBits(buf)
  assert.notEqual(
    top5,
    0,
    `${label}: encoded payload starts with five zero bits ` +
      `(byte 0 = 0x${buf[0].toString(16).padStart(2, "0")}). ` +
      `This violates the extension-gate reservation.`,
  )
}

describe("extension gate — leading 00000 is unreachable", () => {
  it("primitive values never trigger the gate", () => {
    const samples = [
      null, true, false, "", 0, 1, -1, 63, 64, 1024,
      "x", "abc", "hello world",
      0.1, -0.1, 3.14, 1e-10, 1e20,
      [], {},
    ]
    for (const v of samples) assertGateInvariant(v, JSON.stringify(v))
  })

  it("structured values never trigger the gate", () => {
    const samples = [
      { a: 1 },
      { a: 1, b: 2 },
      [1],
      [1, 2, 3],
      { a: { b: { c: 1 } } },
      [{ a: 1 }, { b: 2 }],
      { a: [], b: {} },
      { a: [{}], b: [{}] },
    ]
    for (const v of samples) assertGateInvariant(v, JSON.stringify(v))
  })

  it("all 34 bench workloads respect the gate", () => {
    for (const [name, data] of Object.entries(W)) {
      assertGateInvariant(data, name)
    }
  })

  it("delta-chain buffers respect the gate", () => {
    const a = new ARJSON({ json: { count: 0 } })
    for (let i = 1; i <= 20; i++) a.update({ count: i })
    const buf = Buffer.from(a.toBuffer())
    // Each delta in the chain is length-prefixed; the chain itself starts
    // with a varint length (≥ 1, MSB set if ≥ 128). For tiny deltas the
    // length byte is < 128, so byte 0 is the length itself, not the
    // payload — but the length being 0 would also be invalid. Assert
    // length byte ≠ 0.
    assert.notEqual(buf[0], 0, "delta chain length-prefix byte must be ≥ 1")
  })

  it("seeded fuzz: 1000 random JSONs respect the gate", () => {
    const prng = (seed) => {
      let s = seed >>> 0
      return () => {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    const randomString = (rng, len) => {
      let s = ""
      for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)]
      return s
    }
    const randomPrimitive = (rng) => {
      const r = rng()
      if (r < 0.1) return null
      if (r < 0.2) return rng() < 0.5
      if (r < 0.45) return Math.floor(rng() * 1000) - 500
      if (r < 0.6) return Math.round((rng() * 200 - 100) * 100) / 100
      return randomString(rng, 1 + Math.floor(rng() * 12))
    }
    const randomJSON = (rng, depth = 0) => {
      if (depth >= 3) return randomPrimitive(rng)
      const r = rng()
      if (r < 0.15) return randomPrimitive(rng)
      if (r < 0.55) {
        const n = Math.floor(rng() * 5) + 1
        const o = {}
        for (let i = 0; i < n; i++) {
          o[randomString(rng, 1 + Math.floor(rng() * 6))] = randomJSON(rng, depth + 1)
        }
        return o
      }
      const n = Math.floor(rng() * 5) + 1
      const a = []
      for (let i = 0; i < n; i++) a.push(randomJSON(rng, depth + 1))
      return a
    }

    const rng = prng(0xCAFE)
    for (let i = 0; i < 1000; i++) {
      const j = randomJSON(rng)
      assertGateInvariant(j, `iter ${i}: ${JSON.stringify(j).slice(0, 80)}`)
    }
  })
})
