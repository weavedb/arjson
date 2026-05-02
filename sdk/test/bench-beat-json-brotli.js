// Goal: beat json+brotli on raw size by exploiting ARJSON's strmap as a
// deterministic per-document dictionary fed to a downstream compressor.
//
// Pipelines tested:
//   A. json (raw)
//   B. json + brotli (the target to beat — has 120 KB built-in text dict)
//   C. arjson + brotli (our previous baseline)
//   D. arjson + zstd (no dict)
//   E. arjson + zstd with strmap-derived dictionary (the new pipeline)
//   F. arjson + brotli with strmap as raw prefix (cheaper variant)
//
// Workloads: per-document AND a homogeneous corpus of 100 user records,
// since that's where json+brotli was beating us.

import { gzipSync, brotliCompressSync, constants } from "zlib"
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execFileSync } from "child_process"
import { encode as msgEnc } from "@msgpack/msgpack"
import { encode as cborEnc } from "cbor-x"
import { enc as encA, ARJSON } from "../src/arjson.js"
import { Encoder, encode } from "../src/encoder.js"
import { Decoder } from "../src/decoder.js"

const BR_OPTS = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
  },
}

// ─── strmap → dictionary ──────────────────────────────────────────────────
//
// ARJSON's strmap is { "0": "alice", "1": "admin", ... }. Lay them out as a
// canonical byte sequence so brotli/zstd can use them as backreference
// source bytes. Concatenate by index order, separated by 0x00. This gives
// brotli/zstd a seed of the strings most likely to recur in the encoded
// data — keys, common values, etc.
function strmapToDict(strmap) {
  const indices = Object.keys(strmap).map(Number).sort((a, b) => a - b)
  const parts = indices.map(i => strmap[i] ?? "")
  return Buffer.from(parts.join("\0"), "utf8")
}

// Encode a doc and capture its strmap (so we can ship a dictionary alongside).
function encodeWithStrmap(json) {
  const u = new Encoder()
  const buf = encode(json, u)
  const strmap = {}
  for (const [k, v] of u.strMap.entries()) strmap[v] = k
  return { buf: Buffer.from(buf), strmap }
}

// Build a "training" strmap by encoding many representative docs and
// merging their strmaps. This is the dictionary you'd ship with the
// decoder, derived deterministically from a known training corpus.
function trainStrmap(corpus) {
  const merged = {}
  let next = 0
  for (const doc of corpus) {
    const { strmap } = encodeWithStrmap(doc)
    const indices = Object.keys(strmap).map(Number).sort((a, b) => a - b)
    for (const i of indices) {
      const v = strmap[i]
      // dedupe
      if (!Object.values(merged).includes(v)) {
        merged[next++] = v
      }
    }
  }
  return merged
}

// ─── compression helpers ──────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "arj-bench-"))
process.on("exit", () => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})

let counter = 0
function tmpfile(ext) {
  return join(tmp, `f${counter++}.${ext}`)
}

function zstdCompress(input, dict = null, level = 22) {
  const inFile = tmpfile("bin")
  const outFile = inFile + ".zst"
  writeFileSync(inFile, input)
  const args = ["-q", `-${level}`, "--long=27"]
  if (dict) {
    const dictFile = tmpfile("dict")
    writeFileSync(dictFile, dict)
    args.push("-D", dictFile)
  }
  args.push("-f", inFile, "-o", outFile)
  execFileSync("zstd", args, { stdio: "ignore" })
  return readFileSync(outFile)
}

function brotliWithPrefix(input, prefix) {
  // Prepend prefix to input, compress, return compressed bytes minus
  // an estimate of prefix-only compression cost. This simulates a
  // shared-dictionary effect using stock brotli.
  const combined = Buffer.concat([prefix, input])
  const allCompressed = brotliCompressSync(combined, BR_OPTS)
  return { full: allCompressed, prefixOnly: brotliCompressSync(prefix, BR_OPTS) }
}

