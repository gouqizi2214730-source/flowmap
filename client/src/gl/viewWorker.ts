import { ViewWorkerEngine, type ViewColumn, type ViewResult, type ViewTask } from './viewWorkerEngine';

/** One acknowledged chunk in flight: producer copying, worker inbox and
 * source arrays never grow with the historical time span. */
export class ViewWorker {
  private worker: Worker | null;
  private disposed = false;
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  busy = false;
  constructor() {
    if (typeof Worker === 'undefined') { this.worker = null; return; }
    try { this.worker = new Worker(new URL('./viewWorkerRuntime.ts', import.meta.url), { type: 'module' }); }
    catch { this.worker = null; return; }
    this.worker.onmessage = event => {
      const pending = this.pending; this.pending = null;
      if (event.data.error) pending?.reject(new Error(event.data.error));
      else pending?.resolve(event.data);
    };
    this.worker.onerror = event => { this.pending?.reject(new Error(event.message)); this.pending = null; };
  }
  private send(message: unknown, transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.disposed || !this.worker) { reject(new Error('flowmap: view worker disposed')); return; }
      const timeout = setTimeout(() => {
        this.pending = null;
        reject(new Error('flowmap: view worker acknowledgement timed out'));
        this.dispose();
      }, 30_000);
      this.pending = {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      try { this.worker.postMessage(message, transfer); }
      catch (error) { clearTimeout(timeout); this.pending = null; reject(error); }
    });
  }
  async run(task: ViewTask, columns: Iterable<ViewColumn | null>): Promise<ViewResult> {
    if (this.busy) throw new Error('flowmap: view worker already busy');
    if (this.disposed) throw new Error('flowmap: view worker disposed');
    this.busy = true;
    try {
      // Older hosts keep the same exact calculation with cooperative slices.
      if (!this.worker) {
        const engine = new ViewWorkerEngine(task);
        let count = 0, start = performance.now();
        for (const column of columns) {
          if (this.disposed) throw new Error('flowmap: view worker disposed');
          engine.add(column);
          if (++count >= 8 || performance.now() - start >= 2) {
            await new Promise(resolve => setTimeout(resolve, 0)); count = 0; start = performance.now();
          }
        }
        return engine.finish();
      }
      await this.send({ kind: 'begin', task });
      let chunk: (ViewColumn | null)[] = [], transfers: Transferable[] = [];
      let start = performance.now();
      for (const source of columns) {
        if (source) {
          const bid = source.bid.slice(), ask = source.ask?.slice() ?? null;
          chunk.push({ bid, ask, scale: source.scale }); transfers.push(bid.buffer);
          if (ask) transfers.push(ask.buffer);
        } else chunk.push(null);
        if (chunk.length >= 8 || performance.now() - start >= 2) {
          await this.send({ kind: 'chunk', columns: chunk }, transfers);
          chunk = []; transfers = [];
          await new Promise(resolve => setTimeout(resolve, 0)); start = performance.now();
        }
      }
      if (chunk.length) await this.send({ kind: 'chunk', columns: chunk }, transfers);
      const reply = await this.send({ kind: 'finish' }) as { result: ViewResult };
      return reply.result;
    } finally { this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.worker?.terminate(); this.pending?.reject(new Error('flowmap: view worker disposed')); this.pending = null; }
}
