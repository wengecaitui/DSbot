import {
  assertResearchStorageInterchange,
  type ResearchStorageInterchange,
} from '../storage/ResearchStorageContract';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const STORAGE_BUNDLE_ID = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ResearchDatasetLifecycle =
  | 'NOT_YET_PUBLISHED'
  | 'ACTIVE'
  | 'DEPRECATION_SCHEDULED'
  | 'DEPRECATED';

export interface ResearchDatasetVersionRef {
  readonly datasetId: string;
  readonly storageBundleId: string;
}

export interface ResearchDatasetVersionInput extends ResearchDatasetVersionRef {
  readonly publishedAt: string;
  readonly supersedes?: ResearchDatasetVersionRef;
  readonly interchange: ResearchStorageInterchange;
}

export interface ResearchDatasetDeprecationInput {
  readonly target: ResearchDatasetVersionRef;
  readonly declaredAt: string;
  readonly effectiveAt: string;
  readonly reason: string;
  readonly replacement?: ResearchDatasetVersionRef;
}

export interface CreateResearchDatasetVersionCatalogInput {
  readonly versions: readonly ResearchDatasetVersionInput[];
  readonly deprecations: readonly ResearchDatasetDeprecationInput[];
}

export interface CanonicalDatasetLineage {
  readonly dictionaryId: string;
  readonly dictionaryVersion: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly sourceDatasetRef: string;
  readonly adapterVersions: readonly string[];
  readonly manifestVersions: readonly string[];
}

export interface ResearchDatasetVersionMetadata extends ResearchDatasetVersionRef {
  readonly publishedAt: string;
  readonly canonicalLineage: CanonicalDatasetLineage;
  readonly supersedes?: ResearchDatasetVersionRef;
  readonly productionAuthority: false;
}

export interface ResearchDatasetDeprecationMetadata {
  readonly target: ResearchDatasetVersionRef;
  readonly declaredAt: string;
  readonly effectiveAt: string;
  readonly reason: string;
  readonly replacement?: ResearchDatasetVersionRef;
}

export interface ResearchDatasetLifecycleRequest {
  readonly ref: ResearchDatasetVersionRef;
  readonly governanceTime: string;
}

export interface ResearchDatasetPublishedVersionsRequest {
  readonly datasetId: string;
  readonly governanceTime: string;
}

export interface ResearchDatasetGovernanceVersion extends ResearchDatasetVersionMetadata {
  readonly usageMode: 'RESEARCH_GOVERNANCE';
  readonly governanceTime: string;
  readonly lifecycle: Exclude<ResearchDatasetLifecycle, 'NOT_YET_PUBLISHED'>;
  readonly versionIndex?: number;
  readonly deprecation?: ResearchDatasetDeprecationMetadata;
}

export interface ResearchDatasetNotYetPublished {
  readonly usageMode: 'RESEARCH_GOVERNANCE';
  readonly ref: ResearchDatasetVersionRef;
  readonly governanceTime: string;
  readonly lifecycle: 'NOT_YET_PUBLISHED';
  readonly productionAuthority: false;
}

export type ResearchDatasetLifecycleView =
  | ResearchDatasetGovernanceVersion
  | ResearchDatasetNotYetPublished;

export interface ResearchDatasetPublishedVersionsView {
  readonly usageMode: 'RESEARCH_GOVERNANCE';
  readonly datasetId: string;
  readonly governanceTime: string;
  readonly versions: readonly ResearchDatasetGovernanceVersion[];
  readonly productionAuthority: false;
}

export interface ResearchDatasetVersionAudit {
  readonly usageMode: 'RESEARCH_GOVERNANCE_AUDIT';
  readonly version: ResearchDatasetVersionMetadata;
  readonly deprecation?: ResearchDatasetDeprecationMetadata;
  readonly researchGovernanceOnly: true;
  readonly storageIntegrityAuthority: false;
  readonly productionAuthority: false;
}

