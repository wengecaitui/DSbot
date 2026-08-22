import { queryOptions } from '@tanstack/react-query';
import { workbenchApi } from './client';

export const workbenchQueryKeys = {
  root: ['workbench', 'v1'] as const,
  overview: () => [...workbenchQueryKeys.root, 'overview'] as const,
  runtime: () => [...workbenchQueryKeys.root, 'runtime'] as const,
  market: () => [...workbenchQueryKeys.root, 'market'] as const,
  trading: () => [...workbenchQueryKeys.root, 'trading'] as const,
  account: () => [...workbenchQueryKeys.root, 'account'] as const,
  safety: () => [...workbenchQueryKeys.root, 'safety'] as const,
  research: () => [...workbenchQueryKeys.root, 'research'] as const,
  operations: () => [...workbenchQueryKeys.root, 'operations'] as const,
  policy: () => [...workbenchQueryKeys.root, 'policy'] as const,
  data: () => [...workbenchQueryKeys.root, 'data'] as const,
  status: () => [...workbenchQueryKeys.root, 'status'] as const,
};

const stable = { staleTime: 15_000, retry: 1 } as const;

export const workbenchQueries = {
  overview: () => queryOptions({ queryKey: workbenchQueryKeys.overview(), queryFn: workbenchApi.overview, ...stable }),
  runtime: () => queryOptions({ queryKey: workbenchQueryKeys.runtime(), queryFn: workbenchApi.runtime, refetchInterval: 15_000, ...stable }),
  market: () => queryOptions({ queryKey: workbenchQueryKeys.market(), queryFn: workbenchApi.market, refetchInterval: 15_000, ...stable }),
  trading: () => queryOptions({ queryKey: workbenchQueryKeys.trading(), queryFn: workbenchApi.trading, ...stable }),
  account: () => queryOptions({ queryKey: workbenchQueryKeys.account(), queryFn: workbenchApi.account, ...stable }),
  safety: () => queryOptions({ queryKey: workbenchQueryKeys.safety(), queryFn: workbenchApi.safety, refetchInterval: 15_000, ...stable }),
  research: () => queryOptions({ queryKey: workbenchQueryKeys.research(), queryFn: workbenchApi.research, ...stable }),
  operations: () => queryOptions({ queryKey: workbenchQueryKeys.operations(), queryFn: workbenchApi.operations, refetchInterval: 20_000, ...stable }),
  policy: () => queryOptions({ queryKey: workbenchQueryKeys.policy(), queryFn: workbenchApi.policy, ...stable }),
  data: () => queryOptions({ queryKey: workbenchQueryKeys.data(), queryFn: workbenchApi.data, ...stable }),
  status: () => queryOptions({ queryKey: workbenchQueryKeys.status(), queryFn: workbenchApi.status, refetchInterval: 10_000, ...stable }),
};
