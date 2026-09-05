import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import type { RawResearchRecord } from '../../src/research/data/ResearchProviderAdapterContract';
import {
  type CanonicalFieldDefinition,
  type CanonicalFieldDictionary,
  type CanonicalLogicalType,
  type ResearchUsePolicy,
} from '../../src/research/data/dictionary/CanonicalFieldDictionaryContract';
import type {
  ProviderSourceBindingSet,
  ProviderSourceFieldBinding,
  SourcePath,
  SourceTimeBinding,
} from '../../src/research/data/dictionary/ProviderSourceBindingContract';
import {
  PHASE_9C_CANONICAL_PIT_BOUNDARY,
  createCanonicalPointInTimeDataset,
} from '../../src/research/data/pit/CanonicalPointInTimeDataset';
import {
  PHASE_9C_POINT_IN_TIME_ELIGIBILITY_BOUNDARY,
  evaluateDecisionInputEligibility,
  evaluatePointInTimeVisibility,
} from '../../src/research/data/pit/PointInTimeEligibility';

function policy(patch: Partial<ResearchUsePolicy> = {}): ResearchUsePolicy {
  return {
    FACTOR_INPUT: 'DENY', LABEL: 'DENY', RESEARCH_VALUATION: 'DENY',
    UNIVERSE_FILTER: 'DENY', RESEARCH_EXECUTION_MODEL_INPUT: 'DENY',
    JOIN_KEY: 'DENY', DISPLAY: 'ALLOW', QUALITY_CONTROL: 'ALLOW', ...patch,
  };
}

function field(
  fieldId: string,
  logicalType: CanonicalLogicalType = 'FLOAT64',
  patch: Partial<CanonicalFieldDefinition> = {},
): CanonicalFieldDefinition {
  return {
    fieldId,
    logicalType,
    unit: 'UNITLESS',
    meaning: `Canonical meaning for ${fieldId}.`,
    semanticRole: 'MEASURE',
    nullSemantics: { nullable: false },
    priceSemantics: { kind: 'NOT_PRICE' },
    observationSemantics: { kind: 'INSTANT' },
    calendarSemantics: logicalType === 'DATE'
      ? { kind: 'NAMED', timezoneId: 'UTC', calendarId: 'UTC_DAY' }
      : { kind: 'NOT_APPLICABLE' },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT',
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW' }),
    ...patch,
  };
}

function binding(
  definition: CanonicalFieldDefinition,
  sourcePath: SourcePath = [definition.fieldId],
  patch: Partial<ProviderSourceFieldBinding> = {},
): ProviderSourceFieldBinding {
  return {
    canonicalFieldId: definition.fieldId,
    sourcePath,
    mappingKind: 'DIRECT',
    sourceLogicalType: definition.logicalType,
    sourceUnit: definition.unit,
    sourcePriceSemantics: definition.priceSemantics,
    sourceObservationSemantics: definition.observationSemantics,
    sourcePresence: 'REQUIRED',
    sourceNullable: false,
    eventTimeBinding: 'RECORD_ENVELOPE',
    availableAtBinding: 'RECORD_ENVELOPE',
    ...patch,
  };
}

function dictionary(fields: readonly CanonicalFieldDefinition[]): CanonicalFieldDictionary {
  return {
    schemaVersion: '1.0.0', dictionaryId: 'research.pit', dictionaryVersion: '1.0.0',
    dataDomain: 'market-bars', fields, productionAuthority: false,
  };
}

function bindingSet(bindings: readonly ProviderSourceFieldBinding[]): ProviderSourceBindingSet {
  return {
    schemaVersion: '1.0.0', bindingId: 'provider.pit', bindingVersion: '1.0.0',
    providerId: 'example-provider', adapterId: 'example-adapter', sourceDatasetRef: 'source:pit',
    dictionaryId: 'research.pit', dictionaryVersion: '1.0.0', bindings, productionAuthority: false,
  };
}

