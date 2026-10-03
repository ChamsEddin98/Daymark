import type { ServerResponse } from "node:http";

export type EventName = "plan" | "status" | "sync" | "notification";

export interface BusEvent {
  id: number;
  event: EventName;
  data: unknown;
}

/** Fan-out of change events to SSE clients (and in-process listeners, used by tests). */
export class EventBus {
  private clients = new Set<ServerResponse>();
  private listeners = new Set<(e: BusEvent) => void>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(heartbeatMs = 15_000) {
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) c.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, heartbeatMs);
      this.heartbeat.unref();
    }
  }

  get size(): number {
    return this.clients.size;
  }

  publish(event: EventName, data: unknown): void {
    const e: BusEvent = { id: ++this.seq, event, data };
    const frame = `id: ${e.id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
    for (const l of this.listeners) l(e);
  }

  on(listener: (e: BusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.listeners.clear();
  }
}
