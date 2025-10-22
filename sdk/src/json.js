import { Encoder, encode } from "./encoder.js"
import { Decoder, decode } from "./decoder.js"
import { Parser } from "./parser.js"
import { clone } from "ramda"

// delta is array.... it should be buffer
export default (deltas, _json, n) => {
  let json = structuredClone(_json)
  let enc = new Encoder(n)
  deltas = deltas || []
  let encoded = null
  /*
  const update = new_json => {
    if (!encoded) encoded = encode(json, enc)
    const { len, q } = delta(json, new_json, undefined, n)
    const _delta = enc._dump(q)
    deltas.push([len, _delta])
    let d = new Decoder()
    decode(encoded, d)
    let p = new Parser(d.cols())
    console.log("this is the only update...........................")
    json = p.update(encoded, _delta, len, n).json
    // this is the issue, encoded should be cummulative
    encoded = encode(json, enc)
    return [len, _delta]
  }
*/
  const patch = v => {
    // 3rd time fails for missing links because of encoded
    let d = new Decoder()
    decode(encoded, d)
    let p = new Parser(d.cols())
    json = p.update(encoded, v[1], v[0], n).json
    return json
  }

  if (typeof json !== "undefined") {
    encoded = encode(json, enc)
    deltas.push([0, encoded])
  } else {
    let i = 0
    for (let v of deltas) {
      if (i === 0) {
        encoded = v[1]
        let d = new Decoder()
        json = decode(v[1], d)
      } else patch(v)

      i++
    }
  }

  return { json: () => json, deltas: () => deltas, update, patch }
}