export interface ResearchDatasetSupersessionTrace {
  readonly usageMode: 'RESEARCH_GOVERNANCE_AUDIT';
  readonly versions: readonly ResearchDatasetVersionMetadata[];
  readonly researchGovernanceOnly: true;
  readonly storageIntegrityAuthority: false;
  readonly productionAuthority: false;
}

export interface ResearchDatasetGovernancePort {
  readonly getLifecycle: (request: ResearchDatasetLifecycleRequest) => ResearchDatasetLifecycleView;
  readonly listPublishedVersions: (
    request: ResearchDatasetPublishedVersionsRequest,
  ) => ResearchDatasetPublishedVersionsView;
}

export interface ResearchDatasetAuditPort {
  readonly getVersion: (ref: ResearchDatasetVersionRef) => ResearchDatasetVersionAudit;
  readonly traceSupersession: (ref: ResearchDatasetVersionRef) => ResearchDatasetSupersessionTrace;
  readonly researchGovernanceOnly: true;
  readonly productionAuthority: false;
}

export interface ResearchDatasetVersionCatalog {
  readonly governancePort: ResearchDatasetGovernancePort;
  readonly auditPort: ResearchDatasetAuditPort;
  readonly storageIntegrityAuthority: false;
  readonly productionAuthority: false;
}

interface InternalVersion {
  readonly key: string;
  readonly metadata: ResearchDatasetVersionMetadata;
  readonly publishedAtMs: number;
  readonly predecessorKey?: string;
}

function lineageViolation(reason: string): never {
  throw new Error(`PHASE_9F_LINEAGE_INVALID:${reason}`);
}

/** Descriptor-only traversal. It must finish before any semantic property read. */
function assertInertData(value: unknown, rootName: string): void {
  const active = new WeakSet<object>();

  function inspect(current: unknown, path: string): void {
    if (typeof current === 'function') lineageViolation(`FUNCTION:${path}`);
    if (typeof current === 'symbol') lineageViolation(`SYMBOL_VALUE:${path}`);
    if (current === null || typeof current !== 'object') return;
    if (active.has(current)) lineageViolation(`CYCLE:${path}`);
    active.add(current);
    try {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        lineageViolation(`SYMBOL_PROPERTY:${path}`);
      }
      if (Array.isArray(current)) {
        const names = Object.getOwnPropertyNames(current);
        for (const name of names) {
          if (name === 'length') continue;
          if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= current.length) {
            lineageViolation(`ARRAY_CUSTOM_PROPERTY:${path}`);
          }
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined) lineageViolation(`ARRAY_HOLE:${path}`);
          if (descriptor.get !== undefined || descriptor.set !== undefined) {
            lineageViolation(`ARRAY_ACCESSOR:${path}`);
          }
          inspect(descriptor.value, `${path}[${index}]`);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        lineageViolation(`NON_PLAIN_OBJECT:${path}`);
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          lineageViolation(`ACCESSOR:${path}.${key}`);
        }
        inspect(descriptor.value, `${path}.${key}`);
      }
    } finally {
      active.delete(current);
    }
  }

  inspect(value, rootName);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) lineageViolation(reason);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  reason: string,
): void {
  const actual = Object.getOwnPropertyNames(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    lineageViolation(reason);
  }
}

function identifier(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) lineageViolation(reason);
  return value;
}

function storageBundleId(value: unknown): string {
  if (typeof value !== 'string' || !STORAGE_BUNDLE_ID.test(value)) {
    lineageViolation('STORAGE_BUNDLE_ID');
  }
  return value;
}

function canonicalTimestamp(value: unknown, reason: string): { value: string; milliseconds: number } {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) lineageViolation(reason);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    lineageViolation(reason);
  }
  return { value, milliseconds };
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value) {
    lineageViolation('DEPRECATION_REASON');
  }
  return value;
}

function refKey(ref: ResearchDatasetVersionRef): string {
  return `${ref.datasetId}\u0000${ref.storageBundleId}`;
}

function snapshotRef(ref: ResearchDatasetVersionRef): ResearchDatasetVersionRef {
  return { datasetId: ref.datasetId, storageBundleId: ref.storageBundleId };
}

