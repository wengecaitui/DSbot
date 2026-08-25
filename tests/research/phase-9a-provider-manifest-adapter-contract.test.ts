import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PHASE_9A_PROVIDER_MANIFEST_BOUNDARY,
  assertExternalReferenceOnlyConfiguration,
  assertProviderManifest,
  type ProviderManifest,
} from '../../src/research/data/ProviderManifestContract';
import {
  FORBIDDEN_RESEARCH_PROVIDER_CAPABILITIES,
  PHASE_9A_PIT_RULE,
  PHASE_9A_RESEARCH_ADAPTER_BOUNDARY,
  assertRawResearchRecord,
  assertResearchFetchRequest,
  assertResearchProviderAdapterSurface,
  fetchOneResearchPage,
  hasProvablePointInTimeVisibility,
  validateAdapterDescription,
  validateResearchProviderConfiguration,
  type RawResearchRecord,
  type ResearchFetchPage,
  type ResearchProviderAdapter,
} from '../../src/research/data/ResearchProviderAdapterContract';

function validManifest(): ProviderManifest {
  return {
    schemaVersion: '1.0.0',
    manifestVersion: '1.0.0',
    providerId: 'example-research-source',
    adapterId: 'example-bounded-reader',
    adapterVersion: '1.0.0',
    dataDomains: ['market-bars', 'reference-data'],
    marketScopes: ['global-equities'],
    transport: { kind: 'request-response', protocol: 'provider-defined' },
    auth: {
      mode: 'EXTERNAL_REFERENCE',
      credentialReferences: [{ source: 'ENVIRONMENT', reference: 'env:RESEARCH_API_KEY' }],
    },
    pagination: {
      mode: 'cursor-or-range',
      boundedPage: true,
      maximumRecordsPerPage: 1_000,
      cursorSupported: true,
    },
    ordering: { guarantee: 'provider-declared', keys: ['event-time', 'source-record-id'] },
    duplicates: { semantics: 'provider-may-repeat', stableSourceRecordId: true },
    rateLimit: { semantics: 'provider-documented', retryAfterSupported: true },
    revisions: { semantics: 'provider-declared', sourceRevisionAvailable: true },
    licensing: {
      redistributionAllowed: false,
      license: 'provider-terms-reference',
      attribution: 'Example Research Source',
    },
    timeSemantics: {
      eventTimeSource: 'provider event timestamp',
      availableAtSource: null,
      availableAtRule: 'provider publication timestamp documented by source',
      availableAtAuthority: 'DOCUMENTED_RULE',
    },
    productionAuthority: false,
  };
}

function validRecord(patch: Partial<RawResearchRecord> = {}): RawResearchRecord {
  return {
    providerId: 'example-research-source',
    adapterId: 'example-bounded-reader',
    adapterVersion: '1.0.0',
    sourceDatasetRef: 'source:daily-bars',
    sourceRecordId: 'record:001',
    eventTime: '2026-01-01T09:30:00.000Z',
    availableAt: '2026-01-01T09:31:00.000Z',
    availableAtAuthority: 'PROVIDER_FIELD',
    ingestedAt: '2026-01-01T09:32:00.000Z',
    payload: { close: 100 },
    payloadHash: 'a'.repeat(64),
    manifestVersion: '1.0.0',
    manifestReference: 'manifest:example-v1',
    requestId: 'request:001',
    sourceProvenanceRef: 'provenance:example-001',
    ...patch,
  };
}

function page(records: readonly RawResearchRecord[] = [validRecord()]): ResearchFetchPage {
  return { records, nextCursor: null, complete: true };
}

