import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";
import { discoverOpencodeModels, settledWithin } from "./opencode-discovery.js";
import { newCloneSink, type CloneSink, type OpencodeClones } from "./opencode-clone.js";

/**
 * The opencode models discovery last found, and whether their `--verbose`
 * details (context windows, effort levels) are still to come.
 *
 * Until the details arrive, an opencode model's empty `effortLevels` means "not
 * known yet", not "none". Refusing an effort in that window, or dropping an
 * employee's configured one, loses the choice for good, so validation accepts a
 * level while the details are pending, and a turn that has one waits for them.
 *
 * Pending runs from the start of a refresh over a snapshot without details (the
 * first one, or one after `--verbose` failed) until details land (from that
 * refresh or one it overtook), are confirmed (see {@link land}), or are known
 * not to be coming. A refresh over a detailed snapshot never makes it pending,
 * and a slow one never puts its stand-in plain list over that snapshot.
 */

let snapshot: ModelInfo[] | null = null;
/** The clone records of the providers accounts name as their base, from the
 *  same discovery as `snapshot` (opencode-clone.ts). */
let clones: OpencodeClones = new Map();
let detailed = false;
let generation = 0;
let pending: { promise: Promise<void>; resolve: () => void } | undefined;
/** Whether a first detailed answer's second look is still running. */
let confirming = false;
/** The refresh whose detailed answer the snapshot holds. */
let detailedBy = 0;
const listeners = new Set<() => void>();
/** Turns waiting for a base provider's clone records (see {@link opencodeClonesSettled}): told whenever the records change or the wait for details ends. */
const cloneWaiters = new Set<() => void>();

/** One refresh's landing: its generation, its binary, and what to tell when
 *  the snapshot changes (the registry's cache). */
interface Landing {
  refresh: number;
  bin: string;
  changed: () => void;
  /** Whether a first detailed answer gets its second look (see {@link land}). */
  secondLook: boolean;
  /** The environment of every opencode this refresh starts, its second look included. */
  env?: Record<string, string>;
  /** Collects this refresh's clone records, whichever of its runs is served. */
  clones: CloneSink;
}

function newLanding(o: { refresh: number; bin: string; changed: () => void; secondLook: boolean; env?: Record<string, string>; cloneProviders: readonly string[] }): Landing {
  return { refresh: o.refresh, bin: o.bin, changed: o.changed, secondLook: o.secondLook, clones: newCloneSink(o.cloneProviders), ...(o.env ? { env: o.env } : {}) };
}

/** The local opencode binary's API (1 or 2) as the last refresh read it; undefined when there is no binary or it could not say. */
let localApi: 1 | 2 | undefined;

export function opencodeLocalApi(): 1 | 2 | undefined {
  return localApi;
}

/** Record the local binary's API. Callers invalidate the registry that reads it. */
export function setOpencodeLocalApi(api: 1 | 2 | undefined): void {
  localApi = api;
}

/** The discovered models, or null before any discovery found one. */
export function opencodeCatalogue(): ModelInfo[] | null {
  return snapshot;
}

/** What the last detailed discovery recorded of the base providers' models, for
 *  the accounts that clone them. Empty until a detailed discovery lands, and
 *  only for the providers the refresh was asked about (`cloneProviders`). */
export function opencodeClones(): OpencodeClones {
  return clones;
}

/** Refreshes begun and not yet finished, late details included. */
let refreshing = 0;

/** Mark a refresh of `bin` as begun, before the caller's first `await`, and
 *  return what ends it (once; later calls do nothing). From here until it ends,
 *  a turn on an account whose base has no clone records waits for them rather
 *  than being staged with no models (see {@link opencodeClonesSettled}).
 *  {@link refreshOpencodeCatalogue} marks its own; this is also for a caller
 *  with work to await before it gets there. */
export function beginOpencodeRefresh(bin: string | null): () => void {
  if (bin === null) return () => {};
  if (!detailed) beginPending();
  refreshing += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    refreshing -= 1;
    wakeCloneWaiters();
  };
}

/** Discover the models `bin` (null: opencode is not installed) can reach and
 *  keep them. Resolves once the catalogue to serve now is in; details that
 *  outlive the discovery timeout land later and tell {@link onLateOpencodeDetails}.
 *  `secondLook` is the gateway's: a CLI command reads the catalogue once and exits.
 *  `env` is what the opencode runs start with (see `DiscoveryOptions`).
 *  `cloneProviders` are the providers whose models accounts clone: their SDK,
 *  endpoint, price and limits are kept beside the catalogue. */
export async function refreshOpencodeCatalogue(
  bin: string | null,
  changed: () => void,
  secondLook = false,
  env?: Record<string, string>,
  cloneProviders: readonly string[] = [],
): Promise<void> {
  generation += 1;
  const end = beginOpencodeRefresh(bin);
  const at = newLanding({ refresh: generation, bin: bin ?? "", changed, secondLook, env, cloneProviders });
  if (bin === null) return land(at, null, false);
  try {
    const discovery = await discoverOpencodeModels(bin, { env, clones: at.clones });
    logger.info(`opencode model discovery: ${discovery.models.length} model(s)`);
    const { details } = discovery;
    if (!details) {
      land(at, discovery.models, discovery.detailed);
      end();
      return;
    }
    standIn(at, discovery.models);
    void details.then((models) => landLate(at, models)).finally(end);
  } catch (err) {
    logger.warn(`opencode model discovery failed: ${err instanceof Error ? err.message : err}`);
    land(at, null, false);
    end();
  }
}

