import {
  AcDbDatabase,
  AcDbEntity,
  AcDbLine,
  AcDbPolyline,
  AcGePoint3dLike,
  AcGeTol
} from '@mlightcad/data-model'

import { AcApContext, AcApDocManager } from '../../app'
import {
  AcEdCommand,
  AcEdOpenMode,
  AcEdPromptDistanceOptions,
  AcEdPromptDoubleResult,
  AcEdPromptEntityOptions,
  AcEdPromptEntityResult,
  AcEdPromptStatus
} from '../../editor'
import { AcApI18n } from '../../i18n'
import {
  adjacentSegmentsAtVertex,
  applyFilletLines,
  applyFilletPolylineVertex,
  closestPolylineSegment,
  computeFillet,
  isStraightPolylineSegment,
  polylineSegmentAt,
  sharedPolylineVertex
} from './AcApFilletGeometry'

/**
 * Command to fillet two lines or a polyline corner.
 *
 * Workflow follows AutoCAD FILLET:
 * 1) Optionally set Radius.
 * 2) Select the first object, then the second.
 * 3) Repeat until Enter or Escape.
 *
 * Alias: F.
 */
export class AcApFilletCmd extends AcEdCommand {
  /** Last fillet radius, reused as the default on the next run. */
  private static _lastRadius = 0

  /**
   * Creates the FILLET command. Drawing geometry may only be filleted in Write mode.
   */
  constructor() {
    super()
    this.mode = AcEdOpenMode.Write
  }

  /**
   * Runs FILLET: radius option, then pairs of objects until the user finishes.
   *
   * @param context - Current application/document context.
   */
  async execute(context: AcApContext) {
    const db = context.doc.database
    const selectionSet = context.view.selectionSet
    const editor = AcApDocManager.instance.editor
    let radius = AcApFilletCmd._lastRadius

    selectionSet.clear()

    while (true) {
      this.showMessage(
        `${AcApI18n.t('jig.fillet.currentRadius')} ${radius.toFixed(4)}`
      )

      const firstPrompt = new AcEdPromptEntityOptions(
        AcApI18n.t('jig.fillet.selectFirst')
      )
      firstPrompt.allowNone = true
      firstPrompt.setRejectMessage(AcApI18n.t('jig.fillet.invalidSelection'))
      firstPrompt.addAllowedClass('Line')
      firstPrompt.addAllowedClass('Polyline')
      this.addRadiusKeyword(firstPrompt)

      const firstResult = await editor.getEntity(firstPrompt)
      if (!(firstResult instanceof AcEdPromptEntityResult)) break
      if (firstResult.status === AcEdPromptStatus.None) break
      if (
        firstResult.status === AcEdPromptStatus.Keyword &&
        firstResult.stringResult === 'Radius'
      ) {
        const nextRadius = await this.promptRadius(radius)
        if (nextRadius == null) break
        radius = nextRadius
        AcApFilletCmd._lastRadius = radius
        continue
      }
      if (firstResult.status !== AcEdPromptStatus.OK || !firstResult.objectId) {
        break
      }

      const first = db.openEntityForWrite(firstResult.objectId)
      if (!this.isFilletable(first)) {
        this.showMessage(AcApI18n.t('jig.fillet.invalidSelection'), 'warning')
        continue
      }

      const firstPick = this.resolvePickPoint(firstResult, context)
      selectionSet.clear()
      selectionSet.add([first.objectId])

      const secondPrompt = new AcEdPromptEntityOptions(
        AcApI18n.t('jig.fillet.selectSecond')
      )
      secondPrompt.allowNone = true
      secondPrompt.setRejectMessage(AcApI18n.t('jig.fillet.invalidSelection'))
      secondPrompt.addAllowedClass('Line')
      secondPrompt.addAllowedClass('Polyline')

      const secondResult = await editor.getEntity(secondPrompt)
      selectionSet.clear()
      if (!(secondResult instanceof AcEdPromptEntityResult)) break
      if (secondResult.status === AcEdPromptStatus.None) continue
      if (
        secondResult.status !== AcEdPromptStatus.OK ||
        !secondResult.objectId
      ) {
        break
      }

      const second = db.openEntityForWrite(secondResult.objectId)
      if (!this.isFilletable(second)) {
        this.showMessage(AcApI18n.t('jig.fillet.invalidSelection'), 'warning')
        continue
      }

      const secondPick = this.resolvePickPoint(secondResult, context)
      const applied = this.applyPair(
        context,
        first,
        firstPick,
        second,
        secondPick,
        radius
      )
      if (!applied) continue
      AcApFilletCmd._lastRadius = radius
    }

    selectionSet.clear()
  }

