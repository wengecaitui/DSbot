import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import type { RawResearchRecord } from '../../src/research/data/ResearchProviderAdapterContract';
import type {
  CanonicalFieldDefinition,
  CanonicalFieldDictionary,
  ResearchUsePolicy,
} from '../../src/research/data/dictionary/CanonicalFieldDictionaryContract';
import type {
  ProviderSourceBindingSet,
  ProviderSourceFieldBinding,
} from '../../src/research/data/dictionary/ProviderSourceBindingContract';
import {
  createResearchDatasetVersionCatalog,
  PHASE_9F_RESEARCH_DATA_LINEAGE_BOUNDARY,
  type CreateResearchDatasetVersionCatalogInput,
  type ResearchDatasetDeprecationInput,
  type ResearchDatasetVersionInput,
  type ResearchDatasetVersionRef,
} from '../../src/research/data/lineage/ResearchDatasetVersionCatalog';
import { createCanonicalPointInTimeDataset } from '../../src/research/data/pit/CanonicalPointInTimeDataset';
import {
  assertResearchStorageInterchange,
  createResearchStorageInterchange,
  type ResearchStorageInterchange,
} from '../../src/research/data/storage/ResearchStorageContract';

const V1_TIME = '2026-01-01T00:00:00.000Z';
const V2_TIME = '2026-01-02T00:00:00.000Z';
const V3_TIME = '2026-01-03T00:00:00.000Z';
const DECLARED_TIME = '2026-01-04T00:00:00.000Z';
const EFFECTIVE_TIME = '2026-01-05T00:00:00.000Z';

interface InterchangeOptions {
  readonly providerId?: string;
  readonly adapterId?: string;
  readonly sourceDatasetRef?: string;
  readonly dictionaryVersion?: string;
  readonly bindingVersion?: string;
  readonly adapterVersion?: string;
  readonly manifestVersion?: string;
}

function policy(patch: Partial<ResearchUsePolicy> = {}): ResearchUsePolicy {
  return {
    FACTOR_INPUT: 'DENY', LABEL: 'DENY', RESEARCH_VALUATION: 'DENY',
    UNIVERSE_FILTER: 'DENY', RESEARCH_EXECUTION_MODEL_INPUT: 'DENY',
    JOIN_KEY: 'DENY', DISPLAY: 'DENY', QUALITY_CONTROL: 'DENY', ...patch,
  };
}

function definitions(): readonly CanonicalFieldDefinition[] {
  const common = {
    semanticRole: 'MEASURE' as const,
    nullSemantics: { nullable: false as const },
    observationSemantics: { kind: 'INSTANT' as const },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT' as const,
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT' as const,
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY' as const,
  };
  return [
    {
      fieldId: 'currency', logicalType: 'STRING', unit: 'UNITLESS',
      meaning: 'Currency context.', priceSemantics: { kind: 'NOT_PRICE' },
      calendarSemantics: { kind: 'NOT_APPLICABLE' },
      researchUsePolicy: policy({ JOIN_KEY: 'ALLOW', DISPLAY: 'ALLOW' }), ...common,
    },
    {
      fieldId: 'price', logicalType: 'FLOAT64',
      unit: { kind: 'CURRENCY', currencyFieldId: 'currency' }, meaning: 'Observed price.',
      priceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
      calendarSemantics: { kind: 'NOT_APPLICABLE' },
      researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW', DISPLAY: 'ALLOW' }), ...common,
    },
  ];
}

