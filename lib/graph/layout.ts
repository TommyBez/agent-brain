// Deterministic force-directed layout for the knowledge graph. Pure and
// framework-independent so the browser can animate it frame by frame and
// tests can settle it synchronously.

export interface LayoutInputNode {
  id: string;
}

export interface LayoutInputLink {
  sourceId: string;
  targetId: string;
}

export interface LayoutNode {
  id: string;
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned position after a drag; null while free. */
  fx: number | null;
  fy: number | null;
  r: number;
  degree: number;
  /** No links inside this graph while other pages are connected. */
  isolated: boolean;
}

export interface LayoutLink {
  source: number;
  target: number;
  distance: number;
}

export interface Layout {
  nodes: LayoutNode[];
  links: LayoutLink[];
  /** Simulation temperature; the layout is settled once it drops below ALPHA_MIN. */
  alpha: number;
  /** Radius of the orbit holding unlinked pages, 0 when every page is linked. */
  ring: number;
  seed: number;
}

export const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 0.035;
const VELOCITY_DECAY = 0.6;
const REPULSION = -280;
const REPULSION_MAX_DISTANCE = 520;
const GRAVITY = 0.05;
const RING_STRENGTH = 0.35;
const COLLISION_PADDING = 5;
const COLLISION_STRENGTH = 0.7;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function nodeRadius(degree: number) {
  return 6 + Math.min(12, 2.4 * Math.sqrt(degree));
}

