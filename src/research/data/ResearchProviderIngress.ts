import { isDeepStrictEqual } from 'node:util';
import {
  assertProviderManifest,
  assertProviderManifestSnapshotStructure,
  type ProviderManifest,
} from './ProviderManifestContract';
import {
  assertResearchProviderAdapterSurface,
  fetchOneResearchPage,
  validateResearchProviderConfiguration,
  type RawResearchRecord,
  type ResearchFetchPage,
  type ResearchFetchRequest,
  type ResearchProviderAdapter,
} from './ResearchProviderAdapterContract';

export interface ResearchProviderKey {
  readonly providerId: string;
  readonly adapterId: string;
}

export interface ResearchProviderRegistration {
  readonly adapter: ResearchProviderAdapter;
  readonly configuration: unknown;
}

export type PublicResearchProviderManifest = Omit<ProviderManifest, 'auth'> & {
  readonly auth: {
    readonly mode: ProviderManifest['auth']['mode'];
    readonly credentialReferenceCount: number;
  };
};

export interface ResearchProviderDescriptor extends ResearchProviderKey {
  readonly manifest: PublicResearchProviderManifest;
}

export interface ResearchProviderIngress {
  list(): readonly ResearchProviderDescriptor[];
  describe(key: ResearchProviderKey): ResearchProviderDescriptor;
  fetchPage(
    key: ResearchProviderKey,
    request: ResearchFetchRequest,
    signal: AbortSignal,
  ): Promise<ResearchFetchPage>;
}

interface RegistryEntry {
  readonly rawAdapter: ResearchProviderAdapter;
  readonly guardedAdapter: ResearchProviderAdapter;
  readonly pinnedManifest: ProviderManifest;
  readonly descriptor: ResearchProviderDescriptor;
}

function ingressError(reason: 'RESEARCH_PROVIDER_DUPLICATE' | 'RESEARCH_PROVIDER_NOT_FOUND' | 'RESEARCH_PROVIDER_MANIFEST_DRIFT'): Error {
  const error = new Error(reason);
  error.name = 'ResearchProviderIngressError';
  return error;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function cloneManifest(manifest: ProviderManifest): ProviderManifest {
  return structuredClone(manifest);
}

function snapshotValidatedManifest(rawAdapter: ResearchProviderAdapter): ProviderManifest {
  assertResearchProviderAdapterSurface(rawAdapter);
  const rawManifest = rawAdapter.describe();
  assertProviderManifestSnapshotStructure(rawManifest);
  const snapshot = structuredClone(rawManifest);
  assertProviderManifest(snapshot);
  return snapshot;
}

function createPublicDescriptor(manifest: ProviderManifest): ResearchProviderDescriptor {
  const cloned = cloneManifest(manifest);
  const { credentialReferences, ...publicAuth } = cloned.auth;
  const publicManifest: PublicResearchProviderManifest = {
    ...cloned,
    auth: {
      ...publicAuth,
      credentialReferenceCount: credentialReferences.length,
    },
  };
  return deepFreeze({
    providerId: cloned.providerId,
    adapterId: cloned.adapterId,
    manifest: publicManifest,
  });
}

function createGuardedAdapter(
  rawAdapter: ResearchProviderAdapter,
  pinnedManifest: ProviderManifest,
): ResearchProviderAdapter {
  return Object.freeze({
    describe: () => pinnedManifest,
    validateConfiguration: (configuration: unknown) => rawAdapter.validateConfiguration(configuration),
    fetch: (request: ResearchFetchRequest, signal: AbortSignal) => rawAdapter.fetch(request, signal),
  });
}

function protectRecordEnvelope(record: RawResearchRecord): RawResearchRecord {
  const sourceRevision = record.sourceRevision === undefined
    ? undefined
    : Object.freeze({
      revisionId: record.sourceRevision.revisionId,
      ...(record.sourceRevision.observedAt === undefined
        ? {}
        : { observedAt: record.sourceRevision.observedAt }),
    });
  return Object.freeze({
    providerId: record.providerId,
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    sourceDatasetRef: record.sourceDatasetRef,
    sourceRecordId: record.sourceRecordId,
    eventTime: record.eventTime,
    availableAt: record.availableAt,
    availableAtAuthority: record.availableAtAuthority,
    ingestedAt: record.ingestedAt,
    payload: record.payload,
    payloadHash: record.payloadHash,
    manifestVersion: record.manifestVersion,
    manifestReference: record.manifestReference,
    requestId: record.requestId,
    sourceProvenanceRef: record.sourceProvenanceRef,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
  });
}

function protectPageEnvelope(page: ResearchFetchPage): ResearchFetchPage {
  const records = Object.freeze(page.records.map(protectRecordEnvelope));
  return Object.freeze({
    records,
    nextCursor: page.nextCursor,
    complete: page.complete,
  });
}

export function createResearchProviderIngress(
  registrations: readonly ResearchProviderRegistration[],
): ResearchProviderIngress {
  const registry = new Map<string, Map<string, RegistryEntry>>();
  const descriptors: ResearchProviderDescriptor[] = [];

  for (const registration of registrations) {
    const rawAdapter = registration.adapter;
    const describedManifest = snapshotValidatedManifest(rawAdapter);
    validateResearchProviderConfiguration(rawAdapter, registration.configuration);

    let providerEntries = registry.get(describedManifest.providerId);
    if (providerEntries?.has(describedManifest.adapterId)) {
      throw ingressError('RESEARCH_PROVIDER_DUPLICATE');
    }
    if (providerEntries === undefined) {
      providerEntries = new Map<string, RegistryEntry>();
      registry.set(describedManifest.providerId, providerEntries);
    }

    const pinnedManifest = deepFreeze(describedManifest);
    const guardedAdapter = createGuardedAdapter(rawAdapter, pinnedManifest);
    const descriptor = createPublicDescriptor(pinnedManifest);
    providerEntries.set(describedManifest.adapterId, Object.freeze({
      rawAdapter,
      guardedAdapter,
      pinnedManifest,
      descriptor,
    }));
    descriptors.push(descriptor);
  }

  const listedDescriptors = Object.freeze([...descriptors].sort((left, right) => {
    if (left.providerId !== right.providerId) return left.providerId < right.providerId ? -1 : 1;
    if (left.adapterId === right.adapterId) return 0;
    return left.adapterId < right.adapterId ? -1 : 1;
  }));

  function entryFor(key: ResearchProviderKey): RegistryEntry {
    const entry = registry.get(key.providerId)?.get(key.adapterId);
    if (entry === undefined) throw ingressError('RESEARCH_PROVIDER_NOT_FOUND');
    return entry;
  }

  return Object.freeze({
    list(): readonly ResearchProviderDescriptor[] {
      return listedDescriptors;
    },

    describe(key: ResearchProviderKey): ResearchProviderDescriptor {
      return entryFor(key).descriptor;
    },

    async fetchPage(
      key: ResearchProviderKey,
      request: ResearchFetchRequest,
      signal: AbortSignal,
    ): Promise<ResearchFetchPage> {
      const entry = entryFor(key);
      const currentManifest = snapshotValidatedManifest(entry.rawAdapter);
      if (!isDeepStrictEqual(currentManifest, entry.pinnedManifest)) {
        throw ingressError('RESEARCH_PROVIDER_MANIFEST_DRIFT');
      }
      const page = await fetchOneResearchPage(entry.guardedAdapter, request, signal);
      return protectPageEnvelope(page);
    },
  });
}
