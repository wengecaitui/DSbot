import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import {
  DECISION_INPUT_USES,
  NON_DECISION_INPUT_USES,
  PHASE_9B_CANONICAL_DICTIONARY_BOUNDARY,
  RESEARCH_USES,
  assertCanonicalFieldDictionary,
  type CanonicalFieldDefinition,
  type CanonicalFieldDictionary,
  type ResearchUsePolicy,
} from '../../src/research/data/dictionary/CanonicalFieldDictionaryContract';
import {
  PHASE_9B_PROVIDER_BINDING_BOUNDARY,
  assertBindingSetMatchesDictionary,
  assertBindingSetMatchesManifest,
  assertProviderSourceBindingSet,
  type ProviderSourceBindingSet,
} from '../../src/research/data/dictionary/ProviderSourceBindingContract';

function policy(patch: Partial<ResearchUsePolicy> = {}): ResearchUsePolicy {
  return {
    FACTOR_INPUT: 'DENY',
    LABEL: 'DENY',
    RESEARCH_VALUATION: 'DENY',
    UNIVERSE_FILTER: 'DENY',
    RESEARCH_EXECUTION_MODEL_INPUT: 'DENY',
    JOIN_KEY: 'DENY',
    DISPLAY: 'ALLOW',
    QUALITY_CONTROL: 'ALLOW',
    ...patch,
  };
}

function currencyField(): CanonicalFieldDefinition {
  return {
    fieldId: 'currency_code',
    logicalType: 'STRING',
    unit: 'UNITLESS',
    meaning: 'ISO-style currency attribution code supplied by the canonical field contract.',
    semanticRole: 'IDENTIFIER',
    nullSemantics: { nullable: false },
    priceSemantics: { kind: 'NOT_PRICE' },
    observationSemantics: { kind: 'INSTANT' },
    calendarSemantics: { kind: 'NOT_APPLICABLE' },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT',
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({ JOIN_KEY: 'ALLOW' }),
  };
}

function closeField(): CanonicalFieldDefinition {
  return {
    fieldId: 'close_price',
    logicalType: 'FLOAT64',
    unit: { kind: 'CURRENCY', currencyFieldId: 'currency_code' },
    meaning: 'Unadjusted observed close price for the attributed observation.',
    semanticRole: 'MEASURE',
    nullSemantics: { nullable: false },
    priceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
    observationSemantics: { kind: 'INSTANT' },
    calendarSemantics: { kind: 'NAMED', timezoneId: 'Asia/Shanghai', calendarId: 'SSE_SZSE' },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT',
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({
      FACTOR_INPUT: 'ALLOW',
      RESEARCH_VALUATION: 'ALLOW',
      RESEARCH_EXECUTION_MODEL_INPUT: 'ALLOW',
    }),
  };
}

function periodField(): CanonicalFieldDefinition {
  return {
    fieldId: 'period_measure',
    logicalType: { kind: 'DECIMAL', precision: 18, scale: 4 },
    unit: 'RATIO',
    meaning: 'A period-attributed research measure with explicit missing-value meaning.',
    semanticRole: 'MEASURE',
    nullSemantics: { nullable: true, meaning: 'The source published no value for this period.' },
    priceSemantics: { kind: 'NOT_PRICE' },
    observationSemantics: { kind: 'PERIOD', period: 'DAY', eventTimeAnchor: 'PERIOD_END' },
    calendarSemantics: { kind: 'NAMED', timezoneId: 'UTC', calendarId: 'UTC_DAY' },
    eventTimeRequirement: 'FIELD_LEVEL_REQUIRED',
    availabilityRequirement: 'FIELD_LEVEL_REQUIRED',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW' }),
  };
}

function validDictionary(): CanonicalFieldDictionary {
  return {
    schemaVersion: '1.0.0',
    dictionaryId: 'research.market-fields',
    dictionaryVersion: '1.0.0',
    dataDomain: 'market-bars',
    fields: [currencyField(), closeField(), periodField()],
    productionAuthority: false,
  };
}

