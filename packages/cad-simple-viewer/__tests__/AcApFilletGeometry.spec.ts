import {
  AcDbDatabase,
  AcDbLine,
  AcDbPolyline,
  acdbHostApplicationServices,
  AcGePoint2d,
  AcGePoint3d
} from '@mlightcad/data-model'

import {
  applyFilletLines,
  applyFilletPolylineVertex,
  computeFillet,
  sharedPolylineVertex
} from '../src/command/modify/AcApFilletGeometry'

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

describe('computeFillet', () => {
  it('meets two perpendicular lines at the intersection when radius is 0', () => {
    const result = computeFillet(
      {
        start: { x: 0, y: 0, z: 0 },
        end: { x: 8, y: 0, z: 0 },
        pick: { x: 3, y: 0, z: 0 }
      },
      {
        start: { x: 10, y: 2, z: 0 },
        end: { x: 10, y: 10, z: 0 },
        pick: { x: 10, y: 6, z: 0 }
      },
      0
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.arc).toBeUndefined()
    expect(result.join1.x).toBeCloseTo(10)
    expect(result.join1.y).toBeCloseTo(0)
    expect(result.far1.x).toBeCloseTo(0)
    expect(result.far2.y).toBeCloseTo(10)
  })

  it('creates a quarter-circle fillet for perpendicular lines', () => {
    const result = computeFillet(
      {
        start: { x: 0, y: 0, z: 0 },
        end: { x: 10, y: 0, z: 0 },
        pick: { x: 3, y: 0, z: 0 }
      },
      {
        start: { x: 10, y: 0, z: 0 },
        end: { x: 10, y: 10, z: 0 },
        pick: { x: 10, y: 7, z: 0 }
      },
      2
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.arc).toBeDefined()
    expect(result.join1.x).toBeCloseTo(8)
    expect(result.join1.y).toBeCloseTo(0)
    expect(result.join2.x).toBeCloseTo(10)
    expect(result.join2.y).toBeCloseTo(2)
    expect(result.arc?.center.x).toBeCloseTo(8)
    expect(result.arc?.center.y).toBeCloseTo(2)
    expect(result.arc?.radius).toBeCloseTo(2)
  })

  it('returns parallel for non-intersecting lines', () => {
    const result = computeFillet(
      {
        start: { x: 0, y: 0, z: 0 },
        end: { x: 10, y: 0, z: 0 },
        pick: { x: 3, y: 0, z: 0 }
      },
      {
        start: { x: 0, y: 5, z: 0 },
        end: { x: 10, y: 5, z: 0 },
        pick: { x: 3, y: 5, z: 0 }
      },
      1
    )
    expect(result.status).toBe('parallel')
  })

  it('returns degenerate when the radius does not fit', () => {
    const result = computeFillet(
      {
        start: { x: 0, y: 0, z: 0 },
        end: { x: 4, y: 0, z: 0 },
        pick: { x: 1, y: 0, z: 0 }
      },
      {
        start: { x: 4, y: 0, z: 0 },
        end: { x: 4, y: 4, z: 0 },
        pick: { x: 4, y: 1, z: 0 }
      },
      10
    )
    expect(result.status).toBe('degenerate')
  })
})

describe('applyFilletLines', () => {
  it('trims both lines and appends an arc', () => {
    withWorkingDatabase(db => {
      const line1 = new AcDbLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })
      const line2 = new AcDbLine({ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 })
      db.tables.blockTable.modelSpace.appendEntity([line1, line2])

      const computed = computeFillet(
        {
          start: line1.startPoint,
          end: line1.endPoint,
          pick: { x: 3, y: 0, z: 0 }
        },
        {
          start: line2.startPoint,
          end: line2.endPoint,
          pick: { x: 10, y: 7, z: 0 }
        },
        2
      )
      expect(computed.status).toBe('ok')
      if (computed.status !== 'ok') return

      const arc = applyFilletLines(db, line1, line2, computed)
      expect(arc).toBeDefined()
      expect(line1.startPoint.x).toBeCloseTo(8)
      expect(line1.endPoint.x).toBeCloseTo(0)
      expect(line2.startPoint.y).toBeCloseTo(2)
      expect(line2.endPoint.y).toBeCloseTo(10)
    })
  })
})

describe('polyline fillet', () => {
  it('finds the shared vertex of adjacent segments', () => {
    const polyline = new AcDbPolyline()
    polyline.addVertexAt(0, new AcGePoint2d(0, 0))
    polyline.addVertexAt(1, new AcGePoint2d(10, 0))
    polyline.addVertexAt(2, new AcGePoint2d(10, 10))
    expect(sharedPolylineVertex(polyline, 0, 1)).toBe(1)
  })

  it('replaces a polyline corner with tangent vertices', () => {
    withWorkingDatabase(db => {
      const polyline = new AcDbPolyline()
      polyline.addVertexAt(0, new AcGePoint2d(0, 0))
      polyline.addVertexAt(1, new AcGePoint2d(10, 0))
      polyline.addVertexAt(2, new AcGePoint2d(10, 10))
      db.tables.blockTable.modelSpace.appendEntity(polyline)

      const computed = computeFillet(
        {
          start: new AcGePoint3d(0, 0, 0),
          end: new AcGePoint3d(10, 0, 0),
          pick: { x: 3, y: 0, z: 0 }
        },
        {
          start: new AcGePoint3d(10, 0, 0),
          end: new AcGePoint3d(10, 10, 0),
          pick: { x: 10, y: 7, z: 0 }
        },
        2
      )
      expect(computed.status).toBe('ok')
      if (computed.status !== 'ok') return

      applyFilletPolylineVertex(db, polyline, 1, computed)
      expect(polyline.numberOfVertices).toBe(4)
      expect(polyline.getPoint3dAt(1).x).toBeCloseTo(8)
      expect(polyline.getPoint3dAt(1).y).toBeCloseTo(0)
      expect(polyline.getPoint3dAt(2).x).toBeCloseTo(10)
      expect(polyline.getPoint3dAt(2).y).toBeCloseTo(2)
    })
  })
})