function validateRef(value: unknown, reason: string): ResearchDatasetVersionRef {
  const record = plainRecord(value, reason);
  exactKeys(record, ['datasetId', 'storageBundleId'], [], `${reason}_FIELDS`);
  return {
    datasetId: identifier(record.datasetId, `${reason}_DATASET_ID`),
    storageBundleId: storageBundleId(record.storageBundleId),
  };
}

function deriveCanonicalLineage(interchange: ResearchStorageInterchange): CanonicalDatasetLineage {
  const dataset = interchange.canonicalDataset;
  return {
    dictionaryId: dataset.dictionaryId,
    dictionaryVersion: dataset.dictionaryVersion,
    bindingId: dataset.bindingId,
    bindingVersion: dataset.bindingVersion,
    providerId: dataset.providerId,
    adapterId: dataset.adapterId,
    sourceDatasetRef: dataset.sourceDatasetRef,
    adapterVersions: [...new Set(dataset.records.map((record) => record.adapterVersion))].sort(),
    manifestVersions: [...new Set(dataset.records.map((record) => record.manifestVersion))].sort(),
  };
}

function sameSeries(left: CanonicalDatasetLineage, right: CanonicalDatasetLineage): boolean {
  return left.providerId === right.providerId
    && left.adapterId === right.adapterId
    && left.sourceDatasetRef === right.sourceDatasetRef;
}

function assertNoSupersessionCycles(versions: ReadonlyMap<string, InternalVersion>): void {
  for (const version of versions.values()) {
    const visited = new Set<string>();
    let current: InternalVersion | undefined = version;
    while (current !== undefined) {
      if (visited.has(current.key)) lineageViolation('SUPERSESSION_CYCLE');
      visited.add(current.key);
      current = current.predecessorKey === undefined ? undefined : versions.get(current.predecessorKey);
    }
  }
}

function isDescendant(
  candidate: InternalVersion,
  ancestorKey: string,
  versions: ReadonlyMap<string, InternalVersion>,
): boolean {
  let current: InternalVersion | undefined = candidate;
  while (current.predecessorKey !== undefined) {
    if (current.predecessorKey === ancestorKey) return true;
    current = versions.get(current.predecessorKey);
    if (current === undefined) return false;
  }
  return false;
}

function lifecycleAt(
  version: InternalVersion,
  deprecation: ResearchDatasetDeprecationMetadata | undefined,
  governanceTimeMs: number,
): ResearchDatasetLifecycle {
  if (governanceTimeMs < version.publishedAtMs) return 'NOT_YET_PUBLISHED';
  if (deprecation === undefined) return 'ACTIVE';
  const declaredAtMs = Date.parse(deprecation.declaredAt);
  const effectiveAtMs = Date.parse(deprecation.effectiveAt);
  if (governanceTimeMs < declaredAtMs) return 'ACTIVE';
  if (governanceTimeMs < effectiveAtMs) return 'DEPRECATION_SCHEDULED';
  return 'DEPRECATED';
}

function governanceVersion(
  version: InternalVersion,
  deprecation: ResearchDatasetDeprecationMetadata | undefined,
  governanceTime: string,
  governanceTimeMs: number,
  versionIndex?: number,
): ResearchDatasetGovernanceVersion {
  const lifecycle = lifecycleAt(version, deprecation, governanceTimeMs);
  if (lifecycle === 'NOT_YET_PUBLISHED') lineageViolation('INTERNAL_UNPUBLISHED_GOVERNANCE_VIEW');
  const visibleDeprecation = deprecation !== undefined && governanceTimeMs >= Date.parse(deprecation.declaredAt)
    ? deprecation
    : undefined;
  return deepFreeze({
    usageMode: 'RESEARCH_GOVERNANCE',
    ...version.metadata,
    governanceTime,
    lifecycle,
    ...(versionIndex === undefined ? {} : { versionIndex }),
    ...(visibleDeprecation === undefined ? {} : { deprecation: visibleDeprecation }),
  });
}

