import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { errorResult, safeHandler } from '../../src/agents/handlers/types';
import { bittensorHandlers, setBittensorService } from '../../src/agents/handlers/bittensor';
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
  ...bittensorHandlers,
};

const agentSource = ts.createSourceFile('agents/index.ts',
  readFileSync('src/agents/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const inlineNames = new Set<string>();
function collectCases(node: ts.Node): void {
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) inlineNames.add(node.expression.text);
  ts.forEachChild(node, collectCases);
}
const executeDeclaration = agentSource.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'executeTool',
)!;
assert.ok(executeDeclaration);
collectCases(executeDeclaration);

// Execute the complete production function, including its switch and fallback.
// Only dependencies are substituted. This avoids booting unrelated SDKs/agents;
// no guard or switch is recreated in the test harness.
function productionFunction(path: string, name: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `${path}: ${name}`);
  const output = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(`${output}\n${name}`, { exports: {}, ...dependencies }) as
    (name: string, input: Record<string, unknown>, context: any) => Promise<string | null>;
}

// Explicit reviewed regression fixtures, independent of production classification.
const reviewedMutations = `
binance_futures_long binance_futures_short binance_futures_close bybit_long bybit_short bybit_close
hyperliquid_long hyperliquid_short hyperliquid_close hyperliquid_cancel hyperliquid_cancel_all hyperliquid_leverage
kalshi_buy kalshi_sell kalshi_cancel kalshi_cancel_all kalshi_market_order
kalshi_batch_create_orders kalshi_batch_cancel_orders kalshi_amend_order kalshi_decrease_order
kalshi_create_order_group kalshi_delete_order_group kalshi_order_group_limit kalshi_order_group_trigger kalshi_order_group_reset
kalshi_create_subaccount kalshi_subaccount_transfer kalshi_create_api_key kalshi_delete_api_key
kalshi_create_rfq kalshi_cancel_rfq kalshi_create_quote kalshi_cancel_quote kalshi_accept_quote kalshi_confirm_quote
opinion_place_order opinion_cancel_order opinion_cancel_all_orders opinion_redeem opinion_enable_trading opinion_split opinion_merge
predictfun_create_order predictfun_cancel_orders predictfun_redeem_positions predictfun_merge_positions predictfun_set_approvals
betfair_back betfair_lay betfair_cancel betfair_cancel_all smarkets_buy smarkets_sell smarkets_cancel smarkets_cancel_all
manifold_bet manifold_sell manifold_multi_bet manifold_multiple_choice manifold_cancel manifold_create_market
manifold_close_market manifold_resolve_market manifold_add_liquidity manifold_send_mana manifold_add_bounty
manifold_award_bounty manifold_add_answer manifold_create_comment manifold_manage_topic
polymarket_order solana_jupiter_swap solana_auto_swap solana_auto_route
drift_direct_place_order drift_direct_cancel_order drift_direct_modify_order drift_direct_set_leverage
pumpfun_trade pumpfun_create pumpfun_claim pumpfun_ipfs_upload bags_swap bags_launch bags_claim bags_partner_claim
swarm_buy swarm_sell swarm_enable swarm_disable swarm_refresh swarm_preset_save swarm_preset_delete
acp_register_agent acp_register_handle acp_quick_hire acp_create_agreement acp_sign_agreement
acp_create_escrow acp_fund_escrow acp_release_escrow acp_refund_escrow acp_create_bid acp_accept_bid acp_reject_bid
acp_rate_service acp_update_profile acp_use_referral_code acp_submit_prediction acp_resolve_market
setup_polymarket_credentials setup_kalshi_credentials setup_manifold_credentials delete_trading_credentials
enable_auto_copy disable_auto_copy
raydium_swap orca_whirlpool_swap meteora_dlmm_swap
mexc_long mexc_short mexc_close copy_trade execute_arbitrage
polymarket_buy polymarket_sell polymarket_cancel polymarket_cancel_all
polymarket_market_buy polymarket_market_sell polymarket_maker_buy polymarket_maker_sell
polymarket_cancel_market polymarket_post_orders_batch polymarket_cancel_orders_batch
polymarket_create_api_key polymarket_derive_api_key polymarket_delete_api_key
polymarket_create_readonly_api_key polymarket_delete_readonly_api_key
polymarket_update_balance_allowance polymarket_drop_notifications
opinion_place_orders_batch opinion_cancel_orders_batch
drift_place_order drift_cancel_order drift_cancel_all_orders drift_leverage drift_modify_order drift_cancel_and_place
solana_jupiter_limit_order_create solana_jupiter_limit_order_cancel
solana_jupiter_dca_create solana_jupiter_dca_close solana_jupiter_dca_deposit solana_jupiter_dca_withdraw
raydium_clmm_create_position raydium_clmm_increase_liquidity raydium_clmm_decrease_liquidity
raydium_clmm_close_position raydium_clmm_harvest raydium_clmm_swap raydium_clmm_create_pool
raydium_amm_add_liquidity raydium_amm_remove_liquidity
orca_open_full_range_position orca_open_concentrated_position orca_increase_liquidity
orca_decrease_liquidity orca_harvest_position orca_close_position orca_create_pool orca_harvest_all_positions
meteora_dlmm_swap_exact_out meteora_dlmm_swap_with_price_impact meteora_dlmm_open_position
meteora_dlmm_create_empty_position meteora_dlmm_add_liquidity meteora_dlmm_remove_liquidity
meteora_dlmm_close_position meteora_dlmm_create_pool meteora_dlmm_claim_fees
meteora_dlmm_claim_rewards meteora_dlmm_claim_all meteora_dlmm_claim_all_fees
bags_fee_config bags_partner_config acp_list_service bittensor
evm_swap wormhole_bridge wormhole_redeem usdc_bridge usdc_bridge_auto
setup_binance_credentials setup_bybit_credentials setup_hyperliquid_credentials setup_mexc_credentials
setup_betfair_credentials setup_drift_credentials setup_smarkets_credentials setup_opinion_credentials
setup_virtuals_credentials setup_hedgehog_credentials setup_predictfun_credentials
`.trim().split(/\s+/);

