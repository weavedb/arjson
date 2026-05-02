import { enc, dec } from "../src/arjson.js"
// Mix: arr_int_100 + user_record + config_doc
const w1 = Array.from({length: 100}, (_, i) => i)
const w2 = {id: 12345, username: "alice", name: "Alice Johnson", email: "x@y.z", age: 30, active: true, role: "admin"}
const w3 = {server: {host: "0.0.0.0", port: 8080}, db: {host: "x", port: 5432}}
const b1 = enc(w1), b2 = enc(w2), b3 = enc(w3)
for (let i = 0; i < 5000; i++) { enc(w1); enc(w2); enc(w3); dec(b1); dec(b2); dec(b3) }
console.error("starting hot loop")
const t0 = Date.now()
const ITER = 100000
for (let i = 0; i < ITER; i++) { enc(w1); enc(w2); enc(w3) }
console.error("encode", ITER*3, "iters in", Date.now() - t0, "ms")
const t1 = Date.now()
for (let i = 0; i < ITER; i++) { dec(b1); dec(b2); dec(b3) }
console.error("decode", ITER*3, "iters in", Date.now() - t1, "ms")
