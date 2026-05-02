// How close to "minimum bits" does ARJSON+brotli actually get?
//
// Measures, for each workload (and for the corpus as a whole):
//   - raw size in each binary format (arjson, msgpack, cbor, json)
//   - +gzip
//   - +brotli (max quality)
//
// The smallest result across all rows is the empirical lower bound for
// general-purpose (no-trained-dictionary) compression on this corpus.

import { encode as msgEnc } from "@msgpack/msgpack"
import { encode as cborEnc } from "cbor-x"
import { enc as encA } from "../src/arjson.js"
import { gzipSync, brotliCompressSync, constants } from "zlib"

const W = (await import("./bench-workloads.js")).default

const BR_OPTS = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
  },
}

const sizes = (data) => {
  const json = JSON.stringify(data)
  const jsonB = Buffer.from(json, "utf8")
  const msgB = Buffer.from(msgEnc(data))
  const cborB = Buffer.from(cborEnc(data))
  const arjB = Buffer.from(encA(data))
  return {
    json: jsonB.length,
    json_gz: gzipSync(jsonB).length,
    json_br: brotliCompressSync(jsonB, BR_OPTS).length,
    msg: msgB.length,
    msg_gz: gzipSync(msgB).length,
    msg_br: brotliCompressSync(msgB, BR_OPTS).length,
    cbor: cborB.length,
    cbor_gz: gzipSync(cborB).length,
    cbor_br: brotliCompressSync(cborB, BR_OPTS).length,
    arj: arjB.length,
    arj_gz: gzipSync(arjB).length,
    arj_br: brotliCompressSync(arjB, BR_OPTS).length,
  }
}

const pad = (s, n, right = false) => {
  s = String(s)
  if (s.length >= n) return s
  return right ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

const NW = 28
const VW = 9

console.log()
console.log("─".repeat(132))
console.log("  Compression-pipeline size benchmark — bytes per encoded form (lower is better)")
console.log("─".repeat(132))
console.log()
console.log(
  pad("workload", NW, true) +
    " " +
    [
      "json", "json+gz", "json+br",
      "msg", "msg+gz", "msg+br",
      "cbor", "cbor+gz", "cbor+br",
      "arj", "arj+gz", "arj+br",
    ]
      .map(h => pad(h, VW))
      .join(" "),
)

const results = []
const totals = {
  json: 0, json_gz: 0, json_br: 0,
  msg: 0, msg_gz: 0, msg_br: 0,
  cbor: 0, cbor_gz: 0, cbor_br: 0,
  arj: 0, arj_gz: 0, arj_br: 0,
}

for (const [name, data] of Object.entries(W)) {
  const s = sizes(data)
  results.push({ name, s })
  for (const k in totals) totals[k] += s[k]
  console.log(
    pad(name, NW, true) +
      " " +
      [
        s.json, s.json_gz, s.json_br,
        s.msg, s.msg_gz, s.msg_br,
        s.cbor, s.cbor_gz, s.cbor_br,
        s.arj, s.arj_gz, s.arj_br,
      ]
        .map(v => pad(v, VW))
        .join(" "),
  )
}

console.log("─".repeat(132))
console.log(
  pad("TOTAL", NW, true) +
    " " +
    [
      totals.json, totals.json_gz, totals.json_br,
      totals.msg, totals.msg_gz, totals.msg_br,
      totals.cbor, totals.cbor_gz, totals.cbor_br,
      totals.arj, totals.arj_gz, totals.arj_br,
    ]
      .map(v => pad(v, VW))
      .join(" "),
)

console.log()
console.log("─".repeat(96))
console.log("  Summary — totals across all 34 workloads")
console.log("─".repeat(96))

const refs = [
  ["json (text)         ", totals.json],
  ["json + gzip         ", totals.json_gz],
  ["json + brotli       ", totals.json_br],
  ["msgpack             ", totals.msg],
  ["msgpack + gzip      ", totals.msg_gz],
  ["msgpack + brotli    ", totals.msg_br],
  ["cbor                ", totals.cbor],
  ["cbor + gzip         ", totals.cbor_gz],
  ["cbor + brotli       ", totals.cbor_br],
  ["arjson              ", totals.arj],
  ["arjson + gzip       ", totals.arj_gz],
  ["arjson + brotli     ", totals.arj_br],
]
const minimum = Math.min(...refs.map(r => r[1]))

for (const [label, bytes] of refs) {
  const pct = ((bytes / totals.json) * 100).toFixed(1) + "%"
  const vsArjBr = ((bytes / totals.arj_br) * 100).toFixed(1) + "%"
  const isMin = bytes === minimum ? "  ← smallest" : ""
  console.log(`  ${label}: ${pad(bytes, 8)} B  (${pad(pct, 6)} of JSON, ${pad(vsArjBr, 6)} of arj+br)${isMin}`)
}

// ─── concatenated corpus — single big input ──────────────────────────────
//
// For permanent storage you typically have many documents. brotli's window
// can find patterns ACROSS documents if you feed it a single concatenated
// stream. This measures the corpus-as-one-blob case.

console.log()
console.log("─".repeat(96))
console.log("  Corpus-as-single-blob (each format concatenated and then compressed once)")
console.log("─".repeat(96))

const concat = bufs => Buffer.concat(bufs.map(b => (typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b))))