export function createResearchDatasetVersionCatalog(
  callerInput: CreateResearchDatasetVersionCatalogInput,
): ResearchDatasetVersionCatalog {
  assertInertData(callerInput, 'PHASE_9F_CATALOG_INPUT');
  const input = structuredClone(callerInput) as CreateResearchDatasetVersionCatalogInput;
  const root = plainRecord(input, 'CATALOG_INPUT');
  exactKeys(root, ['versions', 'deprecations'], [], 'CATALOG_INPUT_FIELDS');
  if (!Array.isArray(input.versions) || !Array.isArray(input.deprecations)) {
    lineageViolation('CATALOG_INPUT_ARRAYS');
  }

  const versions = new Map<string, InternalVersion>();
  const bundleOwners = new Map<string, string>();
  const seriesLineage = new Map<string, CanonicalDatasetLineage>();

  for (const candidate of input.versions) {
    const record = plainRecord(candidate, 'VERSION_INPUT');
    exactKeys(
      record,
      ['datasetId', 'storageBundleId', 'publishedAt', 'interchange'],
      ['supersedes'],
      'VERSION_INPUT_FIELDS',
    );
    const ref = deepFreeze({
      datasetId: identifier(candidate.datasetId, 'DATASET_ID'),
      storageBundleId: storageBundleId(candidate.storageBundleId),
    });
    const published = canonicalTimestamp(candidate.publishedAt, 'PUBLISHED_AT');
    const supersedes = candidate.supersedes === undefined
      ? undefined
      : validateRef(candidate.supersedes, 'SUPERSEDES_REF');
    assertResearchStorageInterchange(candidate.interchange);
    const canonicalLineage = deriveCanonicalLineage(candidate.interchange);
    const key = refKey(ref);
    if (versions.has(key)) lineageViolation('DUPLICATE_VERSION_REF');
    const existingOwner = bundleOwners.get(ref.storageBundleId);
    if (existingOwner !== undefined && existingOwner !== ref.datasetId) lineageViolation('BUNDLE_ALIAS');
    bundleOwners.set(ref.storageBundleId, ref.datasetId);
    const existingSeries = seriesLineage.get(ref.datasetId);
    if (existingSeries !== undefined && !sameSeries(existingSeries, canonicalLineage)) {
      if (existingSeries.providerId !== canonicalLineage.providerId) lineageViolation('PROVIDER_IDENTITY_DRIFT');
      if (existingSeries.adapterId !== canonicalLineage.adapterId) lineageViolation('ADAPTER_IDENTITY_DRIFT');
      lineageViolation('SOURCE_DATASET_REF_DRIFT');
    }
    seriesLineage.set(ref.datasetId, canonicalLineage);
    const metadata = deepFreeze({
      ...ref,
      publishedAt: published.value,
      canonicalLineage,
      ...(supersedes === undefined ? {} : { supersedes }),
      productionAuthority: false,
    } satisfies ResearchDatasetVersionMetadata);
    versions.set(key, {
      key,
      metadata,
      publishedAtMs: published.milliseconds,
      ...(supersedes === undefined ? {} : { predecessorKey: refKey(supersedes) }),
    });
  }

  for (const version of versions.values()) {
    if (version.predecessorKey === undefined) continue;
    if (version.predecessorKey === version.key) lineageViolation('SELF_SUPERSESSION');
    const predecessor = versions.get(version.predecessorKey);
    if (predecessor === undefined) lineageViolation('MISSING_PREDECESSOR');
    if (predecessor.metadata.datasetId !== version.metadata.datasetId) {
      lineageViolation('CROSS_DATASET_SUPERSESSION');
    }
  }
  assertNoSupersessionCycles(versions);
  const successors = new Map<string, string>();
  for (const version of versions.values()) {
    if (version.predecessorKey === undefined) continue;
    const predecessor = versions.get(version.predecessorKey);
    if (predecessor === undefined) lineageViolation('MISSING_PREDECESSOR');
    if (version.publishedAtMs <= predecessor.publishedAtMs) {
      lineageViolation('NON_MONOTONIC_PUBLICATION');
    }
    if (successors.has(version.predecessorKey)) lineageViolation('SUPERSESSION_BRANCH');
    successors.set(version.predecessorKey, version.key);
  }

  const deprecations = new Map<string, ResearchDatasetDeprecationMetadata>();
  for (const candidate of input.deprecations) {
    const record = plainRecord(candidate, 'DEPRECATION_INPUT');
    exactKeys(
      record,
      ['target', 'declaredAt', 'effectiveAt', 'reason'],
      ['replacement'],
      'DEPRECATION_INPUT_FIELDS',
    );
    const target = validateRef(candidate.target, 'DEPRECATION_TARGET');
    const targetKey = refKey(target);
    const targetVersion = versions.get(targetKey);
    if (targetVersion === undefined) lineageViolation('UNKNOWN_DEPRECATION_TARGET');
    if (deprecations.has(targetKey)) lineageViolation('DUPLICATE_DEPRECATION');
    const declared = canonicalTimestamp(candidate.declaredAt, 'DECLARED_AT');
    const effective = canonicalTimestamp(candidate.effectiveAt, 'EFFECTIVE_AT');
    if (declared.milliseconds < targetVersion.publishedAtMs) {
      lineageViolation('DECLARED_BEFORE_PUBLICATION');
    }
    if (effective.milliseconds < declared.milliseconds) {
      lineageViolation('EFFECTIVE_BEFORE_DECLARED');
    }
    const reason = boundedReason(candidate.reason);
    const replacement = candidate.replacement === undefined
      ? undefined
      : validateRef(candidate.replacement, 'REPLACEMENT_REF');
    if (replacement !== undefined) {
      const replacementKey = refKey(replacement);
      if (replacementKey === targetKey) lineageViolation('SELF_REPLACEMENT');
      const replacementVersion = versions.get(replacementKey);
      if (replacementVersion === undefined) lineageViolation('UNKNOWN_REPLACEMENT');
      if (replacementVersion.metadata.datasetId !== targetVersion.metadata.datasetId) {
        lineageViolation('CROSS_DATASET_REPLACEMENT');
      }
      if (replacementVersion.publishedAtMs <= targetVersion.publishedAtMs) {
        lineageViolation('REPLACEMENT_NOT_LATER');
      }
      if (replacementVersion.publishedAtMs > effective.milliseconds) {
        lineageViolation('REPLACEMENT_NOT_PUBLISHED_BY_EFFECTIVE_TIME');
      }
      if (!isDescendant(replacementVersion, targetKey, versions)) {
        lineageViolation('REPLACEMENT_NOT_DESCENDANT');
      }
    }
    deprecations.set(targetKey, deepFreeze({
      target,
      declaredAt: declared.value,
      effectiveAt: effective.value,
      reason,
      ...(replacement === undefined ? {} : { replacement }),
    }));
  }

  const governancePort: ResearchDatasetGovernancePort = Object.freeze({
    getLifecycle(callerRequest: ResearchDatasetLifecycleRequest): ResearchDatasetLifecycleView {
      assertInertData(callerRequest, 'LIFECYCLE_REQUEST');
      const request = plainRecord(callerRequest, 'LIFECYCLE_REQUEST');
      exactKeys(request, ['ref', 'governanceTime'], [], 'LIFECYCLE_REQUEST_FIELDS');
      const ref = validateRef(callerRequest.ref, 'LIFECYCLE_REF');
      const governance = canonicalTimestamp(callerRequest.governanceTime, 'GOVERNANCE_TIME');
      const version = versions.get(refKey(ref));
      if (version === undefined) lineageViolation('UNKNOWN_VERSION');
      const lifecycle = lifecycleAt(version, deprecations.get(version.key), governance.milliseconds);
      if (lifecycle === 'NOT_YET_PUBLISHED') {
        return deepFreeze({
          usageMode: 'RESEARCH_GOVERNANCE',
          ref: snapshotRef(ref),
          governanceTime: governance.value,
          lifecycle,
          productionAuthority: false,
        });
      }
      return governanceVersion(
        version,
        deprecations.get(version.key),
        governance.value,
        governance.milliseconds,
      );
    },

    listPublishedVersions(
      callerRequest: ResearchDatasetPublishedVersionsRequest,
    ): ResearchDatasetPublishedVersionsView {
      assertInertData(callerRequest, 'PUBLISHED_VERSIONS_REQUEST');
      const request = plainRecord(callerRequest, 'PUBLISHED_VERSIONS_REQUEST');
      exactKeys(request, ['datasetId', 'governanceTime'], [], 'PUBLISHED_VERSIONS_REQUEST_FIELDS');
      const datasetId = identifier(callerRequest.datasetId, 'LIST_DATASET_ID');
      const governance = canonicalTimestamp(callerRequest.governanceTime, 'GOVERNANCE_TIME');
      const visible = [...versions.values()]
        .filter((version) => (
          version.metadata.datasetId === datasetId && version.publishedAtMs <= governance.milliseconds
        ))
        .sort((left, right) => (
          left.publishedAtMs - right.publishedAtMs
          || left.metadata.storageBundleId.localeCompare(right.metadata.storageBundleId)
        ));
      return deepFreeze({
        usageMode: 'RESEARCH_GOVERNANCE',
        datasetId,
        governanceTime: governance.value,
        versions: visible.map((version, versionIndex) => governanceVersion(
          version,
          deprecations.get(version.key),
          governance.value,
          governance.milliseconds,
          versionIndex,
        )),
        productionAuthority: false,
      });
    },
  });

  const auditPort: ResearchDatasetAuditPort = Object.freeze({
    getVersion(callerRef: ResearchDatasetVersionRef): ResearchDatasetVersionAudit {
      assertInertData(callerRef, 'AUDIT_VERSION_REF');
      const ref = validateRef(callerRef, 'AUDIT_VERSION_REF');
      const version = versions.get(refKey(ref));
      if (version === undefined) lineageViolation('UNKNOWN_VERSION');
      const deprecation = deprecations.get(version.key);
      return deepFreeze({
        usageMode: 'RESEARCH_GOVERNANCE_AUDIT',
        version: version.metadata,
        ...(deprecation === undefined ? {} : { deprecation }),
        researchGovernanceOnly: true,
        storageIntegrityAuthority: false,
        productionAuthority: false,
      });
    },

    traceSupersession(callerRef: ResearchDatasetVersionRef): ResearchDatasetSupersessionTrace {
      assertInertData(callerRef, 'AUDIT_TRACE_REF');
      const ref = validateRef(callerRef, 'AUDIT_TRACE_REF');
      let version: InternalVersion | undefined = versions.get(refKey(ref));
      if (version === undefined) lineageViolation('UNKNOWN_VERSION');
      const trace: ResearchDatasetVersionMetadata[] = [];
      while (version !== undefined) {
        trace.push(version.metadata);
        version = version.predecessorKey === undefined ? undefined : versions.get(version.predecessorKey);
      }
      trace.reverse();
      return deepFreeze({
        usageMode: 'RESEARCH_GOVERNANCE_AUDIT',
        versions: trace,
        researchGovernanceOnly: true,
        storageIntegrityAuthority: false,
        productionAuthority: false,
      });
    },

    researchGovernanceOnly: true,
    productionAuthority: false,
  });

  return Object.freeze({
    governancePort,
    auditPort,
    storageIntegrityAuthority: false,
    productionAuthority: false,
  });
}

export const PHASE_9F_RESEARCH_DATA_LINEAGE_BOUNDARY = Object.freeze({
  phase: '9F',
  exactBundleVersionIdentity: true,
  automaticLatestResolution: false,
  mutableRegistry: false,
  storageIO: false,
  networkIO: false,
  processIO: false,
  decisionTimeAuthority: false,
  pitEligibilityAuthority: false,
  researchDataAuthority: false,
  storageIntegrityAuthority: false,
  productionAuthority: false,
  phase9GProviderIngestion: false,
  backtestKernel: false,
} as const);
