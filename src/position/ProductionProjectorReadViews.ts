import type { KernelPositionStateStore } from '../kernel/KernelPositionStateStore';
import type { KernelPolicyStore } from '../kernel/KernelPolicyStore';
import type { KernelMarketStateStore } from '../kernel/KernelMarketStateStore';
import type { PositionPlanStore } from './PositionPlanStore';
import type { PositionManagerRuntime } from './PositionManagerRuntime';

export type ProductionPositionReadView = Readonly<Pick<KernelPositionStateStore,
  'getLatest' | 'getByVersion' | 'resolve' | 'listResolved' | 'digest'>>;
export type ProductionPolicyReadView = Readonly<Pick<KernelPolicyStore,
  'getLatest' | 'getByVersion' | 'resolve' | 'digest'>>;
export type ProductionMarketReadView = Readonly<Pick<KernelMarketStateStore, 'getSnapshot' | 'digest'> & {
  getAllSnapshots(): readonly ReturnType<KernelMarketStateStore['getAllSnapshots']>[number][];
}>;
export type ProductionPlanReadView = Readonly<Pick<PositionPlanStore, 'get' | 'getActive' | 'list' | 'digest'>>;
export type ProductionProtectionView = Readonly<Pick<PositionManagerRuntime,
  'getMode' | 'getSubmittedCount'> & {
  readonly positionManager: Readonly<Pick<PositionManagerRuntime['positionManager'], 'getStopConfig'>>;
}>;

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

export function createProductionMarketReadView(store: KernelMarketStateStore): ProductionMarketReadView {
  return Object.freeze({
    getSnapshot: (...args: Parameters<KernelMarketStateStore['getSnapshot']>) => snapshot(store.getSnapshot(...args)),
    getAllSnapshots: () => snapshot(store.getAllSnapshots()),
    digest: () => store.digest(),
  });
}

export function createProductionPlanReadView(store: PositionPlanStore): ProductionPlanReadView {
  return Object.freeze({
    get: (id: string) => snapshot(store.get(id)),
    getActive: (exchange: string, symbol: string) => snapshot(store.getActive(exchange, symbol)),
    list: () => snapshot(store.list()),
    digest: () => store.digest(),
  });
}

/** Observations only: lifecycle and in-flight state remain owner/internal authority. */
export function createProductionProtectionView(runtime: PositionManagerRuntime): ProductionProtectionView {
  return Object.freeze({
    getMode: () => runtime.getMode(),
    getSubmittedCount: () => runtime.getSubmittedCount(),
    positionManager: Object.freeze({ getStopConfig: () => snapshot(runtime.positionManager.getStopConfig()) }),
  });
}
