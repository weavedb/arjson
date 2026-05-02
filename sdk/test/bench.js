// Comprehensive side-by-side benchmark.
// arjson-orig (master, src-orig/) vs arjson-fixed (src/) vs @msgpack/msgpack vs JSON.
//
// Each measurement runs in a forked child process with a hard wall-clock
// timeout, so workloads that infinite-loop or OOM in any one library don't
// kill the benchmark — they're reported as TIMEOUT/ERROR.

import { spawnSync } from "child_process"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER = join(__dirname, "bench-worker.js")

const ITER_BASE = parseInt(process.argv[2] ?? "2000", 10)
const TIMEOUT_MS = 8000

const fmt = nsec => (nsec / 1e6).toFixed(2)
const pad = (s, n, right = false) => {
  s = String(s)
  if (s.length >= n) return s
  return right ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}
const fmtPct = (newV, oldV) => {
  if (oldV <= 0 || newV < 0) return "—"
  const pct = ((newV - oldV) / oldV) * 100
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

const iterFor = data => {
  const size = JSON.stringify(data).length
  if (size > 5000) return Math.max(20, Math.floor(ITER_BASE / 100))
  if (size > 1500) return Math.max(50, Math.floor(ITER_BASE / 20))
  if (size > 500) return Math.max(200, Math.floor(ITER_BASE / 5))
  return ITER_BASE
}

// Run one measurement in a forked worker; -1 = timeout, -2 = error.
function measure(lib, op, data, n) {
  const r = spawnSync(
    process.execPath,
    [WORKER],
    {
      input: JSON.stringify({ lib, op, data, n }),
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (r.signal === "SIGTERM" || r.error) return { status: "TIMEOUT" }
  if (r.status !== 0) return { status: "ERROR", msg: r.stderr.slice(0, 200) }
  try {
    const out = JSON.parse(r.stdout)
    if (out.error) return { status: "ERROR", msg: out.error }
    return { status: "OK", ns: out.ns, size: out.size }
  } catch (e) {
    return { status: "ERROR", msg: "bad-output" }
  }
}

// ─── workloads ─────────────────────────────────────────────────────────────

const W = {
  null_: null,
  true_: true,
  int_small: 42,
  int_neg: -1234567,
  string_short: "hello",
  string_med: "The quick brown fox jumps over the lazy dog",
  string_long: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
  float: 3.14159,

  tiny_obj: { a: 1, b: 2 },
  tiny_arr: [1, 2, 3],

  user_record: {
    id: 12345,
    username: "alice",
    name: "Alice Johnson",
    email: "alice@example.com",
    age: 30,
    active: true,
    role: "admin",
    tags: ["staff", "verified"],
    preferences: { theme: "dark", notifications: true, language: "en" },
  },

  log_entry: {
    ts: 1709876543210,
    level: "info",
    service: "api-gateway",
    method: "POST",
    path: "/v1/users",
    status: 200,
    duration_ms: 47.3,
    user_id: "u_8f3a92",
    request_id: "r_19283abc",
  },

  config_doc: {
    server: { host: "0.0.0.0", port: 8080, ssl: true, timeout_ms: 30000 },
    database: { host: "db.internal", port: 5432, name: "prod", pool_size: 20 },
    cache: { enabled: true, ttl_s: 3600, max_entries: 100000 },
    log: { level: "info", outputs: ["stdout", "file"], file: "/var/log/app.log" },
    features: { feature_a: true, feature_b: false, feature_c: true },
  },

  schema_doc: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1, maxLength: 255 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      email: { type: "string", format: "email" },
      tags: { type: "array", items: { type: "string" } },
      meta: { type: "object", additionalProperties: true },
    },
  },

  wide_50: (() => {
    const o = {}
    for (let i = 0; i < 50; i++) o[`field_${i}`] = i
    return o
  })(),

  wide_100_mixed: (() => {
    const o = {}
    for (let i = 0; i < 100; i++) {
      o[`k${i}`] = i % 4 === 0 ? `value${i}` : i % 4 === 1 ? i : i % 4 === 2 ? i % 2 === 0 : null
    }
    return o
  })(),

  wide_500: (() => {
    const o = {}
    for (let i = 0; i < 500; i++) o[`k${i}`] = i
    return o
  })(),

  arr_int_10: Array.from({ length: 10 }, (_, i) => i),
  arr_int_100: Array.from({ length: 100 }, (_, i) => i),
  arr_int_1000: Array.from({ length: 1000 }, (_, i) => i),
  arr_int_random_100: Array.from({ length: 100 }, (_, i) => (i * 37 + 13) % 1000),

  arr_str_100_homog: Array.from({ length: 100 }, () => "repeated"),
  arr_str_100_unique: Array.from({ length: 100 }, (_, i) => `unique_string_${i}`),

  arr_obj_100_homog: Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: "user",
    role: "admin",
    active: true,
  })),

  arr_bool_100: Array.from({ length: 100 }, (_, i) => i % 2 === 0),
  arr_null_100: Array.from({ length: 100 }, () => null),

  deep_nest_30: (() => {
    let o = { v: 0 }
    for (let i = 0; i < 30; i++) o = { x: o }
    return o
  })(),

  deep_nest_50: (() => {
    let o = { v: 0 }
    for (let i = 0; i < 50; i++) o = { x: o }
    return o
  })(),

  redundant_users: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
    active: true,
  })),

  time_series_100: Array.from({ length: 100 }, (_, i) => ({
    ts: 1709000000 + i * 60,
    value: 100 + Math.sin(i / 10) * 20,
  })),

  mixed_array: [
    1, "two", null, true, [3, 4], { five: 5 }, -1.5, "another", false, [], {}, "last",
  ],

  bool_array_500: Array.from({ length: 500 }, (_, i) => (i * 7) % 3 === 0),
  float_array_100: Array.from({ length: 100 }, (_, i) => i * 0.5),

  long_string_obj: {
    title: "A long article",
    content: "Lorem ipsum dolor sit amet. ".repeat(200),
    tags: ["text", "long", "content"],
  },
}

