// Worker: run encode+decode benchmark for one workload, one library.
// Reads JSON {lib, op, data, n} from stdin, writes JSON {ns, size} or {error}.
import { encode as msgEnc, decode as msgDec } from "@msgpack/msgpack"
import { encode as cborEnc, decode as cborDec } from "cbor-x"
import { enc as encO, dec as decO } from "../src-orig/arjson.js"
import { enc as encN, dec as decN } from "../src/arjson.js"

let raw = ""
process.stdin.on("data", c => (raw += c))
process.stdin.on("end", () => {
  const { lib, op, data, n } = JSON.parse(raw)
  try {
    let buf = null
    if (op === "encode") {
      if (lib === "msgpack") buf = msgEnc(data)
      else if (lib === "cbor") buf = cborEnc(data)
      else if (lib === "orig") buf = encO(data)
      else if (lib === "new") buf = encN(data)
      else if (lib === "json") buf = JSON.stringify(data)
      const fn =
        lib === "msgpack"
          ? () => msgEnc(data)
          : lib === "cbor"
            ? () => cborEnc(data)
            : lib === "orig"
              ? () => encO(data)
              : lib === "new"
                ? () => encN(data)
                : () => JSON.stringify(data)
      const t0 = process.hrtime.bigint()
      for (let i = 0; i < n; i++) fn()
      const t1 = process.hrtime.bigint()
      const size = typeof buf === "string" ? Buffer.byteLength(buf, "utf8") : buf.length
      process.stdout.write(JSON.stringify({ ns: Number(t1 - t0), size }))
    } else {
      // decode
      const buf =
        lib === "msgpack"
          ? msgEnc(data)
          : lib === "cbor"
            ? cborEnc(data)
            : lib === "orig"
              ? encO(data)
              : lib === "new"
                ? encN(data)
                : JSON.stringify(data)
      const fn =
        lib === "msgpack"
          ? () => msgDec(buf)
          : lib === "cbor"
            ? () => cborDec(buf)
            : lib === "orig"
              ? () => decO(buf)
              : lib === "new"
                ? () => decN(buf)
                : () => JSON.parse(buf)
      // warmup
      fn()
      const t0 = process.hrtime.bigint()
      for (let i = 0; i < n; i++) fn()
      const t1 = process.hrtime.bigint()
      process.stdout.write(JSON.stringify({ ns: Number(t1 - t0) }))
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message.slice(0, 200) }))
  }
})
