function createJSON(depth = 0) {
  const maxDepth = 3 // Limit depth so overall JSON size stays moderate.
  if (depth >= maxDepth) {
    return randomPrimitive()
  }

  // Randomly decide between creating an object or an array.
  if (Math.random() < 0.5) {
    // Create an object with 1 to 4 key/value pairs.
    const numKeys = Math.floor(Math.random() * 4) + 1
    const obj = {}
    for (let i = 0; i < numKeys; i++) {
      // Key length between 1 and 6 characters.
      const key = randomString(Math.floor(Math.random() * 6) + 1)
      obj[key] = createJSON(depth + 1)
    }
    return obj
  } else {
    // Create an array with 1 to 4 elements.
    const len = Math.floor(Math.random() * 4) + 1
    const arr = []
    for (let i = 0; i < len; i++) {
      arr.push(createJSON(depth + 1))
    }
    return arr
  }
}

function randomPrimitive() {
  // Return a simple primitive.
  const r = Math.random()
  if (r < 0.25) {
    // A small integer between 0 and 100.
    return Math.floor(Math.random() * 101)
  } else if (r < 0.5) {
    // A short string (length 1 to 10).
    return randomString(Math.floor(Math.random() * 10) + 1)
  } else if (r < 0.75) {
    return Math.random() < 0.5
  } else {
    return null
  }
}

function randomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < length; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return s
}

function randomString2(minLen, maxLen) {
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let result = ""
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
    // Add spaces occasionally for readability
    if (i > 0 && i % 15 === 0 && Math.random() > 0.5) {
      result += " "
    }
  }
  return result.trim()
}

function randomWord() {
  const words = [
    "user",
    "admin",
    "member",
    "guest",
    "moderator",
    "developer",
    "manager",
    "analyst",
    "designer",
    "engineer",
    "consultant",
  ]
  return words[Math.floor(Math.random() * words.length)]
}

function randomName() {
  const first = [
    "Alice",
    "Bob",
    "Charlie",
    "Diana",
    "Eve",
    "Frank",
    "Grace",
    "Henry",
  ]
  const last = [
    "Smith",
    "Johnson",
    "Williams",
    "Brown",
    "Jones",
    "Garcia",
    "Miller",
  ]
  return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomBoolean() {
  return Math.random() > 0.5
}

function randomArray(minItems, maxItems, generator) {
  const len = randomInt(minItems, maxItems)
  return Array.from({ length: len }, generator)
}

function genUser() {
  const userType = Math.random()

  // 40% - Small simple users
  if (userType < 0.4) {
    return {
      name: randomName(),
      age: randomInt(18, 75),
      role: randomWord(),
      id: randomInt(10000, 99999),
    }
  }

  // 35% - Medium users
  if (userType < 0.75) {
    return {
      username: randomString2(6, 12),
      name: randomName(),
      email: `${randomString2(5, 10)}@example.com`,
      age: randomInt(18, 75),
      active: randomBoolean(),
      score: randomInt(0, 1000),
      role: randomWord(),
      tags: randomArray(1, 3, () => randomWord()),
    }
  }

  // 20% - Larger users with descriptions
  if (userType < 0.95) {
    return {
      id: randomString2(15, 25),
      username: randomString2(6, 12),
      name: randomName(),
      bio: randomString2(50, 120),
      age: randomInt(18, 75),
      role: randomWord(),
      active: randomBoolean(),
      metadata: {
        department: randomWord(),
        level: randomInt(1, 10),
        certified: randomBoolean(),
      },
      preferences: {
        theme: ["dark", "light"][randomInt(0, 1)],
        notifications: randomBoolean(),
        language: ["en", "es", "fr"][randomInt(0, 2)],
      },
      tags: randomArray(2, 4, () => randomWord()),
    }
  }

  // 5% - Large detailed users
  return {
    id: randomString2(20, 30),
    username: randomString2(8, 15),
    name: randomName(),
    email: `${randomString2(5, 10)}@example.com`,
    bio: randomString2(80, 150),
    description: randomString2(100, 250),
    age: randomInt(18, 75),
    role: randomWord(),
    experience: randomInt(0, 20),
    active: randomBoolean(),
    verified: randomBoolean(),
    metadata: {
      department: randomWord(),
      level: randomInt(1, 10),
      certified: randomBoolean(),
      joined: Date.now() - randomInt(0, 365 * 24 * 60 * 60 * 1000),
    },
    skills: randomArray(2, 5, () => randomWord()),
    projects: randomArray(1, 3, () => ({
      name: randomString2(10, 20),
      status: ["active", "completed", "pending"][randomInt(0, 2)],
      progress: randomInt(0, 100),
    })),
  }
}

export { createJSON, genUser }
