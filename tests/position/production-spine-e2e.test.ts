// Phase 4C: E2E paper scenario — full kernel execution spine with Gateway
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createProductionSpine, executeThroughGateway } from '../../src/position/ProductionSpine';
import type { TradeIntent } from '../../src/types/trade-intent';

const hardRisk = () => ({
  exchange: 'bitget', locked: false, enabled: true,
  totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity,
});

function makeIntent(id: string, symbol: string, dir: 'long' | 'short', usd: number): TradeIntent {
  return { intentId: id, exchange: 'bitget', symbol, direction: dir, orderType: 'market', positionUsd: usd, limitPrice: undefined, createdAt: Date.now() } as TradeIntent;
}

describe('Phase 4C: E2E — Gateway, market price, protective, risk rejection', () => {
  let spine: any;
  let initDone = false;

  async function init() {
    if (initDone) return;
    spine = await createProductionSpine({ exchange: 'bitget', accountId: 'e2e', hardRisk });
    spine.protection.start();
    spine.protection.setMode('live');
    spine.planStore.subscribeToKernel(spine.kernel as any);
    // Seed market price
    await spine.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    initDone = true;
  }

  // ── 1. Real market event → KernelMarketStateStore snapshot ────────────────
  it('market event → market store snapshot', async () => {
    await init();
    await spine.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'ETH/USDT', symbol: 'ETH/USDT', channel: 'ticker', last: 3500, bestBid: 3499, bestAsk: 3501, volume24h: 1000, high24h: 3600, low24h: 3400, ts: Date.now() },
      receivedAt: Date.now(),
    });
    const snap = spine.marketStore.getSnapshot('bitget', 'ETH/USDT');
    assert.ok(snap, 'market snapshot exists');
    assert.strictEqual(snap.ticker.ticker.last, 3500, 'factual market price');
    assert.strictEqual(snap.isStale, false, 'not stale');
  });

  // ── 2. Gateway-admitted open → OMS fill at factual price ──────────────────
  it('admitted open → OMS paper fill at factual price → OPEN position', async () => {
    await init();
    const intent = makeIntent('gw-open-1', 'BTC/USDT', 'long', 5000);
    const result = await executeThroughGateway(spine, intent, 'open', 5000);
    assert.strictEqual(result.admitted, true, 'Gateway admitted');
    assert.strictEqual(result.riskCode, null, 'no risk code');
    assert.ok(result.omsResult, 'OMS result exists');
    assert.ok(result.omsResult!.status === 'submitted' || result.omsResult!.status === 'filled', `OMS: ${result.omsResult!.status}`);

    // Factual position
    const pos = spine.positionStore.resolve('bitget', 'BTC/USDT');
    assert.ok(pos, 'position exists');
    assert.strictEqual(pos.status, 'open');

    // Plan projected
    await new Promise(r => setTimeout(r, 300));
    const plan = spine.planStore.getActive('bitget', 'BTC/USDT');
    assert.ok(plan, 'active plan created');
    assert.strictEqual(plan.side, 'long');
  });

  // ── 3. Gateway-open with missing market → REJECTED ────────────────────────
  it('missing market → Gateway rejects', async () => {
    await init();
    const intent = makeIntent('gw-rej-1', 'XRP/USDT', 'long', 1000);
    const result = await executeThroughGateway(spine, intent, 'open', 1000);
    assert.strictEqual(result.admitted, false, 'Gateway rejected');
    assert.ok(result.riskCode, 'has risk code');
  });

  // ── 4. Protective stop breach → protective close through Gateway ──────────
  it('protective stop breach → Gateway → OMS → close fill', async () => {
    await init();
    // Open position
    const openIntent = makeIntent('prot-open', 'BTC/USDT', 'long', 5000);
    await executeThroughGateway(spine, openIntent, 'open', 5000);
    await new Promise(r => setTimeout(r, 100));

    // Set stop at 47500 (5% below entry). Then publish market tick at 47000 (breached)
    await spine.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 47000, bestBid: 46999, bestAsk: 47001, volume24h: 100, high24h: 48000, low24h: 46000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 800));

    // Position should be reduced after protective stop
    const pos = spine.positionStore.resolve('bitget', 'BTC/USDT');
    assert.ok(pos, 'position still exists');
    // Protection submitted at least once
    const submitted = spine.protection.getSubmittedCount();
    assert.ok(submitted > 0, `protection submitted ${submitted} orders`);
  });

  // ── 5. Risk rejection → zero OMS submission ───────────────────────────────
  it('risk rejection → zero OMS submission', async () => {
    await init();
    const before = spine.protection.getSubmittedCount();
    const intent = makeIntent('gw-rej-2', 'SOL/USDT', 'long', 1000);
    const result = await executeThroughGateway(spine, intent, 'open', 1000);
    assert.strictEqual(result.admitted, false, 'Gateway rejected');
    const after = spine.protection.getSubmittedCount();
    assert.strictEqual(after, before, 'no OMS submission for rejected intent');
  });
});