function manifest(): ProviderManifest {
  return {
    schemaVersion: '1.0.0', manifestVersion: '1.0.0', providerId: 'example-provider',
    adapterId: 'example-adapter', adapterVersion: '1.0.0', dataDomains: ['market-bars'],
    marketScopes: ['global-equities'], transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: {
      mode: 'EXTERNAL_REFERENCE',
      credentialReferences: [{ source: 'ENVIRONMENT', reference: 'env:RESEARCH_API_KEY' }],
    },
    pagination: { mode: 'none', boundedPage: true, maximumRecordsPerPage: 100, cursorSupported: false },
    ordering: { guarantee: 'provider-declared', keys: ['event-time'] },
    duplicates: { semantics: 'provider-may-repeat', stableSourceRecordId: true },
    rateLimit: { semantics: 'provider-documented', retryAfterSupported: false },
    revisions: { semantics: 'provider-declared', sourceRevisionAvailable: true },
    licensing: { redistributionAllowed: false, license: 'provider-terms', attribution: null },
    timeSemantics: {
      eventTimeSource: 'record event timestamp', availableAtSource: 'publication timestamp',
      availableAtRule: null, availableAtAuthority: 'PROVIDER_FIELD',
    },
    productionAuthority: false,
  };
}

function record(payload: unknown, patch: Partial<RawResearchRecord> = {}): RawResearchRecord {
  return {
    providerId: 'example-provider', adapterId: 'example-adapter', adapterVersion: '1.0.0',
    sourceDatasetRef: 'source:pit', sourceRecordId: 'record-1',
    eventTime: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-02T00:00:00.000Z',
    availableAtAuthority: 'PROVIDER_FIELD', ingestedAt: '2026-09-01T00:00:00.000Z',
    payload, payloadHash: 'a'.repeat(64), manifestVersion: '1.0.0',
    manifestReference: 'manifest:example', requestId: 'request-1',
    sourceProvenanceRef: 'provenance:example',
    sourceRevision: { revisionId: 'revision-1', observedAt: '2026-09-01T00:00:00.000Z' },
    ...patch,
  };
}

function build(
  fields: readonly CanonicalFieldDefinition[],
  bindings: readonly ProviderSourceFieldBinding[],
  records: readonly RawResearchRecord[],
) {
  return createCanonicalPointInTimeDataset({ records, dictionary: dictionary(fields), bindingSet: bindingSet(bindings), manifest: manifest() });
}

function onlyField(dataset: ReturnType<typeof build>) {
  return dataset.records[0].fields[0];
}

