// Long-running fuzz stress runner. Not part of `npm test` — run manually.
//
// Iterates property-based tests with a much larger budget than fuzz.test.js
// to surface rare bugs. Tracks heap usage to detect memory leaks. Logs the
// first failing input and attempts to shrink it.
//
// Usage:
//   node test/fuzz-stress.js                    # 1M iterations, default seed
//   node test/fuzz-stress.js 5000000 0xC0FFEE   # custom budget + seed
//   node test/fuzz-stress.js round-trip 1e7     # only round-trip property
//
// Properties:
//   round-trip       — dec(enc(x)) ≡ x for all valid x
//   determinism      — enc(x) === enc(x), bit-identical
//   delta-replay     — chain produces final state via buffer round-trip
//   mutation-chain   — random mutations preserve invariants
//   decoder-robust   — random bytes don't hang or crash
//   all              — interleave all properties (default)

import { equals } from "../src/utils.js"
import { ARJSON, enc, dec } from "../src/arjson.js"

const args = process.argv.slice(2)
let mode = "all"
let budget = 1_000_000
let seed = 0xC0FFEE

for (const arg of args) {
  if (arg === "round-trip" || arg === "determinism" || arg === "delta-replay" ||
      arg === "mutation-chain" || arg === "decoder-robust" || arg === "all") {
    mode = arg
  } else if (/^0x/i.test(arg)) {
    seed = parseInt(arg, 16)
  } else if (/^[0-9.eE+-]+$/.test(arg)) {
    budget = Math.floor(Number(arg))
  }
}

console.log(`fuzz-stress: mode=${mode} budget=${budget} seed=0x${seed.toString(16)}`)

// ─── seeded PRNG ──────────────────────────────────────────────────────────

let s = seed >>> 0
function rng() {
  s = (s + 0x6d2b79f5) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
const randomString = (len) => {
  let r = ""
  for (let i = 0; i < len; i++) r += ALPHA[Math.floor(rng() * ALPHA.length)]
  return r
}
const randomKey = () => randomString(1 + Math.floor(rng() * 8))
const randomPrimitive = () => {
  const r = rng()
  if (r < 0.1) return null
  if (r < 0.2) return rng() < 0.5
  if (r < 0.45) return Math.floor(rng() * 1000) - 500
  if (r < 0.6) return Math.round((rng() * 200 - 100) * 100) / 100
  return randomString(1 + Math.floor(rng() * 12))
}
const randomJSON = (depth = 0, maxDepth = 4) => {
  if (depth >= maxDepth) return randomPrimitive()
  const r = rng()
  if (r < 0.15) return randomPrimitive()
  if (r < 0.55) {
    const n = Math.floor(rng() * 5) + 1
    const o = {}
    for (let i = 0; i < n; i++) o[randomKey()] = randomJSON(depth + 1, maxDepth)
    return o
  }
  const n = Math.floor(rng() * 5) + 1
  const a = []
  for (let i = 0; i < n; i++) a.push(randomJSON(depth + 1, maxDepth))
  return a
}
const sanitize = (x) => {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) return null
    if (Object.is(x, -0)) return 0
  }
  if (Array.isArray(x)) return x.map(sanitize)
  if (x && typeof x === "object") {
    const out = {}
    for (const k of Object.keys(x)) out[k] = sanitize(x[k])
    return out
  }
  return x
}
const mutate = (x) => {
  const op = Math.floor(rng() * 8)
  if (Array.isArray(x)) {
    const c = x.slice()
    if (op === 0 && c.length > 0) c.pop()
    else if (op === 1) c.push(randomPrimitive())
    else if (op === 2 && c.length > 0) c[Math.floor(rng() * c.length)] = randomPrimitive()
    else if (op === 3 && c.length > 0) c.splice(Math.floor(rng() * c.length), 1)
    else if (op === 4 && c.length > 0) {
      const idx = Math.floor(rng() * c.length)
      c[idx] = mutate(c[idx])
    } else if (op === 5) c.push(randomJSON(0, 2))
    else if (op === 6 && c.length >= 2) {
      const i = Math.floor(rng() * c.length)
      const j = Math.floor(rng() * c.length)
      ;[c[i], c[j]] = [c[j], c[i]]
    } else return [...c, randomPrimitive()]
    return c
  }
  if (x && typeof x === "object") {
    const c = { ...x }
    const ks = Object.keys(c)
    if (op === 0) c[randomKey()] = randomPrimitive()
    else if (op === 1 && ks.length > 0) delete c[ks[Math.floor(rng() * ks.length)]]
    else if (op === 2 && ks.length > 0) {
      const k = ks[Math.floor(rng() * ks.length)]
      c[k] = randomPrimitive()
    } else if (op === 3 && ks.length > 0) {
      const k = ks[Math.floor(rng() * ks.length)]
      c[k] = mutate(c[k])
    } else if (op === 4) c[randomKey()] = randomJSON(0, 2)
    else if (op === 5 && ks.length > 0) {
      const k = ks[Math.floor(rng() * ks.length)]
      c[k] = randomJSON(0, 2)
    } else c[randomKey()] = randomPrimitive()
    return c
  }
  return randomPrimitive()
}

// ─── shrinker ─────────────────────────────────────────────────────────────

