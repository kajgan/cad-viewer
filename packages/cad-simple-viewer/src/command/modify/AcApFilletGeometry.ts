import {
  AcDbArc,
  AcDbDatabase,
  AcDbEntity,
  AcDbLine,
  AcDbPolyline,
  AcGeLine3d,
  AcGeMathUtil,
  AcGePoint2d,
  AcGePoint3d,
  AcGePoint3dLike,
  AcGeTol,
  DEFAULT_TOL
} from '@mlightcad/data-model'

/** Geometric epsilon for near-zero lengths and parallel tests. */
const EPS = 1e-8

/**
 * One finite segment participating in a FILLET, with the user pick that
 * identifies which side of the intersection to keep.
 */
export interface AcApFilletSegment {
  /** Segment start in WCS. */
  start: AcGePoint3dLike
  /** Segment end in WCS. */
  end: AcGePoint3dLike
  /** Pick point used to choose the kept half of the segment. */
  pick: AcGePoint3dLike
}

/**
 * Arc created by a positive-radius fillet.
 */
export interface AcApFilletArc {
  /** Fillet center. */
  center: AcGePoint3d
  /** Fillet radius. */
  radius: number
  /** CCW start angle in radians. */
  startAngle: number
  /** CCW end angle in radians. */
  endAngle: number
  /**
   * Polyline bulge for walking from {@link AcApFilletComputeOk.join1} to
   * {@link AcApFilletComputeOk.join2}.
   */
  bulge: number
}

/**
 * Successful FILLET geometry: trimmed endpoints plus an optional connecting arc.
 */
export interface AcApFilletComputeOk {
  status: 'ok'
  /** Tangent or meet point on the first segment. */
  join1: AcGePoint3d
  /** Kept original endpoint of the first segment. */
  far1: AcGePoint3d
  /** Tangent or meet point on the second segment. */
  join2: AcGePoint3d
  /** Kept original endpoint of the second segment. */
  far2: AcGePoint3d
  /** Connecting fillet arc; omitted when the radius is 0. */
  arc?: AcApFilletArc
}

/**
 * FILLET computation result.
 *
 * - `ok` — remaining line ends and optional arc
 * - `parallel` — lines do not meet at a unique intersection
 * - `degenerate` — radius or picks cannot produce a fillet
 */
export type AcApFilletComputeResult =
  | AcApFilletComputeOk
  | { status: 'parallel' }
  | { status: 'degenerate' }

/**
 * Copies layer, color, linetype, and related display traits from one entity to another.
 *
 * @param source - Entity to copy traits from.
 * @param target - Entity to receive traits.
 */
function copyDisplayTraits(source: AcDbEntity, target: AcDbEntity): void {
  target.layer = source.layer
  target.color = source.color.clone()
  target.lineType = source.lineType
  target.lineWeight = source.lineWeight
  target.linetypeScale = source.linetypeScale
  target.transparency = source.transparency
  target.visibility = source.visibility
}

/**
 * Unclamped parameter of `point` along the infinite line through `start` and `end`.
 *
 * @param start - Line start.
 * @param end - Line end.
 * @param point - Query point.
 * @returns Parameter where 0 is `start` and 1 is `end`.
 */
function sameXy(a: AcGePoint3dLike, b: AcGePoint3dLike): boolean {
  return DEFAULT_TOL.equalPoint2d({ x: a.x, y: a.y }, { x: b.x, y: b.y })
}

/**
 * Unclamped parameter of `point` along the infinite line through `start` and `end`.
 *
 * @param start - Line start.
 * @param end - Line end.
 * @param point - Query point.
 * @returns Parameter where 0 is `start` and 1 is `end`.
 */
function unclampedT(
  start: AcGePoint3dLike,
  end: AcGePoint3dLike,
  point: AcGePoint3dLike
): number {
  const geo = new AcGeLine3d(start, end)
  return geo.closestPointToPointParameter(
    new AcGePoint3d(point.x, point.y, point.z ?? 0),
    false
  )
}

