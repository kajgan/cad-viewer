import {
  AcDbArc,
  AcDbCircle,
  AcDbDatabase,
  AcDbLine,
  AcDbPolyline,
  acdbHostApplicationServices,
  AcGePoint2d,
  AcGePoint3d
} from '@mlightcad/data-model'

import {
  applyTrim,
  computeTrim
} from '../src/command/modify/AcApTrimGeometry'

function withWorkingDatabase(run: (db: AcDbDatabase) => void) {
  const db = new AcDbDatabase()
  const services = acdbHostApplicationServices() as unknown as {
    _workingDatabase: AcDbDatabase | null
    workingDatabase: AcDbDatabase
  }
  const previous = services._workingDatabase
  services.workingDatabase = db
  try {
    run(db)
  } finally {
    services._workingDatabase = previous
  }
}

describe('computeTrim', () => {
  it('shortens a line at a crossing cutting edge', () => {
    const line = new AcDbLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
    const cutter = new AcDbLine({ x: 5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 })

    const left = computeTrim(line, [cutter], { x: 2, y: 0, z: 0 })
    expect(left.status).toBe('ok')
    if (left.status !== 'ok') return
    expect(left.pieces).toHaveLength(1)
    expect(left.pieces[0].kind).toBe('line')
    if (left.pieces[0].kind !== 'line') return
    expect(left.pieces[0].start.x).toBeCloseTo(5)
    expect(left.pieces[0].end.x).toBeCloseTo(10)

    const right = computeTrim(line, [cutter], { x: 8, y: 0, z: 0 })
    expect(right.status).toBe('ok')
    if (right.status !== 'ok') return
    expect(right.pieces).toHaveLength(1)
    if (right.pieces[0].kind !== 'line') return
    expect(right.pieces[0].start.x).toBeCloseTo(0)
    expect(right.pieces[0].end.x).toBeCloseTo(5)
  })

  it('splits a line when the picked portion is between two cuts', () => {
    const line = new AcDbLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
    const cutters = [
      new AcDbLine({ x: 3, y: -1, z: 0 }, { x: 3, y: 1, z: 0 }),
      new AcDbLine({ x: 7, y: -1, z: 0 }, { x: 7, y: 1, z: 0 })
    ]

    const result = computeTrim(line, cutters, { x: 5, y: 0, z: 0 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.pieces).toHaveLength(2)
    const xs = result.pieces
      .filter(piece => piece.kind === 'line')
      .flatMap(piece => [piece.start.x, piece.end.x])
      .sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0)
    expect(xs[1]).toBeCloseTo(3)
    expect(xs[2]).toBeCloseTo(7)
    expect(xs[3]).toBeCloseTo(10)
  })

  it('returns none when a line does not meet a cutting edge', () => {
    const line = new AcDbLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
    const cutter = new AcDbLine({ x: 0, y: 5, z: 0 }, { x: 10, y: 5, z: 0 })
    expect(computeTrim(line, [cutter], { x: 2, y: 0, z: 0 }).status).toBe(
      'none'
    )
  })

  it('converts a circle to the complementary arc', () => {
    const circle = new AcDbCircle(new AcGePoint3d(0, 0, 0), 10)
    const cutters = [
      new AcDbLine({ x: 0, y: -20, z: 0 }, { x: 0, y: 20, z: 0 }),
      new AcDbLine({ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })
    ]

    const result = computeTrim(circle, cutters, { x: 10, y: 0.1, z: 0 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0].kind).toBe('arc')
    if (result.pieces[0].kind !== 'arc') return
    expect(result.pieces[0].radius).toBeCloseTo(10)
  })

  it('shortens an arc at a cutting intersection', () => {
    const arc = new AcDbArc(new AcGePoint3d(0, 0, 0), 10, 0, Math.PI)
    const cutter = new AcDbLine({ x: 0, y: -1, z: 0 }, { x: 0, y: 20, z: 0 })

    const result = computeTrim(arc, [cutter], { x: 10, y: 1, z: 0 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.pieces).toHaveLength(1)
    if (result.pieces[0].kind !== 'arc') return
    expect(result.pieces[0].startAngle).toBeCloseTo(Math.PI / 2, 5)
    expect(result.pieces[0].endAngle).toBeCloseTo(Math.PI, 5)
  })

  it('opens a closed polyline at a cutting edge', () => {
    const polyline = new AcDbPolyline()
    polyline.addVertexAt(0, new AcGePoint2d(0, 0))
    polyline.addVertexAt(1, new AcGePoint2d(10, 0))
    polyline.addVertexAt(2, new AcGePoint2d(10, 10))
    polyline.addVertexAt(3, new AcGePoint2d(0, 10))
    polyline.closed = true
    const cutter = new AcDbLine({ x: 5, y: -1, z: 0 }, { x: 5, y: 1, z: 0 })

    const result = computeTrim(polyline, [cutter], { x: 2, y: 0, z: 0 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.pieces).toHaveLength(1)
    if (result.pieces[0].kind !== 'polyline') return
    expect(result.pieces[0].points[0].x).toBeCloseTo(5)
    expect(result.pieces[0].points[0].y).toBeCloseTo(0)
  })
})

describe('applyTrim', () => {
  it('updates a line in place and keeps its object id', () => {
    withWorkingDatabase(db => {
      const line = new AcDbLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
      const cutter = new AcDbLine({ x: 5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 })
      db.tables.blockTable.modelSpace.appendEntity([line, cutter])
      const originalId = line.objectId

      const computed = computeTrim(line, [cutter], { x: 2, y: 0, z: 0 })
      expect(computed.status).toBe('ok')
      if (computed.status !== 'ok') return

      const remaining = applyTrim(db, line, computed.pieces)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].objectId).toBe(originalId)
      expect((remaining[0] as AcDbLine).startPoint.x).toBeCloseTo(5)
    })
  })
})
