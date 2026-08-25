import type { ObservableEventSink, ObservableEventSourceAdapter } from '../contracts';

export interface PollingAdapterOptions {
  name: string;
  intervalMs?: number;
  poll(sink: ObservableEventSink): void | Promise<void>;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export function createPollingAdapter(options: PollingAdapterOptions): ObservableEventSourceAdapter {
  const intervalMs = options.intervalMs ?? 2_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new Error('Polling intervalMs must be an integer greater than or equal to 100');
  }
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  function run(sink: ObservableEventSink): Promise<void> {
    if (!running) return Promise.resolve();
    inFlight = inFlight.then(async () => {
      if (!running) return;
      try {
        await options.poll(sink);
        try { options.onSuccess?.(); } catch { /* evidence status observers cannot break polling */ }
      } catch (cause) {
        try { options.onError?.(cause instanceof Error ? cause : new Error(String(cause))); }
        catch { /* evidence status observers cannot break polling */ }
      }
    });
    return inFlight;
  }

  return {
    name: options.name,
    async start(sink) {
      if (running) return;
      running = true;
      await run(sink);
      timer = setInterval(() => { void run(sink); }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (!running) return;
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