const pad = (s, n, right = false) => {
  s = String(s)
  if (s.length >= n) return s
  return right ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

// ─── corpus ────────────────────────────────────────────────────────────────

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

// ─── per-document encoding ────────────────────────────────────────────────

const trainSet = users.slice(0, 50) // first 50 used to train shared dict
const testSet = users.slice(50)     // last 50 we measure size on

const trainedStrmap = trainStrmap(trainSet)
const trainedDict = strmapToDict(trainedStrmap)

console.log()
console.log("─".repeat(96))
console.log("  Beating json+brotli — homogeneous user-record corpus")
console.log(`  Train: 50 user records (used to build shared dict, ${trainedDict.length} B)`)
console.log("  Test:  50 NEW user records (size measured here)")
console.log("─".repeat(96))

let totals = {}
const accum = (k, v) => (totals[k] = (totals[k] ?? 0) + v)

for (const u of testSet) {
  const json = JSON.stringify(u)
  const jsonB = Buffer.from(json, "utf8")

  const arj = Buffer.from(encA(u))

  // Baselines
  accum("json", jsonB.length)
  accum("json+br", brotliCompressSync(jsonB, BR_OPTS).length)
  accum("arj", arj.length)
  accum("arj+br", brotliCompressSync(arj, BR_OPTS).length)
  accum("arj+zstd", zstdCompress(arj, null, 22).length)

  // With trained shared dict (zstd's first-class dictionary support)
  accum("arj+zstd+trained-dict", zstdCompress(arj, trainedDict, 22).length)

  // Brotli with prefix dict (approximation — full minus prefix-only)
  const br = brotliWithPrefix(arj, trainedDict)
  // The shipped bytes are just the difference; the prefix is reconstructed
  // from the strmap on the decoder side, so we don't pay for prefixOnly.
  accum("arj+br+prefix-dict (sim)", Math.max(0, br.full.length - br.prefixOnly.length))

  // Per-document strmap as dict (zero-shot, no training set)
  const { strmap } = encodeWithStrmap(u)
  const ownDict = strmapToDict(strmap)
  accum("arj+zstd+self-strmap", zstdCompress(arj, ownDict, 22).length)
}

// ARJSON delta chain (the actual permanent-storage pipeline)
const aj = new ARJSON({ json: testSet[0] })
for (const u of testSet.slice(1)) aj.update(u)
const deltaBuf = Buffer.from(aj.toBuffer())
accum("arj-DELTA-CHAIN", deltaBuf.length)
accum("arj-DELTA + br", brotliCompressSync(deltaBuf, BR_OPTS).length)
accum("arj-DELTA + zstd", zstdCompress(deltaBuf, null, 22).length)
accum("arj-DELTA + zstd+trained-dict", zstdCompress(deltaBuf, trainedDict, 22).length)
const finalStrmap = aj.artable.strmap
accum("arj-DELTA + zstd+self-strmap", zstdCompress(deltaBuf, strmapToDict(finalStrmap), 22).length)

console.log()
console.log("  Per-doc pipelines (50 documents summed):")
console.log()
const order = [
  "json",
  "json+br",
  "arj",
  "arj+br",
  "arj+zstd",
  "arj+zstd+trained-dict",
  "arj+zstd+self-strmap",
  "arj+br+prefix-dict (sim)",
]
const baseline = totals["json+br"]
for (const k of order) {
  if (!(k in totals)) continue
  const v = totals[k]
  const pct = ((v / totals.json) * 100).toFixed(1) + "%"
  const vsBase = ((v / baseline) * 100).toFixed(1) + "%"
  const winner = v < baseline ? "  ← beats json+br" : ""
  console.log(`    ${pad(k, 30, true)}: ${pad(v, 6)} B  (${pad(pct, 6)} of JSON, ${pad(vsBase, 6)} of json+br)${winner}`)
}

console.log()
console.log("  Delta-chain pipelines (all 50 docs in one ARJSON delta chain):")
console.log()
const deltaOrder = [
  "arj-DELTA-CHAIN",
  "arj-DELTA + br",
  "arj-DELTA + zstd",
  "arj-DELTA + zstd+trained-dict",
  "arj-DELTA + zstd+self-strmap",
]
for (const k of deltaOrder) {
  if (!(k in totals)) continue
  const v = totals[k]
  const pct = ((v / totals.json) * 100).toFixed(1) + "%"
  const vsBase = ((v / baseline) * 100).toFixed(1) + "%"
  const winner = v < baseline ? "  ← beats json+br" : ""
  console.log(`    ${pad(k, 30, true)}: ${pad(v, 6)} B  (${pad(pct, 6)} of JSON, ${pad(vsBase, 6)} of json+br)${winner}`)
}

console.log()
console.log("  Note: zstd dictionary is shipped alongside the decoder, not in each payload.")
console.log("  arj+br+prefix-dict approximates dictionary effect using stock brotli (subtractive).")
console.log()

// ─── also try the heterogeneous corpus from earlier ──────────────────────

import("./bench-workloads.js").then(({ default: W }) => {
  const allDocs = Object.values(W)
  // Train dict on half, measure on the other half
  const half = Math.floor(allDocs.length / 2)
  const train = allDocs.slice(0, half)
  const test = allDocs.slice(half)
  const dictH = strmapToDict(trainStrmap(train))

  let h = {}
  const accH = (k, v) => (h[k] = (h[k] ?? 0) + v)
  for (const d of test) {
    const json = Buffer.from(JSON.stringify(d), "utf8")
    const arj = Buffer.from(encA(d))
    accH("json", json.length)
    accH("json+br", brotliCompressSync(json, BR_OPTS).length)
    accH("arj", arj.length)
    accH("arj+br", brotliCompressSync(arj, BR_OPTS).length)
    accH("arj+zstd", zstdCompress(arj, null, 22).length)
    accH("arj+zstd+trained-dict", zstdCompress(arj, dictH, 22).length)
    accH("arj+zstd+self-strmap", zstdCompress(arj, strmapToDict(encodeWithStrmap(d).strmap), 22).length)
  }

  console.log("─".repeat(96))
  console.log(`  Heterogeneous corpus (${test.length} mixed workloads, dict trained on the other ${train.length})`)
  console.log("─".repeat(96))
  console.log()
  const baseH = h["json+br"]
  for (const k of [
    "json", "json+br", "arj", "arj+br", "arj+zstd",
    "arj+zstd+trained-dict", "arj+zstd+self-strmap",
  ]) {
    const v = h[k]
    const pct = ((v / h.json) * 100).toFixed(1) + "%"
    const vsBase = ((v / baseH) * 100).toFixed(1) + "%"
    const winner = v < baseH ? "  ← beats json+br" : ""
    console.log(`    ${pad(k, 30, true)}: ${pad(v, 6)} B  (${pad(pct, 6)} of JSON, ${pad(vsBase, 6)} of json+br)${winner}`)
  }
  console.log()
})