// ─── run measurements ─────────────────────────────────────────────────────

const NW = 28
const VW = 11

console.log()
console.log("─".repeat(110))
console.log(
  `  ARJSON vs MessagePack vs CBOR — base iter ${ITER_BASE}, scaled per workload, ${TIMEOUT_MS}ms timeout per measurement`,
)
console.log("─".repeat(110))
console.log("  Each measurement runs in a forked worker so a hang/error in any library is isolated.")
console.log()

const fmtCell = m => {
  if (m.status === "OK") return fmt(m.ns)
  return m.status
}

const results = []
const cases = Object.entries(W)

console.log(
  pad("workload", NW, true) +
    "  " +
    pad("op", 6, true) +
    " " +
    ["msgpack", "cbor", "arjson-orig", "arjson-fixed", "JSON"]
      .map(h => pad(h, VW))
      .join(" "),
)

for (const [name, data] of cases) {
  const n = iterFor(data)

  const eMsg = measure("msgpack", "encode", data, n)
  const eCbor = measure("cbor", "encode", data, n)
  const eOrig = measure("orig", "encode", data, n)
  const eNew = measure("new", "encode", data, n)
  const eJson = measure("json", "encode", data, n)

  const dMsg = measure("msgpack", "decode", data, n)
  const dCbor = measure("cbor", "decode", data, n)
  const dOrig = measure("orig", "decode", data, n)
  const dNew = measure("new", "decode", data, n)
  const dJson = measure("json", "decode", data, n)

  const sizes = {
    msgpack: eMsg.size ?? "—",
    cbor: eCbor.size ?? "—",
    orig: eOrig.size ?? "—",
    new: eNew.size ?? "—",
    json: eJson.size ?? "—",
  }

  results.push({
    name, n,
    eMsg, eCbor, eOrig, eNew, eJson,
    dMsg, dCbor, dOrig, dNew, dJson,
    sizes,
  })

  console.log(
    pad(name, NW, true) +
      "  " +
      pad("enc", 6, true) +
      " " +
      [eMsg, eCbor, eOrig, eNew, eJson]
        .map(m => pad(fmtCell(m), VW))
        .join(" "),
  )
  console.log(
    pad("", NW, true) +
      "  " +
      pad("dec", 6, true) +
      " " +
      [dMsg, dCbor, dOrig, dNew, dJson]
        .map(m => pad(fmtCell(m), VW))
        .join(" "),
  )
}

