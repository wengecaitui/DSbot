import { Router, type Request, type Response } from 'express';
import type { WorkbenchReadAdapter } from '../observability/workbench-read-adapter';

export const WORKBENCH_API_PREFIX = '/api/workbench/v1';

export function createWorkbenchRouter(adapter: WorkbenchReadAdapter): Router {
  const router = Router();

  const send = (reader: () => unknown) => (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(reader());
  };

  router.get('/overview', send(adapter.overview));
  router.get('/runtime', send(adapter.runtime));
  router.get('/market', send(adapter.market));
  router.get('/trading', send(adapter.trading));
  router.get('/account', send(adapter.account));
  router.get('/safety', send(adapter.safety));
  router.get('/research', send(adapter.research));
  router.get('/activity', send(adapter.activity));
  router.get('/operations', send(adapter.operations));
  router.get('/policy', send(adapter.policy));
  router.get('/data', send(adapter.data));
  router.get('/status', send(adapter.status));
  router.get('/routes', send(adapter.routes));

  router.use((req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'workbench_read_only', allowedMethods: ['GET'] });
      return;
    }
    res.status(404).json({ error: 'workbench_resource_not_found' });
  });

  return router;
}
