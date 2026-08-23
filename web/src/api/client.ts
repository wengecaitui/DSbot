import type {
  AccountingSnapshot,
  DataSnapshot,
  MarketSnapshot,
  OperationsSnapshot,
  OverviewSnapshot,
  PolicySnapshot,
  ReadEnvelope,
  ResearchSnapshot,
  RuntimeSnapshot,
  SafetySnapshot,
  StatusResponse,
  LifecycleSnapshot,
  OrderSnapshot,
  PositionRecord,
} from './types';

const API_ROOT = '/api/workbench/v1';
const TOKEN_KEY = 'dsbot.workbench.session-token';

export class WorkbenchHttpError extends Error {
  constructor(
    readonly resource: string,
    readonly status: number,
  ) {
    const guidance = status === 401
      ? 'Authentication is required. Open /workbench/?token=<gateway-token>.'
      : status === 404
        ? 'The read API is not mounted here. Open /workbench/ on the running application gateway, not a standalone frontend preview.'
        : status >= 500
          ? 'The application gateway could not serve this read projection.'
          : 'The application gateway rejected this read request.';
    super(`Workbench ${resource} HTTP ${status}. ${guidance}`);
    this.name = 'WorkbenchHttpError';
  }
}

function sessionToken(): string | null {
  const queryToken = new URLSearchParams(window.location.search).get('token');
  if (queryToken) {
    window.sessionStorage.setItem(TOKEN_KEY, queryToken);
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    window.history.replaceState({}, '', `${clean.pathname}${clean.search}${clean.hash}`);
    return queryToken;
  }
  return window.sessionStorage.getItem(TOKEN_KEY);
}

async function read<T>(resource: string): Promise<T> {
  const token = sessionToken();
  const response = await fetch(`${API_ROOT}/${resource}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new WorkbenchHttpError(resource, response.status);
  return response.json() as Promise<T>;
}

export const workbenchApi = {
  overview: () => read<OverviewSnapshot>('overview'),
  runtime: () => read<ReadEnvelope<RuntimeSnapshot>>('runtime'),
  market: () => read<ReadEnvelope<{ instruments: MarketSnapshot[]; regime: { label: string; evidenceId: string } | null }>>('market'),
  trading: () => read<ReadEnvelope<{ positions: PositionRecord[]; orders: OrderSnapshot[]; protectivePlans: Array<{ planId: string; symbol: string; status: string }> }>>('trading'),
  account: () => read<ReadEnvelope<{ accounting: AccountingSnapshot | null; tradeLifecycle: LifecycleSnapshot | null }>>('account'),
  safety: () => read<ReadEnvelope<SafetySnapshot>>('safety'),
  research: () => read<ReadEnvelope<ResearchSnapshot>>('research'),
  operations: () => read<ReadEnvelope<OperationsSnapshot>>('operations'),
  policy: () => read<ReadEnvelope<PolicySnapshot>>('policy'),
  data: () => read<ReadEnvelope<DataSnapshot>>('data'),
  status: () => read<StatusResponse>('status'),
};
