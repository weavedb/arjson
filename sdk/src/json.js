import { Encoder, encode } from "./encoder.js"
import { Decoder, decode } from "./decoder.js"
import { Parser, delta } from "./parser.js"

export default (deltas, json) => {
  let enc = new Encoder()
  deltas = deltas || []
  let encoded = null
  const update = new_json => {
    const { len, q } = delta(json, new_json)
    const _delta = enc._dump(q)
    deltas.push([len, _delta])
    let d = new Decoder()
    decode(encoded, d)
    let p = new Parser(d.cols())
    json = p.update(encoded, _delta, len).json
    return [len, _delta]
  }
  const patch = v => {
    let d = new Decoder()
    decode(encoded, d)
    let p = new Parser(d.cols())
    json = p.update(encoded, v[1], v[0]).json
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
