import { ViewWorkerEngine, type ViewColumn, type ViewTask } from './viewWorkerEngine';

const context = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let engine: ViewWorkerEngine | null = null;
context.onmessage = event => {
  const message = event.data as { kind: 'begin' | 'chunk' | 'finish'; task?: ViewTask; columns?: (ViewColumn | null)[] };
  try {
    if (message.kind === 'begin') engine = new ViewWorkerEngine(message.task!);
    else if (message.kind === 'chunk') for (const column of message.columns ?? []) engine!.add(column);
    else {
      const result = engine!.finish(); engine = null;
      context.postMessage({ result }, [result.bins.buffer]); return;
    }
    context.postMessage({ ack: true });
  } catch (error) { engine = null; context.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
