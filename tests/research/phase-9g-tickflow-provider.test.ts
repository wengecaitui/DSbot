import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assertProviderManifest, type ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import {
  assertRawResearchRecord,
  hasProvablePointInTimeVisibility,
  type ResearchFetchRequest,
  type ResearchProviderAdapter,
} from '../../src/research/data/ResearchProviderAdapterContract';
import { createResearchProviderIngress } from '../../src/research/data/ResearchProviderIngress';
import {
  TICKFLOW_FREE_ORIGIN,
  TICKFLOW_KLINE_PATH,
  TICKFLOW_MAX_RESPONSE_BYTES,
  TICKFLOW_PROVIDER_MANIFEST,
  createTickFlowHistoricalKlineAdapter,
} from '../../src/research/data/providers/tickflow/TickFlowHistoricalKlineAdapter';
import { TICKFLOW_QUALIFICATION } from '../../src/research/data/providers/tickflow/TickFlowQualification';

const ROOT = process.cwd();
const ADAPTER_SOURCE = join(
  ROOT, 'src', 'research', 'data', 'providers', 'tickflow', 'TickFlowHistoricalKlineAdapter.ts',
);
const QUALIFICATION_SOURCE = join(
  ROOT, 'src', 'research', 'data', 'providers', 'tickflow', 'TickFlowQualification.ts',
);
const SYMBOL = '600000.SH';
const T0 = Date.UTC(2026, 0, 2);
const T1 = Date.UTC(2026, 0, 3);
const INGESTED = '2026-01-04T00:00:00.000Z';

interface FetchObservation {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

function compact(timestamps: readonly number[] = [T0, T1]): Record<string, unknown> {
  return {
    timestamp: [...timestamps],
    open: timestamps.map((_value, index) => 10 + index),
    high: timestamps.map((_value, index) => 12 + index),
    low: timestamps.map((_value, index) => 9 + index),
    close: timestamps.map((_value, index) => 11 + index),
    volume: timestamps.map((_value, index) => 1_000 + index),
    amount: timestamps.map((_value, index) => 10_500 + index),
    prev_close: timestamps.map((_value, index) => 9.5 + index),
  };
}

function body(data: Record<string, unknown> = compact()): string {
  return JSON.stringify({ data });
}

function response(
  responseBody: BodyInit | null = body(),
  status = 200,
  url = `${TICKFLOW_FREE_ORIGIN}${TICKFLOW_KLINE_PATH}?symbol=${SYMBOL}`,
  headers?: HeadersInit,
): Response {
  const value = new Response(responseBody, { status, headers });
  Object.defineProperty(value, 'url', { configurable: true, value: url });
  return value;
}

function request(patch: Partial<ResearchFetchRequest> = {}): ResearchFetchRequest {
  return {
    requestId: 'request:tickflow:001',
    limit: 2,
    timeoutMs: 1_000,
    ...patch,
  };
}

function transport(
  factory: (input: string, init: RequestInit | undefined) => Promise<Response> | Response,
  observations: FetchObservation[] = [],
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const observed = { input: String(input), init };
    observations.push(observed);
    return factory(observed.input, init);
  }) as typeof globalThis.fetch;
}

function adapter(
  fetchImplementation: typeof globalThis.fetch,
  now: () => string = () => INGESTED,
): ResearchProviderAdapter {
  return createTickFlowHistoricalKlineAdapter(
    { symbol: SYMBOL },
    { fetch: fetchImplementation, now },
  );
}

function ingress(subject: ResearchProviderAdapter) {
  return createResearchProviderIngress([{
    adapter: subject,
    configuration: { symbol: SYMBOL },
  }]);
}

const KEY = Object.freeze({
  providerId: 'tickflow',
  adapterId: 'tickflow-historical-kline-v1',
});