  /**
   * Adds the Radius keyword used on the first-object prompt.
   *
   * @param prompt - Entity prompt to decorate.
   */
  private addRadiusKeyword(prompt: AcEdPromptEntityOptions) {
    prompt.keywords.add(
      AcApI18n.t('jig.fillet.keywords.radius.display'),
      AcApI18n.t('jig.fillet.keywords.radius.global'),
      AcApI18n.t('jig.fillet.keywords.radius.local')
    )
  }

  /**
   * Prompts for a non-negative fillet radius.
   *
   * @param current - Radius shown as the default.
   * @returns The accepted radius, or `undefined` when the prompt is cancelled.
   */
  private async promptRadius(current: number): Promise<number | undefined> {
    const prompt = new AcEdPromptDistanceOptions(
      AcApI18n.t('jig.fillet.radius')
    )
    prompt.useBasePoint = false
    prompt.allowZero = true
    prompt.allowNegative = false
    prompt.defaultValue = current
    prompt.useDefaultValue = true
    prompt.allowNone = true

    const result = await AcApDocManager.instance.editor.getDistance(prompt)
    if (!(result instanceof AcEdPromptDoubleResult)) return undefined
    if (result.status === AcEdPromptStatus.None) return current
    if (result.status !== AcEdPromptStatus.OK || result.value == null) {
      return undefined
    }
    if (!Number.isFinite(result.value) || result.value < 0) {
      this.showMessage(AcApI18n.t('jig.fillet.invalidRadius'), 'warning')
      return current
    }
    return result.value
  }

  /**
   * True when the entity can participate in FILLET.
   *
   * @param entity - Database entity, or `undefined` when lookup failed.
   * @returns `true` for lines and polylines.
   */
  private isFilletable(
    entity: AcDbEntity | undefined
  ): entity is AcDbLine | AcDbPolyline {
    return entity instanceof AcDbLine || entity instanceof AcDbPolyline
  }

  /**
   * Uses the entity pick point when available, otherwise the current cursor position.
   *
   * @param result - Entity prompt result.
   * @param context - Current application/document context.
   * @returns Pick point in WCS.
   */
  private resolvePickPoint(
    result: AcEdPromptEntityResult,
    context: AcApContext
  ): AcGePoint3dLike {
    if (result.pickedPoint) return result.pickedPoint
    return { ...context.view.curPos, z: 0 }
  }

  /**
   * Applies a fillet to one pair of selected objects.
   *
   * @param context - Current application/document context.
   * @param first - First selected entity.
   * @param firstPick - Pick on the first entity.
   * @param second - Second selected entity.
   * @param secondPick - Pick on the second entity.
   * @param radius - Fillet radius.
   * @returns `true` when geometry was applied or a zero-radius polyline was a no-op.
   */
  private applyPair(
    context: AcApContext,
    first: AcDbLine | AcDbPolyline,
    firstPick: AcGePoint3dLike,
    second: AcDbLine | AcDbPolyline,
    secondPick: AcGePoint3dLike,
    radius: number
  ): boolean {
    if (first instanceof AcDbLine && second instanceof AcDbLine) {
      if (first.objectId === second.objectId) {
        this.showMessage(AcApI18n.t('jig.fillet.needTwoObjects'), 'warning')
        return false
      }
      return this.filletLines(context, first, firstPick, second, secondPick, radius)
    }

    if (
      first instanceof AcDbPolyline &&
      second instanceof AcDbPolyline &&
      first.objectId === second.objectId
    ) {
      return this.filletPolyline(
        context.doc.database,
        first,
        firstPick,
        secondPick,
        radius
      )
    }

    this.showMessage(AcApI18n.t('jig.fillet.unsupported'), 'warning')
    return false
  }