describe('Phase 9C canonical extraction', () => {
  it('preserves MISSING, NULL, zero, empty string and false as distinct states', () => {
    const optional = field('missing', 'STRING', { nullSemantics: { nullable: true, meaning: 'Source explicitly published null.' } });
    const nullable = field('nullable', 'STRING', { nullSemantics: { nullable: true, meaning: 'Source explicitly published null.' } });
    const zero = field('zero');
    const empty = field('empty', 'STRING');
    const bool = field('bool', 'BOOLEAN');
    const bindings = [
      binding(optional, ['missing'], { sourcePresence: 'OPTIONAL', sourceNullable: true }),
      binding(nullable, ['nullable'], { sourceNullable: true }), binding(zero), binding(empty), binding(bool),
    ];
    const dataset = build([optional, nullable, zero, empty, bool], bindings, [record({ nullable: null, zero: 0, empty: '', bool: false })]);
    assert.deepEqual(dataset.records[0].fields.map((entry) => entry.presence), [
      { state: 'MISSING' }, { state: 'NULL' }, { state: 'VALUE', value: 0 },
      { state: 'VALUE', value: '' }, { state: 'VALUE', value: false },
    ]);
  });

  it('fails closed for a required missing path', () => {
    const value = field('value');
    assert.throws(() => build([value], [binding(value)], [record({})]), /REQUIRED_SOURCE_MISSING:value/);
  });

  it('rejects explicit null unless both binding and definition permit it', () => {
    const value = field('value', 'STRING', { nullSemantics: { nullable: true, meaning: 'Explicit missing publication.' } });
    assert.throws(() => build([value], [binding(value)], [record({ value: null })]), /NULL_NOT_PERMITTED:value/);
  });

  it('keeps numeric and string path segments distinct for arrays and objects', () => {
    const value = field('value');
    assert.equal(onlyField(build([value], [binding(value, ['bars', 0, 'value'])], [record({ bars: [{ value: 1 }] })])).presence.state, 'VALUE');
    assert.throws(() => build([value], [binding(value, ['bars', '0', 'value'])], [record({ bars: [{ value: 1 }] })]), /REQUIRED_SOURCE_MISSING/);
    assert.throws(() => build([value], [binding(value, ['bars', 0, 'value'])], [record({ bars: { '0': { value: 1 } } })]), /REQUIRED_SOURCE_MISSING/);
  });

  it('never resolves prototype properties', () => {
    const value = field('value');
    const payload = Object.create(null) as Record<string, unknown>;
    payload.own = Object.create({ value: 4 });
    assert.throws(() => build([value], [binding(value, ['own', 'value'])], [record(payload)]), /NON_PLAIN_OBJECT|REQUIRED_SOURCE_MISSING/);
  });

  it('rejects a payload accessor without executing it', () => {
    let executions = 0;
    const payload = {} as Record<string, unknown>;
    Object.defineProperty(payload, 'value', { enumerable: true, get() { executions += 1; return 1; } });
    const value = field('value');
    assert.throws(() => build([value], [binding(value)], [record(payload)]), /ACCESSOR/);
    assert.equal(executions, 0);
  });

  it('rejects an accessor-backed raw record array without executing it', () => {
    let executions = 0;
    const records: RawResearchRecord[] = [];
    Object.defineProperty(records, '0', {
      enumerable: true,
      configurable: true,
      get() { executions += 1; return record({ value: 1 }); },
    });
    Object.defineProperty(records, 'length', { value: 1 });
    const value = field('value');
    assert.throws(() => build([value], [binding(value)], records), /ARRAY_ACCESSOR/);
    assert.equal(executions, 0);
  });

  it('uses one defensive record/payload snapshot and returns immutable independent truth', () => {
    const payload = { value: 1, event: '2026-01-01T00:00:00.000Z', available: '2026-01-02T00:00:00.000Z' };
    const value = field('value', 'FLOAT64', { eventTimeRequirement: 'FIELD_LEVEL_REQUIRED', availabilityRequirement: 'FIELD_LEVEL_REQUIRED' });
    const dataset = build([value], [binding(value, ['value'], {
      eventTimeBinding: { kind: 'SOURCE_PAYLOAD_PATH', path: ['event'] },
      availableAtBinding: { kind: 'SOURCE_PAYLOAD_PATH', path: ['available'] },
    })], [record(payload)]);
    payload.value = 9;
    payload.event = '2030-01-01T00:00:00.000Z';
    assert.deepEqual(onlyField(dataset).presence, { state: 'VALUE', value: 1 });
    assert.equal(onlyField(dataset).eventTimeEvidence.state === 'KNOWN' && onlyField(dataset).eventTimeEvidence.value, '2026-01-01T00:00:00.000Z');
    assert.ok(Object.isFrozen(dataset) && Object.isFrozen(dataset.records[0]) && Object.isFrozen(onlyField(dataset)));
  });

  const validRepresentations: readonly [CanonicalLogicalType, unknown][] = [
    ['BOOLEAN', true], ['INT64', 42], ['FLOAT64', 1.25], ['STRING', 'x'],
    ['DATE', '2026-02-28'], ['TIMESTAMP_UTC', '2026-01-01T00:00:00.000Z'],
    [{ kind: 'DECIMAL', precision: 6, scale: 2 }, '1234.50'],
  ];
  for (const [logicalType, source] of validRepresentations) {
    it(`accepts canonical DIRECT ${typeof logicalType === 'string' ? logicalType : 'DECIMAL'} representation`, () => {
      const value = field('value', logicalType);
      assert.equal(onlyField(build([value], [binding(value)], [record({ value: source })])).presence.state, 'VALUE');
    });
  }

  const invalidRepresentations: readonly [string, CanonicalLogicalType, unknown][] = [
    ['BOOLEAN coercion', 'BOOLEAN', 1], ['INT64 fraction', 'INT64', 1.5],
    ['INT64 unsafe', 'INT64', Number.MAX_SAFE_INTEGER + 1], ['FLOAT64 infinity', 'FLOAT64', Infinity],
    ['STRING coercion', 'STRING', 7], ['DATE rollover', 'DATE', '2026-02-30'],
    ['TIMESTAMP offset', 'TIMESTAMP_UTC', '2026-01-01T08:00:00+08:00'],
    ['DECIMAL number conversion', { kind: 'DECIMAL', precision: 6, scale: 2 }, 1.2],
    ['DECIMAL exponent', { kind: 'DECIMAL', precision: 6, scale: 2 }, '1e2'],
    ['DECIMAL scale', { kind: 'DECIMAL', precision: 6, scale: 2 }, '1.2'],
    ['DECIMAL precision', { kind: 'DECIMAL', precision: 4, scale: 2 }, '123.45'],
    ['DECIMAL plus', { kind: 'DECIMAL', precision: 6, scale: 2 }, '+1.20'],
  ];
  for (const [name, logicalType, source] of invalidRepresentations) {
    it(`rejects ${name} without conversion`, () => {
      const value = field('value', logicalType);
      assert.throws(() => build([value], [binding(value)], [record({ value: source })]), /DIRECT_VALUE_REPRESENTATION/);
    });
  }

  it('preserves raw lineage evidence and caller order without recomputing payloadHash', () => {
    const value = field('value');
    const first = record({ value: 1 }, { sourceRecordId: 'z-last', payloadHash: 'b'.repeat(64) });
    const second = record({ value: 2 }, { sourceRecordId: 'a-first', payloadHash: 'c'.repeat(64), sourceRevision: { revisionId: 'revision-2' } });
    const dataset = build([value], [binding(value)], [first, second]);
    assert.deepEqual(dataset.records.map((entry) => entry.sourceRecordId), ['z-last', 'a-first']);
    assert.equal(dataset.records[0].payloadHash, 'b'.repeat(64));
    assert.deepEqual(dataset.records[1].sourceRevision, { revisionId: 'revision-2' });
  });

  it('rejects ambiguous duplicate sourceRecordId instead of selecting a revision winner', () => {
    const value = field('value');
    assert.throws(() => build([value], [binding(value)], [
      record({ value: 1 }, { sourceRevision: { revisionId: 'r1' } }),
      record({ value: 2 }, { sourceRevision: { revisionId: 'r2' } }),
    ]), /DUPLICATE_SOURCE_RECORD_ID/);
  });
});

