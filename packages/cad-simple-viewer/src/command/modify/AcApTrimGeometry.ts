import {
  AcDbArc,
  AcDbCircle,
  AcDbCurve,
  AcDbDatabase,
  AcDbEntity,
  AcDbLine,
  AcDbObjectId,
  AcDbPolyline,
  AcGeLine3d,
  AcGeMathUtil,
  AcGePoint2d,
  AcGePoint3d,
  AcGePoint3dLike,
  DEFAULT_TOL
} from '@mlightcad/data-model'

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

/** Parameter epsilon used to ignore cuts that coincide with endpoints. */
const PARAM_EPS = 1e-7

/**
 * Remaining geometry produced by a successful TRIM.
 *
 * The original entity is replaced by these pieces: one piece can be applied
 * in place, and extra pieces are appended as new entities.
 */
export type AcApTrimPiece =
  | {
      kind: 'line'
      start: AcGePoint3d
      end: AcGePoint3d
    }
  | {
      kind: 'arc'
      center: AcGePoint3d
      radius: number
      startAngle: number
      endAngle: number
      normal: AcGePoint3dLike
      thickness: number
    }
  | {
      kind: 'polyline'
      points: AcGePoint3d[]
      elevation: number
      thickness: number
      normal: AcGePoint3dLike
    }

/**
 * Result of computing a TRIM against one picked entity.
 *
 * - `ok` — remaining pieces (empty means erase the original)
 * - `none` — no cutting intersection on the picked portion
 * - `unsupported` — entity type cannot be trimmed
 */
export type AcApTrimComputeResult =
  | { status: 'ok'; pieces: AcApTrimPiece[] }
  | { status: 'none' }
  | { status: 'unsupported' }

/**
 * Returns unique increasing numbers, merging values within `eps`.
 *
 * @param values - Raw parameter or angle values.
 * @param eps - Merge tolerance.
 * @returns Sorted unique values.
 */
export function uniqueSorted(values: number[], eps = PARAM_EPS): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const out: number[] = []
  for (const value of sorted) {
    if (out.length === 0 || value - out[out.length - 1] > eps) {
      out.push(value)
    }
  }
  return out
}

/**
 * Polar angle of `point` around `center` in the XY plane, normalized to `[0, 2π)`.
 *
 * @param center - Arc or circle center.
 * @param point - Point on or near the circle.
 * @returns Angle in radians.
 */
export function angleAtCenter(
  center: AcGePoint3dLike,
  point: AcGePoint3dLike
): number {
  return AcGeMathUtil.normalizeAngle(
    Math.atan2(point.y - center.y, point.x - center.x)
  )
}

/**
 * True when `mid` lies strictly inside the counterclockwise sweep `(start, end)`.
 *
 * @param start - Sweep start angle in radians.
 * @param mid - Candidate angle in radians.
 * @param end - Sweep end angle in radians.
 * @returns `true` when `mid` is interior to the sweep.
 */
function isStrictlyOnCcwSweep(start: number, mid: number, end: number): boolean {
  const total = AcGeMathUtil.normalizeAngle(end - start)
  const offset = AcGeMathUtil.normalizeAngle(mid - start)
  if (total <= PARAM_EPS) return false
  return offset > PARAM_EPS && offset < total - PARAM_EPS
}

/**
 * Collects intersection points between `target` and `cutters`, skipping self.
 *
 * @param target - Entity being trimmed.
 * @param cutters - Cutting-edge entities.
 * @returns Intersection points in WCS.
 */
function collectIntersections(
  target: AcDbEntity,
  cutters: AcDbEntity[]
): AcGePoint3d[] {
  const points: AcGePoint3d[] = []
  for (const cutter of cutters) {
    if (cutter.objectId && cutter.objectId === target.objectId) continue
    let hits: AcGePoint3d[] = []
    try {
      hits = target.intersectWith(cutter)
    } catch {
      hits = []
    }
    for (const hit of hits) {
      if (
        points.some(existing => DEFAULT_TOL.equalPoint3d(existing, hit))
      ) {
        continue
      }
      points.push(hit)
    }
  }
  return points
}

