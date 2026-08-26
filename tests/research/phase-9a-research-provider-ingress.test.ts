import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { ProviderManifest } from '../../src/research/data/ProviderManifestContract';
import type {
  RawResearchRecord,
  ResearchFetchPage,
  ResearchFetchRequest,
  ResearchProviderAdapter,
} from '../../src/research/data/ResearchProviderAdapterContract';
import {
  createResearchProviderIngress,
  type ResearchProviderKey,
} from '../../src/research/data/ResearchProviderIngress';

const SRC = join(process.cwd(), 'src');
const INGRESS_SOURCE = join(SRC, 'research', 'data', 'ResearchProviderIngress.ts');

function validManifest(
  providerId = 'example-research-source',
  adapterId = 'example-bounded-reader',
): ProviderManifest {
  return {
    schemaVersion: '1.0.0',
    manifestVersion: '1.0.0',
    providerId,
    adapterId,
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
      maximumRecordsPerPage: 100,
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

function validRecord(manifest: ProviderManifest, requestId: string, payload: unknown = { close: 100 }): RawResearchRecord {
  return {
    providerId: manifest.providerId,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    sourceDatasetRef: 'source:daily-bars',
    sourceRecordId: 'record:001',
    eventTime: '2026-01-01T09:30:00.000Z',
    availableAt: '2026-01-01T09:31:00.000Z',
    availableAtAuthority: 'PROVIDER_FIELD',
    ingestedAt: '2026-01-01T09:32:00.000Z',
    payload,
    payloadHash: 'a'.repeat(64),
    manifestVersion: manifest.manifestVersion,
    manifestReference: 'manifest:example-v1',
    requestId,
    sourceProvenanceRef: 'provenance:example-001',
    sourceRevision: { revisionId: 'revision:1', observedAt: '2026-01-01T09:33:00.000Z' },
  };
}

function completePage(manifest: ProviderManifest, requestId: string, payload?: unknown): ResearchFetchPage {
  return { records: [validRecord(manifest, requestId, payload)], nextCursor: null, complete: true };
}

interface AdapterHarness {
  readonly adapter: ResearchProviderAdapter;
  manifest: ProviderManifest;
  describeCalls: number;
  configurationCalls: number;
  fetchCalls: number;
  lastConfiguration: unknown;
}

function createAdapterHarness(options: {
  manifest?: ProviderManifest;
  maximumDescribeCalls?: number;
  validateConfiguration?: (configuration: unknown) => void;
  fetch?: (
    request: ResearchFetchRequest,
    signal: AbortSignal,
    harness: AdapterHarness,
  ) => Promise<ResearchFetchPage>;
} = {}): AdapterHarness {
  const harness = {} as AdapterHarness;
  Object.assign(harness, {
    manifest: options.manifest ?? validManifest(),
    describeCalls: 0,
    configurationCalls: 0,
    fetchCalls: 0,
    lastConfiguration: undefined,
  });
  const adapter: ResearchProviderAdapter = {
    describe(): ProviderManifest {
      harness.describeCalls += 1;
      if (options.maximumDescribeCalls !== undefined && harness.describeCalls > options.maximumDescribeCalls) {
        throw new Error('REAL_DESCRIBE_CALLED_TOO_MANY_TIMES');
      }
      return harness.manifest;
    },
    validateConfiguration(configuration: unknown): void {
      harness.configurationCalls += 1;
      harness.lastConfiguration = configuration;
      options.validateConfiguration?.(configuration);
    },
    async fetch(request: ResearchFetchRequest, signal: AbortSignal): Promise<ResearchFetchPage> {
      harness.fetchCalls += 1;
      if (options.fetch !== undefined) return options.fetch(request, signal, harness);
      return completePage(harness.manifest, request.requestId);
    },
  };
  Object.assign(harness, { adapter });
  return harness;
}

function key(manifest: ProviderManifest): ResearchProviderKey {
  return { providerId: manifest.providerId, adapterId: manifest.adapterId };
}

function request(requestId = 'request:001'): ResearchFetchRequest {
  return { requestId, limit: 10, timeoutMs: 1_000 };
}

function registration(harness: AdapterHarness, configuration: unknown = { accessToken: 'runtime:token-ref' }) {
  return { adapter: harness.adapter, configuration };
}

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function importedModules(path: string): readonly string[] {
  const modules: string[] = [];
  const source = parseSource(path);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return modules;
}

function hasRuntimeFetchHelperImport(path: string): boolean {
  const source = parseSource(path);
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.includes('ResearchProviderAdapterContract')
      && node.importClause !== undefined
      && !node.importClause.isTypeOnly
    ) {
      const bindings = node.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        found ||= bindings.elements.some((element) => (
          !element.isTypeOnly
          && (element.propertyName?.text ?? element.name.text) === 'fetchOneResearchPage'
        ));
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        const namespace = bindings.name.text;
        function findNamespaceUse(candidate: ts.Node): void {
          if (
            ts.isPropertyAccessExpression(candidate)
            && ts.isIdentifier(candidate.expression)
            && candidate.expression.text === namespace
            && candidate.name.text === 'fetchOneResearchPage'
          ) found = true;
          ts.forEachChild(candidate, findNamespaceUse);
        }
        findNamespaceUse(source);
      }
    }
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text.includes('ResearchProviderAdapterContract')
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) found = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe('Phase 9A internal ResearchProviderIngress', () => {
  it('accepts one valid registration and exposes a credential-reference-free descriptor', () => {
    const harness = createAdapterHarness();
    const ingress = createResearchProviderIngress([registration(harness)]);
    const descriptor = ingress.describe(key(harness.manifest));
    assert.equal(descriptor.providerId, harness.manifest.providerId);
    assert.equal(descriptor.manifest.auth.mode, 'EXTERNAL_REFERENCE');
    assert.equal(descriptor.manifest.auth.credentialReferenceCount, 1);
    assert.equal('credentialReferences' in descriptor.manifest.auth, false);
    assert.equal(JSON.stringify(descriptor).includes('RESEARCH_API_KEY'), false);
  });

  it('rejects invalid adapter surface and invalid manifest during construction', () => {
    const malformedAdapter = {
      describe: () => validManifest(),
      validateConfiguration: () => undefined,
    } as unknown as ResearchProviderAdapter;
    assert.throws(
      () => createResearchProviderIngress([{ adapter: malformedAdapter, configuration: {} }]),
      /ADAPTER_METHOD_REQUIRED:fetch/,
    );

    const invalidManifest = validManifest();
    (invalidManifest as { providerId: string }).providerId = '';
    const harness = createAdapterHarness({ manifest: invalidManifest });
    assert.throws(() => createResearchProviderIngress([registration(harness)]), /PROVIDER_ID/);
  });

  it('rejects sparse manifest arrays during construction', () => {
    const manifest = validManifest();
    (manifest as { dataDomains: string[] }).dataDomains = new Array(1);
    const harness = createAdapterHarness({ manifest });
    assert.throws(
      () => createResearchProviderIngress([registration(harness)]),
      /SNAPSHOT:\$\.dataDomains_ARRAY_HOLE/,
    );
    assert.equal(harness.describeCalls, 1);
    assert.equal(harness.configurationCalls, 0);
  });

  it('cannot publish a phantom credentialReferenceCount from sparse references', () => {
    const manifest = validManifest();
    (manifest.auth as { credentialReferences: unknown[] }).credentialReferences = new Array(1);
    const harness = createAdapterHarness({ manifest });
    assert.throws(
      () => createResearchProviderIngress([registration(harness)]),
      /SNAPSHOT:\$\.auth\.credentialReferences_ARRAY_HOLE/,
    );
  });

  it('rejects accessor-backed array elements before structuredClone can erase the accessor', () => {
    const manifest = validManifest();
    const domains = ['market-bars'];
    let accessorCalls = 0;
    Object.defineProperty(domains, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'market-bars';
      },
    });
    (manifest as { dataDomains: string[] }).dataDomains = domains;
    const harness = createAdapterHarness({ manifest });
    assert.throws(
      () => createResearchProviderIngress([registration(harness)]),
      /SNAPSHOT:\$\.dataDomains_ARRAY_ACCESSOR/,
    );
    assert.equal(accessorCalls, 0, 'descriptor gate must not execute adapter-owned accessors');
  });

  it('rejects accessor-backed adapter-owned manifest state without a validation-to-pin read gap', () => {
    const manifest = validManifest();
    let accessorCalls = 0;
    Object.defineProperty(manifest.pagination, 'maximumRecordsPerPage', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return accessorCalls === 1 ? 100 : 1;
      },
    });
    const harness = createAdapterHarness({ manifest });
    assert.throws(
      () => createResearchProviderIngress([registration(harness)]),
      /SNAPSHOT_ACCESSOR:\$\.pagination\.maximumRecordsPerPage/,
    );
    assert.equal(accessorCalls, 0, 'fail-closed inspection must not sample a mutable accessor');
  });

  it('rejects inline-secret configuration before registration', () => {
    const harness = createAdapterHarness();
    assert.throws(
      () => createResearchProviderIngress([registration(harness, { clientSecret: 'LITERAL_SECRET' })]),
      /INLINE_SECRET/,
    );
    assert.equal(harness.configurationCalls, 0, 'contract rejects secret before delegating to adapter');
  });

  it('fails closed on duplicate structural identity after validating both registrations', () => {
    const first = createAdapterHarness();
    const second = createAdapterHarness();
    assert.throws(
      () => createResearchProviderIngress([registration(first), registration(second)]),
      /RESEARCH_PROVIDER_DUPLICATE/,
    );
    assert.equal(first.configurationCalls, 1);
    assert.equal(second.configurationCalls, 1);
  });

  it('keeps delimiter-collision identities structurally distinct', () => {
    const first = createAdapterHarness({ manifest: validManifest('a:b', 'c') });
    const second = createAdapterHarness({ manifest: validManifest('a', 'b:c') });
    const ingress = createResearchProviderIngress([registration(first), registration(second)]);
    assert.equal(ingress.describe({ providerId: 'a:b', adapterId: 'c' }).providerId, 'a:b');
    assert.equal(ingress.describe({ providerId: 'a', adapterId: 'b:c' }).adapterId, 'b:c');
    assert.equal(ingress.list().length, 2);
  });

  it('allows one provider to register multiple distinct adapters', () => {
    const first = createAdapterHarness({ manifest: validManifest('provider', 'adapter-a') });
    const second = createAdapterHarness({ manifest: validManifest('provider', 'adapter-b') });
    const ingress = createResearchProviderIngress([registration(first), registration(second)]);
    assert.deepEqual(ingress.list().map((item) => item.adapterId), ['adapter-a', 'adapter-b']);
  });

  it('exposes exactly list, describe, and fetchPage with no registry mutation or lifecycle surface', () => {
    const ingress = createResearchProviderIngress([]);
    assert.deepEqual(Object.keys(ingress).sort(), ['describe', 'fetchPage', 'list']);
    for (const forbidden of [
      'register', 'unregister', 'replace', 'reload', 'start', 'stop', 'health',
      'stream', 'subscribe', 'fetchAll', 'adapter', 'getAdapter', 'configuration', 'registry',
    ]) {
      assert.equal(forbidden in ingress, false, forbidden);
    }
    assert.equal(Object.isFrozen(ingress), true);
  });

  it('does not expose or retain configuration through public state', () => {
    const harness = createAdapterHarness();
    const configuration = { accessToken: 'runtime:token-ref' };
    const ingress = createResearchProviderIngress([registration(harness, configuration)]);
    assert.strictEqual(harness.lastConfiguration, configuration);
    assert.equal((ingress as unknown as Record<string, unknown>).configuration, undefined);
    assert.equal((ingress as unknown as Record<string, unknown>).adapter, undefined);
    assert.equal((ingress as unknown as Record<string, unknown>).registry, undefined);
    assert.equal(JSON.stringify(ingress.list()).includes('runtime:token-ref'), false);
  });

  it('fails closed for unknown describe and fetch without defaulting', async () => {
    const ingress = createResearchProviderIngress([]);
    const missing = { providerId: 'missing', adapterId: 'missing' };
    assert.throws(() => ingress.describe(missing), /RESEARCH_PROVIDER_NOT_FOUND/);
    await assert.rejects(
      ingress.fetchPage(missing, request(), new AbortController().signal),
      /RESEARCH_PROVIDER_NOT_FOUND/,
    );
  });

  it('pins a defensive full-manifest clone instead of freezing adapter-owned state', () => {
    const harness = createAdapterHarness();
    const original = harness.manifest;
    const ingress = createResearchProviderIngress([registration(harness)]);
    assert.equal(Object.isFrozen(original), false);
    (original.pagination as { maximumRecordsPerPage: number }).maximumRecordsPerPage = 50;
    assert.equal(ingress.describe(key(original)).manifest.pagination.maximumRecordsPerPage, 100);
  });

  it('validates, freezes, and pins the same defensive manifest snapshot', () => {
    const source = readFileSync(INGRESS_SOURCE, 'utf8');
    const cloneAt = source.indexOf('const snapshot = structuredClone(rawManifest);');
    const validateAt = source.indexOf('assertProviderManifest(snapshot);', cloneAt);
    const returnAt = source.indexOf('return snapshot;', validateAt);
    const pinAt = source.indexOf('const pinnedManifest = deepFreeze(describedManifest);', returnAt);
    assert.ok(cloneAt >= 0, 'raw manifest is defensively snapshotted');
    assert.ok(validateAt > cloneAt, 'semantic validation observes the defensive snapshot');
    assert.ok(returnAt > validateAt, 'the validated snapshot is returned unchanged');
    assert.ok(pinAt > returnAt, 'registration freezes the exact returned snapshot');
    assert.equal(source.includes('deepFreeze(cloneManifest(describedManifest))'), false);
  });

  it('returns deeply frozen list and describe views that cannot mutate pinned truth', () => {
    const harness = createAdapterHarness();
    const ingress = createResearchProviderIngress([registration(harness)]);
    const listed = ingress.list();
    const described = ingress.describe(key(harness.manifest));
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(described), true);
    assert.equal(Object.isFrozen(described.manifest.pagination), true);
    try {
      (described.manifest.pagination as { maximumRecordsPerPage: number }).maximumRecordsPerPage = 1;
    } catch {
      // Strict runtimes throw; non-strict runtimes silently reject the frozen write.
    }
    assert.equal(described.manifest.pagination.maximumRecordsPerPage, 100);
    assert.equal(ingress.describe(key(harness.manifest)).manifest.pagination.maximumRecordsPerPage, 100);
  });

  it('rejects availableAt semantic drift before raw fetch', async () => {
    const harness = createAdapterHarness();
    const registeredKey = key(harness.manifest);
    const ingress = createResearchProviderIngress([registration(harness)]);
    const changed = structuredClone(harness.manifest);
    (changed.timeSemantics as { availableAtRule: string | null }).availableAtRule = 'changed publication rule';
    harness.manifest = changed;
    await assert.rejects(
      ingress.fetchPage(registeredKey, request(), new AbortController().signal),
      /RESEARCH_PROVIDER_MANIFEST_DRIFT/,
    );
    assert.equal(harness.fetchCalls, 0);
  });

  it('rejects pagination-bound drift before raw fetch', async () => {
    const harness = createAdapterHarness();
    const registeredKey = key(harness.manifest);
    const ingress = createResearchProviderIngress([registration(harness)]);
    const changed = structuredClone(harness.manifest);
    (changed.pagination as { maximumRecordsPerPage: number }).maximumRecordsPerPage = 99;
    harness.manifest = changed;
    await assert.rejects(
      ingress.fetchPage(registeredKey, request(), new AbortController().signal),
      /RESEARCH_PROVIDER_MANIFEST_DRIFT/,
    );
    assert.equal(harness.fetchCalls, 0);
  });

  it('rejects licensing, revision, transport, ordering, duplicate, rate-limit, and auth drift', async () => {
    const mutations: Array<(manifest: ProviderManifest) => void> = [
      (manifest) => { (manifest.licensing as { license: string }).license = 'changed-license'; },
      (manifest) => { (manifest.revisions as { semantics: string }).semantics = 'changed-revisions'; },
      (manifest) => { (manifest.transport as { protocol: string }).protocol = 'changed-protocol'; },
      (manifest) => { (manifest.ordering as { guarantee: string }).guarantee = 'changed-ordering'; },
      (manifest) => { (manifest.duplicates as { semantics: string }).semantics = 'changed-duplicates'; },
      (manifest) => { (manifest.rateLimit as { semantics: string }).semantics = 'changed-rate-limit'; },
      (manifest) => {
        (manifest.auth.credentialReferences[0] as { reference: string }).reference = 'env:OTHER_RESEARCH_KEY';
      },
    ];
    for (const mutate of mutations) {
      const harness = createAdapterHarness();
      const registeredKey = key(harness.manifest);
      const ingress = createResearchProviderIngress([registration(harness)]);
      const changed = structuredClone(harness.manifest);
      mutate(changed);
      harness.manifest = changed;
      await assert.rejects(
        ingress.fetchPage(registeredKey, request(), new AbortController().signal),
        /RESEARCH_PROVIDER_MANIFEST_DRIFT/,
      );
      assert.equal(harness.fetchCalls, 0);
    }
  });

  it('calls the real adapter describe and fetch exactly once per fetchPage', async () => {
    const harness = createAdapterHarness();
    const ingress = createResearchProviderIngress([registration(harness)]);
    assert.equal(harness.describeCalls, 1, 'one registration observation');
    await ingress.fetchPage(key(harness.manifest), request('request:001'), new AbortController().signal);
    assert.equal(harness.describeCalls, 2, 'one real fetch observation');
    assert.equal(harness.fetchCalls, 1);
    await ingress.fetchPage(key(harness.manifest), request('request:002'), new AbortController().signal);
    assert.equal(harness.describeCalls, 3);
    assert.equal(harness.fetchCalls, 2);
  });

  it('runs the contract helper against the pinned guarded facade, not a second real describe', async () => {
    const harness = createAdapterHarness({ maximumDescribeCalls: 2 });
    const ingress = createResearchProviderIngress([registration(harness)]);
    await ingress.fetchPage(key(harness.manifest), request(), new AbortController().signal);
    assert.equal(harness.describeCalls, 2, 'registration plus exactly one fetch observation');
    assert.equal(harness.fetchCalls, 1);
  });

  it('retains contract request bounds and returned provenance enforcement', async () => {
    const bounded = createAdapterHarness();
    const boundedIngress = createResearchProviderIngress([registration(bounded)]);
    await assert.rejects(
      boundedIngress.fetchPage(
        key(bounded.manifest),
        { requestId: 'request:001', limit: 101, timeoutMs: 1_000 },
        new AbortController().signal,
      ),
      /REQUEST_EXCEEDS_MANIFEST_PAGE_BOUND/,
    );
    assert.equal(bounded.fetchCalls, 0);

    const wrongProvenance = createAdapterHarness({
      fetch: async (fetchRequest, _signal, harness) => completePage(harness.manifest, `${fetchRequest.requestId}:wrong`),
    });
    const provenanceIngress = createResearchProviderIngress([registration(wrongProvenance)]);
    await assert.rejects(
      provenanceIngress.fetchPage(key(wrongProvenance.manifest), request(), new AbortController().signal),
      /PAGE_PROVENANCE_MISMATCH/,
    );
    assert.equal(wrongProvenance.fetchCalls, 1);
  });

  it('preserves already-aborted and in-flight AbortError identity', async () => {
    const already = createAdapterHarness();
    const alreadyIngress = createResearchProviderIngress([registration(already)]);
    const alreadyController = new AbortController();
    const alreadyReason = new DOMException('already cancelled', 'AbortError');
    alreadyController.abort(alreadyReason);
    await assert.rejects(
      alreadyIngress.fetchPage(key(already.manifest), request(), alreadyController.signal),
      (error: unknown) => error === alreadyReason,
    );
    assert.equal(already.fetchCalls, 0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pendingHarness = createAdapterHarness({
      fetch: async (fetchRequest, _signal, harness) => {
        await gate;
        return completePage(harness.manifest, fetchRequest.requestId);
      },
    });
    const pendingIngress = createResearchProviderIngress([registration(pendingHarness)]);
    const controller = new AbortController();
    const pending = pendingIngress.fetchPage(key(pendingHarness.manifest), request(), controller.signal);
    const reason = new DOMException('cancelled in flight', 'AbortError');
    controller.abort(reason);
    release();
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(pendingHarness.fetchCalls, 1);
  });

  it('preserves provider error identity and performs no retry, empty fallback, or provider fallback', async () => {
    const cause = new Error('provider cause');
    const providerError = Object.assign(new Error('rate limited'), {
      code: 'RATE_LIMIT',
      retryAfter: 30,
      cause,
    });
    const failing = createAdapterHarness({ fetch: async () => { throw providerError; } });
    const fallback = createAdapterHarness({ manifest: validManifest('fallback', 'adapter') });
    const ingress = createResearchProviderIngress([registration(failing), registration(fallback)]);
    await assert.rejects(
      ingress.fetchPage(key(failing.manifest), request(), new AbortController().signal),
      (error: unknown) => error === providerError,
    );
    assert.equal(failing.fetchCalls, 1);
    assert.equal(fallback.fetchCalls, 0);
    assert.strictEqual(providerError.cause, cause);
  });

  it('returns one incomplete page without automatic pagination or prefetch', async () => {
    const harness = createAdapterHarness({
      fetch: async (fetchRequest, _signal, subject) => ({
        records: [validRecord(subject.manifest, fetchRequest.requestId)],
        nextCursor: 'cursor:next',
        complete: false,
      }),
    });
    const ingress = createResearchProviderIngress([registration(harness)]);
    const result = await ingress.fetchPage(key(harness.manifest), request(), new AbortController().signal);
    assert.equal(result.nextCursor, 'cursor:next');
    assert.equal(result.complete, false);
    assert.equal(harness.fetchCalls, 1);
  });

  it('protects page and record envelopes while leaving opaque payload uninterpreted', async () => {
    const payload = { providerOwned: true };
    let rawPage!: ResearchFetchPage;
    const harness = createAdapterHarness({
      fetch: async (fetchRequest, _signal, subject) => {
        rawPage = completePage(subject.manifest, fetchRequest.requestId, payload);
        return rawPage;
      },
    });
    const ingress = createResearchProviderIngress([registration(harness)]);
    const result = await ingress.fetchPage(key(harness.manifest), request(), new AbortController().signal);
    assert.notStrictEqual(result, rawPage);
    assert.notStrictEqual(result.records, rawPage.records);
    assert.notStrictEqual(result.records[0], rawPage.records[0]);
    assert.strictEqual(result.records[0].payload, payload);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.records), true);
    assert.equal(Object.isFrozen(result.records[0]), true);
    assert.equal(Object.isFrozen(result.records[0].sourceRevision), true);
    payload.providerOwned = false;
    assert.equal((result.records[0].payload as { providerOwned: boolean }).providerOwned, false);
  });

  it('contains no lifecycle, timer, Promise.race, network, storage, or provider implementation', () => {
    const ingress = createResearchProviderIngress([]);
    const source = readFileSync(INGRESS_SOURCE, 'utf8');
    const imports = importedModules(INGRESS_SOURCE);
    assert.deepEqual(Object.keys(ingress).sort(), ['describe', 'fetchPage', 'list']);
    assert.equal(source.includes('Promise.race'), false);
    assert.equal(source.includes('process.env'), false);
    for (const forbidden of [
      'node:http', 'node:https', 'node:fs', 'node:child_process', 'axios', 'undici',
      'WebSocket', 'setTimeout', 'setInterval', 'queueMicrotask',
    ]) {
      assert.equal(imports.includes(forbidden) || source.includes(`${forbidden}(`), false, forbidden);
    }
  });

  it('has zero current runtime direct-fetch bypass outside the contract and ingress', () => {
    const allowed = new Set([
      join(SRC, 'research', 'data', 'ResearchProviderAdapterContract.ts'),
      INGRESS_SOURCE,
    ]);
    const bypasses = sourceFiles(SRC)
      .filter((path) => !allowed.has(path))
      .filter(hasRuntimeFetchHelperImport)
      .map((path) => relative(SRC, path));
    assert.deepEqual(bypasses, []);
  });

  it('has no current downstream ResearchProviderIngress consumer', () => {
    const consumers = sourceFiles(SRC)
      .filter((path) => path !== INGRESS_SOURCE)
      .filter((path) => importedModules(path).some((module) => module.includes('ResearchProviderIngress')))
      .map((path) => relative(SRC, path));
    assert.deepEqual(consumers, []);
  });

  it('imports no production market-data or trading authority', () => {
    const imports = importedModules(INGRESS_SOURCE).sort();
    assert.deepEqual(imports, [
      './ProviderManifestContract',
      './ResearchProviderAdapterContract',
      'node:util',
    ]);
    const forbidden = [
      '/data/', 'TradingKernel', 'OMS', 'PreTradeRiskGateway', 'ProductionSpine',
      'Position', 'Accounting', 'Recovery', 'Reconciliation', 'LIVE_READY',
      '/gateway/', '/runtime/production',
    ];
    for (const authority of forbidden) {
      assert.equal(imports.some((module) => module.includes(authority)), false, authority);
    }
  });
});