function makeInterchange(options: InterchangeOptions = {}): ResearchStorageInterchange {
  const providerId = options.providerId ?? 'provider-lineage';
  const adapterId = options.adapterId ?? 'adapter-lineage';
  const sourceDatasetRef = options.sourceDatasetRef ?? 'source:lineage';
  const dictionaryVersion = options.dictionaryVersion ?? '1.0.0';
  const bindingVersion = options.bindingVersion ?? '1.0.0';
  const adapterVersion = options.adapterVersion ?? '1.0.0';
  const manifestVersion = options.manifestVersion ?? '1.0.0';
  const fields = definitions();
  const dictionary: CanonicalFieldDictionary = {
    schemaVersion: '1.0.0', dictionaryId: 'dictionary-lineage', dictionaryVersion,
    dataDomain: 'market-bars', fields, productionAuthority: false,
  };
  const bindings: ProviderSourceFieldBinding[] = fields.map((field) => ({
    canonicalFieldId: field.fieldId,
    sourcePath: [field.fieldId],
    mappingKind: 'DIRECT',
    sourceLogicalType: field.logicalType,
    sourceUnit: field.unit,
    sourcePriceSemantics: field.priceSemantics,
    sourceObservationSemantics: field.observationSemantics,
    sourcePresence: 'REQUIRED',
    sourceNullable: false,
    eventTimeBinding: 'RECORD_ENVELOPE',
    availableAtBinding: 'RECORD_ENVELOPE',
  }));
  const bindingSet: ProviderSourceBindingSet = {
    schemaVersion: '1.0.0', bindingId: 'binding-lineage', bindingVersion,
    providerId, adapterId, sourceDatasetRef,
    dictionaryId: dictionary.dictionaryId, dictionaryVersion,
    bindings, productionAuthority: false,
  };
  const manifest: ProviderManifest = {
    schemaVersion: '1.0.0', manifestVersion, providerId, adapterId, adapterVersion,
    dataDomains: ['market-bars'], marketScopes: ['global'],
    transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: { mode: 'NONE', credentialReferences: [] },
    pagination: { mode: 'none', boundedPage: true, maximumRecordsPerPage: 100, cursorSupported: false },
    ordering: { guarantee: 'provider-declared', keys: ['event-time'] },
    duplicates: { semantics: 'provider-may-repeat', stableSourceRecordId: true },
    rateLimit: { semantics: 'provider-documented', retryAfterSupported: false },
    revisions: { semantics: 'provider-declared', sourceRevisionAvailable: false },
    licensing: { redistributionAllowed: false, license: 'provider-terms', attribution: null },
    timeSemantics: {
      eventTimeSource: 'record event timestamp', availableAtSource: 'publication timestamp',
      availableAtRule: null, availableAtAuthority: 'PROVIDER_FIELD',
    },
    productionAuthority: false,
  };
  const raw: RawResearchRecord = {
    providerId, adapterId, adapterVersion, sourceDatasetRef,
    sourceRecordId: 'record-lineage', eventTime: '2025-12-31T00:00:00.000Z',
    availableAt: '2026-01-01T00:00:00.000Z', availableAtAuthority: 'PROVIDER_FIELD',
    ingestedAt: '2026-01-01T01:00:00.000Z', payload: { currency: 'USD', price: 10 },
    payloadHash: '9'.repeat(64), manifestVersion, manifestReference: 'manifest:lineage',
    requestId: 'request-lineage', sourceProvenanceRef: 'provenance:lineage',
  };
  const dataset = createCanonicalPointInTimeDataset({ records: [raw], dictionary, bindingSet, manifest });
  return createResearchStorageInterchange([raw], dataset);
}

function withVersionCollections(interchange: ResearchStorageInterchange): ResearchStorageInterchange {
  const value: any = structuredClone(interchange);
  const raw = structuredClone(value.rawRecords[0]);
  const record = structuredClone(value.canonicalDataset.records[0]);
  raw.sourceRecordId = 'record-lineage-2';
  record.sourceRecordId = 'record-lineage-2';
  raw.adapterVersion = '0.9.0';
  record.adapterVersion = '0.9.0';
  raw.manifestVersion = '2.0.0';
  record.manifestVersion = '2.0.0';
  raw.requestId = 'request-lineage-2';
  record.requestId = 'request-lineage-2';
  raw.sourceProvenanceRef = 'provenance:lineage-2';
  record.sourceProvenanceRef = 'provenance:lineage-2';
  value.rawRecords.push(raw);
  value.canonicalDataset.records.push(record);
  assertResearchStorageInterchange(value);
  return value;
}