function validBindingSet(): ProviderSourceBindingSet {
  return {
    schemaVersion: '1.0.0',
    bindingId: 'example.daily-bars',
    bindingVersion: '1.0.0',
    providerId: 'example-research-source',
    adapterId: 'example-bounded-reader',
    sourceDatasetRef: 'source:daily-bars',
    dictionaryId: 'research.market-fields',
    dictionaryVersion: '1.0.0',
    bindings: [
      {
        canonicalFieldId: 'close_price',
        sourcePath: ['bars', 0, 'close'],
        mappingKind: 'DIRECT',
        sourceLogicalType: 'FLOAT64',
        sourceUnit: { kind: 'CURRENCY', currencyFieldId: 'currency_code' },
        sourcePriceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
        sourceObservationSemantics: { kind: 'INSTANT' },
        sourcePresence: 'REQUIRED',
        sourceNullable: false,
        eventTimeBinding: 'RECORD_ENVELOPE',
        availableAtBinding: 'RECORD_ENVELOPE',
      },
      {
        canonicalFieldId: 'currency_code',
        sourcePath: ['bars', 0, 'currency'],
        mappingKind: 'DIRECT',
        sourceLogicalType: 'STRING',
        sourceUnit: 'UNITLESS',
        sourcePriceSemantics: { kind: 'NOT_PRICE' },
        sourceObservationSemantics: { kind: 'INSTANT' },
        sourcePresence: 'REQUIRED',
        sourceNullable: false,
        eventTimeBinding: 'RECORD_ENVELOPE',
        availableAtBinding: 'RECORD_ENVELOPE',
      },
    ],
    productionAuthority: false,
  };
}

