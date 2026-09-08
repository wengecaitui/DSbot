/**
 * Central quarantine for legacy mutation surfaces that do not route through
 * the authoritative ProductionSpine -> PreTradeRiskGateway -> OMS path.
 *
 * The application ProductionRuntimeOwner establishes this state. Handlers and
 * skills only query it, before reading credentials or constructing clients.
 *
 * `REGISTERED_DIRECT_MUTATION_TOOLS` is the single source of truth for every
 * mutation-capable tool name across modular handlers and the inline Agent
 * switch. Both dispatch guards consult it so a mutation is quarantined
 * the moment its tool name is added here — no per-handler repetition required.
 */

export const DIRECT_MUTATION_SURFACES = Object.freeze([
  'binance',
  'bybit',
  'hyperliquid',
  'kalshi',
  'opinion',
  'predictfun',
  'betfair',
  'smarkets',
  'manifold',
  'polymarket',
  'solana',
  'acp',
  'credentials',
  'wallets',
  'trading-futures',
] as const);

export type DirectMutationSurface = typeof DIRECT_MUTATION_SURFACES[number];

/**
 * Every registered tool name that performs an authenticated write to external
 * exchange / wallet / betting / escrow / prediction / credential state.
 * Read-only market/account/orderbook/price/position/balance/events/search
 * queries are intentionally absent.
 */
export const REGISTERED_DIRECT_MUTATION_TOOLS: readonly string[] = Object.freeze([
  // binance / bybit (CEX futures)
  'binance_futures_long', 'binance_futures_short', 'binance_futures_close',
  'bybit_long', 'bybit_short', 'bybit_close',
  'mexc_long', 'mexc_short', 'mexc_close',

  // hyperliquid (perps)
  'hyperliquid_long', 'hyperliquid_short', 'hyperliquid_close',
  'hyperliquid_cancel', 'hyperliquid_cancel_all', 'hyperliquid_leverage',

  // kalshi (event contracts)
  'kalshi_buy', 'kalshi_sell', 'kalshi_cancel', 'kalshi_cancel_all',
  'kalshi_market_order', 'kalshi_batch_create_orders', 'kalshi_batch_cancel_orders',
  'kalshi_amend_order', 'kalshi_decrease_order',
  'kalshi_create_order_group', 'kalshi_delete_order_group',
  'kalshi_order_group_limit', 'kalshi_order_group_trigger', 'kalshi_order_group_reset',
  'kalshi_create_subaccount', 'kalshi_subaccount_transfer',
  'kalshi_create_api_key', 'kalshi_delete_api_key',
  'kalshi_create_rfq', 'kalshi_cancel_rfq',
  'kalshi_create_quote', 'kalshi_cancel_quote', 'kalshi_accept_quote', 'kalshi_confirm_quote',

  // opinion (prediction market)
  'opinion_place_order', 'opinion_cancel_order', 'opinion_cancel_all_orders',
  'opinion_redeem', 'opinion_enable_trading', 'opinion_split', 'opinion_merge',
  'opinion_place_orders_batch', 'opinion_cancel_orders_batch',

  // predictfun (prediction market)
  'predictfun_create_order', 'predictfun_cancel_orders',
  'predictfun_redeem_positions', 'predictfun_merge_positions', 'predictfun_set_approvals',

  // betfair / smarkets (exchange betting)
  'betfair_back', 'betfair_lay', 'betfair_cancel', 'betfair_cancel_all',
  'smarkets_buy', 'smarkets_sell', 'smarkets_cancel', 'smarkets_cancel_all',

  // manifold (prediction market)
  'manifold_bet', 'manifold_sell', 'manifold_multi_bet', 'manifold_multiple_choice',
  'manifold_cancel', 'manifold_create_market', 'manifold_close_market',
  'manifold_resolve_market', 'manifold_add_liquidity', 'manifold_send_mana',
  'manifold_add_bounty', 'manifold_award_bounty',
  'manifold_add_answer', 'manifold_create_comment', 'manifold_manage_topic',

  // polymarket (prediction market)
  'polymarket_order',
  'polymarket_buy', 'polymarket_sell', 'polymarket_cancel', 'polymarket_cancel_all',
  'polymarket_market_buy', 'polymarket_market_sell',
  'polymarket_maker_buy', 'polymarket_maker_sell', 'polymarket_cancel_market',
  'polymarket_post_orders_batch', 'polymarket_cancel_orders_batch',
  'polymarket_create_api_key', 'polymarket_derive_api_key', 'polymarket_delete_api_key',
  'polymarket_create_readonly_api_key', 'polymarket_delete_readonly_api_key',
  'polymarket_update_balance_allowance', 'polymarket_drop_notifications',

  // Drift gateway (including the write-capable leverage tool)
  'drift_place_order', 'drift_cancel_order', 'drift_cancel_all_orders',
  'drift_leverage', 'drift_modify_order', 'drift_cancel_and_place',

  // solana (DEX + perps + tokens)
  'solana_jupiter_swap', 'solana_auto_swap', 'solana_auto_route',
  'raydium_swap', 'orca_whirlpool_swap', 'meteora_dlmm_swap',
  'solana_jupiter_limit_order_create', 'solana_jupiter_limit_order_cancel',
  'solana_jupiter_dca_create', 'solana_jupiter_dca_close',
  'solana_jupiter_dca_deposit', 'solana_jupiter_dca_withdraw',
  'raydium_clmm_create_position', 'raydium_clmm_increase_liquidity',
  'raydium_clmm_decrease_liquidity', 'raydium_clmm_close_position',
  'raydium_clmm_harvest', 'raydium_clmm_swap', 'raydium_clmm_create_pool',
  'raydium_amm_add_liquidity', 'raydium_amm_remove_liquidity',
  'orca_open_full_range_position', 'orca_open_concentrated_position',
  'orca_increase_liquidity', 'orca_decrease_liquidity', 'orca_harvest_position',
  'orca_close_position', 'orca_create_pool', 'orca_harvest_all_positions',
  'meteora_dlmm_swap_exact_out', 'meteora_dlmm_swap_with_price_impact',
  'meteora_dlmm_open_position', 'meteora_dlmm_create_empty_position',
  'meteora_dlmm_add_liquidity', 'meteora_dlmm_remove_liquidity',
  'meteora_dlmm_close_position', 'meteora_dlmm_create_pool',
  'meteora_dlmm_claim_fees', 'meteora_dlmm_claim_rewards',
  'meteora_dlmm_claim_all', 'meteora_dlmm_claim_all_fees',
  'drift_direct_place_order', 'drift_direct_cancel_order',
  'drift_direct_modify_order', 'drift_direct_set_leverage',
  'pumpfun_trade', 'pumpfun_create', 'pumpfun_claim', 'pumpfun_ipfs_upload',
  'bags_swap', 'bags_launch', 'bags_claim', 'bags_partner_claim',
  'bags_fee_config', 'bags_partner_config',
  'swarm_buy', 'swarm_sell', 'swarm_enable', 'swarm_disable', 'swarm_refresh',
  'swarm_preset_save', 'swarm_preset_delete',

  // EVM swaps and cross-chain transfers
  'evm_swap', 'wormhole_bridge', 'wormhole_redeem', 'usdc_bridge', 'usdc_bridge_auto',

  // Subnet registration loads wallet authority; queries are classified below.
  'bittensor',

  // acp (agent commerce protocol — escrow/agreements/bids/predictions)
  'acp_register_agent', 'acp_register_handle', 'acp_quick_hire',
  'acp_list_service',
  'acp_create_agreement', 'acp_sign_agreement',
  'acp_create_escrow', 'acp_fund_escrow', 'acp_release_escrow', 'acp_refund_escrow',
  'acp_create_bid', 'acp_accept_bid', 'acp_reject_bid',
  'acp_rate_service', 'acp_update_profile', 'acp_use_referral_code',
  'acp_submit_prediction', 'acp_resolve_market',

  // credential management + copy-trading arming
  'setup_polymarket_credentials', 'setup_kalshi_credentials',
  'setup_manifold_credentials', 'delete_trading_credentials',
  'setup_binance_credentials', 'setup_bybit_credentials', 'setup_hyperliquid_credentials',
  'setup_mexc_credentials', 'setup_betfair_credentials', 'setup_drift_credentials',
  'setup_smarkets_credentials', 'setup_opinion_credentials', 'setup_virtuals_credentials',
  'setup_hedgehog_credentials', 'setup_predictfun_credentials',
  'enable_auto_copy', 'disable_auto_copy',
  'copy_trade', 'execute_arbitrage',
]);

