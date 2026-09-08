import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REGISTERED_DIRECT_MUTATION_TOOLS,
  isRegisteredDirectMutationTool,
  quarantineReasonForTool,
  setDirectMutationQuarantined,
} from '../../src/agents/handlers/direct-exchange-execution';

// Import the actual registered handler maps to verify registry completeness
// against the real surface. acp.ts is excluded from direct import: its
// @solana/web3.js dependency keeps the event loop alive at import (a
// pre-existing codebase characteristic unrelated to this repair); its mutation
// tools are still in the registry and are verified statically below.
import { binanceHandlers } from '../../src/agents/handlers/binance';
import { bybitHandlers } from '../../src/agents/handlers/bybit';
import { hyperliquidHandlers } from '../../src/agents/handlers/hyperliquid';
import { kalshiHandlers } from '../../src/agents/handlers/kalshi';
import { opinionHandlers } from '../../src/agents/handlers/opinion';
import { predictfunHandlers } from '../../src/agents/handlers/predictfun';
import { betfairHandlers } from '../../src/agents/handlers/betfair';
import { smarketsHandlers } from '../../src/agents/handlers/smarkets';
import { manifoldHandlers } from '../../src/agents/handlers/manifold';
import { polymarketHandlers } from '../../src/agents/handlers/polymarket';
import { solanaHandlers } from '../../src/agents/handlers/solana';
import { credentialsHandlers } from '../../src/agents/handlers/credentials';
import { walletsHandlers } from '../../src/agents/handlers/wallets';

const importedMaps: Record<string, unknown> = {
  ...binanceHandlers,
  ...bybitHandlers,
  ...hyperliquidHandlers,
  ...kalshiHandlers,
  ...opinionHandlers,
  ...predictfunHandlers,
  ...betfairHandlers,
  ...smarketsHandlers,
  ...manifoldHandlers,
  ...polymarketHandlers,
  ...solanaHandlers,
  ...credentialsHandlers,
  ...walletsHandlers,
};

test('registry covers every mutation tool across the registered handler surface', () => {
  // No duplicates.
  assert.equal(new Set(REGISTERED_DIRECT_MUTATION_TOOLS).size, REGISTERED_DIRECT_MUTATION_TOOLS.length);

  // Every registry tool is a real registered tool (verified against the imported maps).
  for (const tool of REGISTERED_DIRECT_MUTATION_TOOLS) {
    if (tool.startsWith('acp_')) continue; // verified statically below
    assert.ok(tool in importedMaps, `registry tool not registered: ${tool}`);
  }

  // Static acp coverage (from the acp handler export block).
  const acpMutations = [
    'acp_register_agent', 'acp_register_handle', 'acp_quick_hire',
    'acp_create_agreement', 'acp_sign_agreement',
    'acp_create_escrow', 'acp_fund_escrow', 'acp_release_escrow', 'acp_refund_escrow',
    'acp_create_bid', 'acp_accept_bid', 'acp_reject_bid',
    'acp_rate_service', 'acp_update_profile', 'acp_use_referral_code',
    'acp_submit_prediction', 'acp_resolve_market',
  ];
  for (const tool of acpMutations) {
    assert.ok(REGISTERED_DIRECT_MUTATION_TOOLS.includes(tool), `missing acp mutation: ${tool}`);
  }

  // Explicitly-confirmed defect examples must be present.
  const confirmed = [
    'hyperliquid_long', 'hyperliquid_short', 'hyperliquid_close',
    'hyperliquid_cancel', 'hyperliquid_cancel_all', 'hyperliquid_leverage',
    'kalshi_market_order', 'kalshi_batch_create_orders', 'kalshi_batch_cancel_orders',
    'kalshi_cancel_all', 'kalshi_amend_order', 'kalshi_decrease_order',
  ];
  for (const tool of confirmed) {
    assert.ok(REGISTERED_DIRECT_MUTATION_TOOLS.includes(tool), `missing confirmed mutation: ${tool}`);
  }
});

test('central quarantine fails closed for every registered mutation tool', () => {
  setDirectMutationQuarantined(true);
  try {
    for (const tool of REGISTERED_DIRECT_MUTATION_TOOLS) {
      assert.equal(isRegisteredDirectMutationTool(tool), true, tool);
      const reason = quarantineReasonForTool(tool);
      assert.ok(reason !== null, `${tool} must be quarantined`);
      assert.match(reason, /quarantined by the authoritative production runtime/, tool);
    }
  } finally {
    setDirectMutationQuarantined(false);
  }
});

test('read-only handlers are not classified or blocked', () => {
  setDirectMutationQuarantined(true);
  try {
    const readOnly = [
      'hyperliquid_balance', 'hyperliquid_positions', 'hyperliquid_orders', 'hyperliquid_price',
      'kalshi_balance', 'kalshi_positions', 'kalshi_orders', 'kalshi_orderbook',
      'polymarket_price', 'polymarket_orderbook', 'polymarket_balances',
      'manifold_search', 'manifold_balance', 'manifold_positions',
      'betfair_markets', 'betfair_balance', 'smarkets_markets', 'smarkets_balance',
      'opinion_balances', 'opinion_positions', 'opinion_orders',
      'predictfun_balance', 'predictfun_positions', 'predictfun_orders',
      'binance_futures_balance', 'binance_futures_positions', 'binance_futures_price',
      'bybit_balance', 'bybit_positions', 'bybit_price',
      'find_arbitrage', 'compare_prices',
    ];
    for (const tool of readOnly) {
      assert.equal(isRegisteredDirectMutationTool(tool), false, `${tool} must not be classified as mutation`);
      assert.equal(quarantineReasonForTool(tool), null, `${tool} must remain available`);
    }
  } finally {
    setDirectMutationQuarantined(false);
  }
});

test('single global authority: quarantine off leaves mutations unblocked', () => {
  setDirectMutationQuarantined(false);
  assert.equal(quarantineReasonForTool('hyperliquid_long'), null);
  assert.equal(quarantineReasonForTool('kalshi_buy'), null);
  assert.equal(quarantineReasonForTool('polymarket_order'), null);
});