function validManifest(): ProviderManifest {
  return {
    schemaVersion: '1.0.0',
    manifestVersion: '1.0.0',
    providerId: 'example-research-source',
    adapterId: 'example-bounded-reader',
    adapterVersion: '1.0.0',
    dataDomains: ['market-bars'],
    marketScopes: ['global-equities'],
    transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: {
      mode: 'EXTERNAL_REFERENCE',
      credentialReferences: [{ source: 'ENVIRONMENT', reference: 'env:RESEARCH_API_KEY' }],
    },
    pagination: {
      mode: 'cursor', boundedPage: true, maximumRecordsPerPage: 1000, cursorSupported: true,
    },
    ordering: { guarantee: 'provider-declared', keys: ['event-time'] },
    duplicates: { semantics: 'provider-may-repeat', stableSourceRecordId: true },
    rateLimit: { semantics: 'provider-documented', retryAfterSupported: true },
    revisions: { semantics: 'provider-declared', sourceRevisionAvailable: true },
    licensing: { redistributionAllowed: false, license: 'provider-terms', attribution: null },
    timeSemantics: {
      eventTimeSource: 'record event timestamp',
      availableAtSource: null,
      availableAtRule: 'provider publication timestamp',
      availableAtAuthority: 'DOCUMENTED_RULE',
    },
    productionAuthority: false,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mutableDictionary(): any {
  return clone(validDictionary());
}

function mutableBindingSet(): any {
  return clone(validBindingSet());
}

describe('Phase 9B canonical dictionary contract', () => {
  it('accepts a valid provider-neutral dictionary', () => {
    assert.doesNotThrow(() => assertCanonicalFieldDictionary(validDictionary()));
  });

  it('rejects extra or missing root keys', () => {
    const missing = mutableDictionary();
    delete missing.dataDomain;
    assert.throws(() => assertCanonicalFieldDictionary(missing), /ROOT_FIELDS/);
    const extra = mutableDictionary();
    extra.datasetId = 'not-layer-one';
    assert.throws(() => assertCanonicalFieldDictionary(extra), /ROOT_FIELDS/);
  });

  it('rejects extra or missing field keys', () => {
    const missing = mutableDictionary();
    delete missing.fields[0].meaning;
    assert.throws(() => assertCanonicalFieldDictionary(missing), /FIELD_0_FIELDS/);
    const extra = mutableDictionary();
    extra.fields[0].sourcePath = ['currency'];
    assert.throws(() => assertCanonicalFieldDictionary(extra), /FIELD_0_FIELDS/);
  });

  it('requires literal false production authority on both roots', () => {
    for (const value of [true, null, 'false', 0]) {
      const dictionary = mutableDictionary();
      dictionary.productionAuthority = value;
      assert.throws(() => assertCanonicalFieldDictionary(dictionary), /PRODUCTION_AUTHORITY/);
      const binding = mutableBindingSet();
      binding.productionAuthority = value;
      assert.throws(() => assertProviderSourceBindingSet(binding), /PRODUCTION_AUTHORITY/);
    }
    assert.equal(PHASE_9B_CANONICAL_DICTIONARY_BOUNDARY.productionAuthority, false);
    assert.equal(PHASE_9B_PROVIDER_BINDING_BOUNDARY.productionAuthority, false);
  });

  it('rejects eligibility and lifecycle-shaped dictionary keys', () => {
    for (const [key, value] of [
      ['pointInTimeSafe', true],
      ['status', 'BACKTEST_ELIGIBLE'],
      ['backtestEligible', true],
      ['lifecycleState', 'READY'],
    ] as const) {
      const dictionary = mutableDictionary();
      dictionary[key] = value;
      assert.throws(() => assertCanonicalFieldDictionary(dictionary), /ROOT_FIELDS/);
    }
  });

  it('rejects duplicate canonical field identities', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[2].fieldId = 'close_price';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DUPLICATE_FIELD_ID/);
  });

  it('rejects invalid DECIMAL precision and scale', () => {
    for (const logicalType of [
      { kind: 'DECIMAL', precision: 0, scale: 0 },
      { kind: 'DECIMAL', precision: 5, scale: -1 },
      { kind: 'DECIMAL', precision: 5, scale: 6 },
      { kind: 'DECIMAL', precision: 5.5, scale: 2 },
    ]) {
      const dictionary = mutableDictionary();
      dictionary.fields[2].logicalType = logicalType;
      assert.throws(() => assertCanonicalFieldDictionary(dictionary), /LOGICAL_TYPE/);
    }
  });

  it('rejects missing or nonexistent currency-field references', () => {
    const missing = mutableDictionary();
    delete missing.fields[1].unit.currencyFieldId;
    assert.throws(() => assertCanonicalFieldDictionary(missing), /FIELD_1_UNIT_FIELDS/);
    const nonexistent = mutableDictionary();
    nonexistent.fields[1].unit.currencyFieldId = 'currency_missing';
    assert.throws(() => assertCanonicalFieldDictionary(nonexistent), /CURRENCY_FIELD_NOT_FOUND/);
  });

  it('requires the referenced currency field to be STRING', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].logicalType = 'INT64';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /CURRENCY_FIELD_NOT_STRING/);
  });

  it('requires the referenced currency field not to be CURRENCY', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].unit = { kind: 'CURRENCY', currencyFieldId: 'currency_code' };
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /CURRENCY_FIELD_IS_CURRENCY/);
  });

  it('keeps RATIO, PERCENT, and BASIS_POINTS semantically distinct', () => {
    const units = ['RATIO', 'PERCENT', 'BASIS_POINTS'] as const;
    for (const unit of units) {
      const dictionary = mutableDictionary();
      dictionary.fields[2].unit = unit;
      assert.doesNotThrow(() => assertCanonicalFieldDictionary(dictionary));
    }
    assert.equal(new Set(units).size, 3);
  });

  it('enforces strict nullable semantics', () => {
    const missingMeaning = mutableDictionary();
    missingMeaning.fields[2].nullSemantics = { nullable: true };
    assert.throws(() => assertCanonicalFieldDictionary(missingMeaning), /NULL_SEMANTICS_FIELDS/);
    const falseWithMeaning = mutableDictionary();
    falseWithMeaning.fields[0].nullSemantics = { nullable: false, meaning: 'not accepted' };
    assert.throws(() => assertCanonicalFieldDictionary(falseWithMeaning), /NULL_SEMANTICS_FIELDS/);
    const blank = mutableDictionary();
    blank.fields[2].nullSemantics.meaning = '';
    assert.throws(() => assertCanonicalFieldDictionary(blank), /NULL_SEMANTICS_MEANING/);
  });

  it('rejects default, fill, sentinel, and missing-value semantics', () => {
    for (const key of ['defaultValue', 'fillValue', 'sentinel', 'missingValue', 'zeroMeansMissing']) {
      const dictionary = mutableDictionary();
      dictionary.fields[0].nullSemantics[key] = 0;
      assert.throws(() => assertCanonicalFieldDictionary(dictionary), /NULL_SEMANTICS_FIELDS/);
    }
  });

  it('rejects PERIOD observation without named calendar attribution', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[2].calendarSemantics = { kind: 'NOT_APPLICABLE' };
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /PERIOD_REQUIRES_CALENDAR/);
  });

  it('rejects DATE without named calendar attribution', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].logicalType = 'DATE';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DATE_REQUIRES_CALENDAR/);
  });

  it('rejects LABEL fields that do not forbid historical decision input', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].semanticRole = 'LABEL';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /LABEL_HISTORICAL_POLICY/);
  });

  it('rejects LABEL fields with any decision-input use allowed', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].semanticRole = 'LABEL';
    dictionary.fields[0].historicalDecisionPolicy = 'FORBIDDEN_AS_DECISION_INPUT';
    dictionary.fields[0].researchUsePolicy.FACTOR_INPUT = 'ALLOW';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DECISION_INPUT_MUST_DENY/);
  });

  it('rejects UNKNOWN availability with any decision-input use allowed', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].availabilityRequirement = 'UNKNOWN';
    dictionary.fields[0].researchUsePolicy.JOIN_KEY = 'ALLOW';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DECISION_INPUT_MUST_DENY/);
  });

  it('rejects forbidden historical decision policy with a decision use allowed', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].historicalDecisionPolicy = 'FORBIDDEN_AS_DECISION_INPUT';
    dictionary.fields[0].researchUsePolicy.UNIVERSE_FILTER = 'ALLOW';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DECISION_INPUT_MUST_DENY/);
  });

  it('partitions the research-use vocabulary exactly and disjointly', () => {
    const decision = new Set<string>(DECISION_INPUT_USES);
    const nonDecision = new Set<string>(NON_DECISION_INPUT_USES);
    assert.deepEqual([...decision].filter((use) => nonDecision.has(use)), []);
    assert.deepEqual(new Set([...decision, ...nonDecision]), new Set(RESEARCH_USES));
  });

  it('rejects UNKNOWN price basis with a decision use allowed', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[1].priceSemantics.basis = 'UNKNOWN';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /UNKNOWN_PRICE_DECISION_INPUT/);
  });

  it('rejects adjusted price as research execution-model input', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[1].priceSemantics.basis = 'SPLIT_ADJUSTED';
    dictionary.fields[1].researchUsePolicy.RESEARCH_VALUATION = 'DENY';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DECISION_PRICE_MUST_BE_RAW/);
  });

  it('rejects adjusted price as research valuation input', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[1].priceSemantics.basis = 'DIVIDEND_ADJUSTED';
    dictionary.fields[1].researchUsePolicy.RESEARCH_EXECUTION_MODEL_INPUT = 'DENY';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /DECISION_PRICE_MUST_BE_RAW/);
  });

  it('requires a definition for PROVIDER_DEFINED observation periods', () => {
    const missing = mutableDictionary();
    missing.fields[2].observationSemantics = {
      kind: 'PERIOD', period: 'PROVIDER_DEFINED', eventTimeAnchor: 'PERIOD_END',
    };
    assert.throws(() => assertCanonicalFieldDictionary(missing), /OBSERVATION_SEMANTICS_FIELDS/);

    const empty = mutableDictionary();
    empty.fields[2].observationSemantics = {
      kind: 'PERIOD',
      period: 'PROVIDER_DEFINED',
      eventTimeAnchor: 'PERIOD_END',
      documentedPeriodDefinition: '   ',
    };
    assert.throws(() => assertCanonicalFieldDictionary(empty), /PERIOD_DEFINITION/);

    const valid = mutableDictionary();
    valid.fields[2].observationSemantics = {
      kind: 'PERIOD',
      period: 'PROVIDER_DEFINED',
      eventTimeAnchor: 'PERIOD_END',
      documentedPeriodDefinition: 'Provider business day ending at the published market cut-off.',
    };
    assert.doesNotThrow(() => assertCanonicalFieldDictionary(valid));
  });

  it('rejects a custom definition on standard observation periods', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[2].observationSemantics.documentedPeriodDefinition = 'Not permitted for DAY.';
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /OBSERVATION_SEMANTICS_FIELDS/);
  });

  it('requires a documented adjustment rule for PROVIDER_DEFINED price basis', () => {
    const missing = mutableDictionary();
    missing.fields[1].priceSemantics = {
      kind: 'PRICE', basis: 'PROVIDER_DEFINED', documentedAdjustmentRule: null,
    };
    assert.throws(() => assertCanonicalFieldDictionary(missing), /PROVIDER_DEFINED_RULE_REQUIRED/);

    const valid = mutableDictionary();
    valid.fields[1].priceSemantics = {
      kind: 'PRICE',
      basis: 'PROVIDER_DEFINED',
      documentedAdjustmentRule: 'Provider publishes a split-adjusted series under its documented methodology.',
    };
    valid.fields[1].researchUsePolicy.RESEARCH_EXECUTION_MODEL_INPUT = 'DENY';
    valid.fields[1].researchUsePolicy.RESEARCH_VALUATION = 'DENY';
    assert.doesNotThrow(() => assertCanonicalFieldDictionary(valid));
  });
});