function bundle(seed: number | string): string {
  if (typeof seed === 'string' && seed.length === 1) return seed.repeat(64);
  return Number(seed).toString(16).padStart(64, '0');
}

function ref(storageBundleId: string, datasetId = 'dataset.lineage'): ResearchDatasetVersionRef {
  return { datasetId, storageBundleId };
}

function version(
  storageBundleId: string,
  publishedAt: string,
  patch: Partial<ResearchDatasetVersionInput> = {},
): ResearchDatasetVersionInput {
  return {
    datasetId: 'dataset.lineage', storageBundleId, publishedAt,
    interchange: makeInterchange(), ...patch,
  };
}

function deprecation(
  target: ResearchDatasetVersionRef,
  patch: Partial<ResearchDatasetDeprecationInput> = {},
): ResearchDatasetDeprecationInput {
  return {
    target, declaredAt: DECLARED_TIME, effectiveAt: EFFECTIVE_TIME,
    reason: 'Superseded by a later exact version.', ...patch,
  };
}

function catalog(
  versions: readonly ResearchDatasetVersionInput[],
  deprecations: readonly ResearchDatasetDeprecationInput[] = [],
) {
  return createResearchDatasetVersionCatalog({ versions, deprecations });
}

function chain() {
  const v1 = version(bundle('a'), V1_TIME);
  const v2 = version(bundle('b'), V2_TIME, { supersedes: ref(v1.storageBundleId) });
  const v3 = version(bundle('c'), V3_TIME, { supersedes: ref(v2.storageBundleId) });
  return { v1, v2, v3 };
}