/**
 * Finds the open interval index that strictly contains `pick`.
 *
 * @param params - Sorted inclusive boundary parameters.
 * @param pick - Parameter of the user pick.
 * @returns Interval index, or `-1` when the pick is on a cut or outside.
 */
function findOpenIntervalIndex(params: number[], pick: number): number {
  for (let i = 0; i < params.length - 1; i++) {
    if (pick > params[i] + PARAM_EPS && pick < params[i + 1] - PARAM_EPS) {
      return i
    }
  }
  return -1
}

/**
 * Keeps every interval except `removed` and drops degenerate leftovers.
 *
 * @param params - Sorted inclusive boundary parameters.
 * @param removed - Interval index to discard.
 * @returns Remaining `[start, end]` pairs.
 */
function remainingIntervals(
  params: number[],
  removed: number
): Array<[number, number]> {
  const intervals: Array<[number, number]> = []
  for (let i = 0; i < params.length - 1; i++) {
    if (i === removed) continue
    const start = params[i]
    const end = params[i + 1]
    if (end - start > PARAM_EPS) intervals.push([start, end])
  }
  return intervals
}

/**
 * Trims a line at cutting-edge intersections, removing the picked portion.
 *
 * @param line - Line to trim.
 * @param cutters - Cutting-edge entities.
 * @param pick - Point identifying the portion to remove.
 * @returns Remaining line pieces, or `none` when the pick does not hit a cut portion.
 */
function trimLine(
  line: AcDbLine,
  cutters: AcDbEntity[],
  pick: AcGePoint3dLike
): AcApTrimComputeResult {
  const geo = new AcGeLine3d(line.startPoint, line.endPoint)
  if (!Number.isFinite(geo.distance()) || geo.distance() <= PARAM_EPS) {
    return { status: 'none' }
  }

  const pickPoint = new AcGePoint3d(pick.x, pick.y, pick.z ?? 0)
  const pickT = geo.closestPointToPointParameter(pickPoint, true)
  const cuts = collectIntersections(line, cutters)
    .map(point => geo.closestPointToPointParameter(new AcGePoint3d(point), true))
    .filter(t => t > PARAM_EPS && t < 1 - PARAM_EPS)

  const params = uniqueSorted([0, ...cuts, 1])
  if (params.length < 3) return { status: 'none' }

  const removed = findOpenIntervalIndex(params, pickT)
  if (removed < 0) return { status: 'none' }

  const kept = remainingIntervals(params, removed)
  const pieces: AcApTrimPiece[] = kept.map(([t0, t1]) => {
    const start = new AcGePoint3d()
    const end = new AcGePoint3d()
    geo.at(t0, start)
    geo.at(t1, end)
    return { kind: 'line', start, end }
  })
  return { status: 'ok', pieces }
}

/**
 * Trims a circular arc, shortening an end or splitting at interior cuts.
 *
 * @param arc - Arc to trim.
 * @param cutters - Cutting-edge entities.
 * @param pick - Point identifying the portion to remove.
 * @returns Remaining arc pieces, or `none` when the pick does not hit a cut portion.
 */
function trimArc(
  arc: AcDbArc,
  cutters: AcDbEntity[],
  pick: AcGePoint3dLike
): AcApTrimComputeResult {
  const start = AcGeMathUtil.normalizeAngle(arc.startAngle)
  const end = AcGeMathUtil.normalizeAngle(arc.endAngle)
  const pickAngle = angleAtCenter(arc.center, pick)
  if (!isStrictlyOnCcwSweep(start, pickAngle, end)) {
    return { status: 'none' }
  }

  const interior = collectIntersections(arc, cutters)
    .map(point => angleAtCenter(arc.center, point))
    .filter(angle => isStrictlyOnCcwSweep(start, angle, end))

  const ordered = uniqueSorted(
    interior.map(angle => AcGeMathUtil.normalizeAngle(angle - start))
  ).map(offset => AcGeMathUtil.normalizeAngle(start + offset))

  const params = [start, ...ordered, end]
  if (params.length < 3) return { status: 'none' }

  const pickOffset = AcGeMathUtil.normalizeAngle(pickAngle - start)
  const paramOffsets = params.map(angle =>
    AcGeMathUtil.normalizeAngle(angle - start)
  )
  const removed = findOpenIntervalIndex(paramOffsets, pickOffset)
  if (removed < 0) return { status: 'none' }

  const kept = remainingIntervals(paramOffsets, removed)
  const pieces: AcApTrimPiece[] = kept.map(([t0, t1]) => ({
    kind: 'arc',
    center: arc.center.clone(),
    radius: arc.radius,
    startAngle: AcGeMathUtil.normalizeAngle(start + t0),
    endAngle: AcGeMathUtil.normalizeAngle(start + t1),
    normal: arc.normal.clone(),
    thickness: arc.thickness
  }))
  return { status: 'ok', pieces }
}

