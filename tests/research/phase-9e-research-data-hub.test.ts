import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import type { RawResearchRecord } from '../../src/research/data/ResearchProviderAdapterContract';
import type {
  CanonicalFieldDefinition,
  CanonicalFieldDictionary,
  CanonicalLogicalType,
  ResearchUsePolicy,
} from '../../src/research/data/dictionary/CanonicalFieldDictionaryContract';
import type {
  ProviderSourceBindingSet,
  ProviderSourceFieldBinding,
} from '../../src/research/data/dictionary/ProviderSourceBindingContract';
import { createResearchDataHub, PHASE_9E_RESEARCH_DATA_HUB_BOUNDARY } from '../../src/research/data/hub/ResearchDataHub';
import { createCanonicalPointInTimeDataset } from '../../src/research/data/pit/CanonicalPointInTimeDataset';
import { evaluateDecisionInputEligibility } from '../../src/research/data/pit/PointInTimeEligibility';
import { createResearchStorageInterchange, type ResearchStorageInterchange } from '../../src/research/data/storage/ResearchStorageContract';

function policy(patch: Partial<ResearchUsePolicy> = {}): ResearchUsePolicy {
  return {
    FACTOR_INPUT: 'DENY', LABEL: 'DENY', RESEARCH_VALUATION: 'DENY',
    UNIVERSE_FILTER: 'DENY', RESEARCH_EXECUTION_MODEL_INPUT: 'DENY',
    JOIN_KEY: 'DENY', DISPLAY: 'DENY', QUALITY_CONTROL: 'DENY', ...patch,
  };
}

function field(
  fieldId: string,
  logicalType: CanonicalLogicalType,
  patch: Partial<CanonicalFieldDefinition> = {},
): CanonicalFieldDefinition {
  return {
    fieldId, logicalType, unit: 'UNITLESS', meaning: `Canonical meaning for ${fieldId}.`,
    semanticRole: 'MEASURE', nullSemantics: { nullable: true, meaning: 'A source may publish no value.' },
    priceSemantics: { kind: 'NOT_PRICE' }, observationSemantics: { kind: 'INSTANT' },
    calendarSemantics: { kind: 'NOT_APPLICABLE' },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT',
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW', DISPLAY: 'ALLOW', QUALITY_CONTROL: 'ALLOW' }),
    ...patch,
  };
}

function manifest(): ProviderManifest {
  return {
    schemaVersion: '1.0.0', manifestVersion: '1.0.0', providerId: 'provider-9e',
    adapterId: 'adapter-9e', adapterVersion: '1.0.0', dataDomains: ['market-bars'],
    marketScopes: ['global'], transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: { mode: 'NONE', credentialReferences: [] },
    pagination: { mode: 'none', boundedPage: true, maximumRecordsPerPage: 100, cursorSupported: false },
    ordering: { guarantee: 'provider-declared', keys: ['event-time'] },
    duplicates: { semantics: 'provider-may-repeat', stableSourceRecordId: true },
    rateLimit: { semantics: 'provider-documented', retryAfterSupported: false },
    revisions: { semantics: 'provider-declared', sourceRevisionAvailable: true },
    licensing: { redistributionAllowed: false, license: 'provider-terms', attribution: null },
    timeSemantics: {
      eventTimeSource: 'record event timestamp', availableAtSource: 'publication timestamp',
      availableAtRule: null, availableAtAuthority: 'PROVIDER_FIELD',
    }, productionAuthority: false,
  };
}

const definitions = [
  field('currency', 'STRING', { researchUsePolicy: policy({ JOIN_KEY: 'ALLOW', DISPLAY: 'ALLOW' }) }),
  field('price', 'FLOAT64', {
    unit: { kind: 'CURRENCY', currencyFieldId: 'currency' },
    priceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW', RESEARCH_VALUATION: 'ALLOW', DISPLAY: 'ALLOW' }),
  }),
  field('nullable', 'STRING'), field('zero', 'INT64'), field('bool', 'BOOLEAN'), field('empty', 'STRING'),
  field('date', 'DATE', { calendarSemantics: { kind: 'NAMED', timezoneId: 'UTC', calendarId: 'UTC_DAY' } }),
  field('timestamp', 'TIMESTAMP_UTC'), field('decimal', { kind: 'DECIMAL', precision: 8, scale: 2 }),
  field('missing', 'STRING'), field('secondary', 'FLOAT64'),
  field('denied', 'FLOAT64', { researchUsePolicy: policy() }),
  field('historicalDenied', 'FLOAT64', {
    historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT', researchUsePolicy: policy({ DISPLAY: 'ALLOW' }),
  }),
  field('label', 'STRING', {
    semanticRole: 'LABEL', historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT',
    researchUsePolicy: policy({ LABEL: 'ALLOW' }),
  }),
] as const;

