import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  SourcePath,
} from '../../src/research/data/dictionary/ProviderSourceBindingContract';
import { createCanonicalPointInTimeDataset } from '../../src/research/data/pit/CanonicalPointInTimeDataset';
import {
  evaluateDecisionInputEligibility,
  evaluatePointInTimeVisibility,
} from '../../src/research/data/pit/PointInTimeEligibility';
import {
  canonicalInertPayloadEncoding,
  decodeInertPayload,
  encodeInertPayload,
} from '../../src/research/data/storage/InertPayloadCodec';
import {
  PHASE_9D_RESEARCH_STORAGE_BOUNDARY,
  createResearchStorageInterchange,
  restoreCanonicalPointInTimeDataset,
  restoreRawResearchRecords,
} from '../../src/research/data/storage/ResearchStorageContract';

function policy(patch: Partial<ResearchUsePolicy> = {}): ResearchUsePolicy {
  return {
    FACTOR_INPUT: 'DENY', LABEL: 'DENY', RESEARCH_VALUATION: 'DENY',
    UNIVERSE_FILTER: 'DENY', RESEARCH_EXECUTION_MODEL_INPUT: 'DENY',
    JOIN_KEY: 'DENY', DISPLAY: 'ALLOW', QUALITY_CONTROL: 'ALLOW', ...patch,
  };
}

function field(
  fieldId: string,
  logicalType: CanonicalLogicalType,
  patch: Partial<CanonicalFieldDefinition> = {},
): CanonicalFieldDefinition {
  return {
    fieldId, logicalType, unit: 'UNITLESS', meaning: `Canonical meaning for ${fieldId}.`,
    semanticRole: 'MEASURE', nullSemantics: { nullable: false },
    priceSemantics: { kind: 'NOT_PRICE' }, observationSemantics: { kind: 'INSTANT' },
    calendarSemantics: logicalType === 'DATE'
      ? { kind: 'NAMED', timezoneId: 'UTC', calendarId: 'UTC_DAY' }
      : { kind: 'NOT_APPLICABLE' },
    eventTimeRequirement: 'RECORD_EVENT_TIME_SUFFICIENT',
    availabilityRequirement: 'RECORD_AVAILABLE_AT_SUFFICIENT',
    historicalDecisionPolicy: 'REQUIRES_PROVABLE_AVAILABILITY',
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW' }), ...patch,
  };
}

function binding(
  definition: CanonicalFieldDefinition,
  sourcePath: SourcePath = [definition.fieldId],
  patch: Partial<ProviderSourceFieldBinding> = {},
): ProviderSourceFieldBinding {
  return {
    canonicalFieldId: definition.fieldId, sourcePath, mappingKind: 'DIRECT',
    sourceLogicalType: definition.logicalType, sourceUnit: definition.unit,
    sourcePriceSemantics: definition.priceSemantics,
    sourceObservationSemantics: definition.observationSemantics,
    sourcePresence: 'REQUIRED', sourceNullable: false,
    eventTimeBinding: 'RECORD_ENVELOPE', availableAtBinding: 'RECORD_ENVELOPE', ...patch,
  };
}

