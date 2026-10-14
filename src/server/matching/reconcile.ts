import "server-only";

import { randomUUID } from "node:crypto";

import type { MetadataStatus } from "@/domain/types";
import { LOCK_KEYS, tryAcquireAdvisoryLock } from "@/server/db/advisory-lock";
import type { Database, DbExecutor } from "@/server/db/types";
import {
  analyzeArchiveEventTables,
  applyArchiveEventPlan,
  countArchiveEventsByStatus,
  deleteEmptyArchiveEvents,
  type PlannedArchiveEvent,
  type PlannedMember,
  recalculateArchiveEvents,
} from "@/server/repositories/archive-events";
import {
  analyzeSourceTables,
  countReconciliationTotals,
  createArchiveOnlyEventsForUnlinkedClips,
  findClipMatchCandidates,
  findMultiCameraCandidates,
  findTemporalFallbackCandidates,
  findTemporalFallbackEventIds,
  loadClipFacts,
  loadMemberships,
  loadProtectEventFacts,
  resolveMissingCameras,
} from "@/server/repositories/reconciliation";

import { DEFAULT_MATCHING_CONFIG, type MatchingConfig } from "./config";
import { groupComponents } from "./grouping";
import { clusterTemporalFallback, fallbackCameraKey, type ClipWithMetadata, type FallbackGroup } from "./temporal-fallback";
import { canGroupAcrossCameras, isClipMatch, type DetectionInterval } from "./temporal-match";

/**
 * One-shot reconciliation of NAS clips and Protect events into archive events
 * (docs/event-matching.md). Conservative (separate rather than wrongly merged), deterministic
 * and idempotent: a second run on unchanged data changes nothing.
 *
 *  1. resolve missing cameras of clips (by name) and Protect events (by device ID)
 *  2. find clip ↔ Protect event matches, multi-camera candidates and temporal fallback
 *     candidates (DB query narrows, pure rules decide)
 *  3. load the archive events these belong to, plus every event joined by the fallback
 *  4. priority 1 – primary groups: Protect metadata + existing primary groups (never split)
 *  5. priority 2 – temporal fallback: join whole primary groups (re-checked every run)
 *  6. plan the archive events (IDs kept where possible) and write only what differs:
 *     reuse, merge, split or create, each work unit atomically
 *  7. archiveOnly events for all remaining clips (set-based)
 *  8. delete empty events, recompute start/end/status of all events
 */

export interface ReconcileLogger {
  info(message: string): void;
  /** Only with --verbose. */
  debug(message: string): void;
}

const silentLogger: ReconcileLogger = { info() {}, debug() {} };

export interface ReconcileOptions {
  db: Database;
  config?: Partial<MatchingConfig>;
  /** Run everything inside a transaction that is rolled back: reports, writes nothing. */
  dryRun?: boolean;
  logger?: ReconcileLogger;
  archiveOnlyBatchSize?: number;
}

export interface ReconcileResult {
  dryRun: boolean;
  durationMs: number;
  clipsTotal: number;
  protectEventsTotal: number;
  clipCamerasResolved: number;
  protectEventCamerasResolved: number;
  /** Clip camera names without an unambiguous Protect camera. */
  unresolvedCameraNames: string[];
  /** Clip ↔ Protect event pairs that match (current state). */
  clipEventMatches: number;
  /** Links added by this run. */
  relationsCreated: number;
  archiveEventsCreated: number;
  /** Archive events removed by merging them into another one. */
  archiveEventsMerged: number;
  /** Archive events divided into several (a temporal fallback join no longer holds). */
  archiveEventsSplit: number;
  /** Multi-camera candidates that joined separate clusters in this run. */
  multiCameraJoins: number;
  /** Multi-camera candidates refused because the group would exceed the max span. */
  multiCameraRejectedBySpan: number;
  /** Archive events whose Protect events come from more than one camera (current state). */
  multiCameraEvents: number;
  /** Clip pairs from the fallback candidate query (not yet in one archive event). */
  temporalCandidates: number;
  /** … of these, refused because Protect metadata contradicts or decides otherwise. */
  temporalRejectedByMetadata: number;
  /** … refused because the whole cluster would break a rule (camera twice, spans, IoU). */
  temporalRejectedByCluster: number;
  /** Archive events joined by the temporal fallback, i.e. with several primary groups (current state). */
  temporalFallbackEvents: number;
  /** … of these, new or changed in this run. */
  temporalFallbackEventsChanged: number;
  /** Fallback links (clip pairs of different primary groups in one event) added in this run. */
  temporalLinksAdded: number;
  /** Fallback links that no longer exist after this run (conflict, changed clips, or superseded). */
  temporalLinksRemoved: number;
  /** … of these, superseded: the clips now belong together by Protect metadata. */
  temporalLinksSuperseded: number;
  emptyEventsDeleted: number;
  eventsRecalculated: number;
  status: Record<MetadataStatus, number>;
}

