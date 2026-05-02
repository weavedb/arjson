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
  let inBrackets = false
  let bracketContent = ""

  while (i < path.length) {
    const char = path[i]

    if (!inBrackets) {
      if (char === ".") {
        // End of a key segment
        if (currentKey) {
          result.push(currentKey)
          currentKey = ""
        }
        i++
        continue
      }

      if (char === "[") {
        // Check if this is the start of an array index or part of a key name
        // Look ahead to see if content is purely numeric
        let j = i + 1
        let content = ""
        let foundClosing = false

        while (j < path.length && path[j] !== "]") {
          content += path[j]
          j++
        }

        if (j < path.length && path[j] === "]") {
          foundClosing = true
        }

        // Check if content is a valid array index (pure number)
        if (foundClosing && /^\d+$/.test(content)) {
          // It's an array index
          if (currentKey) {
            result.push(currentKey)
            currentKey = ""
          }
          result.push(parseInt(content, 10))
          i = j + 1 // Skip past the closing bracket
          continue
        } else {
          // It's part of the key name, treat it as a regular character
          currentKey += char
          i++
          continue
        }
      }

      // Regular character, add to current key
      currentKey += char
      i++
    }
  }

  // Don't forget the last key
  if (currentKey) {
    result.push(currentKey)
  }

  return result
}

// Alternative implementation that's more explicit about escaping
function parsePathStrict(path) {
  if (!path) return []

  const result = []
  let currentKey = ""
  let i = 0
  let escaped = false

  while (i < path.length) {
    const char = path[i]

    if (escaped) {
      // Add the escaped character literally
      currentKey += char
      escaped = false
      i++
      continue
    }

    if (char === "\\") {
      // Next character is escaped
      escaped = true
      i++
      continue
    }

    if (char === ".") {
      // End of a key segment
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }
      i++
      continue
    }

    if (char === "[") {
      // Only treat as array index if we have a complete key before it
      // and the content is numeric
      if (currentKey) {
        result.push(currentKey)
        currentKey = ""
      }

      // Find the closing bracket
      let j = i + 1
      let indexStr = ""

      while (j < path.length && path[j] !== "]") {
        indexStr += path[j]
        j++
      }

      if (j >= path.length) {
        // No closing bracket found, treat [ as part of key
        currentKey += char
        i++
        continue
      }

      // Check if it's a valid number
      if (/^\d+$/.test(indexStr)) {
        result.push(parseInt(indexStr, 10))
        i = j + 1 // Skip past ]
      } else {
        // Not a valid array index, treat as part of key name
        currentKey += path.substring(i, j + 1)
        i = j + 1
      }
      continue
    }

    // Regular character
    currentKey += char
    i++
  }

  // Add the last segment if any
  if (currentKey) {
    result.push(currentKey)
  }

  return result
}

export {
  parsePath,
  parsePathStrict,
  getPrecision,
  bits,
  tobits,
  strmap,
  base64,
  base64_rev,
  strmap_rev,
  frombits,
}
