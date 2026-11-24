import type { ToolBoundaryOutcome } from "../shared/types.js";

/**
 * The tool calls an opencode server turn has executing right now, and the
 * callers waiting for none to be.
 *
 * An abort lands wherever the turn is. In the middle of a tool call that is
 * writing, it leaves a half-written file; between two calls, or while the model
 * is only generating, it loses nothing that was already produced. A sender that
 * wants a busy session's turn cut short asks for it at such a boundary.
 *
 * A call counts from the moment opencode starts executing it (its input has been
 * streamed by then, and that is the model talking, not work) to the moment it
 * reports a result or an error. A call whose step was aborted or failed reports
 * neither, so the turn clears the set when a step ends.
 */
export class ToolBoundary {
  private readonly running = new Set<string>();
  private readonly waiting = new Set<(open: boolean) => void>();
  private closed = false;

  get idle(): boolean {
    return this.running.size === 0;
  }

  start(callId: string): void {
    if (!this.closed) this.running.add(callId);
  }

  end(callId: string): void {
    if (this.running.delete(callId)) this.release();
  }

  /** A step ended, failed or was aborted: none of its calls is executing any more. */
  clear(): void {
    if (this.running.size === 0) return;
    this.running.clear();
    this.release();
  }

  /**
   * Run `then(true)` once no call is executing: at once if none is, else when
   * the last one ends. `then(false)` if the turn ends first, so a waiter that
   * outlived its turn never acts on the next one. Returns a cancel.
   */
  whenIdle(then: (open: boolean) => void): () => void {
    if (this.closed) {
      then(false);
      return () => undefined;
    }
    if (this.idle) {
      then(true);
      return () => undefined;
    }
    this.waiting.add(then);
    return () => { this.waiting.delete(then); };
  }

  /** The turn is over: whoever is still waiting is told it never got its boundary. */
  close(): void {
    this.closed = true;
    this.running.clear();
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const then of waiting) then(false);
  }

  private release(): void {
    if (!this.idle) return;
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const then of waiting) then(true);
  }
}

/** What stops a turn at a boundary. */
export interface BoundaryTurn {
  readonly toolBoundary: ToolBoundary;
  interrupt(reason: string): Promise<void>;
}

/**
 * Abort `turn` the moment no tool call is executing, waiting up to `waitMs` for
 * that. Past it the abort stays armed and resolves `"waiting"`; it still fires at
 * the next boundary, unless the turn ends first or `beforeAbort` (asked right before
 * the abort) says the message that wanted it is no longer waiting.
 */
export function interruptAtToolBoundary(
  turn: BoundaryTurn,
  reason: string,
  opts: { waitMs: number; beforeAbort?: () => boolean },
): Promise<ToolBoundaryOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("waiting"), opts.waitMs);
    timer.unref?.();
    turn.toolBoundary.whenIdle((open) => {
      clearTimeout(timer);
      if (!open || (opts.beforeAbort && !opts.beforeAbort())) return resolve("over");
      void turn.interrupt(reason);
      resolve("interrupted");
    });
  });
}
