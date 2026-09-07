import { AcDbEntity, AcGePoint3dLike } from '@mlightcad/data-model'

import { AcApContext, AcApDocManager } from '../../app'
import {
  AcEdCommand,
  AcEdOpenMode,
  AcEdPromptEntityOptions,
  AcEdPromptEntityResult,
  AcEdPromptSelectionOptions,
  AcEdPromptSelectionResult,
  AcEdPromptStatus
} from '../../editor'
import { AcApI18n } from '../../i18n'
import {
  allModelSpaceEntities,
  applyTrim,
  computeTrim,
  entitiesFromIds
} from './AcApTrimGeometry'

/**
 * Command to trim curve entities against selected cutting edges.
 *
 * Workflow follows AutoCAD TRIM:
 * 1) Select cutting edges, or press Enter to use all objects.
 * 2) Pick the portion of each object to remove until Enter or Escape.
 *
 * Preselected objects become cutting edges without an extra prompt.
 */
export class AcApTrimCmd extends AcEdCommand {
  /**
   * Creates the TRIM command. Drawing geometry may only be trimmed in Write mode.
   */
  constructor() {
    super()
    this.mode = AcEdOpenMode.Write
  }

  /**
   * Runs the TRIM command: resolve cutting edges, then trim picked objects in a loop.
   *
   * @param context - Current application/document context.
   */
  async execute(context: AcApContext) {
    const db = context.doc.database
    const selectionSet = context.view.selectionSet
    const editor = AcApDocManager.instance.editor

    const cutters = await this.resolveCuttingEdges(context)
    if (!cutters) return
    if (cutters.length === 0) {
      this.showMessage(AcApI18n.t('jig.trim.noCuttingEdges'), 'warning')
      return
    }

    selectionSet.clear()
    selectionSet.add(cutters.map(entity => entity.objectId))

    const liveCutters = [...cutters]

    while (true) {
      const prompt = new AcEdPromptEntityOptions(
        AcApI18n.t('jig.trim.selectObject')
      )
      prompt.allowNone = true
      prompt.setRejectMessage(AcApI18n.t('jig.trim.invalidSelection'))

      const result = await editor.getEntity(prompt)
      if (!(result instanceof AcEdPromptEntityResult)) break
      if (result.status === AcEdPromptStatus.None) break
      if (result.status !== AcEdPromptStatus.OK || !result.objectId) break

      const target = db.openEntityForWrite(result.objectId)
      if (!target) {
        this.showMessage(AcApI18n.t('jig.trim.invalidSelection'), 'warning')
        continue
      }

      const pick = this.resolvePickPoint(result, context)
      const computed = computeTrim(target, liveCutters, pick)
      if (computed.status === 'unsupported') {
        this.showMessage(AcApI18n.t('jig.trim.unsupported'), 'warning')
        continue
      }
      if (computed.status === 'none') {
        this.showMessage(AcApI18n.t('jig.trim.doesNotIntersect'), 'warning')
        continue
      }

      const remaining = applyTrim(db, target, computed.pieces)
      this.refreshCuttingEdges(liveCutters, target, remaining)
    }

    selectionSet.clear()
  }

  /**
   * Resolves cutting-edge entities from preselection, a prompt, or the whole drawing.
   *
   * Enter with an empty selection uses every model-space entity as a cutting edge.
   *
   * @param context - Current application/document context.
   * @returns Cutting-edge entities, or `undefined` when the prompt is cancelled.
   */
  private async resolveCuttingEdges(
    context: AcApContext
  ): Promise<AcDbEntity[] | undefined> {
    const db = context.doc.database
    const selectionSet = context.view.selectionSet

    if (selectionSet.count > 0) {
      return entitiesFromIds(db, selectionSet.ids)
    }

    const options = new AcEdPromptSelectionOptions(
      AcApI18n.t('jig.trim.selectCuttingEdges')
    )
    const result = await AcApDocManager.instance.editor.getSelection(options)
    if (!(result instanceof AcEdPromptSelectionResult)) return undefined
    if (
      result.status !== AcEdPromptStatus.OK &&
      result.status !== AcEdPromptStatus.None
    ) {
      return undefined
    }

    const ids = result.value?.ids ?? []
    if (ids.length === 0) return allModelSpaceEntities(db)
    return entitiesFromIds(db, ids)
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
   * Keeps the cutting-edge list in sync after a trim replaces or splits an entity.
   *
   * @param cutters - Mutable list of cutting-edge entities.
   * @param target - Entity that was trimmed.
   * @param remaining - Entities that remain after the trim.
   */
  private refreshCuttingEdges(
    cutters: AcDbEntity[],
    target: AcDbEntity,
    remaining: AcDbEntity[]
  ) {
    const index = cutters.findIndex(
      entity => entity.objectId === target.objectId
    )
    if (index < 0) return
    cutters.splice(index, 1, ...remaining)
  }
}