// ─── summaries ─────────────────────────────────────────────────────────────

console.log()
console.log("─".repeat(110))
console.log("  Size comparison (lower is better)")
console.log("─".repeat(110))
console.log(
  pad("workload", NW, true) +
    "  " +
    ["msgpack", "cbor", "arjson-orig", "arjson-fixed", "JSON"]
      .map(h => pad(h, VW))
      .join(" ") +
    "  " +
    pad("arj vs msg", VW, true) +
    " " +
    pad("arj vs cbor", VW, true),
)
let totalMsg = 0, totalCbor = 0, totalOrig = 0, totalNew = 0, totalJson = 0
for (const r of results) {
  const { msgpack, cbor, orig, new: n, json } = r.sizes
  if (typeof msgpack === "number") totalMsg += msgpack
  if (typeof cbor === "number") totalCbor += cbor
  if (typeof orig === "number") totalOrig += orig
  if (typeof n === "number") totalNew += n
  if (typeof json === "number") totalJson += json
  const pctMsg =
    typeof msgpack === "number" && typeof n === "number"
      ? ((n / msgpack) * 100).toFixed(1) + "%"
      : "—"
  const pctCbor =
    typeof cbor === "number" && typeof n === "number"
      ? ((n / cbor) * 100).toFixed(1) + "%"
      : "—"
  console.log(
    pad(r.name, NW, true) +
      "  " +
      [msgpack, cbor, orig, n, json].map(v => pad(v, VW)).join(" ") +
      "  " +
      pad(pctMsg, VW, true) +
      " " +
      pad(pctCbor, VW, true),
  )
}
console.log(
  pad("TOTAL", NW, true) +
    "  " +
    [totalMsg, totalCbor, totalOrig, totalNew, totalJson]
      .map(v => pad(v, VW))
      .join(" ") +
    "  " +
    pad(((totalNew / totalMsg) * 100).toFixed(1) + "%", VW, true) +
    " " +
    pad(((totalNew / totalCbor) * 100).toFixed(1) + "%", VW, true),
)

console.log()
console.log("─".repeat(96))
console.log("  Failure summary (rows where one or more libraries failed)")
console.log("─".repeat(96))
let anyFail = false
for (const r of results) {
  const probs = []
  for (const [phase, m] of [
    ["enc-msg", r.eMsg], ["enc-cbor", r.eCbor], ["enc-orig", r.eOrig], ["enc-fixed", r.eNew], ["enc-json", r.eJson],
    ["dec-msg", r.dMsg], ["dec-cbor", r.dCbor], ["dec-orig", r.dOrig], ["dec-fixed", r.dNew], ["dec-json", r.dJson],
  ]) {
    if (m.status !== "OK") probs.push(`${phase}=${m.status}`)
  }
  if (probs.length) {
    anyFail = true
    console.log(`  ${pad(r.name, NW, true)}  ${probs.join(", ")}`)
  }
}
if (!anyFail) console.log("  (none — all libraries handled all workloads)")

// ─── delta workloads ─────────────────────────────────────────────────────

console.log()
console.log("─".repeat(96))
console.log("  Delta workloads — runs in-process; both ARJSON versions")
console.log("─".repeat(96))

