/**
 * Central quarantine for legacy mutation surfaces that do not route through
 * the authoritative ProductionSpine -> PreTradeRiskGateway -> OMS path.
 *
 * The application ProductionRuntimeOwner establishes this state. Handlers and
 * skills only query it, before reading credentials or constructing clients.
 *
 * `REGISTERED_DIRECT_MUTATION_TOOLS` is the single source of truth for every
 * mutation-capable tool name across the registered Agent handler surface
 * (src/agents/handlers/index.ts -> allHandlers). The central dispatch guard in
 * index.ts consults it so a new mutation handler is covered by the quarantine
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

  // solana (DEX + perps + tokens)
  'solana_jupiter_swap', 'solana_auto_swap', 'solana_auto_route',
  'drift_direct_place_order', 'drift_direct_cancel_order',
  'drift_direct_modify_order', 'drift_direct_set_leverage',
  'pumpfun_trade', 'pumpfun_create', 'pumpfun_claim', 'pumpfun_ipfs_upload',
  'bags_swap', 'bags_launch', 'bags_claim', 'bags_partner_claim',
  'swarm_buy', 'swarm_sell', 'swarm_enable', 'swarm_disable', 'swarm_refresh',
  'swarm_preset_save', 'swarm_preset_delete',

  // acp (agent commerce protocol — escrow/agreements/bids/predictions)
  'acp_register_agent', 'acp_register_handle', 'acp_quick_hire',
  'acp_create_agreement', 'acp_sign_agreement',
  'acp_create_escrow', 'acp_fund_escrow', 'acp_release_escrow', 'acp_refund_escrow',
  'acp_create_bid', 'acp_accept_bid', 'acp_reject_bid',
  'acp_rate_service', 'acp_update_profile', 'acp_use_referral_code',
  'acp_submit_prediction', 'acp_resolve_market',

  // credential management + copy-trading arming
  'setup_polymarket_credentials', 'setup_kalshi_credentials',
  'setup_manifold_credentials', 'delete_trading_credentials',
  'enable_auto_copy', 'disable_auto_copy',
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
export function quarantineReasonForTool(toolName: string): string | null {
  return isRegisteredDirectMutationTool(toolName) && isDirectMutationQuarantined()
    ? directMutationQuarantineReason(toolName)
    : null;
}

export function directMutationQuarantineReason(surface: DirectMutationSurface | string): string {
  return `${surface} direct mutation is quarantined by the authoritative production runtime`;
}
