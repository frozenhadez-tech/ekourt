// Live updates: every successful write is announced over Server-Sent Events so open
// screens (dashboard, court board, POS) refresh without a manual reload.
import type { NextFunction, Request, Response } from 'express';

const clients = new Set<Response>();

export function eventsHandler(req: Request, res: Response) {
  // Serverless: no long-lived process to fan events out from. 204 tells EventSource to stop; the client polls.
  if (process.env.VERCEL) { res.status(204).end(); return; }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function broadcast(topic: string) {
  const msg = `data: ${JSON.stringify({ topic, at: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}

export function broadcastWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) broadcast(req.path.split('/')[1] ?? 'data');
    });
  }
  next();
}