describe('Phase 9B provider source binding contract', () => {
  it('accepts a valid DIRECT binding and current dictionary pair', () => {
    assert.doesNotThrow(() => assertProviderSourceBindingSet(validBindingSet()));
    assert.doesNotThrow(() => assertBindingSetMatchesDictionary(validDictionary(), validBindingSet()));
  });

  it('rejects extra or missing binding root and field keys', () => {
    const missing = mutableBindingSet();
    delete missing.sourceDatasetRef;
    assert.throws(() => assertProviderSourceBindingSet(missing), /ROOT_FIELDS/);
    const extra = mutableBindingSet();
    extra.bindings[0].transform = 'parse-number';
    assert.throws(() => assertProviderSourceBindingSet(extra), /BINDING_0_FIELDS/);
  });

  it('rejects sparse source paths', () => {
    const set = mutableBindingSet();
    const path = new Array(3);
    path[0] = 'bars';
    path[2] = 'close';
    set.bindings[0].sourcePath = path;
    assert.throws(() => assertProviderSourceBindingSet(set), /ARRAY_HOLE/);
  });

  it('rejects accessor-backed source path indices without executing them', () => {
    const set = mutableBindingSet();
    let invoked = 0;
    const path = ['bars'];
    Object.defineProperty(path, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        invoked += 1;
        return 'bars';
      },
    });
    set.bindings[0].sourcePath = path;
    assert.throws(() => assertProviderSourceBindingSet(set), /ARRAY_ACCESSOR/);
    assert.equal(invoked, 0);
  });

  it('rejects symbol and custom source path properties', () => {
    const custom = mutableBindingSet();
    custom.bindings[0].sourcePath.extra = 'hidden';
    assert.throws(() => assertProviderSourceBindingSet(custom), /ARRAY_CUSTOM_PROPERTY/);
    const symbolic = mutableBindingSet();
    symbolic.bindings[0].sourcePath[Symbol('hidden')] = 'value';
    assert.throws(() => assertProviderSourceBindingSet(symbolic), /SYMBOL_PROPERTY/);
  });

  it('rejects negative, fractional, unsafe, NaN, and nested source path segments', () => {
    for (const segment of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, ['nested']]) {
      const set = mutableBindingSet();
      set.bindings[0].sourcePath = ['bars', segment, 'close'];
      assert.throws(() => assertProviderSourceBindingSet(set), /SOURCE_PATH/);
    }
  });

  it('preserves numeric path 0 as distinct from string path 0', () => {
    const numeric = mutableBindingSet();
    const textual = mutableBindingSet();
    textual.bindings[0].sourcePath = ['bars', '0', 'close'];
    assert.doesNotThrow(() => assertProviderSourceBindingSet(numeric));
    assert.doesNotThrow(() => assertProviderSourceBindingSet(textual));
    assert.notDeepEqual(numeric.bindings[0].sourcePath, textual.bindings[0].sourcePath);
  });

  it('rejects functions anywhere in contract data', () => {
    const set = mutableBindingSet();
    set.bindings[0].eventTimeBinding = { kind: 'DOCUMENTED_RULE', rule: () => 'time' };
    assert.throws(() => assertProviderSourceBindingSet(set), /FUNCTION/);
  });

  it('rejects object accessors without invoking them', () => {
    const dictionary = mutableDictionary();
    let invoked = 0;
    Object.defineProperty(dictionary, 'dictionaryId', {
      enumerable: true,
      configurable: true,
      get: () => {
        invoked += 1;
        return 'research.market-fields';
      },
    });
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /ACCESSOR/);
    assert.equal(invoked, 0);
  });

  it('rejects symbol properties on contract objects', () => {
    const set = mutableBindingSet();
    set[Symbol('authority')] = false;
    assert.throws(() => assertProviderSourceBindingSet(set), /SYMBOL_PROPERTY/);
  });

  it('rejects cyclic contract objects', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[0].cycle = dictionary;
    assert.throws(() => assertCanonicalFieldDictionary(dictionary), /CYCLE/);
  });

  it('rejects duplicate canonical field claims', () => {
    const set = mutableBindingSet();
    set.bindings.push(clone(set.bindings[0]));
    assert.throws(() => assertProviderSourceBindingSet(set), /DUPLICATE_CANONICAL_BINDING/);
  });

  it('rejects unknown canonical field claims', () => {
    const set = mutableBindingSet();
    set.bindings[0].canonicalFieldId = 'not_in_dictionary';
    assert.throws(
      () => assertBindingSetMatchesDictionary(validDictionary(), set),
      /UNKNOWN_CANONICAL_FIELD/,
    );
  });

  it('rejects dictionary identity mismatch', () => {
    const set = mutableBindingSet();
    set.dictionaryId = 'another.dictionary';
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /DICTIONARY_ID_MISMATCH/);
  });

  it('rejects dictionary version mismatch', () => {
    const set = mutableBindingSet();
    set.dictionaryVersion = '2.0.0';
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /DICTIONARY_VERSION_MISMATCH/);
  });

  it('rejects DIRECT logical-type mismatch', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourceLogicalType = 'INT64';
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /LOGICAL_TYPE_MISMATCH/);
  });

  it('rejects DIRECT unit mismatch', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourceUnit = 'UNITLESS';
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /UNIT_MISMATCH/);
  });

  it('rejects DIRECT price-semantics mismatch', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourcePriceSemantics = { kind: 'PRICE', basis: 'UNKNOWN', documentedAdjustmentRule: null };
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /PRICE_MISMATCH/);
  });

  it('rejects DIRECT observation-semantics mismatch', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourceObservationSemantics = {
      kind: 'PERIOD', period: 'DAY', eventTimeAnchor: 'PERIOD_END',
    };
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /OBSERVATION_MISMATCH/);
  });

  it('compares provider-defined observation definitions for DIRECT equality', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[1].observationSemantics = {
      kind: 'PERIOD',
      period: 'PROVIDER_DEFINED',
      eventTimeAnchor: 'PERIOD_END',
      documentedPeriodDefinition: 'Provider trading day ending at its published market cut-off.',
    };
    const set = mutableBindingSet();
    set.bindings[0].sourceObservationSemantics = {
      kind: 'PERIOD',
      period: 'PROVIDER_DEFINED',
      eventTimeAnchor: 'PERIOD_END',
      documentedPeriodDefinition: 'Provider calendar day ending at midnight UTC.',
    };
    assert.throws(() => assertBindingSetMatchesDictionary(dictionary, set), /DIRECT_OBSERVATION_MISMATCH/);
  });

  it('compares provider-defined price rules for DIRECT equality', () => {
    const dictionary = mutableDictionary();
    dictionary.fields[1].priceSemantics = {
      kind: 'PRICE',
      basis: 'PROVIDER_DEFINED',
      documentedAdjustmentRule: 'Provider methodology A.',
    };
    dictionary.fields[1].researchUsePolicy.RESEARCH_EXECUTION_MODEL_INPUT = 'DENY';
    dictionary.fields[1].researchUsePolicy.RESEARCH_VALUATION = 'DENY';
    const set = mutableBindingSet();
    set.bindings[0].sourcePriceSemantics = {
      kind: 'PRICE',
      basis: 'PROVIDER_DEFINED',
      documentedAdjustmentRule: 'Provider methodology B.',
    };
    assert.throws(() => assertBindingSetMatchesDictionary(dictionary, set), /DIRECT_PRICE_MISMATCH/);
  });

  it('rejects OPTIONAL source presence for nonnullable canonical field', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourcePresence = 'OPTIONAL';
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /OPTIONAL_SOURCE/);
  });

  it('rejects nullable source values for nonnullable canonical field', () => {
    const set = mutableBindingSet();
    set.bindings[0].sourceNullable = true;
    assert.throws(() => assertBindingSetMatchesDictionary(validDictionary(), set), /NULLABLE_SOURCE/);
  });

  it('rejects record-envelope or unknown event time for field-level requirement', () => {
    for (const kind of ['RECORD_ENVELOPE', 'UNKNOWN']) {
      const dictionary = mutableDictionary();
      dictionary.fields[1].eventTimeRequirement = 'FIELD_LEVEL_REQUIRED';
      const set = mutableBindingSet();
      set.bindings[0].eventTimeBinding = kind;
      assert.throws(() => assertBindingSetMatchesDictionary(dictionary, set), /FIELD_EVENT_TIME_BINDING_REQUIRED/);
    }
  });

  it('accepts source path or documented rule for field-level event time', () => {
    for (const eventTimeBinding of [
      { kind: 'SOURCE_PAYLOAD_PATH', path: ['event_time'] },
      { kind: 'DOCUMENTED_RULE', rule: 'Use the provider-published field timestamp.' },
    ]) {
      const dictionary = mutableDictionary();
      dictionary.fields[1].eventTimeRequirement = 'FIELD_LEVEL_REQUIRED';
      const set = mutableBindingSet();
      set.bindings[0].eventTimeBinding = eventTimeBinding;
      assert.doesNotThrow(() => assertBindingSetMatchesDictionary(dictionary, set));
    }
  });

  it('rejects record-envelope or unknown available-at for field-level requirement', () => {
    for (const kind of ['RECORD_ENVELOPE', 'UNKNOWN']) {
      const dictionary = mutableDictionary();
      dictionary.fields[1].availabilityRequirement = 'FIELD_LEVEL_REQUIRED';
      const set = mutableBindingSet();
      set.bindings[0].availableAtBinding = kind;
      assert.throws(() => assertBindingSetMatchesDictionary(dictionary, set), /FIELD_AVAILABLE_AT_BINDING_REQUIRED/);
    }
  });

  it('requires DIRECT mapping kind and rejects transform-like mapping kinds', () => {
    const set = mutableBindingSet();
    set.bindings[0].mappingKind = 'SCALE';
    assert.throws(() => assertProviderSourceBindingSet(set), /MAPPING_KIND/);
  });

  it('requires the currency attribution binding when a CURRENCY field is bound', () => {
    const set = mutableBindingSet();
    set.bindings = [set.bindings[0]];
    assert.throws(
      () => assertBindingSetMatchesDictionary(validDictionary(), set),
      /CURRENCY_BINDING_DEPENDENCY_MISSING:close_price/,
    );
  });

  it('accepts a bound CURRENCY field with its referenced currency binding', () => {
    assert.doesNotThrow(() => assertBindingSetMatchesDictionary(validDictionary(), validBindingSet()));
  });

  it('does not require unrelated dictionary fields to be bound', () => {
    const set = validBindingSet();
    assert.equal(set.bindings.some((binding) => binding.canonicalFieldId === 'period_measure'), false);
    assert.doesNotThrow(() => assertBindingSetMatchesDictionary(validDictionary(), set));
  });

  it('allows multiple CURRENCY fields to share one bound currency field', () => {
    const dictionary = mutableDictionary();
    const secondPrice = clone(dictionary.fields[1]);
    secondPrice.fieldId = 'open_price';
    secondPrice.meaning = 'Unadjusted observed open price for the attributed observation.';
    dictionary.fields.push(secondPrice);
    const set = mutableBindingSet();
    const secondBinding = clone(set.bindings[0]);
    secondBinding.canonicalFieldId = 'open_price';
    secondBinding.sourcePath = ['bars', 0, 'open'];
    set.bindings.push(secondBinding);
    assert.doesNotThrow(() => assertBindingSetMatchesDictionary(dictionary, set));
  });

  it('still validates ordinary DIRECT semantics on the currency dependency binding', () => {
    const set = mutableBindingSet();
    set.bindings[1].sourceLogicalType = 'FLOAT64';
    assert.throws(
      () => assertBindingSetMatchesDictionary(validDictionary(), set),
      /DIRECT_LOGICAL_TYPE_MISMATCH:currency_code/,
    );
  });

  it('validates the Phase 9A manifest before matching identities', () => {
    const manifest: any = validManifest();
    manifest.productionAuthority = true;
    assert.throws(
      () => assertBindingSetMatchesManifest(validBindingSet(), manifest),
      /PHASE_9A_PROVIDER_MANIFEST_INVALID/,
    );
  });

  it('rejects a root manifest accessor without executing its getter', () => {
    const manifest: any = validManifest();
    let executions = 0;
    Object.defineProperty(manifest, 'providerId', {
      enumerable: true,
      get() {
        executions += 1;
        return 'example-research-source';
      },
    });
    assert.throws(() => assertBindingSetMatchesManifest(validBindingSet(), manifest), /SNAPSHOT_ACCESSOR/);
    assert.equal(executions, 0);
  });

  it('rejects a nested manifest accessor without executing its getter', () => {
    const manifest: any = validManifest();
    let executions = 0;
    Object.defineProperty(manifest.auth, 'mode', {
      enumerable: true,
      get() {
        executions += 1;
        return 'EXTERNAL_REFERENCE';
      },
    });
    assert.throws(() => assertBindingSetMatchesManifest(validBindingSet(), manifest), /SNAPSHOT_ACCESSOR/);
    assert.equal(executions, 0);
  });

  it('rejects symbol properties on caller-owned manifests', () => {
    const manifest: any = validManifest();
    manifest[Symbol('hidden')] = 'not-cloned-away';
    assert.throws(() => assertBindingSetMatchesManifest(validBindingSet(), manifest), /SNAPSHOT_SYMBOL_PROPERTY/);
  });

  it('rejects sparse and accessor-backed manifest arrays before cloning', () => {
    const sparse: any = validManifest();
    sparse.dataDomains = new Array(2);
    sparse.dataDomains[1] = 'market-bars';
    assert.throws(() => assertBindingSetMatchesManifest(validBindingSet(), sparse), /ARRAY_HOLE/);

    const accessor: any = validManifest();
    let executions = 0;
    const domains = ['market-bars'];
    Object.defineProperty(domains, '0', {
      enumerable: true,
      get() {
        executions += 1;
        return 'market-bars';
      },
    });
    accessor.dataDomains = domains;
    assert.throws(() => assertBindingSetMatchesManifest(validBindingSet(), accessor), /ARRAY_ACCESSOR/);
    assert.equal(executions, 0);
  });

  it('compares identities against the validated defensive manifest snapshot', () => {
    const manifest = validManifest();
    const set = mutableBindingSet();
    set.providerId = 'snapshot-provider';
    const originalStructuredClone = globalThis.structuredClone;
    globalThis.structuredClone = ((value: unknown) => {
      const snapshot: any = originalStructuredClone(value);
      snapshot.providerId = 'snapshot-provider';
      return snapshot;
    }) as typeof structuredClone;
    try {
      assert.doesNotThrow(() => assertBindingSetMatchesManifest(set, manifest));
      assert.equal(manifest.providerId, 'example-research-source');
    } finally {
      globalThis.structuredClone = originalStructuredClone;
    }
  });

  it('rejects provider identity mismatch against a valid manifest', () => {
    const set = mutableBindingSet();
    set.providerId = 'other-provider';
    assert.throws(() => assertBindingSetMatchesManifest(set, validManifest()), /MANIFEST_PROVIDER_ID_MISMATCH/);
  });

  it('rejects adapter identity mismatch against a valid manifest', () => {
    const set = mutableBindingSet();
    set.adapterId = 'other-adapter';
    assert.throws(() => assertBindingSetMatchesManifest(set, validManifest()), /MANIFEST_ADAPTER_ID_MISMATCH/);
  });

  it('matches a current valid Phase 9A manifest without inventing dataset equality', () => {
    const set = mutableBindingSet();
    set.sourceDatasetRef = 'source:manifest-does-not-enumerate-this';
    assert.doesNotThrow(() => assertBindingSetMatchesManifest(set, validManifest()));
    assert.equal(PHASE_9B_PROVIDER_BINDING_BOUNDARY.sourceDatasetManifestEqualityClaimed, false);
  });
});