/**
 * Intersection of two infinite 2D lines, or `null` when they are parallel.
 *
 * @param a1 - First line start.
 * @param a2 - First line end.
 * @param b1 - Second line start.
 * @param b2 - Second line end.
 * @returns Intersection in WCS, or `null`.
 */
export function intersectInfiniteLines(
  a1: AcGePoint3dLike,
  a2: AcGePoint3dLike,
  b1: AcGePoint3dLike,
  b2: AcGePoint3dLike
): AcGePoint3d | null {
  const dax = a2.x - a1.x
  const day = a2.y - a1.y
  const dbx = b2.x - b1.x
  const dby = b2.y - b1.y
  const den = dax * dby - day * dbx
  if (Math.abs(den) < EPS) return null
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den
  return new AcGePoint3d(a1.x + t * dax, a1.y + t * day, 0)
}

/**
 * Unit XY vector, or `null` when the length is degenerate.
 *
 * @param x - X component.
 * @param y - Y component.
 * @returns Unit vector, or `null`.
 */
function unit2(x: number, y: number): { x: number; y: number } | null {
  const len = Math.hypot(x, y)
  if (len < EPS) return null
  return { x: x / len, y: y / len }
}

/**
 * Direction from the intersection along the picked half of a segment.
 *
 * @param start - Segment start.
 * @param end - Segment end.
 * @param intersection - Line-line intersection.
 * @param pick - User pick on the kept side.
 * @returns Unit direction from the intersection toward the pick.
 */
function pickSideDirection(
  start: AcGePoint3dLike,
  end: AcGePoint3dLike,
  intersection: AcGePoint3dLike,
  pick: AcGePoint3dLike
): { x: number; y: number } | null {
  const tI = unclampedT(start, end, intersection)
  const tP = unclampedT(start, end, pick)
  let side = tP - tI
  if (Math.abs(side) < EPS) {
    side = Math.abs(1 - tI) >= Math.abs(tI) ? 1 - tI : -tI
  }
  const unit = unit2(end.x - start.x, end.y - start.y)
  if (!unit) return null
  return side >= 0 ? unit : { x: -unit.x, y: -unit.y }
}

/**
 * Original endpoint kept after trimming a segment to `join`.
 *
 * @param start - Segment start.
 * @param end - Segment end.
 * @param join - New endpoint at the fillet or intersection.
 * @param pick - User pick on the kept side.
 * @returns Endpoint that remains with `join`.
 */
function keptEndpoint(
  start: AcGePoint3dLike,
  end: AcGePoint3dLike,
  join: AcGePoint3dLike,
  pick: AcGePoint3dLike
): AcGePoint3d {
  const tJ = unclampedT(start, end, join)
  const tP = unclampedT(start, end, pick)
  let side = Math.sign(tP - tJ)
  if (side === 0) {
    side = Math.abs(1 - tJ) >= Math.abs(tJ) ? 1 : -1
  }
  const candidates: Array<{ t: number; point: AcGePoint3dLike }> = []
  const s0 = Math.sign(0 - tJ)
  const s1 = Math.sign(1 - tJ)
  if (s0 === side) candidates.push({ t: 0, point: start })
  if (s1 === side) candidates.push({ t: 1, point: end })
  if (candidates.length === 0) {
    return Math.abs(0 - tJ) >= Math.abs(1 - tJ)
      ? new AcGePoint3d(start.x, start.y, start.z ?? 0)
      : new AcGePoint3d(end.x, end.y, end.z ?? 0)
  }
  candidates.sort((a, b) => Math.abs(b.t - tJ) - Math.abs(a.t - tJ))
  const point = candidates[0].point
  return new AcGePoint3d(point.x, point.y, point.z ?? 0)
}