function binding(definition: CanonicalFieldDefinition): ProviderSourceFieldBinding {
  return {
    canonicalFieldId: definition.fieldId, sourcePath: [definition.fieldId], mappingKind: 'DIRECT',
    sourceLogicalType: definition.logicalType, sourceUnit: definition.unit,
    sourcePriceSemantics: definition.priceSemantics, sourceObservationSemantics: definition.observationSemantics,
    sourcePresence: 'OPTIONAL', sourceNullable: true,
    eventTimeBinding: 'RECORD_ENVELOPE', availableAtBinding: 'RECORD_ENVELOPE',
  };
}

function baseInterchange(): ResearchStorageInterchange {
  const dictionary: CanonicalFieldDictionary = {
    schemaVersion: '1.0.0', dictionaryId: 'dictionary-9e', dictionaryVersion: '1.0.0',
    dataDomain: 'market-bars', fields: [...definitions], productionAuthority: false,
  };
  const bindingSet: ProviderSourceBindingSet = {
    schemaVersion: '1.0.0', bindingId: 'binding-9e', bindingVersion: '1.0.0',
    providerId: 'provider-9e', adapterId: 'adapter-9e', sourceDatasetRef: 'source:9e',
    dictionaryId: 'dictionary-9e', dictionaryVersion: '1.0.0',
    bindings: definitions.map(binding), productionAuthority: false,
  };
  const raw: RawResearchRecord = {
    providerId: 'provider-9e', adapterId: 'adapter-9e', adapterVersion: '1.0.0', sourceDatasetRef: 'source:9e',
    sourceRecordId: 'eligible-record', eventTime: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-02T00:00:00.000Z', availableAtAuthority: 'PROVIDER_FIELD',
    ingestedAt: '2026-09-01T00:00:00.000Z', payload: {
      currency: 'USD', price: 10, nullable: null, zero: 0, bool: false, empty: '',
      date: '2026-01-01', timestamp: '2026-01-01T00:00:00.000Z', decimal: '1234.50', missing: 'present',
      secondary: 20, denied: 30, historicalDenied: 40, label: 'FUTURE_LABEL_SENTINEL_9E',
    }, payloadHash: 'a'.repeat(64), manifestVersion: '1.0.0', manifestReference: 'manifest:9e',
    requestId: 'request-9e', sourceProvenanceRef: 'provenance:eligible',
    sourceRevision: { revisionId: 'revision-eligible', observedAt: '2026-09-01T00:00:00.000Z' },
  };
  const dataset = createCanonicalPointInTimeDataset({ records: [raw], dictionary, bindingSet, manifest: manifest() });
  return createResearchStorageInterchange([raw], dataset);
}

type MutableInterchange = {
  productionAuthority: boolean;
  rawRecords: Array<Record<string, any>>;
  canonicalDataset: Record<string, any> & { records: Array<Record<string, any> & { fields: Array<Record<string, any>> }> };
};

function mutableBase(): MutableInterchange {
  return structuredClone(baseInterchange()) as unknown as MutableInterchange;
}

function duplicateRows(count: number): MutableInterchange {
  const value = mutableBase();
  const raw = value.rawRecords[0];
  const canonical = value.canonicalDataset.records[0];
  value.rawRecords = [];
  value.canonicalDataset.records = [];
  for (let index = 0; index < count; index += 1) {
    const rawCopy = structuredClone(raw);
    const canonicalCopy = structuredClone(canonical);
    const id = index === 0 ? 'eligible-record' : `future-record-${index}`;
    rawCopy.sourceRecordId = id;
    canonicalCopy.sourceRecordId = id;
    rawCopy.sourceProvenanceRef = `provenance:${id}`;
    canonicalCopy.sourceProvenanceRef = `provenance:${id}`;
    rawCopy.sourceRevision = { revisionId: `revision-${id}`, observedAt: '2026-09-01T00:00:00.000Z' };
    canonicalCopy.sourceRevision = structuredClone(rawCopy.sourceRevision);
    if (index > 0) setAvailability(rawCopy, canonicalCopy, '2026-02-01T00:00:00.000Z');
    value.rawRecords.push(rawCopy);
    value.canonicalDataset.records.push(canonicalCopy);
  }
  return value;
}