/** The plain list stands in until the details land, but never over a detailed
 *  snapshot from an earlier refresh: that one is the better answer. */
function standIn(at: Landing, models: ModelInfo[]): void {
  if (detailed || at.refresh !== generation) return;
  snapshot = models;
  at.changed();
}

function beginPending(): void {
  if (pending) return;
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  pending = { promise, resolve };
}

/**
 * Put a refresh's answer in place. The newest refresh's answer always lands. An
 * overtaken one's lands only when it brings details the snapshot lacks, since
 * the newer refresh may never bring them.
 *
 * opencode 1.x's first run on a fresh home lists the catalogue bundled in its
 * binary while it fetches the current one into its cache (on 1.19.0 the first
 * `models --verbose` listed 11 bundled models, the very next run the 10 current
 * ones), so a model newer than the binary would have no window or levels until
 * the next refresh, hours away. So the gateway's first detailed answer is served
 * at once and confirmed by one more run; until then only a model that answer
 * does not list counts as pending. A warm home answers the same twice.
 */
/** The records of a plain list say nothing: the last detailed ones stay until a detailed answer replaces them, or until there is nothing left to serve. */
function keepClones(at: Landing, models: ModelInfo[] | null, isDetailed: boolean): void {
  if (isDetailed || models === null) setClones(at.clones.models);
}

function setClones(next: OpencodeClones): void {
  clones = next;
  wakeCloneWaiters();
}

function wakeCloneWaiters(): void {
  for (const waiter of [...cloneWaiters]) waiter();
}

function land(at: Landing, models: ModelInfo[] | null, isDetailed: boolean): void {
  const current = at.refresh === generation;
  if (!current && !(isDetailed && !detailed)) return;
  const firstDetails = isDetailed && !detailed;
  snapshot = models;
  detailed = isDetailed;
  if (isDetailed) detailedBy = at.refresh;
  keepClones(at, models, isDetailed);
  at.changed();
  if (firstDetails && at.secondLook) {
    confirming = true;
    void confirm(at);
  } else if (current || detailed) {
    settle();
  }
}

async function confirm(at: Landing): Promise<void> {
  const second = newCloneSink(at.clones.providers);
  const again = await discoverOpencodeModels(at.bin, { env: at.env, clones: second });
  const models = again.detailed ? again.models : await again.details;
  confirming = false;
  // A newer refresh's detailed answer outranks this look; one that brought
  // none (a reload whose --verbose failed) does not.
  if (models && detailedBy <= at.refresh) {
    snapshot = models;
    detailed = true;
    detailedBy = at.refresh;
    setClones(second.models);
    at.changed();
  }
  logger.info(`opencode model discovery: ${models ? `second look found ${models.length} model(s)` : "the second look found nothing; keeping the first answer"}`);
  settle();
  announce();
}

function landLate(at: Landing, models: ModelInfo[] | undefined): void {
  if (!models) {
    if (at.refresh !== generation) return;
    logger.info("opencode model discovery: --verbose gave nothing; keeping what is there");
    // A second look still running settles the wait itself, with what it finds.
    if (!confirming) settle();
    return;
  }
  if (at.refresh !== generation && detailed) return;
  logger.info(`opencode model discovery: details for ${models.length} model(s) arrived`);
  land(at, models, true);
  announce();
}

function settle(): void {
  if (!pending) return;
  pending.resolve();
  pending = undefined;
  wakeCloneWaiters();
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** Details that landed after their refresh returned changed the catalogue;
 *  the gateway tells the web UI, which otherwise refetches only on its own
 *  refresh. Returns the unsubscribe. */
export function onLateOpencodeDetails(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `engine`'s effort levels for `modelId` (unnamed: whichever model
 *  the turn ends up on) cannot be known yet, so an effort must be neither
 *  refused nor dropped for want of them. */
export function effortLevelsPending(engine: string, modelId?: string): boolean {
  if (engine !== "opencode" || !pending) return false;
  const listed = modelId !== undefined && (snapshot?.some((m) => m.id === modelId) ?? false);
  return !(confirming && listed);
}

/** Resolves once {@link effortLevelsPending} clears, or after `timeoutMs`; at
 *  once when it is not pending. */
export async function effortLevelsSettled(engine: string, timeoutMs: number, modelId?: string): Promise<void> {
  if (effortLevelsPending(engine, modelId) && pending) await settledWithin(pending.promise, timeoutMs);
}

/** Whether a turn on an account cloning `base` should wait for discovery: no
 *  record of the base's models is kept yet, and a refresh that may bring them is
 *  still running (or a first one's details are still to come). False once the
 *  records are in, and false when no refresh is running (the base may simply not be in the catalogue, or discovery failed):
 *  then waiting would bring nothing. */
export function opencodeClonesPending(base: string): boolean {
  return !clones.has(base) && (pending !== undefined || refreshing > 0);
}

/** Resolves once {@link opencodeClonesPending} clears for `base`, or after
 *  `timeoutMs`; at once when it is not pending. A fresh gateway's first turn on
 *  an account model can start before the first detailed discovery lands, and an
 *  account staged then has no models, which opencode refuses as `provider.no-route`. */
export async function opencodeClonesSettled(base: string, timeoutMs: number): Promise<void> {
  if (!opencodeClonesPending(base)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      cloneWaiters.delete(check);
      resolve();
    };
    const check = (): void => {
      if (!opencodeClonesPending(base)) done();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    cloneWaiters.add(check);
  });
}