const allJson = concat(Object.values(W).map(d => JSON.stringify(d)))
const allMsg = concat(Object.values(W).map(d => msgEnc(d)))
const allCbor = concat(Object.values(W).map(d => cborEnc(d)))
const allArj = concat(Object.values(W).map(d => encA(d)))

const blob = [
  ["json (concatenated)      ", allJson.length],
  ["json (concat) + gzip     ", gzipSync(allJson).length],
  ["json (concat) + brotli   ", brotliCompressSync(allJson, BR_OPTS).length],
  ["msgpack (concatenated)   ", allMsg.length],
  ["msgpack (concat) + gzip  ", gzipSync(allMsg).length],
  ["msgpack (concat) + brotli", brotliCompressSync(allMsg, BR_OPTS).length],
  ["cbor (concatenated)      ", allCbor.length],
  ["cbor (concat) + gzip     ", gzipSync(allCbor).length],
  ["cbor (concat) + brotli   ", brotliCompressSync(allCbor, BR_OPTS).length],
  ["arjson (concatenated)    ", allArj.length],
  ["arjson (concat) + gzip   ", gzipSync(allArj).length],
  ["arjson (concat) + brotli ", brotliCompressSync(allArj, BR_OPTS).length],
]
const blobMin = Math.min(...blob.map(r => r[1]))

for (const [label, bytes] of blob) {
  const pct = ((bytes / allJson.length) * 100).toFixed(1) + "%"
  const isMin = bytes === blobMin ? "  ← smallest" : ""
  console.log(`  ${label}: ${pad(bytes, 8)} B  (${pad(pct, 6)} of JSON-concat)${isMin}`)
}

// ─── homogeneous-corpus stress: 100 user records ─────────────────────────
//
// The most favorable case for cross-document compression: many similar docs.

console.log()
console.log("─".repeat(96))
console.log("  Homogeneous corpus: 100 generated user records, treated as one stream")
console.log("─".repeat(96))

const users = []
for (let i = 0; i < 100; i++) {
  users.push({
    id: i,
    username: `user_${i}`,
    name: `User ${i}`,
    email: `user_${i}@example.com`,
    age: 18 + (i % 60),
    active: i % 3 !== 0,
    role: ["admin", "user", "guest"][i % 3],
    tags: ["staff", "verified", "premium"].slice(0, (i % 3) + 1),
  })
}

const uJson = concat(users.map(u => JSON.stringify(u)))
const uMsg = concat(users.map(u => msgEnc(u)))
const uCbor = concat(users.map(u => cborEnc(u)))
const uArj = concat(users.map(u => encA(u)))

// Plus: ARJSON-as-delta-chain (the format's actual permanent-storage story)
const { ARJSON } = await import("../src/arjson.js")
const arjDelta = (() => {
  const a = new ARJSON({ json: users[0] })
  for (let i = 1; i < users.length; i++) a.update(users[i])
  return Buffer.from(a.toBuffer())
})()

const uTable = [
  ["json (raw)            ", uJson.length],
  ["json + gzip           ", gzipSync(uJson).length],
  ["json + brotli         ", brotliCompressSync(uJson, BR_OPTS).length],
  ["msgpack (raw)         ", uMsg.length],
  ["msgpack + gzip        ", gzipSync(uMsg).length],
  ["msgpack + brotli      ", brotliCompressSync(uMsg, BR_OPTS).length],
  ["cbor (raw)            ", uCbor.length],
  ["cbor + gzip           ", gzipSync(uCbor).length],
  ["cbor + brotli         ", brotliCompressSync(uCbor, BR_OPTS).length],
  ["arjson (concat raw)   ", uArj.length],
  ["arjson + gzip         ", gzipSync(uArj).length],
  ["arjson + brotli       ", brotliCompressSync(uArj, BR_OPTS).length],
  ["arjson DELTA-CHAIN raw", arjDelta.length],
  ["arjson DELTA + gzip   ", gzipSync(arjDelta).length],
  ["arjson DELTA + brotli ", brotliCompressSync(arjDelta, BR_OPTS).length],
]
const uMin = Math.min(...uTable.map(r => r[1]))

for (const [label, bytes] of uTable) {
  const pct = ((bytes / uJson.length) * 100).toFixed(1) + "%"
  const isMin = bytes === uMin ? "  ← smallest" : ""
  console.log(`  ${label}: ${pad(bytes, 8)} B  (${pad(pct, 6)} of JSON)${isMin}`)
}
console.log()