function setAvailability(raw: Record<string, any>, record: Record<string, any>, timestamp: string): void {
  raw.availableAt = timestamp;
  record.availableAt = timestamp;
  for (const item of record.fields) item.availabilityEvidence = { state: 'KNOWN', value: timestamp, source: 'RECORD_ENVELOPE' };
}

function decision(hub: ReturnType<typeof createResearchDataHub>, fieldIds: string[] = ['price'], decisionTime = '2026-01-03T00:00:00.000Z') {
  return hub.decisionPort.createDecisionView({ researchUse: 'FACTOR_INPUT', decisionTime, fieldIds });
}

describe('Phase 9E request and hub trust boundaries', () => {
  it('rejects hostile requests without executing accessors and enforces exact request fields', () => {
    const hub = createResearchDataHub(baseInterchange());
    let executions = 0;
    const accessor = Object.defineProperty({}, 'researchUse', { enumerable: true, get() { executions += 1; return 'FACTOR_INPUT'; } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const request of [accessor, () => 1, Symbol('request'), cycle, new Date(),
      { researchUse: 'FACTOR_INPUT', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['price'], extra: true },
      { researchUse: 'FACTOR_INPUT', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: [] },
      { researchUse: 'FACTOR_INPUT', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['price', 'price'] },
      { researchUse: 'FACTOR_INPUT', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['unknown'] },
      { researchUse: 'LABEL', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['price'] },
      { researchUse: 'FACTOR_INPUT', decisionTime: '2026-01-03', fieldIds: ['price'] },
    ]) assert.throws(() => hub.decisionPort.createDecisionView(request as never));
    assert.equal(executions, 0);
  });

  it('takes immutable defensive snapshots of caller interchange and requests', () => {
    const caller = mutableBase();
    const hub = createResearchDataHub(caller as unknown as ResearchStorageInterchange);
    caller.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'price')!.presence.value = 999;
    const request = { researchUse: 'FACTOR_INPUT' as const, decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['price'] };
    const view = hub.decisionPort.createDecisionView(request);
    request.fieldIds[0] = 'zero';
    assert.equal(view.rows[0].fields[0].presence.state === 'VALUE' && view.rows[0].fields[0].presence.value, 10);
    assert.ok(Object.isFrozen(hub) && Object.isFrozen(hub.decisionPort) && Object.isFrozen(view) && Object.isFrozen(view.rows[0].fields[0]));
  });

  it('rejects production authority, accessors, schema drift, field-order drift, and duplicate ambiguity', () => {
    const production = mutableBase(); production.productionAuthority = true;
    assert.throws(() => createResearchDataHub(production as never), /PRODUCTION_AUTHORITY/);
    let executions = 0;
    const accessor = mutableBase();
    Object.defineProperty(accessor.canonicalDataset, 'records', { enumerable: true, get() { executions += 1; return []; } });
    assert.throws(() => createResearchDataHub(accessor as never));
    assert.equal(executions, 0);

    const drift = duplicateRows(2);
    drift.canonicalDataset.records[1].fields[0].unit = 'PERCENT';
    assert.throws(() => createResearchDataHub(drift as never), /FIELD_SCHEMA_DRIFT/);
    const order = duplicateRows(2);
    order.canonicalDataset.records[1].fields.reverse();
    assert.throws(() => createResearchDataHub(order as never), /FIELD_SCHEMA_DRIFT/);
    const duplicate = mutableBase();
    duplicate.canonicalDataset.records[0].fields[1].fieldId = duplicate.canonicalDataset.records[0].fields[0].fieldId;
    assert.throws(() => createResearchDataHub(duplicate as never), /DUPLICATE_FIELD_ID|DUPLICATE_FIELD_SCHEMA/);
  });

  it('allows describing no false schema and fails field usage against an empty dataset', () => {
    const empty = mutableBase(); empty.rawRecords = []; empty.canonicalDataset.records = [];
    const hub = createResearchDataHub(empty as never);
    assert.throws(() => decision(hub), /EMPTY_DATASET_FIELD_SCHEMA_UNAVAILABLE/);
  });
});