export class ReconciliationAlreadyRunningError extends Error {
  override name = "ReconciliationAlreadyRunningError";
  constructor() {
    super("Another reconciliation is already running.");
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: Omit<ReconcileResult, "dryRun" | "durationMs">) {
    super("dry run rollback");
  }
}

export async function reconcileArchive(options: ReconcileOptions): Promise<ReconcileResult> {
  const { db, dryRun = false } = options;
  const config: MatchingConfig = { ...DEFAULT_MATCHING_CONFIG, ...options.config };
  const logger = options.logger ?? silentLogger;
  const started = Date.now();

  const release = await tryAcquireAdvisoryLock(db, LOCK_KEYS.reconciliation);
  if (!release) throw new ReconciliationAlreadyRunningError();
  try {
    let result: Omit<ReconcileResult, "dryRun" | "durationMs">;
    if (dryRun) {
      try {
        await db.transaction(async (tx) => {
          throw new DryRunRollback(await run(tx, config, logger, options.archiveOnlyBatchSize));
        });
        throw new Error("unreachable");
      } catch (error) {
        if (!(error instanceof DryRunRollback)) throw error;
        result = error.result;
      }
    } else {
      result = await run(db, config, logger, options.archiveOnlyBatchSize);
    }
    return { ...result, dryRun, durationMs: Date.now() - started };
  } finally {
    await release();
  }
}

/** Planned events are written in batches of about this size (one transaction per batch). */
const PLAN_BATCH_SIZE = 500;
/** Refresh planner statistics after creating more events than this in one run. */
const ANALYZE_AFTER_CREATED = 1000;

const clipNode = (id: string) => `clip:${id}`;
const protectNode = (id: string) => `pe:${id}`;
const groupNode = (id: string) => `group:${id}`;
const idOf = (node: string) => node.slice(node.indexOf(":") + 1);
const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** A primary group after this run: clips and Protect events that belong together by metadata. */
interface Component {
  key: string;
  clipIds: string[];
  protectIds: string[];
  /** Primary group IDs its members had so far (sorted); empty for new members only. */
  oldGroups: string[];
}