describe('Phase 9F exact version metadata', () => {
  it('derives bounded canonical lineage and deterministic record version collections', () => {
    const v1 = version(bundle('a'), V1_TIME, {
      interchange: withVersionCollections(makeInterchange({ adapterVersion: '2.0.0', manifestVersion: '1.0.0' })),
    });
    const created = catalog([v1]);
    const audit = created.auditPort.getVersion(ref(v1.storageBundleId));
    assert.deepEqual(audit.version.canonicalLineage, {
      dictionaryId: 'dictionary-lineage', dictionaryVersion: '1.0.0',
      bindingId: 'binding-lineage', bindingVersion: '1.0.0',
      providerId: 'provider-lineage', adapterId: 'adapter-lineage', sourceDatasetRef: 'source:lineage',
      adapterVersions: ['0.9.0', '2.0.0'], manifestVersions: ['1.0.0', '2.0.0'],
    });
    assert.equal(Object.isFrozen(audit.version.canonicalLineage.adapterVersions), true);
    assert.equal(Object.isFrozen(audit.version.canonicalLineage.manifestVersions), true);
    assert.equal(audit.storageIntegrityAuthority, false);
    assert.equal(audit.productionAuthority, false);
    assert.equal('interchange' in audit.version, false);

    const emptyInterchange: any = structuredClone(makeInterchange());
    emptyInterchange.rawRecords = [];
    emptyInterchange.canonicalDataset.records = [];
    assertResearchStorageInterchange(emptyInterchange);
    const emptyAudit = catalog([version(bundle('b'), V1_TIME, {
      interchange: emptyInterchange,
    })]).auditPort.getVersion(ref(bundle('b')));
    assert.deepEqual(emptyAudit.version.canonicalLineage.adapterVersions, []);
    assert.deepEqual(emptyAudit.version.canonicalLineage.manifestVersions, []);
  });

  it('accepts only lowercase 64-character exact bundle references', () => {
    for (const invalid of ['a'.repeat(63), 'A'.repeat(64), 'bundle-name', 'C:/bundle', 'https://bundle']) {
      assert.throws(() => catalog([version(invalid, V1_TIME)]), /STORAGE_BUNDLE_ID/);
    }
    assert.doesNotThrow(() => catalog([version(bundle('a'), V1_TIME)]));
  });

  it('rejects duplicate refs and one bundle assigned to two dataset identities', () => {
    const v1 = version(bundle('a'), V1_TIME);
    assert.throws(() => catalog([v1, structuredClone(v1)]), /DUPLICATE_VERSION_REF/);
    assert.throws(() => catalog([
      v1,
      version(v1.storageBundleId, V2_TIME, { datasetId: 'dataset.other' }),
    ]), /BUNDLE_ALIAS/);
  });

  it('allows contract and record version evolution within a stable source series', () => {
    const v1 = version(bundle('a'), V1_TIME);
    const v2 = version(bundle('b'), V2_TIME, {
      supersedes: ref(v1.storageBundleId),
      interchange: makeInterchange({
        dictionaryVersion: '2.0.0', bindingVersion: '2.0.0',
        adapterVersion: '2.0.0', manifestVersion: '2.0.0',
      }),
    });
    const created = catalog([v2, v1]);
    const audit = created.auditPort.getVersion(ref(v2.storageBundleId));
    assert.equal(audit.version.canonicalLineage.dictionaryVersion, '2.0.0');
    assert.equal(audit.version.canonicalLineage.bindingVersion, '2.0.0');
    assert.deepEqual(audit.version.canonicalLineage.adapterVersions, ['2.0.0']);
    assert.deepEqual(audit.version.canonicalLineage.manifestVersions, ['2.0.0']);
  });

  it('accepts lineage only from a valid interchange and rejects caller lineage copies', () => {
    const invalidInterchange: any = structuredClone(makeInterchange());
    invalidInterchange.canonicalDataset.providerId = 'inconsistent-provider';
    assert.throws(() => catalog([version(bundle('a'), V1_TIME, {
      interchange: invalidInterchange,
    })]), /PHASE_9D_RESEARCH_STORAGE_INVALID/);

    assert.throws(() => catalog([{
      ...version(bundle('b'), V1_TIME),
      canonicalLineage: { providerId: 'caller-copy' },
    } as never]), /VERSION_INPUT_FIELDS/);
  });

  it('rejects provider, adapter, and source-series identity drift independently', () => {
    const v1 = version(bundle('a'), V1_TIME);
    assert.throws(() => catalog([v1, version(bundle('b'), V2_TIME, {
      interchange: makeInterchange({ providerId: 'provider-other' }),
    })]), /PROVIDER_IDENTITY_DRIFT/);
    assert.throws(() => catalog([v1, version(bundle('c'), V2_TIME, {
      interchange: makeInterchange({ adapterId: 'adapter-other' }),
    })]), /ADAPTER_IDENTITY_DRIFT/);
    assert.throws(() => catalog([v1, version(bundle('d'), V2_TIME, {
      interchange: makeInterchange({ sourceDatasetRef: 'source:other' }),
    })]), /SOURCE_DATASET_REF_DRIFT/);
  });
});

describe('Phase 9F supersession invariants', () => {
  it('traces an explicit linear chain from oldest to requested exact version', () => {
    const { v1, v2, v3 } = chain();
    const trace = catalog([v3, v1, v2]).auditPort.traceSupersession(ref(v3.storageBundleId));
    assert.deepEqual(trace.versions.map((item) => item.storageBundleId), [
      v1.storageBundleId, v2.storageBundleId, v3.storageBundleId,
    ]);
    assert.equal(trace.usageMode, 'RESEARCH_GOVERNANCE_AUDIT');
    assert.equal(trace.researchGovernanceOnly, true);
    assert.equal(trace.productionAuthority, false);
  });

  it('rejects self, missing, cross-dataset, and non-monotonic predecessors', () => {
    const selfBundleId = bundle('a');
    const self = version(selfBundleId, V1_TIME, { supersedes: ref(selfBundleId) });
    assert.throws(() => catalog([self]), /SELF_SUPERSESSION/);

    assert.throws(() => catalog([version(bundle('b'), V2_TIME, {
      supersedes: ref(bundle('f')),
    })]), /MISSING_PREDECESSOR/);

    const other = version(bundle('c'), V1_TIME, { datasetId: 'dataset.other' });
    assert.throws(() => catalog([
      other,
      version(bundle('d'), V2_TIME, { supersedes: ref(other.storageBundleId, 'dataset.other') }),
    ]), /CROSS_DATASET_SUPERSESSION/);

    const later = version(bundle('e'), V2_TIME);
    const earlier = version(bundle('f'), V1_TIME, { supersedes: ref(later.storageBundleId) });
    assert.throws(() => catalog([later, earlier]), /NON_MONOTONIC_PUBLICATION/);
  });

  it('rejects cycles and multiple successors for one predecessor', () => {
    const v1 = version(bundle('a'), V1_TIME, { supersedes: ref(bundle('b')) });
    const v2 = version(bundle('b'), V2_TIME, { supersedes: ref(bundle('a')) });
    assert.throws(() => catalog([v1, v2]), /SUPERSESSION_CYCLE/);

    const root = version(bundle('c'), V1_TIME);
    const left = version(bundle('d'), V2_TIME, { supersedes: ref(root.storageBundleId) });
    const right = version(bundle('e'), V3_TIME, { supersedes: ref(root.storageBundleId) });
    assert.throws(() => catalog([root, left, right]), /SUPERSESSION_BRANCH/);
  });
});

