// Phase 4C: E2E paper scenario — full kernel execution spine with Gateway
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createProductionSpine, executeThroughGateway, trustBaseline } from '../../src/position/ProductionSpine';
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
    // Establish trusted baseline (required before first trade)
    trustBaseline(spine, 'bitget', 'BTC/USDT');
    trustBaseline(spine, 'bitget', 'ETH/USDT');
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
  it('protective stop breach → factual fill at breached price → position reduced', async () => {
    // Fresh spine — avoid shared state pollution from test 2
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'prot-e2e', hardRisk });
    s.protection.start();
    s.protection.setMode('live');
    s.planStore.subscribeToKernel(s.kernel as any);
    trustBaseline(s, 'bitget', 'BTC/USDT');
    await s.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });

    // Open position
    const openIntent = makeIntent('prot-open', 'BTC/USDT', 'long', 5000);
    await executeThroughGateway(s, openIntent, 'open', 5000);
    await new Promise(r => setTimeout(r, 200));

    const before = s.positionStore.resolve('bitget', 'BTC/USDT');
    const beforeQty = before?.signedQuantity ?? 0;
    assert.ok(beforeQty > 0, `position open before breach: qty=${beforeQty}`);

    // Capture protective fill price from kernel events
    let protectiveFillPrice: number | null = null;
    s.kernel.subscribe('execution.fill.confirmed', (e: any) => {
      const fill = e.payload?.fill;
      if (fill?.side === 'sell') protectiveFillPrice = fill.price;
    });

    // Breach stop at 47000 (entry at 50000, stop at 47500 → 47000 < 47500 breached)
    await s.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 47000, bestBid: 46999, bestAsk: 47001, volume24h: 100, high24h: 48000, low24h: 46000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 1500));

    const after = s.positionStore.resolve('bitget', 'BTC/USDT');
    const afterQty = after?.signedQuantity ?? 0;
    assert.ok(afterQty < beforeQty, `position reduced: ${beforeQty} → ${afterQty}`);

    // Unconditional: protective fill executed at factual breached price
    assert.strictEqual(protectiveFillPrice, 47000, `protective fill price = ${protectiveFillPrice}, expected 47000`);
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

  // ── 6. Trusted baseline required for first trade ──────────────────────────
  it('missing position without trusted baseline → Gateway rejects', async () => {
    await init();
    // Do NOT trust baseline for SOL/USDT → position is missing
    const intent = makeIntent('gw-no-baseline', 'SOL/USDT', 'long', 1000);
    const result = await executeThroughGateway(spine, intent, 'open', 1000);
    assert.strictEqual(result.admitted, false, 'missing position rejected');
    assert.ok(result.riskCode, 'has risk code');
  });
});
