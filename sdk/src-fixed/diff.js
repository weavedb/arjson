import fastDiff from "fast-diff"

export function encodeFastDiff(diffs, strmap) {
  const ops = []
  let originalPos = 0
  for (const [op, text] of diffs) {
    if (op === fastDiff.DELETE) {
      ops.push({ op: 0, pos: originalPos, len: text.length })
      originalPos += text.length
    } else if (op === fastDiff.INSERT) {
      let strRef = null
      for (const [key, value] of Object.entries(strmap)) {
        if (value === text) {
          strRef = parseInt(key)
          break
        }
      }
      ops.push({ op: 1, pos: originalPos, str: text, ref: strRef })
    } else originalPos += text.length
  }

  return encodeToBinary(ops)
}

function encodeToBinary(ops) {
  const tempBuf = new Uint8Array(10000)
  let tempOffset = 0
  tempBuf[tempOffset++] = ops.length
  for (const op of ops) {
    const flags = (op.op << 7) | ((op.ref !== null ? 1 : 0) << 6)
    tempBuf[tempOffset++] = flags
    tempOffset = writeVarint(tempBuf, tempOffset, op.pos)
    if (op.op === 0) tempOffset = writeVarint(tempBuf, tempOffset, op.len)
    else {
      if (op.ref !== null) tempOffset = writeVarint(tempBuf, tempOffset, op.ref)
      else {
        tempOffset = writeVarint(tempBuf, tempOffset, op.str.length)
        for (let i = 0; i < op.str.length; i++) {
          tempBuf[tempOffset++] = op.str.charCodeAt(i)
        }
      }
    }
  }

  const dataSize = tempOffset
  const totalBits = dataSize * 8
  const lengthPrefixSize = varintSize(totalBits)
  const buf = new Uint8Array(lengthPrefixSize + dataSize)
  let offset = 0
  offset = writeVarint(buf, offset, totalBits)
  buf.set(tempBuf.slice(0, dataSize), offset)
  return buf
}

export function decodeFastDiff(binary, strmap) {
  let offset = 0
  let byte
  do byte = binary[offset++]
  while (byte & 0x80)
  const opCount = binary[offset++]
  const ops = []
  for (let i = 0; i < opCount; i++) {
    const flags = binary[offset++]
    const opType = (flags >> 7) & 1
    const hasRef = (flags >> 6) & 1

    const [pos, newOffset] = readVarint(binary, offset)
    offset = newOffset

    if (opType === 0) {
      const [len, newOffset2] = readVarint(binary, offset)
      offset = newOffset2
      ops.push({ op: 0, pos, len })
    } else {
      if (hasRef) {
        const [ref, newOffset2] = readVarint(binary, offset)
        offset = newOffset2
        const str = strmap[ref]
        ops.push({ op: 1, pos, str })
      } else {
        const [len, newOffset2] = readVarint(binary, offset)
        offset = newOffset2
        let str = ""
        for (let j = 0; j < len; j++) {
          str += String.fromCharCode(binary[offset++])
        }
        ops.push({ op: 1, pos, str })
      }
    }
  }

  return ops
}

export function applyDecodedOps(original, ops) {
  if (ops.length === 0) return original

  const sortedOps = [...ops].sort((a, b) => a.pos - b.pos)

  const result = []
  let originalPos = 0

  for (const op of sortedOps) {
    if (op.pos > originalPos) {
      for (let i = originalPos; i < op.pos; i++) result.push(original[i])
    }

    if (op.op === 0) originalPos = op.pos + op.len
    else {
      for (let i = 0; i < op.str.length; i++) result.push(op.str[i])

      originalPos = op.pos
    }
  }

  for (let i = originalPos; i < original.length; i++) {
    result.push(original[i])
  }

  return result.join("")
}

function writeVarint(buf, offset, value) {
  while (value >= 0x80) {
    buf[offset++] = (value & 0x7f) | 0x80
    value >>>= 7
  }
  buf[offset++] = value & 0x7f
  return offset
}

function readVarint(buf, offset) {
  let value = 0
  let shift = 0
  let byte

  do {
    byte = buf[offset++]
    value |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)

  return [value, offset]
}

function varintSize(value) {
  let size = 0
  while (value >= 0x80) {
    size++
    value >>>= 7
  }
  return size + 1
}
