/**
 * Phase 7B — narrow injectable outbound config-flush sink.
 *
 * The installed Hermes 0.20.0 API (127.0.0.1:8642) exposes health/OpenAI/
 * session/run endpoints but no dedicated config-flush listener, so we must NOT
 * misuse chat/responses//v1/runs as a flush target. Instead the flush notifier
 * accepts an injected sink. This module provides the only production outbound
 * transport: an explicit HTTP POST sink selected by the operator via
 * HERMES_FLUSH_URL. When that URL is absent, no sink is installed and flushes
 * remain unacknowledged (fail closed).
 */

import type { FlushNotification } from './types';
import type { FlushSink } from './flush-notifier';
import { DEFAULT_SINK_TIMEOUT_MS } from './types';

export interface HttpFlushSinkOptions {
  /** Absolute timeout for the outbound request. */
  timeoutMs?: number;
}

/**
 * Build an HTTP POST sink for flush notifications.
 *
 * The sink posts the notification as JSON and throws on any non-2xx response,
 * network error, or timeout so the notifier records an unacknowledged failure.
 * The notifier's own bounded timeout (`sinkTimeoutMs`) remains the authority;
 * this abort signal is a secondary guard so an abandoned request cannot leak
 * a timer.
 */
export function createHttpFlushSink(
  url: string,
  options: HttpFlushSinkOptions = {}
): FlushSink {
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_SINK_TIMEOUT_MS;

  return async (notification: FlushNotification): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Never echo the response body — it may contain listener internals.
      throw new Error(`FLUSH_SINK_HTTP_${response.status}`);
    }
  };
}