/** FNV-1a hash, so equal graphs always produce equal layouts. */
export function hashSeed(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small seeded generator, uniform in [0, 1). */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Links connect distinct nodes in the supplied graph, as returned by getGraph. */
export function createLayout(
  inputNodes: LayoutInputNode[],
  inputLinks: LayoutInputLink[],
  seed = 1,
): Layout {
  const indexById = new Map(inputNodes.map((node, index) => [node.id, index]));
  const degree = new Array<number>(inputNodes.length).fill(0);
  const pairs: [number, number][] = [];
  for (const link of inputLinks) {
    const source = indexById.get(link.sourceId) as number;
    const target = indexById.get(link.targetId) as number;
    pairs.push([source, target]);
    degree[source] += 1;
    degree[target] += 1;
  }
  const connectedCount = degree.filter((value) => value > 0).length;
  const isolatedCount =
    connectedCount > 0 ? inputNodes.length - connectedCount : 0;
  const coreCount = connectedCount || inputNodes.length;
  const coreRadius = Math.max(90, 34 * Math.sqrt(coreCount));
  const ring = isolatedCount ? Math.max(coreRadius + 70, 7 * isolatedCount) : 0;
  const random = seededRandom(seed);
  const ringOffset = random() * Math.PI * 2;
  let coreIndex = 0;
  let ringIndex = 0;
  const nodes: LayoutNode[] = inputNodes.map((node, index) => {
    const isolated = connectedCount > 0 && degree[index] === 0;
    let x: number;
    let y: number;
    if (isolated) {
      const angle = ringOffset + (ringIndex / isolatedCount) * Math.PI * 2;
      ringIndex += 1;
      x = Math.cos(angle) * ring;
      y = Math.sin(angle) * ring;
    } else {
      // Sunflower placement spreads the core evenly before forces refine it.
      const angle = coreIndex * GOLDEN_ANGLE + random() * 0.4;
      const radius = coreRadius * Math.sqrt((coreIndex + 0.5) / coreCount);
      coreIndex += 1;
      x = Math.cos(angle) * radius + (random() - 0.5) * 8;
      y = Math.sin(angle) * radius + (random() - 0.5) * 8;
    }
    return {
      id: node.id,
      index,
      x,
      y,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      r: nodeRadius(degree[index]),
      degree: degree[index],
      isolated,
    };
  });
  const links: LayoutLink[] = pairs.map(([source, target]) => ({
    source,
    target,
    distance: Math.min(
      130,
      60 + 12 * Math.sqrt(Math.max(degree[source], degree[target])),
    ),
  }));
  return { nodes, links, alpha: 1, ring, seed };
}

/** Advances the simulation one step. Returns false once the layout is settled. */
export function tick(layout: Layout) {
  if (layout.alpha < ALPHA_MIN) return false;
  const { nodes, links } = layout;
  const alpha = layout.alpha;
  layout.alpha += (0 - alpha) * ALPHA_DECAY;
  const jitter = seededRandom(layout.seed + Math.round(alpha * 1e6));

  for (const link of links) {
    const source = nodes[link.source];
    const target = nodes[link.target];
    let dx = target.x + target.vx - source.x - source.vx;
    let dy = target.y + target.vy - source.y - source.vy;
    if (dx === 0 && dy === 0) {
      dx = (jitter() - 0.5) * 1e-4;
      dy = (jitter() - 0.5) * 1e-4;
    }
    const length = Math.hypot(dx, dy);
    const strength = 1 / Math.min(source.degree, target.degree);
    const pull = ((length - link.distance) / length) * alpha * strength;
    const bias = source.degree / (source.degree + target.degree);
    target.vx -= dx * pull * bias;
    target.vy -= dy * pull * bias;
    source.vx += dx * pull * (1 - bias);
    source.vy += dy * pull * (1 - bias);
  }

  const maxDistanceSquared = REPULSION_MAX_DISTANCE * REPULSION_MAX_DISTANCE;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let squared = dx * dx + dy * dy;
      if (squared === 0) {
        dx = (jitter() - 0.5) * 1e-3;
        dy = (jitter() - 0.5) * 1e-3;
        squared = dx * dx + dy * dy;
      }
      const length = Math.sqrt(squared);
      const minimum = a.r + b.r + COLLISION_PADDING;
      if (length < minimum) {
        const push = ((minimum - length) / length) * COLLISION_STRENGTH;
        a.vx -= dx * push * 0.5;
        a.vy -= dy * push * 0.5;
        b.vx += dx * push * 0.5;
        b.vy += dy * push * 0.5;
      }
      if (squared > maxDistanceSquared) continue;
      // REPULSION is negative: a is pushed away from b and b away from a.
      const force = (REPULSION * alpha) / Math.max(squared, 100);
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }

  for (const node of nodes) {
    if (node.isolated) {
      const distance = Math.hypot(node.x, node.y) || 1e-6;
      const k = ((layout.ring - distance) / distance) * RING_STRENGTH * alpha;
      node.vx += node.x * k;
      node.vy += node.y * k;
    } else {
      node.vx -= node.x * GRAVITY * alpha;
      node.vy -= node.y * GRAVITY * alpha;
    }
  }

  for (const node of nodes) {
    if (node.fx !== null && node.fy !== null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= VELOCITY_DECAY;
    node.vy *= VELOCITY_DECAY;
    node.x += node.vx;
    node.y += node.vy;
  }
  return layout.alpha >= ALPHA_MIN;
}

/** Runs the simulation to completion synchronously. */
export function settle(layout: Layout, maxTicks = 600) {
  let ticks = 0;
  while (ticks < maxTicks && tick(layout)) ticks += 1;
  return layout;
}

/** Warms a settled layout so nearby nodes react to a moved neighbor. */
export function reheat(layout: Layout, alpha = 0.3) {
  layout.alpha = Math.max(layout.alpha, alpha);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(
  nodes: Iterable<Pick<LayoutNode, "x" | "y" | "r">>,
): Bounds | null {
  let result: Bounds | null = null;
  for (const node of nodes) {
    if (!result) {
      result = {
        minX: node.x - node.r,
        minY: node.y - node.r,
        maxX: node.x + node.r,
        maxY: node.y + node.r,
      };
      continue;
    }
    result.minX = Math.min(result.minX, node.x - node.r);
    result.minY = Math.min(result.minY, node.y - node.r);
    result.maxX = Math.max(result.maxX, node.x + node.r);
    result.maxY = Math.max(result.maxY, node.y + node.r);
  }
  return result;
}
