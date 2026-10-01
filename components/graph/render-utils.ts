import type { Point } from "@/lib/graph/view";

const LABEL_LENGTH = 26;
export function towards(from: Point, to: Point, distance: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: from.x + (dx / length) * distance,
    y: from.y + (dy / length) * distance,
  };
}

/** Server and browser math libraries differ in the last digit; rounding keeps markup stable. */
export function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function truncate(title: string) {
  return title.length > LABEL_LENGTH
    ? `${title.slice(0, LABEL_LENGTH - 1)}…`
    : title;
}
