import type { NoteBlockModel } from '@blocksuite/affine-model';
import type {
  BlockComponent,
  PointerEventState,
  UIEventHandler,
} from '@blocksuite/block-std';
import type { BlockModel } from '@blocksuite/store';

import {
  findNoteBlockModel,
  getBlockComponentsExcludeSubtrees,
  matchFlavours,
} from '@blocksuite/affine-shared/utils';
import { Bound, Point } from '@blocksuite/global/utils';

import type { EdgelessRootBlockComponent } from '../../../edgeless/index.js';
import type { AffineDragHandleWidget } from '../drag-handle.js';

import { DropIndicator } from '../components/drop-indicator.js';
import { AFFINE_DRAG_HANDLE_WIDGET } from '../consts.js';
import {
  captureEventTarget,
  containBlock,
  getDuplicateBlocks,
  includeTextSelection,
} from '../utils.js';

export class DragEventWatcher {
  private _changeCursorToGrabbing = () => {
    document.documentElement.classList.add('affine-drag-preview-grabbing');
  };

  private _createDropIndicator = () => {
    if (!this.widget.dropIndicator) {
      this.widget.dropIndicator = new DropIndicator();
      this.widget.rootComponent.append(this.widget.dropIndicator);
    }
  };

  /**
   * When drag end, should move blocks to drop position
   */
  private _dragEndHandler: UIEventHandler = ctx => {
    this.widget.clearRaf();
    if (!this.widget.dragging || !this.widget.dragPreview) return false;
    if (this.widget.draggingElements.length === 0 || this.widget.doc.readonly) {
      this.widget.hide(true);
      return false;
    }

    const state = ctx.get('pointerState');
    const { target } = state.raw;
    if (!this.widget.host.contains(target as Node)) {
      this.widget.hide(true);
      return true;
    }

    for (const option of this.widget.optionRunner.options) {
      if (
        option.onDragEnd?.({
          state,
          draggingElements: this.widget.draggingElements,
          dropBlockId: this.widget.dropBlockId,
          dropType: this.widget.dropType,
          dragPreview: this.widget.dragPreview,
          noteScale: this.widget.noteScale.peek(),
          editorHost: this.widget.host,
        })
      ) {
        this.widget.hide(true);
        if (this.widget.mode === 'edgeless') {
          this.widget.edgelessWatcher.checkTopLevelBlockSelection();
        }
        return true;
      }
    }

    // call default drag end handler if no option return true
    this._onDragEnd(state);

    if (this.widget.mode === 'edgeless') {
      this.widget.edgelessWatcher.checkTopLevelBlockSelection();
    }

    return true;
  };

  /**
   * When dragging, should:
   * Update drag preview position
   * Update indicator position
   * Update drop block id
   */
  private _dragMoveHandler: UIEventHandler = ctx => {
    if (
      this.widget.isHoverDragHandleVisible ||
      this.widget.isTopLevelDragHandleVisible
    ) {
      this.widget.hide();
    }

    if (!this.widget.dragging || this.widget.draggingElements.length === 0) {
      return false;
    }

    ctx.get('defaultState').event.preventDefault();
    const state = ctx.get('pointerState');

    for (const option of this.widget.optionRunner.options) {
      if (option.onDragMove?.(state, this.widget.draggingElements)) {
        return true;
      }
    }

    // call default drag move handler if no option return true
    return this._onDragMove(state);
  };

  /**
   * When start dragging, should set dragging elements and create drag preview
   */
  private _dragStartHandler: UIEventHandler = ctx => {
    const state = ctx.get('pointerState');
    // If not click left button to start dragging, should do nothing
    const { button } = state.raw;
    if (button !== 0) {
      return false;
    }

    // call default drag start handler if no option return true
    for (const option of this.widget.optionRunner.options) {
      if (
        option.onDragStart?.({
          state,
          startDragging: this._startDragging,
          anchorBlockId: this.widget.anchorBlockId.peek() ?? '',
          editorHost: this.widget.host,
        })
      ) {
        return true;
      }
    }
    return this._onDragStart(state);
  };