function manifest(): ProviderManifest {
  return {
    schemaVersion: '1.0.0', manifestVersion: '1.0.0', providerId: 'example-provider',
    adapterId: 'example-adapter', adapterVersion: '1.0.0', dataDomains: ['market-bars'],
    marketScopes: ['global-equities'], transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: { mode: 'EXTERNAL_REFERENCE', credentialReferences: [{ source: 'ENVIRONMENT', reference: 'env:RESEARCH_API_KEY' }] },
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

function representativeTruth() {
  const currency = field('currency', 'STRING', { researchUsePolicy: policy({ JOIN_KEY: 'ALLOW' }) });
  const price = field('price', 'FLOAT64', {
    unit: { kind: 'CURRENCY', currencyFieldId: 'currency' },
    priceSemantics: { kind: 'PRICE', basis: 'RAW', documentedAdjustmentRule: null },
    researchUsePolicy: policy({ FACTOR_INPUT: 'ALLOW', RESEARCH_VALUATION: 'ALLOW' }),
  });
  const missing = field('missing', 'STRING', {
    nullSemantics: { nullable: true, meaning: 'Provider omitted this optional field.' },
    availabilityRequirement: 'UNKNOWN', researchUsePolicy: policy(),
  });
  const nullable = field('nullable', 'STRING', { nullSemantics: { nullable: true, meaning: 'Provider published no value.' } });
  const zero = field('zero', 'INT64');
  const bool = field('bool', 'BOOLEAN');
  const empty = field('empty', 'STRING');
  const decimal = field('decimal', { kind: 'DECIMAL', precision: 8, scale: 2 });
  const documented = field('documented', 'FLOAT64', { availabilityRequirement: 'FIELD_LEVEL_REQUIRED' });
  const fields = [currency, price, missing, nullable, zero, bool, empty, decimal, documented];
  const bindings = [
    binding(currency), binding(price),
    binding(missing, ['missing'], { sourcePresence: 'OPTIONAL', sourceNullable: true, availableAtBinding: 'UNKNOWN' }),
    binding(nullable, ['nullable'], { sourceNullable: true }), binding(zero), binding(bool), binding(empty), binding(decimal),
    binding(documented, ['documented'], {
      availableAtBinding: { kind: 'DOCUMENTED_RULE', rule: 'Published under the provider release calendar.' },
    }),
  ];
  const dictionary: CanonicalFieldDictionary = {
    schemaVersion: '1.0.0', dictionaryId: 'research.pit', dictionaryVersion: '1.0.0',
    dataDomain: 'market-bars', fields, productionAuthority: false,
  };
  const bindingSet: ProviderSourceBindingSet = {
    schemaVersion: '1.0.0', bindingId: 'provider.pit', bindingVersion: '1.0.0',
    providerId: 'example-provider', adapterId: 'example-adapter', sourceDatasetRef: 'source:pit',
    dictionaryId: 'research.pit', dictionaryVersion: '1.0.0', bindings, productionAuthority: false,
  };
  const raw: RawResearchRecord = {
    providerId: 'example-provider', adapterId: 'example-adapter', adapterVersion: '1.0.0',
    sourceDatasetRef: 'source:pit', sourceRecordId: 'record-z',
    eventTime: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-02T00:00:00.000Z',
    availableAtAuthority: 'PROVIDER_FIELD', ingestedAt: '2026-09-01T00:00:00.000Z',
    payload: {
      currency: 'USD', price: 10.5, nullable: null, zero: 0, bool: false, empty: '',
      decimal: '1234.50', documented: 3.25,
      codecEdges: [undefined, -0, Number.NaN, Infinity, -Infinity, 9007199254740993n, { '0': 'object-key' }],
    },
    payloadHash: 'a'.repeat(64), manifestVersion: '1.0.0', manifestReference: 'manifest:example',
    requestId: 'request-1', sourceProvenanceRef: 'provenance:example',
    sourceRevision: { revisionId: 'revision-1', observedAt: '2026-09-01T00:00:00.000Z' },
  };
  const dataset = createCanonicalPointInTimeDataset({ records: [raw], dictionary, bindingSet, manifest: manifest() });
  return { raw, dataset };
}

describe('Phase 9D inert payload codec', () => {
  it('losslessly preserves all bounded inert values and nested numeric-string keys', () => {
    const input = {
      undef: undefined, negativeZero: -0, nan: Number.NaN, positive: Infinity, negative: -Infinity,
      bigint: 9007199254740993n, nested: [null, false, '', 0, { '0': 'object-key' }],
    };
    const decoded = decodeInertPayload(encodeInertPayload(input)) as Record<string, unknown>;
    assert.equal(decoded.undef, undefined);
    assert.ok(Object.is(decoded.negativeZero, -0));
    assert.ok(Number.isNaN(decoded.nan));
    assert.equal(decoded.positive, Infinity);
    assert.equal(decoded.negative, -Infinity);
    assert.equal(decoded.bigint, 9007199254740993n);
    assert.equal(((decoded.nested as unknown[])[4] as Record<string, unknown>)['0'], 'object-key');
    assert.ok(Object.isFrozen(decoded));
  });

  it('encodes objects deterministically while retaining array index semantics', () => {
    assert.equal(canonicalInertPayloadEncoding({ b: 2, a: 1 }), canonicalInertPayloadEncoding({ a: 1, b: 2 }));
    const encoded = encodeInertPayload({ array: ['zero'], object: { '0': 'zero' } });
    const decoded = decodeInertPayload(encoded) as Record<string, unknown>;
    assert.ok(Array.isArray(decoded.array));
    assert.equal(Array.isArray(decoded.object), false);
  });

  it('rejects executable, symbolic, cyclic, accessor, and non-plain values without invoking accessors', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let executions = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get() { executions += 1; return 1; } });
    for (const rejected of [() => 1, Symbol('x'), cycle, accessor, new Date()]) {
      assert.throws(() => encodeInertPayload(rejected), /PHASE_9B_RESEARCH_DICTIONARY_INVALID/);
    }
    assert.equal(executions, 0);
  });
});