describe('Phase 9F deprecation and lifecycle invariants', () => {
  it('evaluates exact publication, declaration, and effective-time boundaries', () => {
    const { v1, v2 } = chain();
    const created = catalog([v1, v2], [deprecation(ref(v1.storageBundleId), {
      replacement: ref(v2.storageBundleId),
    })]);
    const lifecycle = (time: string) => created.governancePort.getLifecycle({
      ref: ref(v1.storageBundleId), governanceTime: time,
    });
    assert.equal(lifecycle('2025-12-31T23:59:59.999Z').lifecycle, 'NOT_YET_PUBLISHED');
    assert.equal(lifecycle(V1_TIME).lifecycle, 'ACTIVE');
    assert.equal(lifecycle('2026-01-03T23:59:59.999Z').lifecycle, 'ACTIVE');
    assert.equal(lifecycle(DECLARED_TIME).lifecycle, 'DEPRECATION_SCHEDULED');
    assert.equal(lifecycle('2026-01-04T23:59:59.999Z').lifecycle, 'DEPRECATION_SCHEDULED');
    assert.equal(lifecycle(EFFECTIVE_TIME).lifecycle, 'DEPRECATED');

    const immediate = catalog([v1], [deprecation(ref(v1.storageBundleId), {
      declaredAt: DECLARED_TIME, effectiveAt: DECLARED_TIME,
    })]);
    assert.equal(immediate.governancePort.getLifecycle({
      ref: ref(v1.storageBundleId), governanceTime: DECLARED_TIME,
    }).lifecycle, 'DEPRECATED');
  });

  it('rejects unknown, duplicate, retroactive, and reversed declarations', () => {
    const v1 = version(bundle('a'), V1_TIME);
    assert.throws(() => catalog([v1], [deprecation(ref(bundle('f')))]), /UNKNOWN_DEPRECATION_TARGET/);
    const declaration = deprecation(ref(v1.storageBundleId));
    assert.throws(() => catalog([v1], [declaration, structuredClone(declaration)]), /DUPLICATE_DEPRECATION/);
    assert.throws(() => catalog([v1], [deprecation(ref(v1.storageBundleId), {
      declaredAt: '2025-12-31T23:59:59.999Z',
    })]), /DECLARED_BEFORE_PUBLICATION/);
    assert.throws(() => catalog([v1], [deprecation(ref(v1.storageBundleId), {
      declaredAt: EFFECTIVE_TIME, effectiveAt: DECLARED_TIME,
    })]), /EFFECTIVE_BEFORE_DECLARED/);
  });

  it('rejects inconsistent replacement relationships', () => {
    const v1 = version(bundle('a'), V1_TIME);
    const v2 = version(bundle('b'), V3_TIME, { supersedes: ref(v1.storageBundleId) });
    assert.throws(() => catalog([v1], [deprecation(ref(v1.storageBundleId), {
      replacement: ref(v1.storageBundleId),
    })]), /SELF_REPLACEMENT/);

    const other = version(bundle('c'), V2_TIME, { datasetId: 'dataset.other' });
    assert.throws(() => catalog([v1, other], [deprecation(ref(v1.storageBundleId), {
      replacement: ref(other.storageBundleId, 'dataset.other'),
    })]), /CROSS_DATASET_REPLACEMENT/);

    assert.throws(() => catalog([v1, v2], [deprecation(ref(v1.storageBundleId), {
      declaredAt: V2_TIME, effectiveAt: V2_TIME, replacement: ref(v2.storageBundleId),
    })]), /REPLACEMENT_NOT_PUBLISHED_BY_EFFECTIVE_TIME/);

    const unconnected = version(bundle('d'), V2_TIME);
    assert.throws(() => catalog([v1, unconnected], [deprecation(ref(v1.storageBundleId), {
      replacement: ref(unconnected.storageBundleId), declaredAt: V2_TIME, effectiveAt: V3_TIME,
    })]), /REPLACEMENT_NOT_DESCENDANT/);
  });

  it('requires strict canonical UTC timestamps and bounded reasons', () => {
    const v1 = version(bundle('a'), V1_TIME);
    for (const invalid of ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00', 'not-a-time']) {
      assert.throws(() => catalog([version(bundle('b'), invalid)]), /PUBLISHED_AT/);
      assert.throws(() => catalog([v1], [deprecation(ref(v1.storageBundleId), {
        declaredAt: invalid,
      })]), /DECLARED_AT/);
    }
    assert.throws(() => catalog([v1], [deprecation(ref(v1.storageBundleId), { reason: ' spaced ' })]), /DEPRECATION_REASON/);
  });
});