  private _onDragEnd = (state: PointerEventState) => {
    const targetBlockId = this.widget.dropBlockId;
    const dropType = this.widget.dropType;
    const draggingElements = this.widget.draggingElements;
    this.widget.hide(true);

    // handle drop of blocks from note onto edgeless container
    if (!targetBlockId) {
      const target = captureEventTarget(state.raw.target);
      if (!target) return false;

      const isTargetEdgelessContainer =
        target.classList.contains('edgeless-container');
      if (!isTargetEdgelessContainer) return false;

      const selectedBlocks = getBlockComponentsExcludeSubtrees(draggingElements)
        .map(element => element.model)
        .filter((x): x is BlockModel => !!x);
      if (selectedBlocks.length === 0) return false;

      const isSurfaceComponent = selectedBlocks.some(block => {
        const parent = this.widget.doc.getParent(block.id);
        return matchFlavours(parent, ['affine:surface']);
      });
      if (isSurfaceComponent) return true;

      const edgelessRoot = this.widget
        .rootComponent as EdgelessRootBlockComponent;

      const { left: viewportLeft, top: viewportTop } = edgelessRoot.viewport;

      const newNoteId = edgelessRoot.addNoteWithPoint(
        new Point(state.raw.x - viewportLeft, state.raw.y - viewportTop),
        {
          scale: this.widget.noteScale.peek(),
        }
      );
      const newNoteBlock = this.widget.doc.getBlockById(
        newNoteId
      ) as NoteBlockModel;
      if (!newNoteBlock) return;

      const bound = Bound.deserialize(newNoteBlock.xywh);
      bound.h *= this.widget.noteScale.peek();
      bound.w *= this.widget.noteScale.peek();
      this.widget.doc.updateBlock(newNoteBlock, {
        xywh: bound.serialize(),
        edgeless: {
          ...newNoteBlock.edgeless,
          scale: this.widget.noteScale.peek(),
        },
      });

      const altKey = state.raw.altKey;
      if (altKey) {
        const duplicateBlocks = getDuplicateBlocks(selectedBlocks);

        this.widget.doc.addBlocks(duplicateBlocks, newNoteBlock);
      } else {
        this.widget.doc.moveBlocks(selectedBlocks, newNoteBlock);
      }

      edgelessRoot.service.selection.set({
        elements: [newNoteBlock.id],
        editing: true,
      });

      return true;
    }

    // Should make sure drop block id is not in selected blocks
    if (
      containBlock(
        this.widget.selectedBlocks.map(selection => selection.blockId),
        targetBlockId
      )
    ) {
      return false;
    }

    const selectedBlocks = getBlockComponentsExcludeSubtrees(draggingElements)
      .map(element => element.model)
      .filter((x): x is BlockModel => !!x);
    if (!selectedBlocks.length) {
      return false;
    }

    const targetBlock = this.widget.doc.getBlockById(targetBlockId);
    if (!targetBlock) return;

    const shouldInsertIn = dropType === 'in';

    const parent = shouldInsertIn
      ? targetBlock
      : this.widget.doc.getParent(targetBlockId);
    if (!parent) return;

    const altKey = state.raw.altKey;

    if (shouldInsertIn) {
      if (altKey) {
        const duplicateBlocks = getDuplicateBlocks(selectedBlocks);

        this.widget.doc.addBlocks(duplicateBlocks, targetBlock);
      } else {
        this.widget.doc.moveBlocks(selectedBlocks, targetBlock);
      }
    } else {
      if (altKey) {
        const duplicateBlocks = getDuplicateBlocks(selectedBlocks);

        const parentIndex =
          parent.children.indexOf(targetBlock) + (dropType === 'after' ? 1 : 0);

        this.widget.doc.addBlocks(duplicateBlocks, parent, parentIndex);
      } else {
        this.widget.doc.moveBlocks(
          selectedBlocks,
          parent,
          targetBlock,
          dropType === 'before'
        );
      }
    }

    // TODO: need a better way to update selection
    // Should update selection after moving blocks
    // In doc page mode, update selected blocks
    // In edgeless mode, focus on the first block
    setTimeout(() => {
      if (!parent) return;
      // Need to update selection when moving blocks successfully
      // Because the block path may be changed after moving
      const parentElement = this.widget.std.view.getBlock(parent.id);
      if (parentElement) {
        const newSelectedBlocks = selectedBlocks.map(block => {
          return this.widget.std.view.getBlock(block.id);
        });
        if (!newSelectedBlocks) return;

        const note = findNoteBlockModel(parentElement.model);
        if (!note) return;
        this.widget.setSelectedBlocks(
          newSelectedBlocks as BlockComponent[],
          note.id
        );
      }
    }, 0);

    return true;
  };