/**
 * Trims a circle by converting the complement of the picked sector into an arc.
 *
 * A circle needs at least two distinct cutting intersections.
 *
 * @param circle - Circle to trim.
 * @param cutters - Cutting-edge entities.
 * @param pick - Point identifying the sector to remove.
 * @returns One remaining arc, or `none` when fewer than two cuts exist.
 */
function trimCircle(
  circle: AcDbCircle,
  cutters: AcDbEntity[],
  pick: AcGePoint3dLike
): AcApTrimComputeResult {
  const cuts = uniqueSorted(
    collectIntersections(circle, cutters).map(point =>
      angleAtCenter(circle.center, point)
    )
  )
  if (cuts.length < 2) return { status: 'none' }

  const pickAngle = angleAtCenter(circle.center, pick)
  const n = cuts.length
  let removed = -1
  for (let i = 0; i < n; i++) {
    if (isStrictlyOnCcwSweep(cuts[i], pickAngle, cuts[(i + 1) % n])) {
      removed = i
      break
    }
  }
  if (removed < 0) return { status: 'none' }

  const startAngle = cuts[(removed + 1) % n]
  const endAngle = cuts[removed]
  return {
    status: 'ok',
    pieces: [
      {
        kind: 'arc',
        center: circle.center.clone(),
        radius: circle.radius,
        startAngle,
        endAngle,
        normal: circle.normal.clone(),
        thickness: circle.thickness
      }
    ]
  }
}

/**
 * Builds ordered 3D vertices for a lightweight polyline.
 *
 * @param polyline - Source polyline.
 * @returns Vertex list in WCS.
 */
function polylineVertices(polyline: AcDbPolyline): AcGePoint3d[] {
  const points: AcGePoint3d[] = []
  for (let i = 0; i < polyline.numberOfVertices; i++) {
    points.push(polyline.getPoint3dAt(i))
  }
  return points
}

/**
 * True when two points share the same XY location within the default point tolerance.
 *
 * @param a - First point.
 * @param b - Second point.
 * @returns `true` when the XY coordinates match.
 */
function equalPointXy(a: AcGePoint3dLike, b: AcGePoint3dLike): boolean {
  return DEFAULT_TOL.equalPoint2d({ x: a.x, y: a.y }, { x: b.x, y: b.y })
}

/**
 * Interpolates a point on a chord.
 *
 * @param start - Segment start.
 * @param end - Segment end.
 * @param t - Parameter in `[0, 1]`.
 * @returns Interpolated point.
 */
function chordPoint(
  start: AcGePoint3dLike,
  end: AcGePoint3dLike,
  t: number
): AcGePoint3d {
  const geo = new AcGeLine3d(start, end)
  const target = new AcGePoint3d()
  geo.at(t, target)
  return target
}

/**
 * Trims a polyline treated as connected straight segments.
 *
 * Closed polylines become open after a successful trim. A middle cut on an
 * open polyline can produce two remaining polylines.
 *
 * @param polyline - Polyline to trim.
 * @param cutters - Cutting-edge entities.
 * @param pick - Point identifying the portion to remove.
 * @returns Remaining polyline pieces, or `none` when the pick does not hit a cut portion.
 */
