import { createServer, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { ObservableAgentEvent } from '../contracts';
import type { ObservableStateSnapshot } from '../state-projector';
import type { ObservableAlert } from '../alert-engine';
import type { TaskActivitySnapshot } from '../task-activity-projector';
import type { RemediationRecommendation } from '../remediation-advisor';
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from './page';
import { createDashboardCollaborationContext } from './collaboration-context';
import type { ProjectControlCenterSnapshot } from '../project-control-center';

export interface DashboardServerOptions {
  port?: number;
  maxEvents?: number;
  stateProvider: () => ObservableStateSnapshot;
  activityProvider?: () => TaskActivitySnapshot;
  projectProvider?: () => ProjectControlCenterSnapshot;
}

export interface ObservabilityDashboardServer {
  readonly url?: string;
  readonly isRunning: boolean;
  start(): Promise<string>;
  stop(): Promise<void>;
  publish(event: ObservableAgentEvent): void;
  publishAlert(alert: ObservableAlert): void;
  publishRecommendation(recommendation: RemediationRecommendation): void;
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

export function createObservabilityDashboardServer(options: DashboardServerOptions): ObservabilityDashboardServer {
  const port = options.port ?? 8_765;
  const maxEvents = options.maxEvents ?? 500;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Dashboard port must be between 0 and 65535');
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) throw new Error('Dashboard maxEvents must be a positive integer');

  const events: ObservableAgentEvent[] = [];
  const alerts: ObservableAlert[] = [];
  const recommendations: RemediationRecommendation[] = [];
  const clients = new Set<ServerResponse>();
  let server: Server | undefined;
  let currentUrl: string | undefined;
  let keepAlive: NodeJS.Timeout | undefined;

  function securityHeaders(response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Cache-Control', 'no-store');
  }

  function createHttpServer(): Server {
    return createServer((request, response) => {
      securityHeaders(response);
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
        return;
      }
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/') return send(response, 200, 'text/html; charset=utf-8', DASHBOARD_HTML);
      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (requestUrl.pathname === '/dashboard.css') return send(response, 200, 'text/css; charset=utf-8', DASHBOARD_CSS);
      if (requestUrl.pathname === '/dashboard.js') return send(response, 200, 'text/javascript; charset=utf-8', DASHBOARD_JS);
      if (requestUrl.pathname === '/api/health') {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, service: 'hermes-observability-dashboard' }));
      }
      if (requestUrl.pathname === '/api/project') {
        if (!options.projectProvider) return send(response, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'project_evidence_unavailable' }));
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(options.projectProvider()));
      }
      if (requestUrl.pathname === '/api/state') {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({
          generatedAt: new Date().toISOString(),
          project: options.projectProvider?.(),
          monitor: options.stateProvider(),
          activity: options.activityProvider?.() ?? { recentTasks: [] },
          recentEvents: events.slice(-100),
          recentAlerts: alerts.slice(-100),
          recommendations: recommendations.slice(-100),
        }));
      }
      if (requestUrl.pathname === '/api/collaboration-context') {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(
          createDashboardCollaborationContext({
            monitor: options.stateProvider(),
            activity: options.activityProvider?.() ?? { recentTasks: [] },
            project: options.projectProvider?.(),
            recentEvents: events,
            recentAlerts: alerts,
            recommendations,
          }),
        ));
      }
      if (requestUrl.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        response.write('event: connected\ndata: {"ok":true}\n\n');
        clients.add(response);
        request.once('close', () => clients.delete(response));
        return;
      }
      send(response, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not_found' }));
    });
  }

  return {
    get url() { return currentUrl; },
    get isRunning() { return server !== undefined; },
    async start() {
      if (server && currentUrl) return currentUrl;
      server = createHttpServer();
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address() as AddressInfo;
      currentUrl = `http://127.0.0.1:${address.port}`;
      keepAlive = setInterval(() => {
        for (const client of clients) client.write(': keep-alive\n\n');
      }, 15_000);
      return currentUrl;
    },
    async stop() {
      if (!server) return;
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = undefined;
      for (const client of clients) client.end();
      clients.clear();
      const current = server;
      server = undefined;
      currentUrl = undefined;
      await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
    },
    publish(event) {
      const safeEvent = structuredClone(event);
      events.push(safeEvent);
      if (events.length > maxEvents) events.shift();
      const payload = `event: observable\ndata: ${JSON.stringify(safeEvent)}\n\n`;
      for (const client of clients) client.write(payload);
    },
    publishAlert(alert) {
      const safeAlert = structuredClone(alert);
      const existing = alerts.findIndex(item => item.alertId === safeAlert.alertId);
      if (existing >= 0) alerts[existing] = safeAlert;
      else alerts.push(safeAlert);
      if (alerts.length > maxEvents) alerts.shift();
      const payload = `event: alert\ndata: ${JSON.stringify(safeAlert)}\n\n`;
      for (const client of clients) client.write(payload);
    },
    publishRecommendation(recommendation) {
      const safeRecommendation = structuredClone(recommendation);
      const existing = recommendations.findIndex(item => item.recommendationId === safeRecommendation.recommendationId);
      if (existing >= 0) recommendations[existing] = safeRecommendation;
      else recommendations.push(safeRecommendation);
      if (recommendations.length > maxEvents) recommendations.shift();
      const payload = `event: recommendation\ndata: ${JSON.stringify(safeRecommendation)}\n\n`;
      for (const client of clients) client.write(payload);
    },
  };
}