test('registry covers every mutation tool across the registered handler surface', () => {
  // No duplicates.
  assert.equal(new Set(REGISTERED_DIRECT_MUTATION_TOOLS).size, REGISTERED_DIRECT_MUTATION_TOOLS.length);

  // Every registry tool is a real registered tool (verified against the imported maps).
  for (const tool of REGISTERED_DIRECT_MUTATION_TOOLS) {
    if (tool.startsWith('acp_')) continue; // verified statically below
    assert.ok(tool in importedMaps || inlineNames.has(tool), `registry tool not registered: ${tool}`);
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
  for (const tool of reviewedMutations) {
    assert.ok(REGISTERED_DIRECT_MUTATION_TOOLS.includes(tool), `missing reviewed mutation: ${tool}`);
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

test('actual Agent executor rejects every reviewed mutation before context or credentials are read', async () => {
  let contextReads = 0;
  const context = new Proxy({}, { get() { contextReads++; throw new Error('context must remain inert'); } });
  const execute = productionFunction('src/agents/index.ts', 'executeTool', { quarantineReasonForTool });
  setDirectMutationQuarantined(true);
  try {
    for (const name of new Set([...REGISTERED_DIRECT_MUTATION_TOOLS, ...reviewedMutations])) {
      const result = await execute(name, { action: 'register', set_leverage: 2 }, context);
      assert.match(JSON.parse(result!).error, /quarantined/, name);
    }
    assert.equal(contextReads, 0);
  } finally {
    setDirectMutationQuarantined(false);
  }
});

test('inline MEXC, Polymarket, copy and arbitrage bodies remain unentered with available fake dependencies', async () => {
  const calls = { mexc: 0, fetch: 0, execution: 0, credentials: 0, wallet: 0, swap: 0 };
  const mutate = async () => { calls.execution++; return {}; };
  const fakeCredentials = { platform: 'polymarket' };
  const context = {
    session: { userId: 'fixture', id: 'fixture' },
    db: { logMexcFuturesTrade() {} },
    credentials: { async markSuccess() {} },
    tradingContext: {
      credentials: { get() { calls.credentials++; return fakeCredentials; } },
      executionService: { buyLimit: mutate, sellLimit: mutate },
    },
  };
  const fetchFixture = async (_context: unknown, url: string) => {
    calls.fetch++;
    return { ok: true, async json() {
      if (url.includes('/trades?')) return [{ id: 'fixture', size: '2', price: '0.4', side: 'BUY', asset_id: 'yes' }];
      if (url.includes('/markets/')) return { tokens: [
        { outcome: 'Yes', token_id: 'yes' }, { outcome: 'No', token_id: 'no' },
      ] };
      if (url.includes('/book?')) return { asks: [{ price: '0.4' }] };
      return [];
    } };
  };
  const dependencies = {
    quarantineReasonForTool,
    logger: { error() {} },
    process: { env: { MEXC_API_KEY: 'fixture', MEXC_API_SECRET: 'fixture' } },
    mexc: Object.fromEntries(['openLong', 'openShort', 'closePosition'].map(name =>
      [name, async () => { calls.mexc++; return { orderId: 'fixture' }; }])),
    fetch: fetchFixture, fetchPolymarketClob: fetchFixture,
    loadSolanaKeypair() { calls.wallet++; return {}; },
    getSolanaConnection() { return {}; },
    executeRaydiumSwap: async () => { calls.swap++; return {}; },
    executeOrcaWhirlpoolSwap: async () => { calls.swap++; return {}; },
    executeMeteoraDlmmSwap: async () => { calls.swap++; return {}; },
  };
  const execute = productionFunction('src/agents/index.ts', 'executeTool', dependencies);
  const input = { address: 'fixture', trade_id: 'fixture', market_id: 'fixture', symbol: 'BTC_USDT', vol: 1 };
  setDirectMutationQuarantined(true);
  try {
    for (const name of reviewedMutations.filter(name =>
      name.startsWith('polymarket_') || name.startsWith('mexc_') ||
      ['copy_trade', 'execute_arbitrage', 'raydium_swap', 'orca_whirlpool_swap', 'meteora_dlmm_swap'].includes(name))) {
      assert.match(JSON.parse((await execute(name, input, context))!).error, /quarantined/, name);
    }
    assert.deepEqual(calls, { mexc: 0, fetch: 0, execution: 0, credentials: 0, wallet: 0, swap: 0 });
  } finally {
    setDirectMutationQuarantined(false);
  }
  // Positive controls prove the harness reaches real switch bodies when allowed.
  await execute('mexc_long', input, context);
  await execute('polymarket_delete_api_key', input, context);
  await execute('copy_trade', input, context);
  await execute('execute_arbitrage', input, context);
  await execute('raydium_swap', input, context);
  assert.equal(calls.mexc, 1);
  assert.equal(calls.fetch, 5);
  assert.equal(calls.execution, 3);
  assert.equal(calls.credentials, 2);
  assert.equal(calls.wallet, 1);
  assert.equal(calls.swap, 1);
});

test('modular dispatch preserves previously classified exchange mutation non-entry', async () => {
  const dispatch = productionFunction('src/agents/handlers/index.ts', 'dispatchHandler', {
    allHandlers: importedMaps, quarantineReasonForTool, errorResult,
  });
  let reads = 0;
  const context = new Proxy({}, { get() { reads++; throw new Error('unexpected dependency access'); } });
  setDirectMutationQuarantined(true);
  try {
    for (const name of REGISTERED_DIRECT_MUTATION_TOOLS.filter(name => name in importedMaps)) {
      assert.match(JSON.parse((await dispatch(name, { action: 'register' }, context))!).error, /quarantined/, name);
    }
    assert.equal(reads, 0);
  } finally {
    setDirectMutationQuarantined(false);
  }
});

test('actual modular Solana dispatch fails before SDK loading and swap calls', async () => {
  let moduleLoads = 0;
  let walletReads = 0;
  let swaps = 0;
  const sdk = {
    loadSolanaKeypair() { walletReads++; return {}; }, getSolanaConnection() { return {}; },
    executeRaydiumSwap: async () => { swaps++; return {}; },
    executeOrcaWhirlpoolSwap: async () => { swaps++; return {}; },
    executeMeteoraDlmmSwap: async () => { swaps++; return {}; },
  };
  const exports: Record<string, any> = {};
  const source = ts.transpileModule(readFileSync('src/agents/handlers/solana.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(source, { exports, require(name: string) {
    if (name === './types') return { safeHandler };
    assert.ok(name.startsWith('../../solana/'), name);
    moduleLoads++;
    return sdk;
  } });
  const dispatch = productionFunction('src/agents/handlers/index.ts', 'dispatchHandler', {
    allHandlers: exports.solanaHandlers, quarantineReasonForTool, errorResult,
  });
  const names = ['raydium_swap', 'orca_whirlpool_swap', 'meteora_dlmm_swap', 'bags_fee_config', 'bags_partner_config'];
  setDirectMutationQuarantined(true);
  try {
    for (const name of names) assert.match(JSON.parse((await dispatch(name, {}, {}))!).error, /quarantined/, name);
    assert.equal(moduleLoads, 0);
    assert.equal(walletReads, 0);
    assert.equal(swaps, 0);
  } finally {
    setDirectMutationQuarantined(false);
  }
  for (const name of names.slice(0, 3)) await dispatch(name, {}, {});
  assert.ok(moduleLoads > 0);
  assert.equal(walletReads, 3);
  assert.equal(swaps, 3);
});

test('mixed tools preserve queries and reject wallet registration or leverage writes', async () => {
  let registrations = 0;
  let starts = 0;
  let queries = 0;
  const fakeService = {
    async registerOnSubnet() { registrations++; return {}; },
    async startMining() { starts++; return {}; },
    async getStatus() { queries++; return { connected: false }; },
  };
  setBittensorService(fakeService as any);
  const dispatch = productionFunction('src/agents/handlers/index.ts', 'dispatchHandler', {
    allHandlers: bittensorHandlers, quarantineReasonForTool, errorResult,
  });
  const methods: string[] = [];
  const execute = productionFunction('src/agents/index.ts', 'executeTool', {
    quarantineReasonForTool, dispatchHandler: dispatch, hasHandler: (name: string) => name in bittensorHandlers,
    logger: { error() {} },
    async driftGatewayRequest(method: string) { methods.push(method); return { leverage: 1 }; },
  });
  const context = { session: { userId: 'fixture', id: 'fixture' } };
  setDirectMutationQuarantined(true);
  try {
    for (const runner of [execute, dispatch]) {
      for (const action of ['register', 'start', 'unknown']) {
        assert.match(JSON.parse((await runner('bittensor', { action, subnetId: 1 }, context))!).error, /quarantined/);
      }
      const status = await runner('bittensor', { action: 'status' }, context);
      assert.equal(JSON.parse(status!).result.connected, false);
    }
    assert.equal(queries, 2);
    assert.equal(registrations, 0);
    assert.equal(starts, 0);
    assert.equal(JSON.parse((await execute('drift_leverage', {}, context))!).leverage, 1);
    assert.match(JSON.parse((await execute('drift_leverage', { set_leverage: 2 }, context))!).error, /quarantined/);
    assert.deepEqual(methods, ['GET']);
  } finally {
    setDirectMutationQuarantined(false);
    setBittensorService(null);
  }
});

test('read-only inline queries and ordinary local operations still enter their handlers', async () => {
  const calls: string[] = [];
  const context = {
    session: { userId: 'fixture' },
    db: { query() { calls.push('local-query'); return []; } },
    feeds: { async searchMarkets() { calls.push('markets'); return []; } },
  };
  const execute = productionFunction('src/agents/index.ts', 'executeTool', {
    quarantineReasonForTool, logger: { error() {} },
    process: { env: { MEXC_API_KEY: 'fixture', MEXC_API_SECRET: 'fixture' } },
    mexc: { async getPrice() { calls.push('price'); return 1; } },
    async fetchPolymarketClob() { calls.push('orders'); return { async json() { return []; } }; },
  });
  setDirectMutationQuarantined(true);
  try {
    for (const name of ['search_markets', 'mexc_price', 'polymarket_get_order', 'list_auto_copy']) {
      const result = JSON.parse((await execute(name, { query: 'fixture', order_id: 'fixture' }, context))!);
      assert.equal(result.error, undefined, name);
    }
    assert.deepEqual(calls, ['markets', 'price', 'orders', 'local-query']);
    for (const name of ['mexc_balance', 'mexc_positions', 'mexc_orders', 'mexc_funding',
      'polymarket_positions', 'polymarket_balance', 'polymarket_orders', 'polymarket_get_api_keys',
      'polymarket_midpoints_batch', 'kalshi_live_data_batch', 'solana_jupiter_limit_order_history',
      'raydium_quote', 'orca_whirlpool_quote', 'meteora_dlmm_quote', 'kalshi_exchange_status',
      'create_alert', 'git_commit', 'edit_message', 'qmd_update', 'add_position']) {
      assert.equal(quarantineReasonForTool(name), null, name);
    }
  } finally {
    setDirectMutationQuarantined(false);
  }
});
