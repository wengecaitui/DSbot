/**
 * CanonicalJson — strict canonical JSON serializer.
 *
 * Rules:
 * - null, string, boolean accepted.
 * - finite numbers accepted; negative zero → zero.
 * - object keys sorted lexicographically at every depth; array order preserved.
 * - Reject: undefined, bigint, symbol, function, NaN, Infinity, -Infinity.
 * - Reject non-plain objects (only Object.prototype or null prototype).
 * - Inspect own property descriptors without invoking getters.
 * - Reject accessors, symbol keys, non-enumerable custom properties,
 *   array custom (non-index) properties, and sparse arrays.
 * - Detect cycles via DFS path; shared non-cyclic subobjects serialize repeatedly.
 * - Clone without mutating or freezing caller input. Deep-freeze only the clone.
 */

// ─── Canonical Serialize ─────────────────────────────────────────────────────

export function canonicalSerialize(value: unknown): string {
  return _serialize(value, new WeakSet<object>());
}

/** DFS path — only acts as cycle guard, not dedup. Shared non-cyclic subobjects serialize repeatedly. */
function _serialize(value: unknown, path: WeakSet<object>): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`CanonicalJson: non-finite number not allowed: ${value}`);
    }
    // Negative zero → zero
    if (Object.is(value as number, -0)) return '0';
    return JSON.stringify(value);
  }

  if (t === 'undefined') throw new Error('CanonicalJson: undefined not allowed');
  if (t === 'bigint') throw new Error('CanonicalJson: bigint not allowed');
  if (t === 'symbol') throw new Error('CanonicalJson: symbol not allowed');
  if (t === 'function') throw new Error('CanonicalJson: function not allowed');

  if (Array.isArray(value)) {
    return _serializeArray(value, path);
  }

  if (t === 'object') {
    return _serializeObject(value as object, path);
  }

  throw new Error(`CanonicalJson: unsupported type: ${t}`);
}

function _serializeArray(arr: unknown[], path: WeakSet<object>): string {
  // Cycle check
  if (path.has(arr)) throw new Error('CanonicalJson: cycle detected');
  path.add(arr);

  try {
    // Sparse check — Object.keys won't enumerate holes but length will be larger
    const ownKeys = Object.keys(arr);
    if (ownKeys.length !== arr.length) {
      throw new Error('CanonicalJson: sparse arrays not allowed');
    }

    // Check for non-index properties via descriptors (skip built-in 'length')
    const descs = Object.getOwnPropertyDescriptors(arr);
    for (const key of Object.getOwnPropertyNames(arr)) {
      if (key === 'length') continue; // built-in property

      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length || String(idx) !== key) {
        const desc = descs[key];
        if (desc.get !== undefined || desc.set !== undefined) {
          throw new Error('CanonicalJson: accessor properties not allowed');
        }
        throw new Error('CanonicalJson: array custom properties not allowed');
      }
      // Check for accessor on index (unlikely but possible)
      const desc = descs[key];
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new Error('CanonicalJson: accessor properties not allowed');
      }
    }

    // Symbol keys on arrays
    if (Object.getOwnPropertySymbols(arr).length > 0) {
      throw new Error('CanonicalJson: symbol keys not allowed');
    }

    const parts = arr.map((item) => _serialize(item, path));
    return '[' + parts.join(',') + ']';
  } finally {
    path.delete(arr);
  }
}

function _serializeObject(obj: object, path: WeakSet<object>): string {
  // Prototype check
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error('CanonicalJson: non-plain objects not allowed');
  }

  // Cycle check
  if (path.has(obj)) throw new Error('CanonicalJson: cycle detected');
  path.add(obj);

  try {
    // Inspect descriptors without invoking getters
    const descs = Object.getOwnPropertyDescriptors(obj);
    const symbolKeys = Object.getOwnPropertySymbols(obj);

    if (symbolKeys.length > 0) {
      throw new Error('CanonicalJson: symbol keys not allowed');
    }

    const keys: string[] = [];

    for (const key of Object.getOwnPropertyNames(obj)) {
      const desc = descs[key];

      // Reject accessors
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new Error('CanonicalJson: accessor properties not allowed');
      }

      // Reject non-enumerable (all own props on plain objects should be enumerable)
      if (desc.enumerable === false) {
        throw new Error('CanonicalJson: non-enumerable properties not allowed');
      }

      keys.push(key);
    }

    // Sort lexicographically
    keys.sort();

    const parts = keys.map((key) => {
      const val = (obj as Record<string, unknown>)[key];
      return JSON.stringify(key) + ':' + _serialize(val, path);
    });

    return '{' + parts.join(',') + '}';
  } finally {
    path.delete(obj);
  }
}

// ─── Canonical Clone ─────────────────────────────────────────────────────────

export function cloneCanonicalValue(value: unknown): unknown {
  // Pre-validate with canonicalSerialize to enforce the identical rejection
  // contract (cycles, sparse arrays, accessors, symbol keys, non-plain objects, etc.)
  // before cloning. Shared non-cyclic subobjects are still deduplicated during cloning.
  canonicalSerialize(value);
  const cloned = _clone(value, new WeakMap<object, unknown>());
  _deepFreeze(cloned);
  return cloned;
}

function _clone(value: unknown, cache: WeakMap<object, unknown>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`CanonicalJson clone: non-finite number not allowed: ${value}`);
    }
    return Object.is(value as number, -0) ? 0 : value;
  }

  if (t === 'undefined' || t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new Error(`CanonicalJson clone: unsupported type: ${t}`);
  }

  if (Array.isArray(value)) {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const sparseCheck = Object.keys(value);
    if (sparseCheck.length !== value.length) {
      throw new Error('CanonicalJson clone: sparse arrays not allowed');
    }
    const arr: unknown[] = [];
    cache.set(value, arr);
    for (let i = 0; i < value.length; i++) {
      arr.push(_clone(value[i], cache));
    }
    return arr;
  }

  if (typeof value === 'object') {
    const obj = value;
    const cached = cache.get(obj);
    if (cached !== undefined) return cached;
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      throw new Error('CanonicalJson clone: non-plain objects not allowed');
    }
    const descs = Object.getOwnPropertyDescriptors(obj);
    const symbolKeys = Object.getOwnPropertySymbols(obj);
    if (symbolKeys.length > 0) throw new Error('CanonicalJson clone: symbol keys not allowed');

    for (const key of Object.getOwnPropertyNames(obj)) {
      const desc = descs[key];
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new Error('CanonicalJson clone: accessor properties not allowed');
      }
      if (desc.enumerable === false) {
        throw new Error('CanonicalJson clone: non-enumerable properties not allowed');
      }
    }

    const cloned: Record<string, unknown> = proto === null ? Object.create(null) : {};
    cache.set(obj, cloned);
    for (const key of Object.getOwnPropertyNames(obj)) {
      cloned[key] = _clone((obj as Record<string, unknown>)[key], cache);
    }
    return cloned;
  }

  throw new Error(`CanonicalJson clone: unsupported type: ${t}`);
}

function _deepFreeze(value: unknown): void {
  if (value === null) return;
  if (typeof value !== 'object' && typeof value !== 'function') return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) _deepFreeze(item);
  } else {
    const obj = value as object;
    for (const key of Object.getOwnPropertyNames(obj)) {
      _deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
}