describe('Phase 9F temporal visibility', () => {
  it('lists only published versions in deterministic order with dense visible indices', () => {
    const { v1, v2, v3 } = chain();
    const created = catalog([v3, v1, v2]);
    const view = created.governancePort.listPublishedVersions({
      datasetId: 'dataset.lineage', governanceTime: V2_TIME,
    });
    assert.deepEqual(view.versions.map((item) => item.storageBundleId), [v1.storageBundleId, v2.storageBundleId]);
    assert.deepEqual(view.versions.map((item) => item.versionIndex), [0, 1]);
    assert.equal(JSON.stringify(view).includes(v3.storageBundleId), false);
    assert.deepEqual(created.governancePort.listPublishedVersions({
      datasetId: 'dataset.unknown', governanceTime: V2_TIME,
    }).versions, []);
  });

  it('does not reveal future versions or their count', () => {
    const v1 = version(bundle('a'), V1_TIME);
    const base = catalog([v1]);
    const future: ResearchDatasetVersionInput[] = [];
    let predecessor = v1;
    const start = Date.parse('2026-02-01T00:00:00.000Z');
    for (let index = 1; index <= 100; index += 1) {
      const next = version(bundle(index), new Date(start + index).toISOString(), {
        supersedes: ref(predecessor.storageBundleId),
      });
      future.push(next);
      predecessor = next;
    }
    const expanded = catalog([v1, ...future]);
    const request = { datasetId: 'dataset.lineage', governanceTime: '2026-01-01T12:00:00.000Z' };
    assert.deepEqual(
      expanded.governancePort.listPublishedVersions(request),
      base.governancePort.listPublishedVersions(request),
    );
  });

  it('does not reveal a future deprecation declaration or replacement', () => {
    const v1 = version(bundle('a'), V1_TIME);
    const v2 = version(bundle('b'), V2_TIME, { supersedes: ref(v1.storageBundleId) });
    const withoutDeclaration = catalog([v1]);
    const withFutureMetadata = catalog([v1, v2], [deprecation(ref(v1.storageBundleId), {
      declaredAt: V3_TIME, effectiveAt: EFFECTIVE_TIME, replacement: ref(v2.storageBundleId),
    })]);
    const request = {
      ref: ref(v1.storageBundleId), governanceTime: '2026-01-01T12:00:00.000Z',
    };
    assert.deepEqual(
      withFutureMetadata.governancePort.getLifecycle(request),
      withoutDeclaration.governancePort.getLifecycle(request),
    );
    const encoded = JSON.stringify(withFutureMetadata.governancePort.getLifecycle(request));
    assert.equal(encoded.includes('Superseded'), false);
    assert.equal(encoded.includes(v2.storageBundleId), false);
    assert.equal(encoded.includes(V3_TIME), false);
    assert.equal(encoded.includes(EFFECTIVE_TIME), false);
  });
});