describe('Phase 9B static architecture boundary', () => {
  const dictionaryDirectory = join(process.cwd(), 'src', 'research', 'data', 'dictionary');
  const layerOnePath = join(dictionaryDirectory, 'CanonicalFieldDictionaryContract.ts');
  const sourceFiles = readdirSync(dictionaryDirectory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [name, readFileSync(join(dictionaryDirectory, name), 'utf8')] as const);

  it('keeps Layer 1 free of provider source authority fields', () => {
    const source = readFileSync(layerOnePath, 'utf8');
    for (const forbidden of [
      'providerId', 'adapterId', 'sourceDatasetRef', 'sourcePath', 'datasetId',
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });

  it('contains no production trading-authority imports', () => {
    for (const [name, source] of sourceFiles) {
      for (const forbidden of [
        "from '../../../data/", 'TradingKernel', 'OMS', 'PreTradeRiskGateway',
        'ProductionSpine', 'PositionResolution', 'RuntimeAccounting', 'LIVE_READY',
      ]) {
        assert.equal(source.includes(forbidden), false, `${name}:${forbidden}`);
      }
    }
  });

  it('contains no provider, network, storage, or filesystem implementation', () => {
    for (const [name, source] of sourceFiles) {
      for (const forbidden of [
        'fetch(', 'axios', 'node:http', 'node:https', 'node:fs', 'writeFile',
        'Parquet', 'DuckDB', 'Polars', 'TickFlow', 'QMT', 'TDX',
      ]) {
        assert.equal(source.includes(forbidden), false, `${name}:${forbidden}`);
      }
    }
  });

  it('contains no Phase 9C or later implementation surface', () => {
    for (const [name, source] of sourceFiles) {
      for (const forbidden of [
        'CanonicalResearchRow', 'CanonicalDataset', 'ResearchDataHub',
        'DatasetUsagePolicy', 'ResearchBacktestKernel', 'normalizeRecord',
      ]) {
        assert.equal(source.includes(forbidden), false, `${name}:${forbidden}`);
      }
    }
  });
});
