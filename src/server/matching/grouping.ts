/**
 * Deterministic clustering of clips, Protect events and existing archive events into the
 * future archive events (connected components). Pure: no database, no clock.
 *
 * - `links` are always followed: existing relations (an event keeps what it has) and
 *   clip ↔ Protect event matches (several Protect events in one clip end up together).
 * - `groupEdges` (multi-camera candidates) are applied in a fixed order and only if the
 *   resulting cluster's Protect event span stays within `maxSpanMs`. This stops chains like
 *   A–B–C–D… (each 2 s apart) from becoming one long event.
 */

export interface ProtectSpan {
  startMs: number;
  /** End, or start for an ongoing event. */
  endMs: number;
}

export interface GroupingInput {
  nodes: readonly string[];
  links: readonly (readonly [string, string])[];
  groupEdges: readonly (readonly [string, string])[];
  /** Time span of each Protect event node (other nodes have none). */
  protectSpans: ReadonlyMap<string, ProtectSpan>;
  maxSpanMs: number;
}

export interface GroupingResult {
  /** Components, members sorted; components sorted by their first member. */
  components: string[][];
  /** Multi-camera edges that joined two different clusters. */
  groupEdgesApplied: number;
  /** Multi-camera edges rejected because the cluster would exceed `maxSpanMs`. */
  groupEdgesRejected: number;
}

export function groupComponents({ nodes, links, groupEdges, protectSpans, maxSpanMs }: GroupingInput): GroupingResult {
  const parent = new Map<string, string>();
  const span = new Map<string, ProtectSpan | undefined>();
  for (const node of nodes) {
    parent.set(node, node);
    span.set(node, protectSpans.get(node));
  }

  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    let current = node;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const merged = (a: ProtectSpan | undefined, b: ProtectSpan | undefined): ProtectSpan | undefined =>
    a && b ? { startMs: Math.min(a.startMs, b.startMs), endMs: Math.max(a.endMs, b.endMs) } : (a ?? b);
  const union = (a: string, b: string) => {
    // Deterministic root: the smaller key.
    const [root, child] = a < b ? [a, b] : [b, a];
    parent.set(child, root);
    span.set(root, merged(span.get(root), span.get(child)));
  };

  for (const [a, b] of links) {
    if (!parent.has(a) || !parent.has(b)) throw new Error(`link between unknown nodes ${a} – ${b}`);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) union(ra, rb);
  }

  // Fixed order: earliest pair first, then by keys.
  const edgeStart = ([a, b]: readonly [string, string]) =>
    Math.min(protectSpans.get(a)?.startMs ?? Infinity, protectSpans.get(b)?.startMs ?? Infinity);
  const ordered = [...groupEdges].sort(
    (x, y) => edgeStart(x) - edgeStart(y) || (x[0] + x[1] < y[0] + y[1] ? -1 : x[0] + x[1] > y[0] + y[1] ? 1 : 0),
  );

  let groupEdgesApplied = 0;
  let groupEdgesRejected = 0;
  for (const [a, b] of ordered) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const combined = merged(span.get(ra), span.get(rb));
    if (combined && combined.endMs - combined.startMs > maxSpanMs) {
      groupEdgesRejected++;
      continue;
    }
    union(ra, rb);
    groupEdgesApplied++;
  }

  const byRoot = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node);
    const members = byRoot.get(root);
    if (members) members.push(node);
    else byRoot.set(root, [node]);
  }
  const components = [...byRoot.values()].map((members) => members.sort()).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return { components, groupEdgesApplied, groupEdgesRejected };
}