/**
 * Closest point on the infinite line through `start` and `end`.
 *
 * @param start - Line start.
 * @param end - Line end.
 * @param point - Query point.
 * @returns Closest point on the infinite line.
 */
function projectToInfiniteLine(
  start: AcGePoint3dLike,
  end: AcGePoint3dLike,
  point: AcGePoint3dLike
): AcGePoint3d {
  const t = unclampedT(start, end, point)
  return new AcGePoint3d(
    start.x + t * (end.x - start.x),
    start.y + t * (end.y - start.y),
    0
  )
}

/**
 * True when `join` lies strictly between the intersection and the kept endpoint.
 *
 * @param intersection - Line-line intersection.
 * @param join - Fillet tangent or meet point.
 * @param far - Kept original endpoint.
 * @param start - Segment start.
 * @param end - Segment end.
 * @returns `true` when the fillet fits on the picked side.
 */
function joinBetweenIntersectionAndFar(
  intersection: AcGePoint3dLike,
  join: AcGePoint3dLike,
  far: AcGePoint3dLike,
  start: AcGePoint3dLike,
  end: AcGePoint3dLike
): boolean {
  const tI = unclampedT(start, end, intersection)
  const tJ = unclampedT(start, end, join)
  const tF = unclampedT(start, end, far)
  const sJ = tJ - tI
  const sF = tF - tI
  return sJ * sF > EPS * EPS && Math.abs(sJ) < Math.abs(sF) - EPS
}

/**
 * Computes fillet geometry for two segments and a radius.
 *
 * Radius 0 extends or trims both segments so they meet at their intersection.
 * A positive radius inserts a tangent arc in the angle selected by the picks.
 *
 * @param seg1 - First segment and pick.
 * @param seg2 - Second segment and pick.
 * @param radius - Fillet radius; 0 means a sharp corner.
 * @returns Fillet endpoints and optional arc, or a failure status.
 */