describe('Phase 9C time evidence and visibility', () => {
  it('uses the record envelope eventTime only when the canonical requirement permits it', () => {
    const value = field('value');
    const evidence = onlyField(build([value], [binding(value)], [record({ value: 1 })])).eventTimeEvidence;
    assert.deepEqual(evidence, { state: 'KNOWN', value: '2026-01-01T00:00:00.000Z', source: 'RECORD_ENVELOPE' });
  });

  it('resolves field-level event time from a strict source path', () => {
    const value = field('value', 'FLOAT64', { eventTimeRequirement: 'FIELD_LEVEL_REQUIRED' });
    const evidence = onlyField(build([value], [binding(value, ['value'], {
      eventTimeBinding: { kind: 'SOURCE_PAYLOAD_PATH', path: ['event'] },
    })], [record({ value: 1, event: '2026-01-01T01:00:00.000Z' })])).eventTimeEvidence;
    assert.equal(evidence.state, 'KNOWN');
  });

  it('keeps field-level documented event rules unresolved and ineligible', () => {
    const value = field('value', 'FLOAT64', { eventTimeRequirement: 'FIELD_LEVEL_REQUIRED' });
    const dataset = build([value], [binding(value, ['value'], {
      eventTimeBinding: { kind: 'DOCUMENTED_RULE', rule: 'Provider assigns the close of the published interval.' },
    })], [record({ value: 1 })]);
    assert.equal(onlyField(dataset).eventTimeEvidence.state, 'DOCUMENTED_RULE_UNMATERIALIZED');
    assert.equal(evaluateDecisionInputEligibility(dataset.records[0], 'value', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'EVENT_TIME_UNPROVABLE');
  });

  it('uses concrete non-UNKNOWN record availableAt and ignores ingestedAt for visibility', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 }, { ingestedAt: '2030-01-01T00:00:00.000Z' })]);
    assert.equal(evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-03T00:00:00.000Z').state, 'VISIBLE');
  });

  it('treats UNKNOWN record availability authority as unprovable and does not substitute eventTime or ingestedAt', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 }, {
      availableAt: null, availableAtAuthority: 'UNKNOWN', ingestedAt: '2025-01-01T00:00:00.000Z',
    })]);
    assert.equal(evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-03T00:00:00.000Z').state, 'UNPROVABLE');
  });

  it('resolves field-level availableAt path and rejects a noncanonical timestamp', () => {
    const value = field('value', 'FLOAT64', { availabilityRequirement: 'FIELD_LEVEL_REQUIRED' });
    const sourceBinding = binding(value, ['value'], { availableAtBinding: { kind: 'SOURCE_PAYLOAD_PATH', path: ['published'] } });
    const dataset = build([value], [sourceBinding], [record({ value: 1, published: '2026-01-02T00:00:00.000Z' })]);
    assert.equal(onlyField(dataset).availabilityEvidence.state, 'KNOWN');
    assert.throws(() => build([value], [sourceBinding], [record({ value: 1, published: '2026-01-02T08:00:00+08:00' })]), /AVAILABLE_AT_REPRESENTATION/);
  });

  it('keeps a field-level documented availability rule unmaterialized', () => {
    const value = field('value', 'FLOAT64', { availabilityRequirement: 'FIELD_LEVEL_REQUIRED' });
    const dataset = build([value], [binding(value, ['value'], {
      availableAtBinding: { kind: 'DOCUMENTED_RULE', rule: 'Provider publication occurs after the scheduled release.' },
    })], [record({ value: 1 })]);
    assert.equal(onlyField(dataset).availabilityEvidence.state, 'DOCUMENTED_RULE_UNMATERIALIZED');
  });

  it('canonical UNKNOWN availability overrides a provider timestamp path', () => {
    const value = field('value', 'FLOAT64', {
      availabilityRequirement: 'UNKNOWN', historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT', researchUsePolicy: policy(),
    });
    const dataset = build([value], [binding(value, ['value'], {
      availableAtBinding: { kind: 'SOURCE_PAYLOAD_PATH', path: ['published'] },
    })], [record({ value: 1, published: '2026-01-01T00:00:00.000Z' })]);
    assert.equal(onlyField(dataset).availabilityEvidence.state, 'UNKNOWN');
  });

  it('evaluates before, equality and after using availableAt rather than eventTime', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 }, { eventTime: '2030-01-01T00:00:00.000Z' })]);
    assert.equal(evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-01T23:59:59.999Z').state, 'NOT_YET_AVAILABLE');
    assert.equal(evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-02T00:00:00.000Z').state, 'VISIBLE');
    assert.equal(evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-03T00:00:00.000Z').state, 'VISIBLE');
  });

  it('requires an explicit strict decision timestamp', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 })]);
    assert.throws(() => evaluatePointInTimeVisibility(onlyField(dataset), '2026-01-02'), /DECISION_TIME/);
  });
});

