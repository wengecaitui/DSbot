export const TICKFLOW_QUALIFICATION = Object.freeze({
  phase: '9G',
  qualificationScope: 'RESEARCH_INGESTION_ONLY',
  provider: 'tickflow',
  adapter: 'tickflow-historical-kline-v1',
  dataset: 'historical-raw-1d-klines',
  marketScope: 'CN-equities',
  period: '1d',
  adjust: 'none',
  productionAuthority: false,
  pitAuthority: false,
  storageAuthority: false,
  backtestAuthority: false,
} as const);
