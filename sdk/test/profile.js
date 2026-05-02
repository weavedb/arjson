import { enc, dec } from "../src/arjson.js"
const data = JSON.parse(`[${"42,".repeat(99)}42]`)
const buf = enc(data)
console.error("encoded size:", buf.length)
for (let i = 0; i < 5000; i++) { enc(data); dec(buf) }
console.error("starting hot loop")
const t0 = Date.now()
const ITER = 500000
for (let i = 0; i < ITER; i++) enc(data)
console.error("encode", ITER, "iters in", Date.now() - t0, "ms")
const t1 = Date.now()
for (let i = 0; i < ITER; i++) dec(buf)
console.error("decode", ITER, "iters in", Date.now() - t1, "ms")