describe('Phase 9G TickFlow manifest and qualification boundary', () => {
  it('publishes one conservative immutable provider manifest and qualification declaration', () => {
    assert.doesNotThrow(() => assertProviderManifest(TICKFLOW_PROVIDER_MANIFEST));
    assert.deepEqual(TICKFLOW_PROVIDER_MANIFEST.auth, { mode: 'NONE', credentialReferences: [] });
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.pagination.maximumRecordsPerPage, 10_000);
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.pagination.cursorSupported, false);
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.licensing.redistributionAllowed, false);
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.revisions.sourceRevisionAvailable, false);
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.timeSemantics.availableAtAuthority, 'UNKNOWN');
    assert.equal(TICKFLOW_PROVIDER_MANIFEST.productionAuthority, false);
    assert.equal(Object.isFrozen(TICKFLOW_PROVIDER_MANIFEST.timeSemantics), true);

    assert.deepEqual(TICKFLOW_QUALIFICATION, {
      phase: '9G',
      qualificationScope: 'RESEARCH_INGESTION_ONLY',
      provider: 'tickflow',
      adapter: 'tickflow-historical-kline-v1',
      dataset: 'historical-raw-1d-klines',
      marketScope: 'CN-SH-SZ-BJ-6digit-symbols',
      instrumentClassVerified: false,
      period: '1d',
      adjust: 'none',
      productionAuthority: false,
      pitAuthority: false,
      storageAuthority: false,
      backtestAuthority: false,
    });
    assert.equal(Object.isFrozen(TICKFLOW_QUALIFICATION), true);
    for (const claim of ['verified', 'safe', 'productionReady', 'backtestReady']) {
      assert.equal(claim in TICKFLOW_QUALIFICATION, false);
    }
  });

  it('exposes exactly the existing three-method adapter surface', () => {
    const subject = adapter(transport(() => response()));
    assert.deepEqual(Object.keys(subject).sort(), ['describe', 'fetch', 'validateConfiguration']);
    for (const capability of ['start', 'stream', 'subscribe', 'registry', 'fetchAll', 'publish']) {
      assert.equal(capability in subject, false, capability);
    }
  });

  it('keeps manifest scope equal to the accepted six-digit SH/SZ/BJ symbol syntax', () => {
    const subject = adapter(transport(() => response()));
    assert.deepEqual(subject.describe().marketScopes, ['CN-SH-SZ-BJ-6digit-symbols']);
    assert.equal(TICKFLOW_QUALIFICATION.marketScope, subject.describe().marketScopes[0]);
    assert.equal(TICKFLOW_QUALIFICATION.instrumentClassVerified, false);
    for (const symbol of ['600000.SH', '510300.SH', '159915.SZ', '000001.SH', '430047.BJ']) {
      const candidate = createTickFlowHistoricalKlineAdapter(
        { symbol },
        { fetch: transport(() => response()) },
      );
      assert.doesNotThrow(() => candidate.validateConfiguration({ symbol }));
    }
    for (const symbol of ['AAPL.US', '00700.HK', '600000', 'ABC.SH']) {
      assert.throws(
        () => createTickFlowHistoricalKlineAdapter(
          { symbol },
          { fetch: transport(() => response()) },
        ),
        /CONFIGURATION_SYMBOL/,
      );
    }
    for (const invalid of [
      { symbol: '600000.SH', adjust: 'forward' },
      { symbol: '600000.SH', period: '1m' },
      { symbol: '600000.SH', baseUrl: 'https://example.test' },
    ]) {
      assert.throws(() => subject.validateConfiguration(invalid), /PHASE_9G_TICKFLOW_INVALID/);
    }
    assert.throws(
      () => createResearchProviderIngress([{ adapter: subject, configuration: { symbol: '000001.SZ' } }]),
      /CONFIGURATION_MISMATCH/,
    );
  });
});