  /**
   * Fillets two line entities.
   *
   * @param context - Current application/document context.
   * @param line1 - First line.
   * @param pick1 - Pick on the first line.
   * @param line2 - Second line.
   * @param pick2 - Pick on the second line.
   * @param radius - Fillet radius.
   * @returns `true` when the fillet was applied.
   */
  private filletLines(
    context: AcApContext,
    line1: AcDbLine,
    pick1: AcGePoint3dLike,
    line2: AcDbLine,
    pick2: AcGePoint3dLike,
    radius: number
  ): boolean {
    const computed = computeFillet(
      {
        start: line1.startPoint,
        end: line1.endPoint,
        pick: pick1
      },
      {
        start: line2.startPoint,
        end: line2.endPoint,
        pick: pick2
      },
      radius
    )
    if (!this.reportCompute(computed.status)) return false
    if (computed.status !== 'ok') return false
    const arc = applyFilletLines(
      context.doc.database,
      line1,
      line2,
      computed
    )
    if (arc) context.view.addEntity(arc)
    return true
  }

  /**
   * Fillets the shared vertex of two picked polyline segments.
   *
   * @param polyline - Polyline containing both picks.
   * @param pick1 - First pick.
   * @param pick2 - Second pick.
   * @param radius - Fillet radius.
   * @returns `true` when the fillet was applied or radius 0 was a no-op.
   */
  private filletPolyline(
    db: AcDbDatabase,
    polyline: AcDbPolyline,
    pick1: AcGePoint3dLike,
    pick2: AcGePoint3dLike,
    radius: number
  ): boolean {
    const segA = closestPolylineSegment(polyline, pick1)
    const segB = closestPolylineSegment(polyline, pick2)
    const vertex = sharedPolylineVertex(polyline, segA, segB)
    if (vertex < 0) {
      this.showMessage(AcApI18n.t('jig.fillet.notAdjacent'), 'warning')
      return false
    }

    const neighbors = adjacentSegmentsAtVertex(polyline, vertex)
    if (!neighbors) {
      this.showMessage(AcApI18n.t('jig.fillet.notAdjacent'), 'warning')
      return false
    }
    if (
      !isStraightPolylineSegment(polyline, neighbors.incoming) ||
      !isStraightPolylineSegment(polyline, neighbors.outgoing)
    ) {
      this.showMessage(AcApI18n.t('jig.fillet.unsupported'), 'warning')
      return false
    }

    const incoming = polylineSegmentAt(polyline, neighbors.incoming)
    const outgoing = polylineSegmentAt(polyline, neighbors.outgoing)
    const incomingPick = segA === neighbors.incoming ? pick1 : pick2
    const outgoingPick = segA === neighbors.incoming ? pick2 : pick1
    const computed = computeFillet(
      { ...incoming, pick: incomingPick },
      { ...outgoing, pick: outgoingPick },
      radius
    )
    if (!this.reportCompute(computed.status)) return false
    if (computed.status !== 'ok') return false
    if (AcGeTol.equalToZero(radius) || !computed.arc) return true
    applyFilletPolylineVertex(db, polyline, vertex, computed)
    return true
  }

  /**
   * Shows a warning for a failed fillet computation.
   *
   * @param status - Compute result status.
   * @returns `true` when the status is `ok`.
   */
  private reportCompute(status: string): boolean {
    if (status === 'ok') return true
    if (status === 'parallel') {
      this.showMessage(AcApI18n.t('jig.fillet.parallel'), 'warning')
      return false
    }
    this.showMessage(AcApI18n.t('jig.fillet.degenerate'), 'warning')
    return false
  }
}
