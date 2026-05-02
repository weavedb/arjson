import { enc, dec } from "../src/arjson.js"
// Object-rich workload — closer to the bench's user_record / config_doc shape.
const data = {
  id: 12345, username: "alice", name: "Alice Johnson",
  email: "alice@example.com", age: 30, active: true, role: "admin",
  tags: ["staff", "verified"],
  preferences: { theme: "dark", notifications: true, language: "en" },
}
const buf = enc(data)
console.error("encoded size:", buf.length)
for (let i = 0; i < 5000; i++) { enc(data); dec(buf) }
console.error("starting hot loop")
const t0 = Date.now()
const ITER = 200000
for (let i = 0; i < ITER; i++) enc(data)
console.error("encode", ITER, "iters in", Date.now() - t0, "ms")
const t1 = Date.now()
for (let i = 0; i < ITER; i++) dec(buf)
console.error("decode", ITER, "iters in", Date.now() - t1, "ms")
