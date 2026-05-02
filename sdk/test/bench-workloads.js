// Shared workload corpus for bench scripts.
const W = {
  null_: null,
  true_: true,
  int_small: 42,
  int_neg: -1234567,
  string_short: "hello",
  string_med: "The quick brown fox jumps over the lazy dog",
  string_long: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
  float: 3.14159,
  tiny_obj: { a: 1, b: 2 },
  tiny_arr: [1, 2, 3],
  user_record: {
    id: 12345,
    username: "alice",
    name: "Alice Johnson",
    email: "alice@example.com",
    age: 30,
    active: true,
    role: "admin",
    tags: ["staff", "verified"],
    preferences: { theme: "dark", notifications: true, language: "en" },
  },
  log_entry: {
    ts: 1709876543210,
    level: "info",
    service: "api-gateway",
    method: "POST",
    path: "/v1/users",
    status: 200,
    duration_ms: 47.3,
    user_id: "u_8f3a92",
    request_id: "r_19283abc",
  },
  config_doc: {
    server: { host: "0.0.0.0", port: 8080, ssl: true, timeout_ms: 30000 },
    database: { host: "db.internal", port: 5432, name: "prod", pool_size: 20 },
    cache: { enabled: true, ttl_s: 3600, max_entries: 100000 },
    log: { level: "info", outputs: ["stdout", "file"], file: "/var/log/app.log" },
    features: { feature_a: true, feature_b: false, feature_c: true },
  },
  schema_doc: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1, maxLength: 255 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      email: { type: "string", format: "email" },
      tags: { type: "array", items: { type: "string" } },
      meta: { type: "object", additionalProperties: true },
    },
  },
  wide_50: (() => {
    const o = {}
    for (let i = 0; i < 50; i++) o[`field_${i}`] = i
    return o
  })(),
  wide_100_mixed: (() => {
    const o = {}
    for (let i = 0; i < 100; i++) {
      o[`k${i}`] = i % 4 === 0 ? `value${i}` : i % 4 === 1 ? i : i % 4 === 2 ? i % 2 === 0 : null
    }
    return o
  })(),
  wide_500: (() => {
    const o = {}
    for (let i = 0; i < 500; i++) o[`k${i}`] = i
    return o
  })(),
  arr_int_10: Array.from({ length: 10 }, (_, i) => i),
  arr_int_100: Array.from({ length: 100 }, (_, i) => i),
  arr_int_1000: Array.from({ length: 1000 }, (_, i) => i),
  arr_int_random_100: Array.from({ length: 100 }, (_, i) => (i * 37 + 13) % 1000),
  arr_str_100_homog: Array.from({ length: 100 }, () => "repeated"),
  arr_str_100_unique: Array.from({ length: 100 }, (_, i) => `unique_string_${i}`),
  arr_obj_100_homog: Array.from({ length: 100 }, (_, i) => ({
    id: i,
    name: "user",
    role: "admin",
    active: true,
  })),
  arr_bool_100: Array.from({ length: 100 }, (_, i) => i % 2 === 0),
  arr_null_100: Array.from({ length: 100 }, () => null),
  deep_nest_30: (() => {
    let o = { v: 0 }
    for (let i = 0; i < 30; i++) o = { x: o }
    return o
  })(),
  deep_nest_50: (() => {
    let o = { v: 0 }
    for (let i = 0; i < 50; i++) o = { x: o }
    return o
  })(),
  redundant_users: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
    active: true,
  })),
  time_series_100: Array.from({ length: 100 }, (_, i) => ({
    ts: 1709000000 + i * 60,
    value: 100 + Math.sin(i / 10) * 20,
  })),
  mixed_array: [
    1, "two", null, true, [3, 4], { five: 5 }, -1.5, "another", false, [], {}, "last",
  ],
  bool_array_500: Array.from({ length: 500 }, (_, i) => (i * 7) % 3 === 0),
  float_array_100: Array.from({ length: 100 }, (_, i) => i * 0.5),
  long_string_obj: {
    title: "A long article",
    content: "Lorem ipsum dolor sit amet. ".repeat(200),
    tags: ["text", "long", "content"],
  },
}
export default W
