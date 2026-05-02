import { enc, dec } from "../src/arjson.js"
const data = {
  id: 12345, username: "alice", name: "Alice Johnson",
  email: "alice@example.com", age: 30, active: true, role: "admin",
  tags: ["staff", "verified"],
  preferences: { theme: "dark", notifications: true, language: "en" },
}
const buf = enc(data)
console.error("encoded size:", buf.length)
for (let i = 0; i < 5000; i++) dec(buf)
console.error("starting decode hot loop")
const t1 = Date.now()
const ITER = 500000
for (let i = 0; i < ITER; i++) dec(buf)
console.error("decode", ITER, "iters in", Date.now() - t1, "ms")
