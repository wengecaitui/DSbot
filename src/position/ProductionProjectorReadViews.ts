import type { KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import type { KernelPolicyStore } from '../kernel/KernelPolicyStore';

export type ProductionPositionReadView = Readonly<Pick<KernelPositionStateStore,
  'getLatest' | 'getByVersion' | 'resolve' | 'listResolved' | 'digest'>>;
export type ProductionPolicyReadView = Readonly<Pick<KernelPolicyStore,
  'getLatest' | 'getByVersion' | 'resolve' | 'digest'>>;

/** Detached, recursively frozen evidence. Never return the projector or its methods. */
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}

export function createProductionPositionReadView(store: KernelPositionStateStore): ProductionPositionReadView {
  return Object.freeze({
    getLatest: (...args: Parameters<KernelPositionStateStore['getLatest']>) => snapshot(store.getLatest(...args)),
    getByVersion: (...args: Parameters<KernelPositionStateStore['getByVersion']>) => snapshot(store.getByVersion(...args)),
    resolve: (...args: Parameters<KernelPositionStateStore['resolve']>) => snapshot(store.resolve(...args)),
    listResolved: () => snapshot(store.listResolved()),
    digest: () => store.digest(),
  });
}

export function createProductionPolicyReadView(store: KernelPolicyStore): ProductionPolicyReadView {
  return Object.freeze({
    getLatest: (...args: Parameters<KernelPolicyStore['getLatest']>) => snapshot(store.getLatest(...args)),
    getByVersion: (...args: Parameters<KernelPolicyStore['getByVersion']>) => snapshot(store.getByVersion(...args)),
    resolve: (...args: Parameters<KernelPolicyStore['resolve']>) => snapshot(store.resolve(...args)),
    digest: () => store.digest(),
  });
}