export function computeFillet(
  seg1: AcApFilletSegment,
  seg2: AcApFilletSegment,
  radius: number
): AcApFilletComputeResult {
  if (!Number.isFinite(radius) || radius < 0) return { status: 'degenerate' }

  const intersection = intersectInfiniteLines(
    seg1.start,
    seg1.end,
    seg2.start,
    seg2.end
  )
  if (!intersection) return { status: 'parallel' }

  const d1 = pickSideDirection(seg1.start, seg1.end, intersection, seg1.pick)
  const d2 = pickSideDirection(seg2.start, seg2.end, intersection, seg2.pick)
  if (!d1 || !d2) return { status: 'degenerate' }

  const cross = d1.x * d2.y - d1.y * d2.x
  const dot = d1.x * d2.x + d1.y * d2.y
  const alpha = Math.atan2(cross, dot)
  if (Math.abs(Math.sin(alpha)) < 1e-6) return { status: 'parallel' }

  if (AcGeTol.equalToZero(radius)) {
    const far1 = keptEndpoint(seg1.start, seg1.end, intersection, seg1.pick)
    const far2 = keptEndpoint(seg2.start, seg2.end, intersection, seg2.pick)
    if (sameXy(far1, intersection) || sameXy(far2, intersection)) {
      return { status: 'degenerate' }
    }
    return {
      status: 'ok',
      join1: intersection.clone(),
      far1,
      join2: intersection.clone(),
      far2
    }
  }

  const half = Math.abs(alpha) / 2
  const dist = radius / Math.sin(half)
  if (!Number.isFinite(dist) || dist > 1e12) return { status: 'degenerate' }

  const halfRot = alpha / 2
  const cos = Math.cos(halfRot)
  const sin = Math.sin(halfRot)
  const bisector = {
    x: d1.x * cos - d1.y * sin,
    y: d1.x * sin + d1.y * cos
  }
  const bisUnit = unit2(bisector.x, bisector.y)
  if (!bisUnit) return { status: 'degenerate' }

  const center = new AcGePoint3d(
    intersection.x + bisUnit.x * dist,
    intersection.y + bisUnit.y * dist,
    0
  )
  const join1 = projectToInfiniteLine(seg1.start, seg1.end, center)
  const join2 = projectToInfiniteLine(seg2.start, seg2.end, center)
  const far1 = keptEndpoint(seg1.start, seg1.end, join1, seg1.pick)
  const far2 = keptEndpoint(seg2.start, seg2.end, join2, seg2.pick)
  if (sameXy(far1, join1) || sameXy(far2, join2)) return { status: 'degenerate' }
  if (
    !joinBetweenIntersectionAndFar(
      intersection,
      join1,
      far1,
      seg1.start,
      seg1.end
    ) ||
    !joinBetweenIntersectionAndFar(
      intersection,
      join2,
      far2,
      seg2.start,
      seg2.end
    )
  ) {
    return { status: 'degenerate' }
  }

  const towardI = unit2(
    intersection.x - center.x,
    intersection.y - center.y
  )
  if (!towardI) return { status: 'degenerate' }
  const mid = {
    x: center.x + towardI.x * radius,
    y: center.y + towardI.y * radius
  }
  const a1 = AcGeMathUtil.normalizeAngle(
    Math.atan2(join1.y - center.y, join1.x - center.x)
  )
  const a2 = AcGeMathUtil.normalizeAngle(
    Math.atan2(join2.y - center.y, join2.x - center.x)
  )
  const midAngle = AcGeMathUtil.normalizeAngle(
    Math.atan2(mid.y - center.y, mid.x - center.x)
  )
  const ccwThroughMid = AcGeMathUtil.isAngleOnCcwSweep(a1, midAngle, a2)
  const startAngle = ccwThroughMid ? a1 : a2
  const endAngle = ccwThroughMid ? a2 : a1
  const sweep = AcGeMathUtil.normalizeAngle(endAngle - startAngle)
  const bulge = ccwThroughMid ? Math.tan(sweep / 4) : -Math.tan(sweep / 4)

  return {
    status: 'ok',
    join1,
    far1,
    join2,
    far2,
    arc: {
      center,
      radius,
      startAngle,
      endAngle,
      bulge
    }
  }
}

/**
 * Applies a line-line fillet: shortens both lines and appends the arc when needed.
 *
 * @param db - Drawing database.
 * @param line1 - First line, opened for write.
 * @param line2 - Second line, opened for write.
 * @param result - Successful fillet geometry.
 * @returns The new arc when one was created.
 */
export function applyFilletLines(
  db: AcDbDatabase,
  line1: AcDbLine,
  line2: AcDbLine,
  result: AcApFilletComputeOk
): AcDbArc | undefined {
  const opened1 = (db.openEntityForWrite(line1.objectId) as AcDbLine) ?? line1
  const opened2 = (db.openEntityForWrite(line2.objectId) as AcDbLine) ?? line2
  opened1.startPoint = result.join1
  opened1.endPoint = result.far1
  opened2.startPoint = result.join2
  opened2.endPoint = result.far2

  if (!result.arc) return undefined
  const arc = new AcDbArc(
    result.arc.center,
    result.arc.radius,
    result.arc.startAngle,
    result.arc.endAngle
  )
  copyDisplayTraits(opened1, arc)
  db.tables.blockTable.modelSpace.appendEntity(arc)
  return arc
}

/**
 * Finds the polyline segment closest to a pick point.
 *
 * @param polyline - Source polyline.
 * @param pick - Pick point in WCS.
 * @returns Segment index, or `-1` when the polyline has no segments.
 */
