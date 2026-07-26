import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWalkForward, type SimResult } from '../../src/validation/WalkForward';
import type { CostConfig, WalkForwardConfig } from '../../src/validation/ValidationTypes';
import type { StrategyPromotionPolicy } from '../../src/validation/StrategyPromotionGate';
import {
  createPromotionDecisionArtifact,
  PromotionDecisionArtifactStore,
  verifyPromotionDecisionArtifact,
} from '../../src/validation/PromotionDecisionArtifactStore';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const CONFIG: WalkForwardConfig = {
  mode: 'rolling', totalBars: 5_000, trainBars: 500, validationBars: 100, testBars: 100,
  purgeBars: 5, embargoBars: 5, featureLookbackBars: 20, labelHorizonBars: 5,
};
const COST: CostConfig = {
  feeBps: 1, spreadBps: 1, slippageBps: 1, latencyPenaltyBps: 0, stressMultiplier: 1,
};
const POLICY: StrategyPromotionPolicy = {
  minDevelopmentFolds: 1, maxWarnings: 10, maxLimitations: 10,
  minFinalHoldoutTrades: 10, minFinalHoldoutNetReturn: -1_000_000,
  minFinalHoldoutSharpe: 1, maxFinalHoldoutDrawdown: 0.2,
};

function simulator(): SimResult {
  return {
    grossPnl: 1_000, volume: 10_000, turnover: 2, maxDrawdown: 0.1,
    sharpe: 1.5, sortino: 2, profitFactor: 1.4, trades: 20,
  };
}

function report(createdAt = '2026-07-26T00:00:00.000Z') {
  return runWalkForward(CONFIG, COST, simulator, {
    paramGrid: [{ lookback: 20 }, { lookback: 40 }],
    clock: { nowISO: () => createdAt, nowMs: () => 1 },
  });
}

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'clodds-promotion-'));
  dirs.push(dir);
  return { dir, store: new PromotionDecisionArtifactStore({ dir }) };
}

test('1. artifact is deterministic, frozen, and does not freeze caller policy', () => {
  const policy = { ...POLICY };
  const first = createPromotionDecisionArtifact(report(), policy);
  const second = createPromotionDecisionArtifact(report(), { ...POLICY });
  assert.equal(first.artifactId, second.artifactId);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.report));
  assert.ok(Object.isFrozen(first.policy));
  assert.equal(Object.isFrozen(policy), false);
});

test('2. save and load round-trip verified promotion evidence', async () => {
  const target = await store();
  const artifact = createPromotionDecisionArtifact(report(), POLICY);
  await target.store.save(artifact);
  assert.deepStrictEqual(await target.store.load(artifact.decision.decisionId), artifact);
});

test('3. concurrent identical saves are idempotent and leave one artifact', async () => {
  const target = await store();
  const artifact = createPromotionDecisionArtifact(report(), POLICY);
  await Promise.all(Array.from({ length: 12 }, () => target.store.save(artifact)));
  const files = (await readdir(target.dir)).filter(file => file.endsWith('.json'));
  assert.deepStrictEqual(files, [`${artifact.decision.decisionId}.json`]);
  assert.equal((await readdir(target.dir)).some(file => file.endsWith('.tmp')), false);
});

test('4. tampered persisted decision fails closed', async () => {
  const target = await store();
  const artifact = createPromotionDecisionArtifact(report(), POLICY);
  await target.store.save(artifact);
  const filename = join(target.dir, `${artifact.decision.decisionId}.json`);
  const parsed = JSON.parse(await readFile(filename, 'utf8'));
  parsed.decision.status = 'reject';
  await writeFile(filename, JSON.stringify(parsed), 'utf8');
  await assert.rejects(() => target.store.load(artifact.decision.decisionId),
    /PROMOTION_ARTIFACT_INVALID:DECISION_MISMATCH/);
});

test('5. tampered report fails gate re-evaluation or digest verification', () => {
  const parsed = JSON.parse(JSON.stringify(createPromotionDecisionArtifact(report(), POLICY)));
  parsed.report.finalHoldoutEvaluationCount = 0;
  assert.throws(() => verifyPromotionDecisionArtifact(parsed),
    /PROMOTION_ARTIFACT_INVALID:DECISION_MISMATCH/);
});

test('6. missing artifact returns null', async () => {
  const target = await store();
  assert.equal(await target.store.load('a'.repeat(64)), null);
});

test('7. traversal and relative store directories fail closed', async () => {
  assert.throws(() => new PromotionDecisionArtifactStore({ dir: 'relative' }),
    /PROMOTION_ARTIFACT_INVALID:ABSOLUTE_DIRECTORY_REQUIRED/);
  const target = await store();
  await assert.rejects(() => target.store.load('../escape'),
    /PROMOTION_ARTIFACT_INVALID:DECISION_ID/);
});

test('8. malformed JSON fails closed', async () => {
  const target = await store();
  const decisionId = 'b'.repeat(64);
  await writeFile(join(target.dir, `${decisionId}.json`), '{', 'utf8');
  await assert.rejects(() => target.store.load(decisionId),
    /PROMOTION_ARTIFACT_INVALID:INVALID_JSON/);
});

test('9. same decisionId with different evidence cannot overwrite', async () => {
  const target = await store();
  const first = createPromotionDecisionArtifact(report('2026-07-26T00:00:00.000Z'), POLICY);
  const second = createPromotionDecisionArtifact(report('2026-07-26T00:00:01.000Z'), POLICY);
  assert.equal(first.decision.decisionId, second.decision.decisionId);
  assert.notEqual(first.artifactId, second.artifactId);
  await target.store.save(first);
  await assert.rejects(() => target.store.save(second), /PROMOTION_ARTIFACT_COLLISION/);
  assert.equal((await target.store.load(first.decision.decisionId))?.artifactId, first.artifactId);
});

test('10. rejection decisions remain auditable artifacts', () => {
  const artifact = createPromotionDecisionArtifact(report(), { ...POLICY, minFinalHoldoutSharpe: 99 });
  assert.equal(artifact.decision.status, 'reject');
  assert.equal(verifyPromotionDecisionArtifact(artifact).artifactId, artifact.artifactId);
});