function* shrinkCandidates(x) {
  if (Array.isArray(x)) {
    if (x.length > 0) yield []
    if (x.length > 1) {
      for (let i = 0; i < x.length; i++) {
        const c = x.slice()
        c.splice(i, 1)
        yield c
      }
    }
    for (let i = 0; i < x.length; i++) {
      for (const sub of shrinkCandidates(x[i])) {
        const c = x.slice()
        c[i] = sub
        yield c
      }
    }
  } else if (x && typeof x === "object") {
    const ks = Object.keys(x)
    if (ks.length > 0) yield {}
    if (ks.length > 1) {
      for (const k of ks) {
        const c = { ...x }
        delete c[k]
        yield c
      }
    }
    for (const k of ks) {
      for (const sub of shrinkCandidates(x[k])) {
        yield { ...x, [k]: sub }
      }
    }
  } else if (typeof x === "string" && x.length > 0) {
    yield ""
    if (x.length > 1) yield x.slice(0, Math.floor(x.length / 2))
  } else if (typeof x === "number" && x !== 0) {
    yield 0
  }
}

const shrink = (x, fails, maxAttempts = 500) => {
  let best = x
  let attempts = 0
  let changed = true
  while (changed && attempts < maxAttempts) {
    changed = false
    for (const c of shrinkCandidates(best)) {
      attempts++
      if (attempts >= maxAttempts) break
      try {
        if (fails(c)) {
          best = c
          changed = true
          break
        }
      } catch {
        best = c
        changed = true
        break
      }
    }
  }
  return best
}

// ─── properties ───────────────────────────────────────────────────────────

const fail = (label, input, fails) => {
  console.error(`\n${label} FAILED at iter ${i}:`)
  console.error(`  input: ${JSON.stringify(input).slice(0, 200)}`)
  const min = shrink(input, fails)
  console.error(`  shrunk to: ${JSON.stringify(min)}`)
  process.exit(1)
}

const propRoundTrip = (x) => {
  if (!equals(dec(enc(x)), x)) {
    fail("round-trip", x, (v) => !equals(dec(enc(v)), v))
  }
}

const propDeterminism = (x) => {
  const a = enc(x)
  const b = enc(x)
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
    fail("determinism", x, (v) => {
      const ea = enc(v)
      const eb = enc(v)
      return Buffer.compare(Buffer.from(ea), Buffer.from(eb)) !== 0
    })
  }
}

const propDeltaReplay = (states) => {
  const a = new ARJSON({ json: states[0] })
  for (const s of states.slice(1)) a.update(s)
  const final = states[states.length - 1]
  if (!equals(a.json, final)) {
    fail("delta-replay live", states, () => false)
  }
  const b = new ARJSON({ arj: a.toBuffer() })
  if (!equals(b.json, final)) {
    fail("delta-replay buffer", states, () => false)
  }
}

const propMutationChain = (initial, n) => {
  let cur = initial
  const a = new ARJSON({ json: cur })
  const states = [cur]
  for (let step = 0; step < n; step++) {
    cur = sanitize(mutate(cur))
    states.push(cur)
    a.update(cur)
    if (!equals(a.json, cur)) {
      console.error(`\nmutation-chain FAILED at iter ${i} step ${step}`)
      console.error(`  expected: ${JSON.stringify(cur).slice(0, 200)}`)
      console.error(`  got     : ${JSON.stringify(a.json).slice(0, 200)}`)
      console.error(`  full chain: ${states.length} states`)
      console.error(`  states[0]:  ${JSON.stringify(states[0]).slice(0, 100)}`)
      console.error(`  failing:    ${JSON.stringify(cur).slice(0, 100)}`)
      process.exit(1)
    }
  }
}

const propDecoderRobust = (buf) => {
  // Must not hang or crash. Result content irrelevant.
  try { dec(buf) } catch { /* ok */ }
}

// ─── runner ───────────────────────────────────────────────────────────────

let i = 0
const t0 = Date.now()
const reportEvery = Math.max(1000, Math.floor(budget / 100))
const heap0 = process.memoryUsage().heapUsed

while (i < budget) {
  if (mode === "all" || mode === "round-trip") {
    propRoundTrip(sanitize(randomJSON(0, 3)))
  }
  if (mode === "all" || mode === "determinism") {
    propDeterminism(sanitize(randomJSON(0, 3)))
  }
  if (mode === "all" || mode === "delta-replay") {
    const len = 2 + Math.floor(rng() * 6)
    const states = []
    for (let j = 0; j < len; j++) states.push(sanitize(randomJSON(0, 2)))
    propDeltaReplay(states)
  }
  if (mode === "all" || mode === "mutation-chain") {
    propMutationChain(sanitize(randomJSON(0, 2)), 5 + Math.floor(rng() * 15))
  }
  if (mode === "all" || mode === "decoder-robust") {
    const len = 1 + Math.floor(rng() * 64)
    const buf = Buffer.alloc(len)
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256)
    propDecoderRobust(buf)
  }

  i++
  if (i % reportEvery === 0) {
    const elapsed = (Date.now() - t0) / 1000
    const rate = i / elapsed
    const heap = process.memoryUsage().heapUsed
    const heapDelta = ((heap - heap0) / 1024 / 1024).toFixed(1)
    const eta = ((budget - i) / rate).toFixed(0)
    process.stderr.write(
      `[${i}/${budget} ${(i / budget * 100).toFixed(1)}% ${rate.toFixed(0)}/s heap=+${heapDelta}MB eta=${eta}s]\n`,
    )
    if (typeof globalThis.gc === "function") globalThis.gc()
  }
}

const elapsed = (Date.now() - t0) / 1000
console.log(`\nALL ${budget} iterations passed in ${elapsed.toFixed(1)}s (${(budget / elapsed).toFixed(0)}/s)`)