export function closestPolylineSegment(
  polyline: AcDbPolyline,
  pick: AcGePoint3dLike
): number {
  const count = polyline.closed
    ? polyline.numberOfVertices
    : polyline.numberOfVertices - 1
  if (count <= 0) return -1
  const pickPoint = new AcGePoint3d(pick.x, pick.y, pick.z ?? 0)
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < count; i++) {
    const start = polyline.getPoint3dAt(i)
    const end = polyline.getPoint3dAt((i + 1) % polyline.numberOfVertices)
    const geo = new AcGeLine3d(start, end)
    const closest = new AcGePoint3d()
    geo.closestPointToPoint(pickPoint, true, closest)
    const dist = pickPoint.distanceTo(closest)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

/**
 * Shared vertex index of two adjacent polyline segments, or `-1`.
 *
 * @param polyline - Source polyline.
 * @param segA - First segment index.
 * @param segB - Second segment index.
 * @returns Vertex index between the segments.
 */
export function sharedPolylineVertex(
  polyline: AcDbPolyline,
  segA: number,
  segB: number
): number {
  if (segA === segB || segA < 0 || segB < 0) return -1
  const n = polyline.numberOfVertices
  const closed = polyline.closed
  const next = (index: number) => (closed ? (index + 1) % n : index + 1)
  if (next(segA) === segB) return next(segA)
  if (next(segB) === segA) return next(segB)
  return -1
}

/**
 * Applies a fillet to one polyline vertex by replacing it with the tangent points.
 *
 * @param db - Drawing database.
 * @param polyline - Polyline to modify.
 * @param vertexIndex - Corner vertex to fillet.
 * @param result - Successful fillet geometry.
 */
export function applyFilletPolylineVertex(
  db: AcDbDatabase,
  polyline: AcDbPolyline,
  vertexIndex: number,
  result: AcApFilletComputeOk
): void {
  if (!result.arc) return
  const opened =
    (db.openEntityForWrite(polyline.objectId) as AcDbPolyline) ?? polyline
  opened.removeVertexAt(vertexIndex)
  opened.addVertexAt(
    vertexIndex,
    new AcGePoint2d(result.join1.x, result.join1.y),
    result.arc.bulge
  )
  opened.addVertexAt(
    vertexIndex + 1,
    new AcGePoint2d(result.join2.x, result.join2.y)
  )
}

/**
 * Finite polyline segment from vertex `index` to the next vertex.
 *
 * @param polyline - Source polyline.
 * @param index - Segment start vertex.
 * @returns Segment endpoints.
 */
export function polylineSegmentAt(
  polyline: AcDbPolyline,
  index: number
): { start: AcGePoint3d; end: AcGePoint3d } {
  const n = polyline.numberOfVertices
  return {
    start: polyline.getPoint3dAt(index),
    end: polyline.getPoint3dAt((index + 1) % n)
  }
}

/**
 * Incoming and outgoing straight-segment indices at a polyline vertex.
 *
 * @param polyline - Source polyline.
 * @param vertexIndex - Corner vertex.
 * @returns Adjacent segment indices, or `null` at an open-polyline endpoint.
 */
export function adjacentSegmentsAtVertex(
  polyline: AcDbPolyline,
  vertexIndex: number
): { incoming: number; outgoing: number } | null {
  const n = polyline.numberOfVertices
  if (n < 2) return null
  if (polyline.closed) {
    if (n < 3) return null
    return {
      incoming: (vertexIndex - 1 + n) % n,
      outgoing: vertexIndex
    }
  }
  if (vertexIndex <= 0 || vertexIndex >= n - 1) return null
  return { incoming: vertexIndex - 1, outgoing: vertexIndex }
}

/**
 * True when the polyline segment starting at `index` is straight (zero bulge).
 *
 * @param polyline - Source polyline.
 * @param index - Segment start vertex.
 * @returns `true` when the segment has no bulge.
 */
export function isStraightPolylineSegment(
  polyline: AcDbPolyline,
  index: number
): boolean {
  const getBulgeAt = (
    polyline as unknown as { getBulgeAt?: (i: number) => number }
  ).getBulgeAt
  const bulge = getBulgeAt?.call(polyline, index) ?? 0
  return Math.abs(bulge) < EPS
}
