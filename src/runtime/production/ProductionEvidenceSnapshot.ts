/** Public evidence is detached data, never a service or a mutable internal reference. */
export function productionEvidenceSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const visited = new WeakSet<object>();
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object' || visited.has(item)) return;
    const prototype = Object.getPrototypeOf(item);
    // Object.freeze does not disable Map/Set/Date/typed-array internal mutators.
    // Public evidence contracts use DTOs; reject unsupported mutable containers.
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null
        && !(item instanceof Error)) throw new Error('OBSERVABILITY_NON_DTO_VALUE');
    visited.add(item);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if ('value' in descriptor) {
        freeze(descriptor.value);
      } else {
        // Node's cloned Error.stack can retain an accessor setter even after
        // Object.freeze. Materialize the detached value before sealing the DTO.
        const data = Reflect.get(item, key);
        Object.defineProperty(item, key, { value: data, enumerable: descriptor.enumerable,
          writable: true, configurable: true });
        freeze(data);
      }
    }
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}