describe('Phase 9E decision capability', () => {
  it('makes future rows and their count completely unobservable', () => {
    const one = decision(createResearchDataHub(duplicateRows(1) as never));
    const eleven = decision(createResearchDataHub(duplicateRows(11) as never));
    assert.deepEqual(eleven, one);
    const serialized = JSON.stringify(eleven);
    for (const forbidden of ['future-record', 'provenance:', 'revision-', '2026-02-01', 'excludedCount', 'sourceRecordCount', 'rejectedRows', 'originalRecordIndex']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(Object.keys(eleven).sort(), ['decisionTime', 'fieldIds', 'productionAuthority', 'researchUse', 'rows', 'usageMode']);
  });

  it('uses stable source order with dense indexes after hidden rows', () => {
    const data = duplicateRows(4);
    setAvailability(data.rawRecords[3], data.canonicalDataset.records[3], '2026-01-02T00:00:00.000Z');
    const view = decision(createResearchDataHub(data as never));
    assert.deepEqual(view.rows.map((row) => [row.viewIndex, row.sourceRecordId]), [[0, 'eligible-record'], [1, 'future-record-3']]);
  });

  it('requires all requested fields and never exposes a partial row', () => {
    for (const evidence of [
      { state: 'KNOWN', value: '2026-02-01T00:00:00.000Z', source: 'RECORD_ENVELOPE' },
      { state: 'UNKNOWN' },
      { state: 'DOCUMENTED_RULE_UNMATERIALIZED', rule: 'published later' },
    ]) {
      const data = mutableBase();
      data.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'secondary')!.availabilityEvidence = evidence;
      assert.equal(decision(createResearchDataHub(data as never), ['price', 'secondary']).rows.length, 0);
    }
    const missing = mutableBase();
    missing.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'secondary')!.presence = { state: 'MISSING' };
    assert.equal(decision(createResearchDataHub(missing as never), ['price', 'secondary']).rows.length, 0);
    assert.equal(decision(createResearchDataHub(baseInterchange()), ['price', 'secondary']).rows.length, 1);
  });

  it('preserves NULL, zero, false, and empty string while excluding MISSING', () => {
    const hub = createResearchDataHub(baseInterchange());
    const view = decision(hub, ['nullable', 'zero', 'bool', 'empty']);
    assert.deepEqual(view.rows[0].fields.map((item) => item.presence), [
      { state: 'NULL' }, { state: 'VALUE', value: 0 }, { state: 'VALUE', value: false }, { state: 'VALUE', value: '' },
    ]);
    const missing = mutableBase();
    missing.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'missing')!.presence = { state: 'MISSING' };
    assert.equal(decision(createResearchDataHub(missing as never), ['missing']).rows.length, 0);
  });

  it('projects every canonical logical representation without normalization', () => {
    const view = decision(createResearchDataHub(baseInterchange()),
      ['bool', 'zero', 'price', 'empty', 'date', 'timestamp', 'decimal']);
    assert.deepEqual(view.rows[0].fields.map((item) => item.presence), [
      { state: 'VALUE', value: false },
      { state: 'VALUE', value: 0 },
      { state: 'VALUE', value: 10 },
      { state: 'VALUE', value: '' },
      { state: 'VALUE', value: '2026-01-01' },
      { state: 'VALUE', value: '2026-01-01T00:00:00.000Z' },
      { state: 'VALUE', value: '1234.50' },
    ]);
  });

  it('fails static policy violations rather than returning an empty view', () => {
    const hub = createResearchDataHub(baseInterchange());
    assert.throws(() => decision(hub, ['denied']), /RESEARCH_USE_DENIED/);
    assert.throws(() => decision(hub, ['historicalDenied']), /HISTORICAL_DECISION_FORBIDDEN/);
    const forged = mutableBase();
    const label = forged.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'label')!;
    label.historicalDecisionPolicy = 'REQUIRES_PROVABLE_AVAILABILITY';
    label.researchUsePolicy.FACTOR_INPUT = 'ALLOW';
    assert.throws(() => decision(createResearchDataHub(forged as never), ['label']), /LABEL_DECISION_INPUT/);
  });

  it('delegates PIT edges, forecast event time, late ingestion, JOIN_KEY, and currency context to Phase 9C', () => {
    const hub = createResearchDataHub(baseInterchange());
    assert.equal(decision(hub, ['price'], '2026-01-01T23:59:59.999Z').rows.length, 0);
    assert.equal(decision(hub, ['price'], '2026-01-02T00:00:00.000Z').rows.length, 1);
    assert.equal(decision(hub, ['price'], '2026-01-02T00:00:00.001Z').rows.length, 1);
    assert.equal(hub.decisionPort.createDecisionView({ researchUse: 'JOIN_KEY', decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['currency'] }).rows.length, 1);

    const forecast = mutableBase();
    forecast.rawRecords[0].eventTime = '2026-12-01T00:00:00.000Z';
    forecast.canonicalDataset.records[0].eventTime = forecast.rawRecords[0].eventTime;
    for (const item of forecast.canonicalDataset.records[0].fields) item.eventTimeEvidence.value = forecast.rawRecords[0].eventTime;
    forecast.rawRecords[0].ingestedAt = '2027-01-01T00:00:00.000Z';
    forecast.canonicalDataset.records[0].ingestedAt = forecast.rawRecords[0].ingestedAt;
    assert.equal(decision(createResearchDataHub(forecast as never)).rows.length, 1);

    for (const context of [
      { presence: { state: 'MISSING' } }, { presence: { state: 'NULL' } },
      { availabilityEvidence: { state: 'KNOWN', value: '2026-02-01T00:00:00.000Z', source: 'RECORD_ENVELOPE' } },
      { availabilityEvidence: { state: 'UNKNOWN' } },
      { historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT' },
    ]) {
      const data = mutableBase();
      Object.assign(data.canonicalDataset.records[0].fields.find((item) => item.fieldId === 'currency')!, context);
      const record = data.canonicalDataset.records[0] as never;
      const expected = evaluateDecisionInputEligibility(record, 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').eligible;
      assert.equal(decision(createResearchDataHub(data as never)).rows.length > 0, expected);
    }
  });
});

