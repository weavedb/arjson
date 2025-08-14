# ARJSON Delta Update - Bug Report & Fix Strategy

## Executive Summary

ARJSON successfully handles most JSON transformations. This report focuses on actual bugs and implementation issues that need fixing, excluding non-JSON features like undefined, NaN, Infinity, and circular references which are outside JSON specification.

## Critical Bugs to Fix

### 1. Empty Structures Cannot Be Delta Updated 🐛
**Issue**: Empty objects `{}` and arrays `[]` use special 2-byte encoding that doesn't create the reference structure needed for delta updates.

**Impact**: Cannot use empty structures as starting point for delta updates

**Current Workaround**: Use minimal structures like `{_:null}` or `[null]`

**Fix Strategy**:
- Option A: When encoding empty structures, check if they might need updates and use standard encoding
- Option B: Handle empty structure as special case in delta system
- Option C: Document as intentional trade-off for size optimization

---

### 2. Keys with Brackets Break Path Parser 🐛
**Issue**: Object keys containing brackets are misinterpreted as array indices.

**Example**: 
```javascript
{ "user[admin]": true }  // Breaks: parser thinks "user" is array
{ "data[2020]": 100 }    // Breaks: tries to parse "2020" as array index
```

**Impact**: Cannot update objects with bracket-containing keys

**Fix Strategy**:
- Implement proper key escaping/quoting in path parser
- Use different syntax for array access (e.g., `/` separator)
- Or document as limitation and validate keys during encoding

---

### 3. Large Number Handling (JavaScript Implementation) 🐛
**Issue**: JavaScript encoder fails with large numbers due to precision and overflow issues.

**Problems**:
- Numbers approaching MAX_SAFE_INTEGER may lose precision
- Very large numbers cause infinite loops in encoder
- Not language-agnostic

**Fix Strategy**:
```javascript
// Detect and handle large numbers appropriately
if (Math.abs(v) > Number.MAX_SAFE_INTEGER) {
  // Use BigInt path or throw clear error
  throw new Error("Number exceeds safe range")
}

// For floats, detect problematic ranges
if (Math.abs(v) > 1e15) {
  // Use alternative encoding or limit precision
}
```

**Language-Agnostic Approach**:
- Define clear number ranges in spec
- Let each language handle within its capabilities
- Specify behavior for out-of-range numbers

---

### 4. Deep Nesting Performance 🐛
**Issue**: Very deep nesting (50+ levels) causes performance degradation or stack issues.

**Impact**: Practical limit of ~20-30 nesting levels

**Fix Strategy**:
- Convert recursive algorithms to iterative
- Add configurable depth limit with clear error
- Optimize stack usage in parser

---

## Non-Issues (Working as Designed)

### ✅ JSON-Incompatible Values
- **undefined**: Correctly not supported (not valid JSON)
- **NaN/Infinity**: Correctly converted to null (JSON standard)
- **Circular references**: Correctly rejected (not valid JSON)
- **Sparse arrays**: Correctly densified (JSON has no sparse arrays)

These are not bugs - they follow JSON specification correctly.

---

## Implementation Priority

### High Priority (Actual Bugs)
1. **Keys with brackets** - Path parser fix
2. **Large numbers** - Prevent infinite loops, add range checking
3. **Empty structure deltas** - Either fix or document clearly

### Medium Priority (Optimizations)
1. **Deep nesting** - Iterative algorithms
2. **Float precision** - Document precision limits
3. **Performance** - Optimize hot paths

### Low Priority (Nice to Have)
1. **Better error messages** - Clear feedback for unsupported operations
2. **Validation** - Warn about problematic keys early
3. **Test coverage** - Edge case testing

---

## Proposed Solutions

### 1. Path Parser Fix
```javascript
// Current (broken)
parsePath("user[admin]")  // Incorrectly parsed as array access

// Proposed
parsePath("user['admin']")     // Quoted keys
parsePath("user\[admin\]")     // Escaped brackets
parsePath("user.[admin]")      // Different syntax
```

### 2. Number Range Validation
```javascript
function validateNumber(n) {
  if (!Number.isFinite(n)) {
    return null; // JSON standard
  }
  if (Math.abs(n) > MAX_SAFE_ENCODING) {
    throw new RangeError(`Number ${n} exceeds safe encoding range`);
  }
  return n;
}
```

### 3. Empty Structure Handling
```javascript
// Option: Add metadata flag
if (isEmpty(obj) && needsDeltaSupport) {
  encoder.useStandardEncoding();
} else {
  encoder.useCompactEncoding();
}
```

---

## Testing Requirements

### Must Test:
- [ ] All valid JSON structures
- [ ] Keys with special characters (dots, brackets, quotes)
- [ ] Number boundary values within safe ranges
- [ ] Deep nesting up to reasonable limits
- [ ] Empty to non-empty transformations
- [ ] Large objects (1000+ keys)

### Should Reject (With Clear Errors):
- [ ] Circular references
- [ ] undefined values
- [ ] Numbers beyond safe range
- [ ] Invalid UTF-8 in strings

---

## Success Criteria

1. **All valid JSON** can be encoded, decoded, and delta-updated
2. **No crashes or hangs** on any input
3. **Clear error messages** for unsupported features
4. **Predictable performance** characteristics
5. **Cross-language compatibility** for valid JSON

---

## Conclusion

ARJSON's core design is solid. The main issues are:
1. Path parser bug with bracket-containing keys
2. JavaScript number handling causing infinite loops
3. Empty structure delta limitation

These are fixable implementation bugs, not fundamental design flaws. Once fixed, ARJSON will robustly handle all valid JSON transformations.