describe('Phase 9F inert construction and capability boundaries', () => {
  it('rejects accessors at every catalog nesting boundary without executing them', () => {
    let executions = 0;
    const getter = () => { executions += 1; return []; };
    const v1 = version(bundle('a'), V1_TIME);
    const v2 = version(bundle('b'), V2_TIME, { supersedes: ref(v1.storageBundleId) });
    const dep = deprecation(ref(v1.storageBundleId), { replacement: ref(v2.storageBundleId) });
    const fixtures: any[] = [];

    fixtures.push(Object.defineProperty({ deprecations: [] }, 'versions', { enumerable: true, get: getter }));

    const versionsArray: any[] = [v1];
    Object.defineProperty(versionsArray, '0', { enumerable: true, get: getter });
    fixtures.push({ versions: versionsArray, deprecations: [] });

    fixtures.push({
      versions: [Object.defineProperty({ ...v1 }, 'datasetId', { enumerable: true, get: getter })],
      deprecations: [],
    });

    fixtures.push({
      versions: [v1, { ...v2, supersedes: Object.defineProperty({ datasetId: 'dataset.lineage' }, 'storageBundleId', {
        enumerable: true, get: getter,
      }) }],
      deprecations: [],
    });

    const deprecationsArray: any[] = [dep];
    Object.defineProperty(deprecationsArray, '0', { enumerable: true, get: getter });
    fixtures.push({ versions: [v1, v2], deprecations: deprecationsArray });

    fixtures.push({
      versions: [v1, v2],
      deprecations: [{ ...dep, replacement: Object.defineProperty({ datasetId: 'dataset.lineage' }, 'storageBundleId', {
        enumerable: true, get: getter,
      }) }],
    });

    const interchange: any = structuredClone(v1.interchange);
    Object.defineProperty(interchange, 'canonicalDataset', { enumerable: true, get: getter });
    fixtures.push({ versions: [{ ...v1, interchange }], deprecations: [] });

    for (const fixture of fixtures) {
      assert.throws(() => createResearchDatasetVersionCatalog(fixture));
    }
    assert.equal(executions, 0);
  });

  it('rejects executable, symbolic, cyclic, sparse, extended, and non-plain input', () => {
    const v1 = version(bundle('a'), V1_TIME);
    const cycle: any = { versions: [], deprecations: [] };
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = v1;
    const extended: any[] = [v1];
    (extended as any).extra = true;
    for (const invalid of [
      { versions: [() => 1], deprecations: [] },
      { versions: [Symbol('version')], deprecations: [] },
      cycle,
      { versions: sparse, deprecations: [] },
      { versions: extended, deprecations: [] },
      { versions: [new Date()], deprecations: [] },
    ]) {
      assert.throws(() => createResearchDatasetVersionCatalog(invalid as never));
    }
  });

  it('isolates caller mutation and deeply freezes all outputs', () => {
    const { v1, v2 } = chain();
    const input: any = structuredClone({
      versions: [v1, v2],
      deprecations: [deprecation(ref(v1.storageBundleId), { replacement: ref(v2.storageBundleId) })],
    } satisfies CreateResearchDatasetVersionCatalogInput);
    const created = createResearchDatasetVersionCatalog(input);
    const before = created.auditPort.getVersion(ref(v1.storageBundleId));
    input.versions[0].publishedAt = '2030-01-01T00:00:00.000Z';
    input.versions[1].supersedes.storageBundleId = bundle('f');
    input.versions[0].interchange.canonicalDataset.providerId = 'changed';
    input.deprecations[0].reason = 'Changed.';
    input.deprecations[0].replacement.storageBundleId = bundle('e');
    assert.deepEqual(created.auditPort.getVersion(ref(v1.storageBundleId)), before);
    assert.equal(Object.isFrozen(created), true);
    assert.equal(Object.isFrozen(created.governancePort), true);
    assert.equal(Object.isFrozen(created.auditPort), true);
    assert.equal(Object.isFrozen(before), true);
    assert.equal(Object.isFrozen(before.version), true);
    assert.equal(Object.isFrozen(before.version.canonicalLineage), true);
    assert.equal(Reflect.set(before.version, 'publishedAt', V3_TIME), false);
    assert.equal(created.auditPort.getVersion(ref(v1.storageBundleId)).version.publishedAt, V1_TIME);
  });

  it('enforces exact request shapes and deterministic empty-catalog behavior', () => {
    const empty = catalog([]);
    assert.deepEqual(empty.governancePort.listPublishedVersions({
      datasetId: 'dataset.lineage', governanceTime: V1_TIME,
    }).versions, []);
    assert.throws(() => empty.auditPort.getVersion(ref(bundle('a'))), /UNKNOWN_VERSION/);
    assert.throws(() => empty.governancePort.getLifecycle({
      ref: ref(bundle('a')), governanceTime: V1_TIME,
    }), /UNKNOWN_VERSION/);

    const created = catalog([version(bundle('a'), V1_TIME)]);
    assert.throws(() => created.auditPort.getVersion({ ...ref(bundle('a')), extra: true } as never), /FIELDS/);
    assert.throws(() => created.governancePort.getLifecycle({
      ref: ref(bundle('a')), governanceTime: V1_TIME, extra: true,
    } as never), /LIFECYCLE_REQUEST_FIELDS/);
  });

  it('exposes only separated metadata capabilities and declares the frozen Phase 9F boundary', () => {
    const created = catalog([version(bundle('a'), V1_TIME)]);
    assert.deepEqual(Object.keys(created).sort(), [
      'auditPort', 'governancePort', 'productionAuthority', 'storageIntegrityAuthority',
    ]);
    assert.deepEqual(Object.keys(created.governancePort).sort(), ['getLifecycle', 'listPublishedVersions']);
    assert.deepEqual(Object.keys(created.auditPort).sort(), [
      'getVersion', 'productionAuthority', 'researchGovernanceOnly', 'traceSupersession',
    ]);
    assert.deepEqual(PHASE_9F_RESEARCH_DATA_LINEAGE_BOUNDARY, {
      phase: '9F', exactBundleVersionIdentity: true, automaticLatestResolution: false,
      mutableRegistry: false, storageIO: false, networkIO: false, processIO: false,
      decisionTimeAuthority: false, pitEligibilityAuthority: false, researchDataAuthority: false,
      storageIntegrityAuthority: false, productionAuthority: false,
      phase9GProviderIngestion: false, backtestKernel: false,
    });
    assert.equal(Object.isFrozen(PHASE_9F_RESEARCH_DATA_LINEAGE_BOUNDARY), true);
  });

  it('contains no data, Hub, PIT, storage, network, process, or implicit-clock authority', () => {
    const source = readFileSync(
      new URL('../../src/research/data/lineage/ResearchDatasetVersionCatalog.ts', import.meta.url),
      'utf8',
    );
    for (const forbiddenImport of [
      "from 'node:fs'", "from 'node:net'", "from 'node:http'", "from 'node:https'",
      'ResearchDataHub', 'PointInTimeEligibility', 'child_process', 'Date.now(',
    ]) {
      assert.equal(source.includes(forbiddenImport), false, forbiddenImport);
    }
    const created = catalog([version(bundle('a'), V1_TIME)]);
    const serialized = JSON.stringify(created.auditPort.getVersion(ref(bundle('a'))));
    for (const forbiddenField of [
      'rawRecords', 'canonicalDataset', 'payloadHash', 'sourceRecordId',
      'eventTime', 'availableAt', 'ingestedAt', 'requestId', 'sourceProvenanceRef',
    ]) {
      assert.equal(serialized.includes(forbiddenField), false, forbiddenField);
    }
  });
});
