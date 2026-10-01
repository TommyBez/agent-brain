import { bounds, type Layout } from "./layout";
export interface View {
  k: number;
  tx: number;
  ty: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const FIT_MAX_ZOOM = 1.4;
const FIT_PADDING = 56;
export function clampZoom(k: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

export function zoomAt(view: View, point: Point, factor: number): View {
  const k = clampZoom(view.k * factor);
  const wx = (point.x - view.tx) / view.k;
  const wy = (point.y - view.ty) / view.k;
  return { k, tx: point.x - wx * k, ty: point.y - wy * k };
}

export function fitView(
  layout: Layout,
  visible: ReadonlySet<string>,
  size: Size | null,
): View | null {
  if (!size || !size.width || !size.height) return null;
  const shown = layout.nodes.filter((node) => visible.has(node.id));
  const box = bounds(shown.length ? shown : layout.nodes);
  if (!box) return null;
  const width = Math.max(box.maxX - box.minX, 1);
  const height = Math.max(box.maxY - box.minY, 1);
  const k = clampZoom(
    Math.min(
      (size.width - FIT_PADDING * 2) / width,
      (size.height - FIT_PADDING * 2) / height,
      FIT_MAX_ZOOM,
    ),
  );
  return {
    k,
    tx: size.width / 2 - ((box.minX + box.maxX) / 2) * k,
    ty: size.height / 2 - ((box.minY + box.maxY) / 2) * k,
  };
}