describe('Phase 9E analysis and capability separation', () => {
  it('preserves every row, presence state, value, and order only for approved non-decision use', () => {
    const data = duplicateRows(2);
    const second = data.canonicalDataset.records[1];
    second.fields.find((item) => item.fieldId === 'nullable')!.presence = { state: 'MISSING' };
    const hub = createResearchDataHub(data as never);
    const view = hub.analysisPort.createAnalysisView({ researchUse: 'DISPLAY', fieldIds: ['nullable', 'zero', 'bool', 'empty'] });
    assert.deepEqual(view.rows.map((row) => row.sourceRecordId), ['eligible-record', 'future-record-1']);
    assert.deepEqual(view.rows[0].fields.map((item) => item.presence), [
      { state: 'NULL' }, { state: 'VALUE', value: 0 }, { state: 'VALUE', value: false }, { state: 'VALUE', value: '' },
    ]);
    assert.deepEqual(view.rows[1].fields[0].presence, { state: 'MISSING' });
    assert.equal(view.usageMode, 'NON_DECISION_RESEARCH');
    assert.equal(view.productionAuthority, false);
    assert.throws(() => hub.analysisPort.createAnalysisView({ researchUse: 'DISPLAY', fieldIds: ['denied'] }), /RESEARCH_USE_DENIED/);
  });

  it('allows labels only through the separate analysis capability', () => {
    const hub = createResearchDataHub(baseInterchange());
    const label = hub.analysisPort.createAnalysisView({ researchUse: 'LABEL', fieldIds: ['label'] });
    assert.equal(JSON.stringify(label).includes('FUTURE_LABEL_SENTINEL_9E'), true);
    assert.equal(JSON.stringify(decision(hub)).includes('FUTURE_LABEL_SENTINEL_9E'), false);
    assert.throws(() => hub.decisionPort.createDecisionView({ researchUse: 'LABEL' as never, decisionTime: '2026-01-03T00:00:00.000Z', fieldIds: ['label'] }));
  });

  it('exposes exact frozen capability keys and no generic bypass surface', () => {
    const hub = createResearchDataHub(baseInterchange());
    assert.deepEqual(Object.keys(hub).sort(), ['analysisPort', 'decisionPort', 'productionAuthority']);
    assert.deepEqual(Object.keys(hub.decisionPort), ['createDecisionView']);
    assert.deepEqual(Object.keys(hub.analysisPort), ['createAnalysisView']);
    assert.notEqual(hub.decisionPort, hub.analysisPort);
    assert.equal(PHASE_9E_RESEARCH_DATA_HUB_BOUNDARY.decisionEligibilityAuthority, 'PHASE_9C');
    assert.equal(PHASE_9E_RESEARCH_DATA_HUB_BOUNDARY.storageIntegrityAuthority, false);

    const sourceRoot = join(process.cwd(), 'src', 'research', 'data', 'hub');
    const source = readdirSync(sourceRoot).map((name) => readFileSync(join(sourceRoot, name), 'utf8')).join('\n');
    for (const forbidden of [
      'getCanonicalDataset', 'getRawDataset', 'getInterchange', 'unsafeGetData', 'getAllRows',
      'rawMode', 'bypassPolicy', 'includeHidden', 'includeRejected', 'Date.now(', 'performance.now(',
      'node:fs', 'node:http', 'node:https', 'fetch(', 'WebSocket', 'TradingKernel', 'ProductionSpine',
      'ResearchBacktestKernel', 'pointInTimeSafe', 'BACKTEST_ELIGIBLE',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