let quarantined = false;

export function setDirectMutationQuarantined(value: boolean): void {
  quarantined = value;
}

export function isDirectMutationQuarantined(_surface?: DirectMutationSurface | string): boolean {
  return quarantined;
}

export function isRegisteredDirectMutationTool(toolName: string): boolean {
  return REGISTERED_DIRECT_MUTATION_TOOLS.includes(toolName);
}

/**
 * Central dispatch guard. Returns a quarantine reason when `toolName` is a
 * registered direct mutation and the production-runtime quarantine is active,
 * otherwise null. `dispatchHandler` applies this before invoking any handler,
 * so a mutation fails closed before credential read / private-key use /
 * authenticated mutation request.
 */
export function quarantineReasonForTool(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string | null {
  if (!isRegisteredDirectMutationTool(toolName) || !isDirectMutationQuarantined()) return null;

  // Preserve queries on mixed tools using the same classification authority.
  // Without an explicit input, a mutation-capable tool remains fail closed.
  if (toolName === 'drift_leverage' && toolInput && !('set_leverage' in toolInput)) return null;
  if (toolName === 'bittensor' && toolInput) {
    const action = Object.getOwnPropertyDescriptor(toolInput, 'action');
    if (action && 'value' in action &&
        ['status', 'earnings', 'wallet', 'miners', 'subnets', 'stop'].includes(action.value)) return null;
  }
  return directMutationQuarantineReason(toolName);
}

export function directMutationQuarantineReason(surface: DirectMutationSurface | string): string {
  return `${surface} direct mutation is quarantined by the authoritative production runtime`;
}