function adapter(fetchImpl: ResearchProviderAdapter['fetch'] = async () => page()): ResearchProviderAdapter {
  return {
    describe: validManifest,
    validateConfiguration: () => undefined,
    fetch: fetchImpl,
  };
}

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe('Phase 9A provider manifest and bounded adapter contract', () => {
  it('rejects missing, extra, and invalid manifest fields', () => {
    assert.doesNotThrow(() => assertProviderManifest(validManifest()));
    const missing = clone(validManifest());
    delete missing.providerId;
    assert.throws(() => assertProviderManifest(missing), /PHASE_9A_PROVIDER_MANIFEST_INVALID:ROOT_FIELDS/);
    const extra = clone(validManifest());
    extra.datasetId = 'phase-9c-is-not-here';
    assert.throws(() => assertProviderManifest(extra), /ROOT_FIELDS/);
    const invalid = clone(validManifest());
    invalid.dataDomains = [];
    assert.throws(() => assertProviderManifest(invalid), /DATA_DOMAINS/);
  });

  it('requires productionAuthority to be the literal false', () => {
    for (const value of [true, 'false', null, undefined]) {
      const manifest = clone(validManifest());
      manifest.productionAuthority = value;
      assert.throws(() => assertProviderManifest(manifest), /PRODUCTION_AUTHORITY_MUST_BE_FALSE|ROOT_FIELDS/);
    }
    assert.equal(PHASE_9A_PROVIDER_MANIFEST_BOUNDARY.productionAuthority, false);
    assert.equal(PHASE_9A_PROVIDER_MANIFEST_BOUNDARY.researchDataIsProductionMarketData, false);
  });

  it('allows only external credential references and rejects secret values in manifest or configuration', () => {
    const inline = clone(validManifest());
    inline.auth.credentialReferences[0].reference = 'RESEARCH_SECRET_VALUE';
    assert.throws(() => assertProviderManifest(inline), /AUTH_REFERENCE_VALUE/);

    const injected = clone(validManifest());
    injected.auth.apiKey = 'SUPER_SECRET_VALUE';
    assert.throws(() => assertProviderManifest(injected), /AUTH_FIELDS/);

    assert.doesNotThrow(() => assertExternalReferenceOnlyConfiguration({ apiKey: 'env:RESEARCH_API_KEY' }));
    for (const configuration of [
      { apiKey: 'SUPER_SECRET_VALUE' },
      { nested: { GH_TOKEN: 'ghp_inline_value' } },
      { endpoint: 'Authorization: Bearer SUPER_SECRET_VALUE' },
      { privateKey: '-----BEGIN PRIVATE KEY-----inline' },
    ]) {
      assert.throws(() => assertExternalReferenceOnlyConfiguration(configuration), /INLINE_SECRET/);
    }
  });

  it('rejects literal credentials through generic compound sensitive-key semantics', () => {
    const literalCases: readonly Record<string, string>[] = [
      { credential: 'CREDENTIAL_LITERAL' },
      { credentials: 'CREDENTIALS_LITERAL' },
      { accessToken: 'ACCESS_TOKEN_LITERAL' },
      { access_token: 'ACCESS_TOKEN_LITERAL' },
      { 'access-token': 'ACCESS_TOKEN_LITERAL' },
      { refreshToken: 'REFRESH_TOKEN_LITERAL' },
      { refresh_token: 'REFRESH_TOKEN_LITERAL' },
      { 'refresh-token': 'REFRESH_TOKEN_LITERAL' },
      { clientSecret: 'CLIENT_SECRET_LITERAL' },
      { client_secret: 'CLIENT_SECRET_LITERAL' },
      { 'client-secret': 'CLIENT_SECRET_LITERAL' },
      { dbPassword: 'DB_PASSWORD_LITERAL' },
      { db_password: 'DB_PASSWORD_LITERAL' },
      { 'db-password': 'DB_PASSWORD_LITERAL' },
      { authorizationHeader: 'AUTHORIZATION_HEADER_LITERAL' },
      { authorization_header: 'AUTHORIZATION_HEADER_LITERAL' },
      { 'authorization-header': 'AUTHORIZATION_HEADER_LITERAL' },
    ];
    for (const configuration of literalCases) {
      assert.throws(() => assertExternalReferenceOnlyConfiguration(configuration), /INLINE_SECRET/);
    }

    for (const configuration of [
      { credential: 'env:RESEARCH_API_KEY' },
      { accessToken: 'runtime:research-token' },
      { client_secret: 'secret-manager:provider-key' },
    ]) {
      assert.doesNotThrow(() => assertExternalReferenceOnlyConfiguration(configuration));
    }
    assert.doesNotThrow(() => assertProviderManifest(validManifest()));
  });

  it('allows only the validated manifest auth credentialReferences container', () => {
    assert.doesNotThrow(() => assertProviderManifest(validManifest()));

    for (const configuration of [
      { credentialReferences: 'LITERAL_SECRET' },
      { auth: { credentialReferences: 'LITERAL_SECRET' } },
    ]) {
      assert.throws(() => assertExternalReferenceOnlyConfiguration(configuration), /INLINE_SECRET/);
    }

    assert.throws(
      () => validateResearchProviderConfiguration(adapter(), { credentialReferences: 'LITERAL_SECRET' }),
      /INLINE_SECRET/,
    );
  });

  it('rejects credential-bearing URI userinfo wherever it appears in configuration', () => {
    for (const uri of [
      'postgres://user:password@host/db',
      'mongodb://user:password@host/db',
      'redis://:password@host',
      'https://user:password@host/path',
      'postgres://user@host/db',
    ]) {
      assert.throws(() => assertExternalReferenceOnlyConfiguration({ endpoint: uri }), /INLINE_SECRET/);
    }
  });

  it('rejects symbol-keyed adapter, prototype, and configuration properties', () => {
    const symbolCapability = Object.assign(adapter(), { [Symbol('trade')]: () => undefined });
    assert.throws(
      () => assertResearchProviderAdapterSurface(symbolCapability),
      /ADAPTER_SYMBOL_PROPERTY_FORBIDDEN/,
    );

    const symbolPrototype = { [Symbol('trade')]: () => undefined };
    const prototypeCapability = Object.assign(Object.create(symbolPrototype), adapter());
    assert.throws(
      () => assertResearchProviderAdapterSurface(prototypeCapability),
      /ADAPTER_SYMBOL_PROPERTY_FORBIDDEN/,
    );

    const symbolConfiguration = { endpoint: 'provider-defined', [Symbol('credential')]: 'INLINE_SECRET' };
    assert.throws(
      () => assertExternalReferenceOnlyConfiguration(symbolConfiguration),
      /CONFIGURATION_SYMBOL_PROPERTY/,
    );
  });

  it('requires explicit availableAtAuthority and evidence appropriate to that authority', () => {
    const missing = clone(validManifest());
    delete missing.timeSemantics.availableAtAuthority;
    assert.throws(() => assertProviderManifest(missing), /TIME_SEMANTICS_FIELDS/);

    const providerField = clone(validManifest());
    providerField.timeSemantics.availableAtAuthority = 'PROVIDER_FIELD';
    providerField.timeSemantics.availableAtRule = null;
    providerField.timeSemantics.availableAtSource = null;
    assert.throws(() => assertProviderManifest(providerField), /PROVIDER_FIELD_SOURCE_REQUIRED/);
  });

  it('keeps UNKNOWN authority as raw uncertainty and never turns it into PIT-safe truth', () => {
    const manifest = clone(validManifest());
    manifest.timeSemantics = {
      eventTimeSource: 'provider event timestamp',
      availableAtSource: null,
      availableAtRule: null,
      availableAtAuthority: 'UNKNOWN',
    };
    assert.doesNotThrow(() => assertProviderManifest(manifest));
    const unknown = validRecord({ availableAt: null, availableAtAuthority: 'UNKNOWN' });
    assert.doesNotThrow(() => assertRawResearchRecord(unknown));
    assert.equal(hasProvablePointInTimeVisibility(unknown, '2030-01-01T00:00:00.000Z'), false);
    assert.equal(PHASE_9A_PIT_RULE.unknownAvailableAtAuthorityProvesPointInTimeSafety, false);
    assert.equal(PHASE_9A_PIT_RULE.backtestEligibilityStateImplemented, false);
  });

  it('exposes only describe, validateConfiguration, and one-page fetch', () => {
    assert.doesNotThrow(() => assertResearchProviderAdapterSurface(adapter()));
    assert.deepEqual(Object.keys(adapter()).sort(), ['describe', 'fetch', 'validateConfiguration']);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.statefulLifecycleAllowed, false);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.continuousStreamingAllowed, false);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.pagesPerFetch, 1);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.requestTimeoutMustBeEnforcedByAdapter, true);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.genericTimeoutWrapperImplemented, false);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.transportDeadlineEnforcementDeferredToConcreteAdapter, true);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.ownedIoCancellationMustBeProvenByConcreteAdapter, true);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.abortMustRejectWithoutSuccessfulPartialPage, true);

    const widened = { ...adapter(), trade: () => undefined };
    assert.throws(() => assertResearchProviderAdapterSurface(widened), /ADAPTER_CAPABILITY_FORBIDDEN:trade/);
    const widenedWithData = { ...adapter(), productionEndpoint: 'not-part-of-the-contract' };
    assert.throws(
      () => assertResearchProviderAdapterSurface(widenedWithData),
      /ADAPTER_CAPABILITY_FORBIDDEN:productionEndpoint/,
    );
    assert.ok(FORBIDDEN_RESEARCH_PROVIDER_CAPABILITIES.includes('publishToMarketRuntime'));
    assert.ok(FORBIDDEN_RESEARCH_PROVIDER_CAPABILITIES.includes('setLiveReady'));
  });

  it('requires both record and wall-time bounds on every fetch request', () => {
    const valid = { requestId: 'request:001', limit: 100, timeoutMs: 5_000 };
    assert.doesNotThrow(() => assertResearchFetchRequest(valid));
    assert.throws(() => assertResearchFetchRequest({ requestId: 'request:001', timeoutMs: 5_000 }), /REQUEST_LIMIT/);
    assert.throws(() => assertResearchFetchRequest({ requestId: 'request:001', limit: 100 }), /REQUEST_TIMEOUT/);
    assert.throws(() => assertResearchFetchRequest({ ...valid, limit: Number.MAX_SAFE_INTEGER }), /REQUEST_LIMIT/);
    assert.throws(() => assertResearchFetchRequest({ ...valid, timeoutMs: 0 }), /REQUEST_TIMEOUT/);
    assert.throws(() => assertResearchFetchRequest({
      ...valid,
      range: { startInclusive: '2026-01-02T00:00:00.000Z', endExclusive: '2026-01-01T00:00:00.000Z' },
    }), /REQUEST_RANGE_ORDER/);
  });

  it('binds the request to the manifest page limit and returned provenance', async () => {
    const subject = adapter();
    const signal = new AbortController().signal;
    await assert.rejects(
      fetchOneResearchPage(subject, { requestId: 'request:001', limit: 1_001, timeoutMs: 1_000 }, signal),
      /REQUEST_EXCEEDS_MANIFEST_PAGE_BOUND/,
    );
    await assert.rejects(
      fetchOneResearchPage(
        adapter(async () => page([validRecord({ requestId: 'request:other' })])),
        { requestId: 'request:001', limit: 10, timeoutMs: 1_000 },
        signal,
      ),
      /PAGE_PROVENANCE_MISMATCH/,
    );
  });

  it('makes abort win over a returned partial page', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const partial: ResearchFetchPage = { records: [validRecord()], nextCursor: 'cursor:next', complete: false };
    const pending = fetchOneResearchPage(
      adapter(async () => { await gate; return partial; }),
      { requestId: 'request:001', limit: 10, timeoutMs: 1_000 },
      controller.signal,
    );
    controller.abort(new DOMException('cancelled by test', 'AbortError'));
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  });

  it('rejects an already-aborted fetch without calling the adapter', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already cancelled', 'AbortError'));
    let calls = 0;
    await assert.rejects(
      fetchOneResearchPage(
        adapter(async () => { calls += 1; return page(); }),
        { requestId: 'request:001', limit: 10, timeoutMs: 1_000 },
        controller.signal,
      ),
      /already cancelled/,
    );
    assert.equal(calls, 0);
  });

  it('preserves event, availability, and ingestion time as separate raw facts', () => {
    const record = validRecord();
    assert.doesNotThrow(() => assertRawResearchRecord(record));
    assert.notEqual(record.eventTime, record.availableAt);
    assert.notEqual(record.availableAt, record.ingestedAt);
    assert.equal(hasProvablePointInTimeVisibility(record, '2026-01-01T09:31:00.000Z'), true);
    assert.equal(hasProvablePointInTimeVisibility(record, '2026-01-01T09:30:59.999Z'), false);
    assert.equal(PHASE_9A_PIT_RULE.visibilityRule, 'available_at <= decision_time');
  });

  it('requires provenance, payload digest, and optional source revision without deriving dataset identity', () => {
    const record = validRecord({ sourceRevision: { revisionId: 'revision:7', observedAt: '2026-01-01T09:33:00.000Z' } });
    assert.doesNotThrow(() => assertRawResearchRecord(record));
    assert.equal('datasetId' in record, false);
    assert.equal(record.payloadHash, 'a'.repeat(64));
    const malformed = { ...record, payloadHash: 'not-a-digest' };
    assert.throws(() => assertRawResearchRecord(malformed), /RAW_RECORD_PAYLOAD_HASH/);
  });

  it('makes licensing, ordering, duplicate, rate-limit, and revision semantics explicit', () => {
    const manifest = validManifest();
    assert.doesNotThrow(() => assertProviderManifest(manifest));
    assert.equal(typeof manifest.licensing.redistributionAllowed, 'boolean');
    assert.ok(manifest.licensing.license.length > 0);
    assert.ok(manifest.ordering.guarantee.length > 0);
    assert.ok(manifest.duplicates.semantics.length > 0);
    assert.ok(manifest.rateLimit.semantics.length > 0);
    assert.ok(manifest.revisions.semantics.length > 0);
  });

  it('validates adapter descriptions and configuration without accepting inline credentials', () => {
    const subject = adapter();
    assert.equal(validateAdapterDescription(subject).providerId, validManifest().providerId);
    assert.doesNotThrow(() => validateResearchProviderConfiguration(subject, { token: 'runtime:research-token' }));
    assert.throws(
      () => validateResearchProviderConfiguration(subject, { token: 'inline-token-value' }),
      /INLINE_SECRET/,
    );
  });

  it('contains no imports from production authority or production market-data modules', () => {
    const directory = join(process.cwd(), 'src', 'research', 'data');
    const sources = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    const forbiddenImports = [
      '/runtime/', '/data/', 'TradingKernel', 'ProductionSpine', 'PreTradeRiskGateway',
      '/oms/', '/position/', '/accounting/', '/recovery/', '/reconciliation/', 'LIVE_READY',
    ];
    for (const source of sources) {
      const text = readFileSync(join(directory, source), 'utf8');
      const imports = text.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line)).join('\n');
      for (const forbidden of forbiddenImports) {
        assert.equal(imports.includes(forbidden), false, `${source} imports forbidden authority: ${forbidden}`);
      }
    }
  });

  it('adds no real provider or network implementation', () => {
    const directory = join(process.cwd(), 'src', 'research', 'data');
    const sources = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    assert.deepEqual(sources.sort(), ['ProviderManifestContract.ts', 'ResearchProviderAdapterContract.ts']);
    for (const source of sources) {
      const text = readFileSync(join(directory, source), 'utf8');
      for (const forbidden of ['node:http', 'node:https', 'axios', 'undici', 'WebSocket', 'https://']) {
        assert.equal(text.includes(forbidden), false, `${source} contains network implementation token ${forbidden}`);
      }
    }
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.realProviderImplemented, false);
    assert.equal(PHASE_9A_RESEARCH_ADAPTER_BOUNDARY.networkImplementationAdded, false);
  });
});