async function run(
  db: DbExecutor,
  config: MatchingConfig,
  logger: ReconcileLogger,
  archiveOnlyBatchSize = 1000,
): Promise<Omit<ReconcileResult, "dryRun" | "durationMs">> {
  let stepStarted = performance.now();
  const step = (name: string) => {
    const now = performance.now();
    logger.debug(`step ${name}: ${(now - stepStarted).toFixed(0)} ms`);
    stepStarted = now;
  };

  // 1. Cameras.
  const cameras = await resolveMissingCameras(db);
  logger.debug(`resolved cameras: ${cameras.clipsResolved} clips, ${cameras.protectEventsResolved} Protect events`);
  await analyzeSourceTables(db);
  step("cameras");

  // 2. Matches and candidates: narrowed by the database, decided by the pure rules.
  const protectEvents = await loadProtectEventFacts(db);
  const protectById = new Map(protectEvents.map((event) => [event.id, event]));
  const clipMatches = (await findClipMatchCandidates(config.matchTimeToleranceMs, db)).filter((candidate) => {
    const protectEvent = protectById.get(candidate.protectEventId);
    return (
      protectEvent !== undefined &&
      isClipMatch(
        { cameraId: candidate.cameraId, startAt: candidate.clipStartAt, endAt: candidate.clipEndAt },
        protectEvent,
        config.matchTimeToleranceMs,
      )
    );
  });
  const groupEdges = (await findMultiCameraCandidates(config.multiCameraGroupToleranceMs, db)).filter(({ a, b }) => {
    const first = protectById.get(a);
    const second = protectById.get(b);
    return first !== undefined && second !== undefined && canGroupAcrossCameras(first, second, config.multiCameraGroupToleranceMs);
  });
  const fallbackCandidates = await findTemporalFallbackCandidates(
    config.temporalFallbackStartToleranceMs,
    config.temporalFallbackEndToleranceMs,
    db,
  );
  const fallbackEventIds = await findTemporalFallbackEventIds(db);
  step("candidates");

  // 3. Existing archive events of everything involved (transitively), and every event joined
  //    by the fallback so far: its join is re-checked on every run.
  const memberships = await loadMemberships(
    [...new Set([...clipMatches.map((match) => match.clipId), ...fallbackCandidates.flatMap(({ a, b }) => [a, b])])],
    protectEvents.map((event) => event.id),
    db,
    fallbackEventIds,
  );
  step("memberships");

  // 4. Priority 1 – primary groups: clip ↔ Protect matches, multi-camera metadata groups and the
  //    existing primary groups (what belonged together by metadata stays together).
  const nodes = new Set<string>();
  protectEvents.forEach((event) => nodes.add(protectNode(event.id)));
  clipMatches.forEach((match) => nodes.add(clipNode(match.clipId)));
  fallbackCandidates.forEach(({ a, b }) => nodes.add(clipNode(a)).add(clipNode(b)));
  memberships.clipLinks.forEach((link) => nodes.add(groupNode(link.groupId)).add(clipNode(link.clipId)));
  memberships.protectEventLinks.forEach((link) => nodes.add(groupNode(link.groupId)).add(protectNode(link.protectEventId)));
  const links: [string, string][] = [
    ...clipMatches.map((match): [string, string] => [clipNode(match.clipId), protectNode(match.protectEventId)]),
    ...memberships.clipLinks.map((link): [string, string] => [groupNode(link.groupId), clipNode(link.clipId)]),
    ...memberships.protectEventLinks.map((link): [string, string] => [groupNode(link.groupId), protectNode(link.protectEventId)]),
  ];
  const protectSpans = new Map(
    protectEvents.map((event) => [
      protectNode(event.id),
      { startMs: event.startAt.getTime(), endMs: (event.endAt ?? event.startAt).getTime() },
    ]),
  );
  const grouping = groupComponents({
    nodes: [...nodes],
    links,
    groupEdges: groupEdges.map(({ a, b }): [string, string] => [protectNode(a), protectNode(b)]),
    protectSpans,
    maxSpanMs: config.multiCameraMaxClusterSpanMs,
  });
  const components: Component[] = grouping.components.map((members) => ({
    key: members[0],
    clipIds: members.filter((node) => node.startsWith("clip:")).map(idOf),
    protectIds: members.filter((node) => node.startsWith("pe:")).map(idOf),
    oldGroups: members.filter((node) => node.startsWith("group:")).map(idOf).sort(),
  }));
  const componentOfClip = new Map<string, Component>();
  const componentOfProtect = new Map<string, Component>();
  const componentOfGroup = new Map<string, Component>();
  for (const component of components) {
    component.clipIds.forEach((id) => componentOfClip.set(id, component));
    component.protectIds.forEach((id) => componentOfProtect.set(id, component));
    component.oldGroups.forEach((id) => componentOfGroup.set(id, component));
  }
  step("primary groups");

  // 5. Priority 2 – temporal fallback over whole primary groups. A clip's metadata are the
  //    Protect events matched to exactly this clip; its camera is the fallback camera key
  //    (file-name camera while unresolved).
  const clipFacts = await loadClipFacts([...componentOfClip.keys()], db);
  const matchedProtect = new Map<string, DetectionInterval[]>();
  for (const match of clipMatches) {
    const list = matchedProtect.get(match.clipId) ?? [];
    list.push(protectById.get(match.protectEventId)!);
    matchedProtect.set(match.clipId, list);
  }
  const clipsOfComponent = new Map<string, ClipWithMetadata[]>();
  for (const clip of clipFacts) {
    const key = componentOfClip.get(clip.id)!.key;
    const list = clipsOfComponent.get(key) ?? [];
    list.push({ id: clip.id, cameraId: fallbackCameraKey(clip), startAt: clip.startAt, endAt: clip.endAt, protectEvents: matchedProtect.get(clip.id) ?? [] });
    clipsOfComponent.set(key, list);
  }
  const fallbackGroups: FallbackGroup[] = components.map((component) => {
    const clips = clipsOfComponent.get(component.key) ?? [];
    const cameraIds = new Set<string>();
    clips.forEach((clip) => clip.cameraId && cameraIds.add(clip.cameraId));
    component.protectIds.forEach((id) => {
      const camera = protectById.get(id)?.cameraId;
      if (camera) cameraIds.add(camera);
    });
    return { key: component.key, clips, cameraIds: [...cameraIds] };
  });

  // Current state per event: its links with their primary groups.
  const oldEvents = new Map(
    memberships.events.map((event) => [event.id, { clips: new Map<string, string>(), protect: new Map<string, string>() }]),
  );
  memberships.clipLinks.forEach((link) => oldEvents.get(link.eventId)?.clips.set(link.clipId, link.groupId));
  memberships.protectEventLinks.forEach((link) => oldEvents.get(link.eventId)?.protect.set(link.protectEventId, link.groupId));
  // Order of groups within an event: earliest recording first (then key).
  const firstStart = new Map(
    components.map((component) => [
      component.key,
      Math.min(...(clipsOfComponent.get(component.key) ?? []).map((clip) => clip.startAt.getTime())),
    ]),
  );
  const byFirstStart = (a: Component, b: Component) =>
    firstStart.get(a.key)! - firstStart.get(b.key)! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const componentsOfEvent = (eventId: string) => {
    const event = oldEvents.get(eventId)!;
    const found = new Set<Component>();
    event.clips.forEach((_, id) => found.add(componentOfClip.get(id)!));
    event.protect.forEach((_, id) => found.add(componentOfProtect.get(id)!));
    return [...found].sort(byFirstStart);
  };
  /** The event's own primary group: the one with the event's ID, else its smallest group ID. */
  const anchorGroupOf = (eventId: string) => {
    const event = oldEvents.get(eventId)!;
    const groups = [...event.clips.values(), ...event.protect.values()];
    if (groups.length === 0) return undefined;
    return groups.includes(eventId) ? eventId : groups.reduce((min, group) => (group < min ? group : min));
  };
  // Existing fallback joins, oldest event first; within an event the other groups are tried
  // against the event's own group first, so that group's part keeps the event when one splits.
  const existingPairs: [string, string][] = [];
  for (const { id } of memberships.events) {
    const anchor = anchorGroupOf(id);
    if (anchor === undefined) continue;
    const own = componentOfGroup.get(anchor)!;
    const others = componentsOfEvent(id).filter((component) => component !== own);
    others.forEach((other) => existingPairs.push([own.key, other.key]));
    for (let i = 0; i < others.length; i++)
      for (let j = i + 1; j < others.length; j++) existingPairs.push([others[i].key, others[j].key]);
  }
  const fallback = clusterTemporalFallback({
    groups: fallbackGroups,
    existingPairs,
    candidatePairs: fallbackCandidates.map(({ a, b }): [string, string] => [a, b]),
    config,
  });
  step("temporal fallback");

  // 6. Plan: one archive event per cluster of primary groups.
  const componentByKey = new Map(components.map((component) => [component.key, component]));
  const clustered = new Set(fallback.clusters.flat());
  const finals: Component[][] = [
    ...fallback.clusters.map((keys) => keys.map((key) => componentByKey.get(key)!).sort(byFirstStart)),
    ...components.filter((component) => !clustered.has(component.key)).map((component) => [component]),
  ];
  const finalOfComponent = new Map<string, number>();
  finals.forEach((final, index) => final.forEach((component) => finalOfComponent.set(component.key, index)));

  // IDs: oldest event first; each event stays with the part that holds its own primary group
  // (the group with the event's ID, else its smallest group ID). Events whose part already has
  // an older event are merged into it; parts without any event become new events.
  const finalIds: (string | undefined)[] = finals.map(() => undefined);
  const keptIds = new Set<string>();
  for (const { id } of memberships.events) {
    const anchor = anchorGroupOf(id);
    if (anchor === undefined) continue;
    const index = finalOfComponent.get(componentOfGroup.get(anchor)!.key)!;
    if (finalIds[index] === undefined) {
      finalIds[index] = id;
      keptIds.add(id);
    }
  }

  const planned: PlannedArchiveEvent[] = finals.map((final, index) => {
    const id = finalIds[index];
    const isNew = final.every((component) => component.oldGroups.length === 0);
    const groupIdOf = (component: Component, position: number): string | null => {
      if (component.oldGroups.length > 0) return id && component.oldGroups.includes(id) ? id : component.oldGroups[0];
      // New members only: the first group (earliest recording) of a new event is its own group.
      return isNew && position === 0 ? null : randomUUID();
    };
    const clips: PlannedMember[] = [];
    const protect: PlannedMember[] = [];
    final.forEach((component, position) => {
      const primaryGroupId = groupIdOf(component, position);
      component.clipIds.forEach((clipId) => clips.push({ id: clipId, primaryGroupId }));
      component.protectIds.forEach((protectId) => protect.push({ id: protectId, primaryGroupId }));
    });
    return { id, clips, protectEvents: protect };
  });

  // Work units: plans that share an existing event are written together (merge/split atomic).
  const unitParent = finals.map((_, index) => index);
  const findUnit = (index: number): number => {
    while (unitParent[index] !== index) index = unitParent[index] = unitParent[unitParent[index]];
    return index;
  };
  const finalsOfEvent = new Map<string, Set<number>>();
  for (const eventId of oldEvents.keys()) {
    const indexes = new Set(componentsOfEvent(eventId).map((component) => finalOfComponent.get(component.key)!));
    finalsOfEvent.set(eventId, indexes);
    const [first, ...rest] = [...indexes];
    for (const other of rest) {
      const [a, b] = [findUnit(first), findUnit(other)];
      if (a !== b) unitParent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const eventsOfUnit = new Map<number, string[]>();
  for (const [eventId, indexes] of finalsOfEvent) {
    const unit = findUnit([...indexes][0]);
    eventsOfUnit.set(unit, [...(eventsOfUnit.get(unit) ?? []), eventId]);
  }
  const finalsOfUnit = new Map<number, number[]>();
  finals.forEach((_, index) => {
    const unit = findUnit(index);
    finalsOfUnit.set(unit, [...(finalsOfUnit.get(unit) ?? []), index]);
  });

  const sameLinks = (current: Map<string, string>, members: readonly PlannedMember[], eventId: string) =>
    current.size === members.length &&
    members.every((member) => current.get(member.id) === (member.primaryGroupId ?? eventId));
  const isUnchanged = (index: number) => {
    const id = finalIds[index];
    if (id === undefined) return false;
    const current = oldEvents.get(id)!;
    return sameLinks(current.clips, planned[index].clips, id) && sameLinks(current.protect, planned[index].protectEvents, id);
  };

  // Fallback links before and after: clip pairs of different primary groups in one event.
  const oldLinks = new Set<string>();
  for (const event of oldEvents.values()) {
    const clips = [...event.clips];
    for (let i = 0; i < clips.length; i++)
      for (let j = i + 1; j < clips.length; j++) if (clips[i][1] !== clips[j][1]) oldLinks.add(pairKey(clips[i][0], clips[j][0]));
  }
  const newLinks = new Set<string>();
  for (const final of finals) {
    for (let i = 0; i < final.length; i++)
      for (let j = i + 1; j < final.length; j++)
        for (const a of final[i].clipIds) for (const b of final[j].clipIds) newLinks.add(pairKey(a, b));
  }
  const removedLinks = [...oldLinks].filter((link) => !newLinks.has(link));
  const temporalLinksSuperseded = removedLinks.filter((link) => {
    const [a, b] = link.split(" ");
    return componentOfClip.get(a) === componentOfClip.get(b);
  }).length;

  const linkedClips = new Set(memberships.clipLinks.map((link) => link.clipId));
  const linkedProtectEvents = new Set(memberships.protectEventLinks.map((link) => link.protectEventId));
  let archiveEventsCreated = 0;
  let archiveEventsMerged = 0;
  let relationsCreated = 0;
  let temporalFallbackEventsChanged = 0;
  const archiveEventsSplit = [...finalsOfEvent.values()].filter((indexes) => indexes.size > 1).length;

  const batchEvents: PlannedArchiveEvent[] = [];
  const batchDeletes: string[] = [];
  const flush = async () => {
    if (batchEvents.length === 0 && batchDeletes.length === 0) return;
    const events = batchEvents.splice(0);
    const deletes = batchDeletes.splice(0);
    await applyArchiveEventPlan(events, deletes, db);
    logger.debug(`wrote ${events.length} archive events, merged ${deletes.length}`);
  };
  for (const [unit, indexes] of [...finalsOfUnit].sort((a, b) => a[0] - b[0])) {
    const merged = (eventsOfUnit.get(unit) ?? []).filter((id) => !keptIds.has(id));
    if (merged.length === 0 && indexes.every(isUnchanged)) continue;
    for (const index of indexes) {
      const plan = planned[index];
      batchEvents.push(plan);
      if (plan.id === undefined) archiveEventsCreated++;
      if (finals[index].length > 1) temporalFallbackEventsChanged++;
      relationsCreated += plan.clips.filter((member) => !linkedClips.has(member.id)).length;
      relationsCreated += plan.protectEvents.filter((member) => !linkedProtectEvents.has(member.id)).length;
    }
    batchDeletes.push(...merged);
    archiveEventsMerged += merged.length;
    if (batchEvents.length >= PLAN_BATCH_SIZE) await flush();
  }
  await flush();

  const multiCameraEvents = finals.filter(
    (final) =>
      new Set(final.flatMap((component) => component.protectIds.map((id) => protectById.get(id)?.cameraId)).filter(Boolean)).size > 1,
  ).length;
  step("components");

  // 5. Every other clip: its own archiveOnly event.
  const archiveOnlyCreated = await createArchiveOnlyEventsForUnlinkedClips(db, archiveOnlyBatchSize);
  archiveEventsCreated += archiveOnlyCreated;
  relationsCreated += archiveOnlyCreated;

  // Bulk inserts (e.g. the first import of an existing archive) make the planner statistics
  // stale; refresh them before the queries over all events.
  if (archiveEventsCreated > ANALYZE_AFTER_CREATED) await analyzeArchiveEventTables(db);
  step("archiveOnly");

  // 6. Normalize.
  const emptyEventsDeleted = await deleteEmptyArchiveEvents(db);
  const eventsRecalculated = await recalculateArchiveEvents("all", db);

  step("normalize");
  const totals = await countReconciliationTotals(db);
  return {
    clipsTotal: totals.clips,
    protectEventsTotal: totals.protectEvents,
    clipCamerasResolved: cameras.clipsResolved,
    protectEventCamerasResolved: cameras.protectEventsResolved,
    unresolvedCameraNames: cameras.unresolvedNames,
    clipEventMatches: clipMatches.length,
    relationsCreated,
    archiveEventsCreated,
    archiveEventsMerged,
    archiveEventsSplit,
    multiCameraJoins: grouping.groupEdgesApplied,
    multiCameraRejectedBySpan: grouping.groupEdgesRejected,
    multiCameraEvents,
    temporalCandidates: fallbackCandidates.length,
    temporalRejectedByMetadata: fallback.candidatePairsRejectedByMetadata,
    temporalRejectedByCluster: fallback.candidatePairsRejectedByCluster,
    temporalFallbackEvents: finals.filter((final) => final.length > 1).length,
    temporalFallbackEventsChanged,
    temporalLinksAdded: [...newLinks].filter((link) => !oldLinks.has(link)).length,
    temporalLinksRemoved: removedLinks.length,
    temporalLinksSuperseded,
    emptyEventsDeleted,
    eventsRecalculated,
    status: await countArchiveEventsByStatus(db),
  };
}