describe('Phase 9G TickFlow bounded mapping', () => {
  it('uses the existing ingress and maps one valid compact page to valid raw records', async () => {
    const observations: FetchObservation[] = [];
    const providerIngress = ingress(adapter(transport(() => response(), observations)));
    const page = await providerIngress.fetchPage(KEY, request(), new AbortController().signal);

    assert.equal(providerIngress.list().length, 1);
    assert.equal(providerIngress.describe(KEY).manifest.providerId, 'tickflow');
    assert.equal(page.complete, true);
    assert.equal(page.nextCursor, null);
    assert.equal(page.records.length, 2);
    page.records.forEach(assertRawResearchRecord);
    assert.equal(page.records[0].eventTime, new Date(T0).toISOString());
    assert.equal(page.records[0].availableAt, null);
    assert.equal(page.records[0].availableAtAuthority, 'UNKNOWN');
    assert.equal(page.records[0].ingestedAt, INGESTED);
    assert.equal(hasProvablePointInTimeVisibility(page.records[0], '2099-01-01T00:00:00.000Z'), false);
    assert.equal(page.records[0].sourceRevision, undefined);
    assert.deepEqual(page.records[0].payload, {
      symbol: SYMBOL, period: '1d', adjust: 'none', timestamp: T0,
      open: 10, high: 12, low: 9, close: 11, volume: 1_000, amount: 10_500, prev_close: 9.5,
    });

    assert.equal(observations.length, 1);
    const requested = new URL(observations[0].input);
    assert.equal(requested.origin, TICKFLOW_FREE_ORIGIN);
    assert.equal(requested.pathname, TICKFLOW_KLINE_PATH);
    assert.deepEqual(Object.fromEntries(requested.searchParams), {
      symbol: SYMBOL, period: '1d', count: '2', adjust: 'none',
    });
    assert.equal(observations[0].init?.redirect, 'manual');
    assert.equal(new Headers(observations[0].init?.headers).has('x-api-key'), false);
  });

  it('derives stable record identity and adapter-observed content digest from bar content', async () => {
    let acquisitions = 0;
    const subject = ingress(adapter(
      transport(() => response()),
      () => acquisitions++ === 0 ? INGESTED : '2026-01-05T00:00:00.000Z',
    ));
    const first = await subject.fetchPage(KEY, request({ requestId: 'request:tickflow:first' }), new AbortController().signal);
    const second = await subject.fetchPage(KEY, request({ requestId: 'request:tickflow:second' }), new AbortController().signal);
    assert.equal(first.records[0].sourceRecordId, second.records[0].sourceRecordId);
    assert.equal(first.records[0].payloadHash, second.records[0].payloadHash);
    assert.notEqual(first.records[0].sourceProvenanceRef, second.records[0].sourceProvenanceRef);
    assert.notEqual(first.records[0].ingestedAt, second.records[0].ingestedAt);
    assert.match(first.records[0].payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(first.records[0].sourceRecordId, `tickflow:${SYMBOL}:1d:none:${T0}`);
  });

  it('rejects over-count and structurally or relationally inconsistent compact columns', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [];
    const overCount = compact([T0, T1, Date.UTC(2026, 0, 4)]);
    cases.push([overCount, /RESPONSE_RECORD_LIMIT/]);
    const missing = compact();
    delete missing.amount;
    cases.push([missing, /RESPONSE_AMOUNT/]);
    const mismatch = compact();
    mismatch.close = [11];
    cases.push([mismatch, /RESPONSE_COLUMN_LENGTH/]);
    const badRelation = compact();
    badRelation.high = [8, 13];
    cases.push([badRelation, /RESPONSE_OHLC_RELATION/]);
    const badVolume = compact();
    badVolume.volume = [1.5, 2];
    cases.push([badVolume, /RESPONSE_VOLUME/]);
    const duplicate = compact([T0, T0]);
    cases.push([duplicate, /RESPONSE_DUPLICATE_TIMESTAMP/]);

    for (const [data, expected] of cases) {
      const subject = ingress(adapter(transport(() => response(body(data)))));
      await assert.rejects(subject.fetchPage(KEY, request(), new AbortController().signal), expected);
    }
    const subject = ingress(adapter(transport(() => response())));
    await assert.rejects(
      subject.fetchPage(KEY, request({ limit: 10_001 }), new AbortController().signal),
      /REQUEST_LIMIT|REQUEST_EXCEEDS_MANIFEST_PAGE_BOUND/,
    );
  });

  it('rejects declared and streamed response bodies above the fixed byte bound', async () => {
    const declared = ingress(adapter(transport(() => response(
      '{}', 200, `${TICKFLOW_FREE_ORIGIN}${TICKFLOW_KLINE_PATH}`, {
        'content-length': String(TICKFLOW_MAX_RESPONSE_BYTES + 1),
      },
    ))));
    await assert.rejects(
      declared.fetchPage(KEY, request(), new AbortController().signal),
      /RESPONSE_TOO_LARGE/,
    );

    const streamed = ingress(adapter(transport(() => response(
      'x'.repeat(TICKFLOW_MAX_RESPONSE_BYTES + 1),
    ))));
    await assert.rejects(
      streamed.fetchPage(KEY, request(), new AbortController().signal),
      /RESPONSE_TOO_LARGE/,
    );
  });

  it('rejects cursor and range instead of inferring provider-side range semantics', async () => {
    const subject = ingress(adapter(transport(() => response())));
    await assert.rejects(
      subject.fetchPage(KEY, request({ cursor: 'cursor:one' }), new AbortController().signal),
      /CURSOR_UNSUPPORTED/,
    );
    await assert.rejects(
      subject.fetchPage(KEY, request({
        range: {
          startInclusive: '2026-01-01T00:00:00.000Z',
          endExclusive: '2026-02-01T00:00:00.000Z',
        },
      }), new AbortController().signal),
      /RANGE_UNSUPPORTED/,
    );
  });
});