import("../src-orig/arjson.js").then(async ORIG => {
  const NEW = await import("../src/arjson.js")
  const M = await import("@msgpack/msgpack")

  const ns = () => Number(process.hrtime.bigint())

  function deltaCounter(N) {
    const aO = new ORIG.ARJSON({ json: { count: 0 } })
    let t0 = ns()
    for (let i = 1; i <= N; i++) aO.update({ count: i })
    const tO = ns() - t0
    const sO = aO.toBuffer().length

    const aN = new NEW.ARJSON({ json: { count: 0 } })
    t0 = ns()
    for (let i = 1; i <= N; i++) aN.update({ count: i })
    const tN = ns() - t0
    const sN = aN.toBuffer().length

    t0 = ns()
    for (let i = 0; i <= N; i++) M.encode({ count: i })
    const tM = ns() - t0
    let sM = 0
    for (let i = 0; i <= N; i++) sM += M.encode({ count: i }).length

    return { tO, tN, tM, sO, sN, sM }
  }

  function deltaUserUpdate(N) {
    const base = {
      id: "u_001", name: "Alice", age: 30, email: "alice@example.com",
      role: "user", active: true, last_login: 1709000000,
      metadata: { theme: "light", lang: "en" },
    }
    let s = base
    const aO = new ORIG.ARJSON({ json: s })
    let t0 = ns()
    for (let i = 1; i <= N; i++) {
      s = { ...s, age: 30 + i, last_login: 1709000000 + i * 100 }
      aO.update(s)
    }
    const tO = ns() - t0
    const sO = aO.toBuffer().length

    s = base
    const aN = new NEW.ARJSON({ json: s })
    t0 = ns()
    for (let i = 1; i <= N; i++) {
      s = { ...s, age: 30 + i, last_login: 1709000000 + i * 100 }
      aN.update(s)
    }
    const tN = ns() - t0
    const sN = aN.toBuffer().length

    s = base
    t0 = ns()
    for (let i = 1; i <= N; i++) {
      s = { ...s, age: 30 + i, last_login: 1709000000 + i * 100 }
      M.encode(s)
    }
    const tM = ns() - t0
    s = base
    let sM = M.encode(s).length
    for (let i = 1; i <= N; i++) {
      s = { ...s, age: 30 + i, last_login: 1709000000 + i * 100 }
      sM += M.encode(s).length
    }

    return { tO, tN, tM, sO, sN, sM }
  }

  function deltaSchemaMigration(trials) {
    const states = [
      { name: "A", age: 1 },
      { name: "A", age: 2 },
      { name: "A", age: 2, email: "a@b.com" },
      { name: "A", age: 3, email: "a@b.com", roles: ["user"] },
      { name: "A", age: 3, email: "a@b.com", roles: ["user", "admin"] },
      { name: "B", age: 3, email: "a@b.com", roles: ["admin"] },
      { id: "alice", name: "B", age: 3, email: "a@b.com", roles: ["admin"] },
    ]
    let tO = 0, tN = 0, tM = 0, sO = 0, sN = 0, sM = 0
    for (let r = 0; r < trials; r++) {
      const aO = new ORIG.ARJSON({ json: states[0] })
      let t1 = ns()
      for (const s of states.slice(1)) aO.update(s)
      tO += ns() - t1
      if (r === 0) sO = aO.toBuffer().length

      const aN = new NEW.ARJSON({ json: states[0] })
      t1 = ns()
      for (const s of states.slice(1)) aN.update(s)
      tN += ns() - t1
      if (r === 0) sN = aN.toBuffer().length

      t1 = ns()
      for (const s of states) M.encode(s)
      tM += ns() - t1
      if (r === 0) sM = states.reduce((a, s) => a + M.encode(s).length, 0)
    }
    return { tO, tN, tM, sO, sN, sM }
  }

  const printDelta = (label, r) => {
    console.log()
    console.log(`  ${label}`)
    console.log(`    msgpack (sum-of-encodes) : ${pad(fmt(r.tM), 10)} ms,  ${pad(r.sM, 9)} B total`)
    console.log(`    arjson-orig              : ${pad(fmt(r.tO), 10)} ms,  ${pad(r.sO, 9)} B  (${(r.sO / r.sM * 100).toFixed(1)}% of msgpack-sum)`)
    console.log(`    arjson-fixed             : ${pad(fmt(r.tN), 10)} ms,  ${pad(r.sN, 9)} B  (Δ time vs orig: ${fmtPct(r.tN, r.tO)}, Δ size vs orig: ${fmtPct(r.sN, r.sO)})`)
  }

  printDelta("Counter increment 1000×", deltaCounter(1000))
  printDelta("User-record incremental update 500×", deltaUserUpdate(500))
  printDelta("Schema migration 7 states × 100 trials", deltaSchemaMigration(100))

  // ─── overall totals ─────────────────────────────────────────────────────

  const ok = (r, k) => (r[k].status === "OK" ? r[k].ns : 0)
  const sumEncMs = results.reduce((a, r) => a + ok(r, "eMsg"), 0)
  const sumEncCbor = results.reduce((a, r) => a + ok(r, "eCbor"), 0)
  const sumEncOrig = results.reduce((a, r) => a + ok(r, "eOrig"), 0)
  const sumEncNew = results.reduce((a, r) => a + ok(r, "eNew"), 0)
  const sumDecMs = results.reduce((a, r) => a + ok(r, "dMsg"), 0)
  const sumDecCbor = results.reduce((a, r) => a + ok(r, "dCbor"), 0)
  const sumDecOrig = results.reduce((a, r) => a + ok(r, "dOrig"), 0)
  const sumDecNew = results.reduce((a, r) => a + ok(r, "dNew"), 0)

  console.log()
  console.log("═".repeat(110))
  console.log("  TOTALS (sum across workloads where the library succeeded)")
  console.log("═".repeat(110))
  console.log()
  console.log("  Encode time (ms):")
  console.log(`    msgpack       : ${fmt(sumEncMs)}`)
  console.log(`    cbor-x        : ${fmt(sumEncCbor)}  (${(sumEncCbor / sumEncMs).toFixed(2)}x msgpack)`)
  console.log(`    arjson-orig   : ${fmt(sumEncOrig)}  (${(sumEncOrig / sumEncMs).toFixed(2)}x msgpack)`)
  console.log(`    arjson-fixed  : ${fmt(sumEncNew)}  (${(sumEncNew / sumEncMs).toFixed(2)}x msgpack, ${(sumEncNew / sumEncCbor).toFixed(2)}x cbor)`)
  console.log()
  console.log("  Decode time (ms):")
  console.log(`    msgpack       : ${fmt(sumDecMs)}`)
  console.log(`    cbor-x        : ${fmt(sumDecCbor)}  (${(sumDecCbor / sumDecMs).toFixed(2)}x msgpack)`)
  console.log(`    arjson-orig   : ${fmt(sumDecOrig)}  (${(sumDecOrig / sumDecMs).toFixed(2)}x msgpack)`)
  console.log(`    arjson-fixed  : ${fmt(sumDecNew)}  (${(sumDecNew / sumDecMs).toFixed(2)}x msgpack, ${(sumDecNew / sumDecCbor).toFixed(2)}x cbor)`)
  console.log()
  console.log("  Encoded size (B, all successful workloads):")
  console.log(`    msgpack       : ${totalMsg}`)
  console.log(`    cbor-x        : ${totalCbor}  (${((totalCbor / totalMsg) * 100).toFixed(1)}% of msgpack)`)
  console.log(`    arjson-orig   : ${totalOrig}  (${((totalOrig / totalMsg) * 100).toFixed(1)}% of msgpack)`)
  console.log(`    arjson-fixed  : ${totalNew}  (${((totalNew / totalMsg) * 100).toFixed(1)}% of msgpack, ${((totalNew / totalCbor) * 100).toFixed(1)}% of cbor)`)
  console.log()
})