describe('Phase 9D durable round trip', () => {
  it('preserves 9A raw, 9B-bound 9C truth and runtime PIT decisions through real Parquet storage', () => {
    const { raw, dataset } = representativeTruth();
    const before = {
      priceVisibility: evaluatePointInTimeVisibility(dataset.records[0].fields[1], '2026-01-02T00:00:00.000Z'),
      priceEligibility: evaluateDecisionInputEligibility(dataset.records[0], 'price', 'FACTOR_INPUT', '2026-01-02T00:00:00.000Z'),
      documentedEligibility: evaluateDecisionInputEligibility(dataset.records[0], 'documented', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z'),
    };
    const interchange = createResearchStorageInterchange([raw], dataset);
    const root = mkdtempSync(join(tmpdir(), 'dsbot-phase9d-'));
    const inputPath = join(root, 'input.json');
    try {
      writeFileSync(inputPath, JSON.stringify(interchange), 'utf8');
      const code = [
        'import json,sys',
        'from quant_engine.research_storage import commit_research_storage_bundle,load_research_storage_bundle',
        'value=json.load(open(sys.argv[2], encoding="utf-8"))',
        'receipt=commit_research_storage_bundle(sys.argv[1], value)',
        'print(json.dumps({"receipt":receipt,"interchange":load_research_storage_bundle(sys.argv[1], receipt["bundleId"])}, separators=(",",":")))',
      ].join(';');
      const result = spawnSync(process.env.PYTHON ?? 'python', ['-c', code, root, inputPath], {
        cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const stored = JSON.parse(result.stdout) as { receipt: { bundleId: string; productionAuthority: boolean }; interchange: unknown };
      assert.match(stored.receipt.bundleId, /^[0-9a-f]{64}$/);
      assert.equal(stored.receipt.productionAuthority, false);
      const restored = restoreCanonicalPointInTimeDataset(stored.interchange);
      const restoredRaw = restoreRawResearchRecords(stored.interchange);
      const after = {
        priceVisibility: evaluatePointInTimeVisibility(restored.records[0].fields[1], '2026-01-02T00:00:00.000Z'),
        priceEligibility: evaluateDecisionInputEligibility(restored.records[0], 'price', 'FACTOR_INPUT', '2026-01-02T00:00:00.000Z'),
        documentedEligibility: evaluateDecisionInputEligibility(restored.records[0], 'documented', 'FACTOR_INPUT', '2026-01-03T00:00:00.000Z'),
      };
      assert.deepEqual(after, before);
      assert.deepEqual(restored.records[0].fields.map((item) => item.presence), dataset.records[0].fields.map((item) => item.presence));
      assert.ok(Object.is((restoredRaw[0].payload as { codecEdges: unknown[] }).codecEdges[1], -0));
      assert.ok(Number.isNaN((restoredRaw[0].payload as { codecEdges: number[] }).codecEdges[2]));
      assert.equal(readdirSync(join(root, stored.receipt.bundleId)).some((name) => name.endsWith('.duckdb') || name.endsWith('.db')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the contract immutable and research-only', () => {
    const { raw, dataset } = representativeTruth();
    const interchange = createResearchStorageInterchange([raw], dataset);
    assert.ok(Object.isFrozen(interchange) && Object.isFrozen(interchange.rawRecords[0]));
    assert.equal(interchange.productionAuthority, false);
    assert.equal(PHASE_9D_RESEARCH_STORAGE_BOUNDARY.productionAuthority, false);
    assert.equal(PHASE_9D_RESEARCH_STORAGE_BOUNDARY.staticPointInTimeEligibility, false);
  });

  it('rejects forged persistent eligibility or other undeclared interchange fields', () => {
    const { raw, dataset } = representativeTruth();
    const interchange = structuredClone(createResearchStorageInterchange([raw], dataset)) as unknown as Record<string, unknown>;
    (interchange.canonicalDataset as Record<string, unknown>).pointInTimeSafe = true;
    assert.throws(() => restoreCanonicalPointInTimeDataset(interchange), /CANONICAL_DATASET_FIELDS/);
  });

  it('contains no production, provider, network, mutable database, or later-phase authority', () => {
    const sourceRoot = join(process.cwd(), 'src', 'research', 'data', 'storage');
    const source = readdirSync(sourceRoot).map((name) => readFileSync(join(sourceRoot, name), 'utf8')).join('\n');
    for (const forbidden of [
      'TradingKernel', 'ProductionSpine', 'PreTradeRiskGateway', 'ResearchDataHub', 'ResearchBacktestKernel',
      'node:http', 'node:https', 'WebSocket', 'fetch(', 'pointInTimeSafe', 'BACKTEST_ELIGIBLE',
      'datasetEligible', 'historicallySafe', 'paperReady', 'testnetReady', 'liveReady',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
