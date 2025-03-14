function frombits(bitArray) {
  // Join all bit strings
  const bitStr = bitArray.join("")

  // Calculate how many bytes we need
  const byteCount = Math.ceil(bitStr.length / 8)

  // Create a new Uint8Array
  const result = new Uint8Array(byteCount)

  // Fill the Uint8Array
  for (let i = 0; i < byteCount; i++) {
    // Get the next 8 bits (or fewer for the last byte)
    const start = i * 8
    const end = Math.min(start + 8, bitStr.length)
    const bits = bitStr.substring(start, end).padEnd(8, "0")

    // Convert the bits to a byte
    result[i] = parseInt(bits, 2)
  }

  return result
}
function tobits(arr, cursor = 0) {
  let bitStr = ""
  for (let i = 0; i < arr.length; i++) {
    bitStr += arr[i].toString(2).padStart(8, "0")
  }
  let remaining = bitStr.slice(cursor)

  let result = []
  let offset = cursor % 8
  if (offset !== 0) {
    let firstChunkSize = 8 - offset
    result.push(remaining.slice(0, firstChunkSize))
    remaining = remaining.slice(firstChunkSize)
  }
  while (remaining.length >= 8) {
    result.push(remaining.slice(0, 8))
    remaining = remaining.slice(8)
  }
  if (remaining.length > 0) result.push(remaining)
  return result
}

function bits(n) {
  return n === 0 ? 1 : 32 - Math.clz32(n)
}

let str = "abcdefghijklmnopqrstuvwxyz".toUpperCase()
str += str.toLowerCase()
let strmap = {}
let i = 0
for (const s of str.split("")) strmap[s] = i++
let strmap_rev = {}
i = 0
for (const s of str.split("")) {
  strmap_rev[i.toString()] = s
  i++
}
let base64 = {}
let base64_rev = {}
str += "0123456789-_"
i = 0
for (const s of str.split("")) {
  base64_rev[i.toString()] = s
  base64[s] = i++
}

function getPrecision(v) {
  const s = v.toString()
  const dot = s.indexOf(".")
  if (dot === -1) return 0
  const frac = s.slice(dot + 1).replace(/0+$/, "")
  return frac.length
}

function parsePath(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0

  while (i < path.length) {
    if (path[i] === ".") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }
    if (path[i] === "[") {
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      let indexStr = ""
      while (i < path.length && path[i] !== "]") {
        if (!/\d/.test(path[i])) {
          throw new Error(`Invalid array index at position ${i}`)
        }
        indexStr += path[i]
        i++
      }

      if (i >= path.length || path[i] !== "]") {
        throw new Error("Missing closing bracket for array index")
      }
      result.push(parseInt(indexStr, 10))
      i++
      continue
    }
    currentKey += path[i]
    i++
  }
  if (currentKey) result.push(currentKey)

  return result
}

export {
  parsePath,
  getPrecision,
  bits,
  tobits,
  strmap,
  base64,
  base64_rev,
  strmap_rev,
  frombits,
}