  private _onDragMove = (state: PointerEventState) => {
    this.widget.clearRaf();

    this.widget.rafID = requestAnimationFrame(() => {
      this.widget.edgelessWatcher.updateDragPreviewPosition(state);
      this.widget.updateDropIndicator(state, true);
    });
    return true;
  };

  private _onDragStart = (state: PointerEventState) => {
    const event = state.raw;
    const { target } = event;
    const element = captureEventTarget(target);
    const insideDragHandle = !!element?.closest(AFFINE_DRAG_HANDLE_WIDGET);
    // Should only start dragging when pointer down on drag handle
    // And current mouse button is left button
    if (!insideDragHandle) {
      this.widget.hide();
      return false;
    }

    if (!this.widget.isHoverDragHandleVisible || !this.widget.anchorBlockId)
      return;
    // Get current hover block element by path
    const hoverBlock = this.widget.anchorBlockComponent;
    if (!hoverBlock) return false;

    let selections = this.widget.selectedBlocks;

    // When current selection is TextSelection
    // Should set BlockSelection for the blocks in native range
    if (selections.length > 0 && includeTextSelection(selections)) {
      const nativeSelection = document.getSelection();
      const rangeManager = this.widget.std.range;
      if (nativeSelection && nativeSelection.rangeCount > 0 && rangeManager) {
        const range = nativeSelection.getRangeAt(0);
        const blocks = rangeManager.getSelectedBlockComponentsByRange(range, {
          match: el => el.model.role === 'content',
          mode: 'highest',
        });
        this.widget.setSelectedBlocks(blocks);
        selections = this.widget.selectedBlocks;
      }
    }

    // When there is no selected blocks
    // Or selected blocks not including current hover block
    // Set current hover block as selected
    if (
      selections.length === 0 ||
      !containBlock(
        selections.map(selection => selection.blockId),
        this.widget.anchorBlockId.peek()!
      )
    ) {
      const block = this.widget.anchorBlockComponent.peek();
      if (block) {
        this.widget.setSelectedBlocks([block]);
      }
    }

    const blocks = this.widget.selectedBlocks
      .map(selection => {
        return this.widget.std.view.getBlock(selection.blockId);
      })
      .filter((element): element is BlockComponent<BlockModel> => !!element);

    // This could be skip if we can ensure that all selected blocks are on the same level
    // Which means not selecting parent block and child block at the same time
    const blocksExcludingChildren = getBlockComponentsExcludeSubtrees(
      blocks
    ) as BlockComponent[];

    if (blocksExcludingChildren.length === 0) return false;

    this._startDragging(blocksExcludingChildren, state);
    this.widget.hide();
    return true;
  };

  private _startDragging = (
    blocks: BlockComponent[],
    state: PointerEventState,
    dragPreviewEl?: HTMLElement,
    dragPreviewOffset?: Point
  ) => {
    if (!blocks.length) {
      return;
    }

    this.widget.draggingElements = blocks;

    this.widget.dragPreview = this.widget.previewHelper.createDragPreview(
      blocks,
      state,
      dragPreviewEl,
      dragPreviewOffset
    );

    this.widget.dragging = true;
    this._changeCursorToGrabbing();
    this._createDropIndicator();
    this.widget.hide();
  };

  constructor(readonly widget: AffineDragHandleWidget) {}

  watch() {
    this.widget.handleEvent('dragStart', this._dragStartHandler);
    this.widget.handleEvent('dragMove', this._dragMoveHandler);
    this.widget.handleEvent('dragEnd', this._dragEndHandler, { global: true });
  }
}