describe('Phase 9C decision-input eligibility', () => {
  it('allows only an allowed decision use with resolved event time and visible availability', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 })]);
    assert.deepEqual(evaluateDecisionInputEligibility(dataset.records[0], 'value', 'FACTOR_INPUT', '2026-01-02T00:00:00.000Z').eligible, true);
  });

  it('never permits LABEL or another non-decision use', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 })]);
    assert.equal(evaluateDecisionInputEligibility(dataset.records[0], 'value', 'LABEL', '2026-01-03T00:00:00.000Z').reason, 'USE_NOT_DECISION_INPUT');
  });

  it('denies policy DENY and FORBIDDEN_AS_DECISION_INPUT deterministically', () => {
    const denied = field('denied', 'FLOAT64', { researchUsePolicy: policy() });
    const forbidden = field('forbidden', 'FLOAT64', { historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT', researchUsePolicy: policy() });
    const dataset = build([denied, forbidden], [binding(denied), binding(forbidden)], [record({ denied: 1, forbidden: 2 })]);
    assert.equal(evaluateDecisionInputEligibility(dataset.records[0], 'denied', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'RESEARCH_USE_DENIED');
    assert.equal(evaluateDecisionInputEligibility(dataset.records[0], 'forbidden', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'HISTORICAL_DECISION_FORBIDDEN');
  });

  it('does not classify a legitimate visible NULL as missing or ineligible', () => {
    const value = field('value', 'STRING', { nullSemantics: { nullable: true, meaning: 'Explicitly published no value.' } });
    const dataset = build([value], [binding(value, ['value'], { sourceNullable: true })], [record({ value: null })]);
    const result = evaluateDecisionInputEligibility(dataset.records[0], 'value', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z');
    assert.equal(result.eligible, true);
    assert.equal(result.visibility.state, 'VISIBLE');
  });

  function currencyDataset(currencyPresence: 'VALUE' | 'MISSING' | 'NULL', currencyAvailableAt: SourceTimeBinding | 'RECORD') {
    const currency = field('currency', 'STRING', {
      nullSemantics: { nullable: true, meaning: 'Provider explicitly omitted the currency context.' },
      researchUsePolicy: policy({ JOIN_KEY: 'ALLOW' }),
      availabilityRequirement: currencyAvailableAt === 'RECORD' ? 'RECORD_AVAILABLE_AT_SUFFICIENT' : 'FIELD_LEVEL_REQUIRED',
    });
    const price = field('price', 'FLOAT64', {
      unit: { kind: 'CURRENCY', currencyFieldId: 'currency' },
      priceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
      researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW', RESEARCH_VALUATION: 'ALLOW' }),
    });
    const currencyBinding = binding(currency, ['currency'], {
      sourcePresence: currencyPresence === 'MISSING' ? 'OPTIONAL' : 'REQUIRED', sourceNullable: true,
      availableAtBinding: currencyAvailableAt === 'RECORD' ? 'RECORD_ENVELOPE' : currencyAvailableAt,
    });
    const payload: Record<string, unknown> = { price: 10 };
    if (currencyPresence === 'VALUE') payload.currency = 'USD';
    if (currencyPresence === 'NULL') payload.currency = null;
    if (typeof currencyAvailableAt === 'object' && currencyAvailableAt.kind === 'SOURCE_PAYLOAD_PATH') {
      payload.currencyPublished = '2026-01-04T00:00:00.000Z';
    }
    return build([currency, price], [currencyBinding, binding(price)], [record(payload)]);
  }

  it('requires row-level currency context to be present and non-null', () => {
    const missing = currencyDataset('MISSING', 'RECORD');
    const nullable = currencyDataset('NULL', 'RECORD');
    assert.equal(evaluateDecisionInputEligibility(missing.records[0], 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'CURRENCY_CONTEXT_MISSING');
    assert.equal(evaluateDecisionInputEligibility(nullable.records[0], 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'CURRENCY_CONTEXT_NULL');
  });

  it('rejects future and unprovable row-level currency context', () => {
    const future = currencyDataset('VALUE', { kind: 'SOURCE_PAYLOAD_PATH', path: ['currencyPublished'] });
    const unprovable = currencyDataset('VALUE', { kind: 'DOCUMENTED_RULE', rule: 'Currency metadata follows provider publication policy.' });
    assert.equal(evaluateDecisionInputEligibility(future.records[0], 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'CURRENCY_CONTEXT_NOT_YET_AVAILABLE');
    assert.equal(evaluateDecisionInputEligibility(unprovable.records[0], 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason, 'CURRENCY_CONTEXT_AVAILABLE_AT_UNPROVABLE');
  });

  it('accepts visible usable row-level currency context', () => {
    const dataset = currencyDataset('VALUE', 'RECORD');
    assert.equal(evaluateDecisionInputEligibility(dataset.records[0], 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').eligible, true);
  });

  it('rejects historically forbidden currency context even when its timestamp is visible', () => {
    const dataset = currencyDataset('VALUE', 'RECORD');
    const currency = dataset.records[0].fields[0] as unknown as Record<string, unknown>;
    const forgedRecord = {
      ...dataset.records[0],
      fields: [{ ...currency, historicalDecisionPolicy: 'FORBIDDEN_AS_DECISION_INPUT' }, dataset.records[0].fields[1]],
    } as unknown as typeof dataset.records[0];
    assert.equal(
      evaluateDecisionInputEligibility(forgedRecord, 'price', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z').reason,
      'CURRENCY_CONTEXT_HISTORICAL_DECISION_FORBIDDEN',
    );
  });
});

describe('Phase 9C authority and stop boundary', () => {
  it('keeps the dataset research-only with no static eligibility flag', () => {
    const value = field('value');
    const dataset = build([value], [binding(value)], [record({ value: 1 })]);
    assert.equal(dataset.productionAuthority, false);
    for (const forbidden of ['pointInTimeSafe', 'historicallySafe', 'datasetEligible', 'BACKTEST_ELIGIBLE']) {
      assert.equal(Object.hasOwn(dataset, forbidden), false);
    }
    assert.equal(PHASE_9C_CANONICAL_PIT_BOUNDARY.staticPointInTimeEligibility, false);
    assert.equal(PHASE_9C_POINT_IN_TIME_ELIGIBILITY_BOUNDARY.explicitDecisionTimeRequired, true);
  });

  it('contains no network, storage, process, production-kernel, or current-clock authority', () => {
    const sourceRoot = join(process.cwd(), 'src', 'research', 'data', 'pit');
    const source = readdirSync(sourceRoot).map((name) => readFileSync(join(sourceRoot, name), 'utf8')).join('\n');
    for (const forbidden of [
      'Date.now(', 'performance.now(', 'node:fs', 'node:net', 'node:http', 'node:https', 'child_process',
      'TradingKernel', 'ProductionSpine', 'PreTradeRiskGateway', 'ResearchDataHub', 'ResearchBacktestKernel',
      'Parquet', 'DuckDB', 'Polars', 'LIVE_READY',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