describe('Phase 9G TickFlow transport boundaries', () => {
  it('rejects bounded HTTP failures without publishing remote bodies', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const subject = ingress(adapter(transport(() => response('REMOTE_RESPONSE_DETAIL', status))));
      await assert.rejects(
        subject.fetchPage(KEY, request(), new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`HTTP_${status}`));
          assert.equal(error.message.includes('REMOTE_RESPONSE_DETAIL'), false);
          return true;
        },
      );
    }
  });

  it('rejects redirect responses and any response attributed to another origin', async () => {
    const redirect = ingress(adapter(transport(() => response('', 302))));
    await assert.rejects(
      redirect.fetchPage(KEY, request(), new AbortController().signal),
      /REDIRECT_REJECTED/,
    );
    const otherOrigin = ingress(adapter(transport(() => response(body(), 200, 'https://example.test/v1/klines'))));
    await assert.rejects(
      otherOrigin.fetchPage(KEY, request(), new AbortController().signal),
      /REDIRECT_REJECTED/,
    );
  });

  it('enforces the request timeout even when an injected transport does not settle', async () => {
    const never = transport(() => new Promise<Response>(() => undefined));
    const subject = ingress(adapter(never));
    await assert.rejects(
      subject.fetchPage(KEY, request({ timeoutMs: 10 }), new AbortController().signal),
      /REQUEST_TIMEOUT/,
    );
  });

  it('makes caller abort win without returning a successful partial page', async () => {
    const never = transport(() => new Promise<Response>(() => undefined));
    const subject = ingress(adapter(never));
    const controller = new AbortController();
    const pending = subject.fetchPage(KEY, request(), controller.signal);
    const reason = new DOMException('caller cancelled', 'AbortError');
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
  });

  it('retains existing ingress manifest-drift rejection before provider fetch', async () => {
    const concrete = adapter(transport(() => response()));
    let manifest: ProviderManifest = structuredClone(concrete.describe());
    let fetchCalls = 0;
    const driftable: ResearchProviderAdapter = Object.freeze({
      describe: () => manifest,
      validateConfiguration: (configuration) => concrete.validateConfiguration(configuration),
      fetch: async (fetchRequest, signal) => {
        fetchCalls += 1;
        return concrete.fetch(fetchRequest, signal);
      },
    });
    const subject = ingress(driftable);
    manifest = structuredClone(manifest);
    (manifest.pagination as { maximumRecordsPerPage: number }).maximumRecordsPerPage = 9_999;
    await assert.rejects(
      subject.fetchPage(KEY, request(), new AbortController().signal),
      /RESEARCH_PROVIDER_MANIFEST_DRIFT/,
    );
    assert.equal(fetchCalls, 0);
  });
});

describe('Phase 9G TickFlow authority boundary', () => {
  it('contains network I/O only in the provider adapter and no downstream authority imports', () => {
    const adapterSource = readFileSync(ADAPTER_SOURCE, 'utf8');
    const qualificationSource = readFileSync(QUALIFICATION_SOURCE, 'utf8');
    assert.equal(adapterSource.includes('globalThis.fetch'), true);
    assert.equal(qualificationSource.includes('fetch('), false);
    const legacyClassScope = ['CN', 'equities'].join('-');
    const legacyClassPattern = ['CN', 'EQUITY', 'SYMBOL'].join('_');
    assert.equal(adapterSource.includes(legacyClassScope), false);
    assert.equal(adapterSource.includes(legacyClassPattern), false);
    assert.equal(qualificationSource.includes(legacyClassScope), false);
    for (const forbidden of [
      'MarketDataRuntime', 'TradingKernel', 'ProductionSpine', 'PreTradeRiskGateway',
      'ResearchDataHub', 'ResearchDatasetVersionCatalog', 'node:fs', 'node:child_process',
      'submitOrder', 'LIVE_READY',
    ]) {
      assert.equal(adapterSource.includes(forbidden), false, forbidden);
      assert.equal(qualificationSource.includes(forbidden), false, forbidden);
    }
  });
});