function trimPolyline(
  polyline: AcDbPolyline,
  cutters: AcDbEntity[],
  pick: AcGePoint3dLike
): AcApTrimComputeResult {
  const vertices = polylineVertices(polyline)
  if (vertices.length < 2) return { status: 'none' }

  const closed = polyline.closed
  const segmentCount = closed ? vertices.length : vertices.length - 1
  const hits = collectIntersections(polyline, cutters)

  type Subseg = { start: AcGePoint3d; end: AcGePoint3d }
  const subsegs: Subseg[] = []

  for (let i = 0; i < segmentCount; i++) {
    const start = vertices[i]
    const end = vertices[(i + 1) % vertices.length]
    const geo = new AcGeLine3d(start, end)
    if (geo.distance() <= PARAM_EPS) continue

    const cuts = hits
      .map(point => geo.closestPointToPointParameter(new AcGePoint3d(point), true))
      .filter(t => t > PARAM_EPS && t < 1 - PARAM_EPS)
    const params = uniqueSorted([0, ...cuts, 1])
    for (let j = 0; j < params.length - 1; j++) {
      if (params[j + 1] - params[j] <= PARAM_EPS) continue
      subsegs.push({
        start: chordPoint(start, end, params[j]),
        end: chordPoint(start, end, params[j + 1])
      })
    }
  }

  if (subsegs.length === 0 || hits.length === 0) return { status: 'none' }

  const pickPoint = new AcGePoint3d(pick.x, pick.y, pick.z ?? 0)
  let bestIndex = -1
  let bestDist = Infinity
  for (let i = 0; i < subsegs.length; i++) {
    const geo = new AcGeLine3d(subsegs[i].start, subsegs[i].end)
    const t = geo.closestPointToPointParameter(pickPoint, true)
    if (t <= PARAM_EPS || t >= 1 - PARAM_EPS) continue
    const closest = new AcGePoint3d()
    geo.closestPointToPoint(pickPoint, true, closest)
    const dist = pickPoint.distanceTo(closest)
    if (dist < bestDist) {
      bestDist = dist
      bestIndex = i
    }
  }
  if (bestIndex < 0) return { status: 'none' }

  const picked = subsegs[bestIndex]
  const touchesCut = hits.some(
    point => equalPointXy(point, picked.start) || equalPointXy(point, picked.end)
  )
  if (!touchesCut) return { status: 'none' }

  const remaining = subsegs.filter((_, index) => index !== bestIndex)
  if (remaining.length === 0) return { status: 'ok', pieces: [] }

  const runs: AcGePoint3d[][] = []
  for (const seg of remaining) {
    const lastRun = runs[runs.length - 1]
    if (lastRun && equalPointXy(lastRun[lastRun.length - 1], seg.start)) {
      lastRun.push(seg.end)
    } else {
      runs.push([seg.start.clone(), seg.end.clone()])
    }
  }

  if (
    closed &&
    runs.length > 1 &&
    equalPointXy(
      runs[0][0],
      runs[runs.length - 1][runs[runs.length - 1].length - 1]
    )
  ) {
    const first = runs.shift()
    const last = runs[runs.length - 1]
    if (first && last) {
      last.push(...first.slice(1))
    }
  }

  const pieces: AcApTrimPiece[] = runs
    .filter(points => points.length >= 2)
    .map(points => ({
      kind: 'polyline' as const,
      points,
      elevation: polyline.elevation,
      thickness: polyline.thickness,
      normal: polyline.normal.clone()
    }))

  return { status: 'ok', pieces }
}

/**
 * Computes remaining geometry after trimming `target` at `pick`.
 *
 * Supported entity types: line, arc, circle, and lightweight polyline.
 *
 * @param target - Entity to trim.
 * @param cutters - Cutting-edge entities.
 * @param pick - Point identifying the portion to remove.
 * @returns Remaining pieces, or a `none` / `unsupported` status.
 */
export function computeTrim(
  target: AcDbEntity,
  cutters: AcDbEntity[],
  pick: AcGePoint3dLike
): AcApTrimComputeResult {
  if (target instanceof AcDbLine) return trimLine(target, cutters, pick)
  if (target instanceof AcDbArc) return trimArc(target, cutters, pick)
  if (target instanceof AcDbCircle) return trimCircle(target, cutters, pick)
  if (target instanceof AcDbPolyline) return trimPolyline(target, cutters, pick)
  return { status: 'unsupported' }
}

/**
 * Creates database entities for remaining TRIM pieces and copies display traits.
 *
 * @param source - Original entity whose traits should be copied.
 * @param pieces - Remaining geometry.
 * @returns New unbound entities ready to append (or apply in place).
 */
function createEntitiesFromPieces(
  source: AcDbEntity,
  pieces: AcApTrimPiece[]
): AcDbCurve[] {
  const entities: AcDbCurve[] = []
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      const line = new AcDbLine(piece.start, piece.end)
      copyDisplayTraits(source, line)
      entities.push(line)
    } else if (piece.kind === 'arc') {
      const arc = new AcDbArc(
        piece.center,
        piece.radius,
        piece.startAngle,
        piece.endAngle,
        piece.normal
      )
      arc.thickness = piece.thickness
      copyDisplayTraits(source, arc)
      entities.push(arc)
    } else {
      const polyline = new AcDbPolyline()
      polyline.elevation = piece.elevation
      polyline.thickness = piece.thickness
      polyline.normal = piece.normal
      polyline.closed = false
      piece.points.forEach((point, index) => {
        polyline.addVertexAt(index, new AcGePoint2d(point.x, point.y))
      })
      copyDisplayTraits(source, polyline)
      entities.push(polyline)
    }
  }
  return entities
}

/**
 * Applies a computed TRIM result to the drawing database.
 *
 * When possible the original entity is updated in place so its object id is
 * preserved. Extra pieces are appended to model space. An empty piece list
 * erases the original entity.
 *
 * @param db - Drawing database.
 * @param target - Entity that was trimmed.
 * @param pieces - Remaining geometry from {@link computeTrim}.
 * @returns Live entities that remain after the trim (including the original when kept).
 */
export function applyTrim(
  db: AcDbDatabase,
  target: AcDbEntity,
  pieces: AcApTrimPiece[]
): AcDbCurve[] {
  const modelSpace = db.tables.blockTable.modelSpace
  const opened = db.openEntityForWrite(target.objectId) ?? target

  if (pieces.length === 0) {
    opened.erase()
    return []
  }

  const canReuseLine =
    opened instanceof AcDbLine && pieces[0].kind === 'line'
  const canReuseArc = opened instanceof AcDbArc && pieces[0].kind === 'arc'
  const canReusePolyline =
    opened instanceof AcDbPolyline && pieces[0].kind === 'polyline'

  if (canReuseLine && pieces[0].kind === 'line') {
    opened.startPoint = pieces[0].start
    opened.endPoint = pieces[0].end
    const extras = createEntitiesFromPieces(opened, pieces.slice(1))
    if (extras.length > 0) modelSpace.appendEntity(extras)
    return [opened, ...extras]
  }

  if (canReuseArc && pieces[0].kind === 'arc') {
    opened.startAngle = pieces[0].startAngle
    opened.endAngle = pieces[0].endAngle
    const extras = createEntitiesFromPieces(opened, pieces.slice(1))
    if (extras.length > 0) modelSpace.appendEntity(extras)
    return [opened, ...extras]
  }

  if (canReusePolyline && pieces[0].kind === 'polyline') {
    opened.reset(false)
    opened.closed = false
    pieces[0].points.forEach((point, index) => {
      opened.addVertexAt(index, new AcGePoint2d(point.x, point.y))
    })
    const extras = createEntitiesFromPieces(opened, pieces.slice(1))
    if (extras.length > 0) modelSpace.appendEntity(extras)
    return [opened, ...extras]
  }

  const replacements = createEntitiesFromPieces(opened, pieces)
  opened.erase()
  if (replacements.length > 0) modelSpace.appendEntity(replacements)
  return replacements
}

/**
 * Resolves model-space entities for the given object ids.
 *
 * @param db - Drawing database.
 * @param ids - Entity object ids.
 * @returns Entities that still exist in model space.
 */
export function entitiesFromIds(
  db: AcDbDatabase,
  ids: AcDbObjectId[]
): AcDbEntity[] {
  const modelSpace = db.tables.blockTable.modelSpace
  const entities: AcDbEntity[] = []
  for (const id of ids) {
    const entity = modelSpace.getIdAt(id)
    if (entity) entities.push(entity)
  }
  return entities
}

/**
 * Collects every entity currently in model space for use as cutting edges.
 *
 * @param db - Drawing database.
 * @returns Model-space entities.
 */
export function allModelSpaceEntities(db: AcDbDatabase): AcDbEntity[] {
  return [...db.tables.blockTable.modelSpace.newIterator()]
}
