# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Canvas — Groups, Shapes & UX Improvements

13 issues reported. Organized by category.

---

## CATEGORY A: Shape/Drawing Parity with Items

Pen strokes, lines, and shapes (box/ellipse) should behave as first-class items. Currently they're selectable (recent fix) but lack the rest.

### BUG A1: Shapes/drawings can't be grouped

**Symptom:** User selects a drawing + items and creates a group. The items go in, the drawing stays outside.

**Fix:** Group creation must include ALL selection buckets:
```typescript
function createGroup(selectedItems, selectedLines, selectedStrokes, selectedConnections) {
  const allChildren = [
    ...selectedItems.map(i => i.id),
    ...selectedLines.map(l => l.id),
    ...selectedStrokes.map(s => s.id),
    ...selectedConnections.map(c => c.id),
  ];
  
  // All of these need a parentId field that's set to the new group's id
  // Drawings/lines/strokes/connections all need parentId support in their data model
  
  return createContainer({
    childIds: allChildren,
    bounds: computeBboxOfAll(allChildren),
  });
}
```

Drawings, lines, strokes, and connections all need a `parentId` field so they can belong to a container.

### BUG A2: Shapes/drawings use only edge handles, not proportional corner handles

**Symptom:** When resizing a drawing/shape, only N/S/E/W edge handles work (crop-like). Corner handles (NW/NE/SW/SE) that would scale proportionally are missing or broken.

**Fix:** Add corner handles to all shapes and drawings with the same proportional scaling logic as items:
```typescript
// For strokes: scale all points proportionally
function scaleStrokeFromCorner(stroke, scaleX, scaleY, anchorX, anchorY) {
  stroke.points = stroke.points.map(p => ({
    x: anchorX + (p.x - anchorX) * scaleX,
    y: anchorY + (p.y - anchorY) * scaleY,
  }));
  stroke.strokeWidth *= Math.max(scaleX, scaleY); // scale stroke thickness too
}

// For lines: scale the two endpoints
function scaleLineFromCorner(line, scaleX, scaleY, anchorX, anchorY) {
  line.x1 = anchorX + (line.x1 - anchorX) * scaleX;
  line.y1 = anchorY + (line.y1 - anchorY) * scaleY;
  line.x2 = anchorX + (line.x2 - anchorX) * scaleX;
  line.y2 = anchorY + (line.y2 - anchorY) * scaleY;
  line.strokeWidth *= Math.max(scaleX, scaleY);
}

// Edge handles (N/S/E/W) still work for non-proportional crop/stretch
// Corner handles (NW/NE/SW/SE) = proportional scale with Shift for free stretch
```

### BUG A3: Right-click menu missing "Delete" for shapes/drawings

**Symptom:** Del key works, but right-click context menu doesn't show a delete option for drawings/shapes.

**Fix:** Context menu items must check selection across all buckets:
```typescript
function getContextMenuItems(selection) {
  const hasSelection = 
    selection.items.length > 0 ||
    selection.lines.length > 0 ||
    selection.strokes.length > 0 ||
    selection.connections.length > 0;
  
  if (!hasSelection) return baseMenuItems;
  
  return [
    { label: 'Delete', action: deleteAllSelected, shortcut: 'Del' },
    { label: 'Copy', action: copyAllSelected, shortcut: 'Ctrl+C' },
    { label: 'Cut', action: cutAllSelected, shortcut: 'Ctrl+X' },
    { label: 'Group', action: groupAllSelected, shortcut: 'Ctrl+G' },
    // ... other items
  ];
}
```

---

## CATEGORY B: Container/Group Behavior

### BUG B1: Box-to-text conversion creates huge border at low zoom

**Symptom:** User creates a box at 100% zoom (border = 2 world-px). User zooms to 6%. User double-clicks the box to type — border width suddenly becomes massive, disproportionate to the original.

**Root cause:** The box-to-text conversion re-applies the counter-zoom creation rule (`getCreationStrokeWidth`) to the existing box, which already had its borderWidth authored. This double-applies the counter-zoom.

**Fix:** Double-clicking an existing box to add text should NOT re-size its border. The border stays what the user authored:
```typescript
function convertBoxToText(box, clickWorldPos) {
  // Do NOT call getCreationStrokeWidth here
  // The box.borderWidth stays exactly as authored
  
  // Just add a child text item with counter-zoomed fontSize (that's fine)
  const textFontSize = getCreationFontSize(zoom);
  
  addItem({
    type: 'text',
    x: box.x + padding,
    y: box.y + padding,
    w: box.w - padding * 2,
    fontSize: textFontSize,
    parentId: box.id,
  });
}
```

### BUG B2: Group header overlaps with content inside the group

**Symptom:** When a child item is positioned at the very top of the group, the group header bar visually overlaps with it.

**Fix:** Group body has a top padding equal to header height. Children auto-offset below the header:
```typescript
const HEADER_HEIGHT = 32;
const CONTENT_TOP_PADDING = HEADER_HEIGHT + 8; // extra 8px breathing room

// When placing children inside a group, enforce minimum y offset:
function clampChildToBody(child, container) {
  const minY = container.y + CONTENT_TOP_PADDING;
  if (child.y < minY) child.y = minY;
}

// When computing group bounds from children:
function computeGroupBounds(children) {
  const minY = Math.min(...children.map(c => c.y)) - CONTENT_TOP_PADDING;
  // ... rest
}

// Render the body with CSS:
<div style={{
  position: 'absolute',
  top: HEADER_HEIGHT,
  left: 0,
  right: 0,
  bottom: 0,
  padding: '8px', // or use CONTENT_TOP_PADDING equivalent
}}>
  {children}
</div>
```

### BUG B3: Enter-group mode — moving child outside doesn't update group frame

**Symptom:** User enters group mode. User drags a child outside the group's bounds. The child moves, but the group frame stays the same size — child is now outside the visible group rectangle.

**Fix:** Group bounds must auto-update as children move. Recompute on every child drag:
```typescript
function onChildDragEnd(child, container) {
  // Recompute group bounding box from all children
  const newBounds = computeBoundingBox(container.children);
  
  // Expand group to include all children with some padding
  const padding = 16;
  container.x = newBounds.minX - padding;
  container.y = newBounds.minY - padding - HEADER_HEIGHT;
  container.w = newBounds.width + padding * 2;
  container.h = newBounds.height + padding * 2 + HEADER_HEIGHT;
  
  // Or, offer "shrink to fit" behavior only on explicit user action
}
```

**Alternative:** Auto-expand always, auto-shrink only when user clicks a "Fit to content" button in group menu. Auto-shrinking can feel jumpy while the user is still working.

### BUG B4: Group still shows in minimap when collapsed

**Symptom:** Minimap shows the collapsed group as if it were expanded (full bounds).

**Fix:** Minimap render uses the current render dimensions:
```typescript
function renderMinimapItem(item, minimap) {
  if (item.type === 'container') {
    const renderDims = getContainerRenderDimensions(item, 1.0); // use actual rendered, not world
    // When collapsed, render just the tab
    // When expanded, render the full bounds
  }
}
```

When collapsed, the minimap shows just the tab (same as canvas rendering).

### BUG B5: Copy/paste group copies empty (loses children)

**Symptom:** User selects a group with content, presses Ctrl+C, pastes. Result: empty group, 0 items.

**Fix:** Copy must include all children of copied groups recursively:
```typescript
function copySelection(selectedItems) {
  const allItems = [];
  
  for (const item of selectedItems) {
    allItems.push(item);
    
    if (item.type === 'container') {
      // Recursively add all descendants
      const descendants = getAllDescendants(item.id);
      allItems.push(...descendants);
    }
  }
  
  // Also include connections between copied items
  const copiedIds = new Set(allItems.map(i => i.id));
  const connections = state.connections.filter(c => 
    copiedIds.has(c.fromId) && copiedIds.has(c.toId)
  );
  
  return { items: allItems, connections };
}

// On paste, remap all IDs and preserve parent relationships:
function pasteSelection(clipboard, centerPos, zoom) {
  const idMap = new Map();
  
  // Generate new IDs for all items
  for (const item of clipboard.items) {
    idMap.set(item.id, uid());
  }
  
  // Paste items with remapped IDs and parentIds
  for (const item of clipboard.items) {
    addItem({
      ...item,
      id: idMap.get(item.id),
      parentId: item.parentId && idMap.has(item.parentId) 
        ? idMap.get(item.parentId)  // parent was also copied — remap
        : null,                       // parent not copied — paste at root
      // ... position/size scaling from existing paste logic
    });
  }
}
```

### BUG B6: Empty groups should auto-delete

**Symptom:** User creates a group, deletes all children, empty group (0 ITEMS) persists on canvas.

**Fix:** When a child is removed from a group, check if group is now empty. If yes, delete the group:
```typescript
function removeChildFromGroup(childId, groupId) {
  // Remove parentId from child
  const child = getItem(childId);
  child.parentId = null;
  
  // Check if group is now empty
  const group = getItem(groupId);
  const remainingChildren = getChildren(groupId);
  
  if (remainingChildren.length === 0) {
    // Auto-delete empty group
    deleteItem(groupId);
  }
}

// Same logic on delete:
function deleteItem(itemId) {
  const item = getItem(itemId);
  const parent = item.parentId ? getItem(item.parentId) : null;
  
  removeFromState(itemId);
  
  if (parent && parent.type === 'container') {
    const remaining = getChildren(parent.id);
    if (remaining.length === 0) {
      deleteItem(parent.id); // recursive — might delete parent's parent if also empty
    }
  }
}
```

---

## CATEGORY C: Group Keyboard/Context Actions

### FEATURE C1: Ctrl+G to group, right-click → Ungroup

**Fix:** Add keyboard shortcut and context menu items:
```typescript
// In useKeyboardShortcuts:
if (e.key === 'g' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
  e.preventDefault();
  if (selectionIsNonEmpty()) groupSelection();
}

if (e.key === 'g' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
  e.preventDefault();
  if (selectedContainer) ungroupContainer(selectedContainer);
}

// In context menu, when right-clicking on a group:
{
  label: 'Ungroup',
  shortcut: 'Ctrl+Shift+G',
  action: () => ungroupContainer(rightClickedGroup),
  // Only this specific group — doesn't affect nested groups inside
}

function ungroupContainer(group) {
  // Move all children out of the group, preserve their positions
  const children = getChildren(group.id);
  for (const child of children) {
    child.parentId = null; // or group.parentId if the group was itself nested
  }
  
  // Delete the group container
  deleteItem(group.id);
}
```

Note: Ungroup only affects the specific right-clicked group. Nested groups inside stay grouped.

### FEATURE C2: Can't add items while in enter-group mode

**Symptom:** When inside a group (enter-group mode), T/box/pen tools don't work.

**Fix:** Tool actions should work inside group focus, and new items become children of the focused group:
```typescript
function handleCanvasClick(clickPos, activeTool) {
  const focusedGroup = getFocusedGroup();
  
  switch (activeTool) {
    case 'T':
      createTextItem({
        x: clickPos.x,
        y: clickPos.y,
        parentId: focusedGroup?.id || null,
      });
      break;
    case 'box':
      // similar — parentId = focusedGroup?.id
      break;
  }
}
```

### FEATURE C3: Clicking outside shouldn't exit group mode

**Symptom:** User is inside a group. Clicks on empty canvas outside the group. Group focus exits, user has to re-enter.

**Fix:** Only exit group mode via explicit actions:
- Click the "×" / exit button on the group header
- Press Escape key
- Click on another group's header to switch focus

Clicking elsewhere inside the canvas (empty space, selecting things) should NOT exit group mode. The user might be arranging items inside the group.

```typescript
function onCanvasClick(e, clickPos) {
  // If in group mode, clicking outside the group's bounds should NOT exit
  if (focusedGroupId) {
    const focusedGroup = getItem(focusedGroupId);
    // Click is handled in group context regardless of position
    // Only Escape key or explicit exit button exits
    return;
  }
  
  // Normal canvas click handling
}
```

### FEATURE C4: Nested groups — header shows submenu to enter each

**Symptom:** User groups two groups. Wants to enter the inner groups individually.

**Fix:** Group header shows a dropdown / breadcrumb list when containing sub-groups:
```
┌─── OuterGroup ───── 5 items ▼ ─── [Enter ▾] ─ ┐
│                                       ├──────┤
│  Inner1 (3 items)    Inner2 (2 items) │ Enter Inner1 │
│                                       │ Enter Inner2 │
│                                       │──────────────│
│                                       │ Enter Outer  │
│                                       └──────────────┘
```

Or a breadcrumb navigation at the top:
```
[Canvas] > [OuterGroup] > [Inner1]  ← click any crumb to jump there
```

The breadcrumb approach is simpler — use what was already scoped in the earlier breadcrumb discussion.

Also: when viewing the outer group (not focused), both inner groups render as they were authored (expanded or collapsed). No change to their visual state from being nested.

---

## CATEGORY D: App Window

### BUG D1: Window position not persisted on toggle

**Symptom:** User toggles KLYPIX off, toggles back on. Window appears on left side of screen instead of where user had it (right side, aligned with chat).

**Fix:** Save and restore window bounds in the main Electron process:
```typescript
// In main.ts
const { app, BrowserWindow, screen } = require('electron');
const Store = require('electron-store');
const store = new Store();

let mainWindow;

function createWindow() {
  const savedBounds = store.get('windowBounds');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workArea;
  
  // Default: right side, aligned with typical chat app position
  const defaultBounds = {
    width: 1200,
    height: 800,
    x: screenWidth - 1200,
    y: 100,
  };
  
  mainWindow = new BrowserWindow({
    ...defaultBounds,
    ...savedBounds, // override with saved if exists
  });
  
  // Save bounds on close
  mainWindow.on('close', () => {
    store.set('windowBounds', mainWindow.getBounds());
  });
  
  // Also save periodically on move/resize
  let saveTimer;
  mainWindow.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('windowBounds', mainWindow.getBounds()), 500);
  });
  mainWindow.on('resized', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('windowBounds', mainWindow.getBounds()), 500);
  });
}
```

Install `electron-store` if not already installed. This persists window position across app restarts, toggles, and reboots.

---

## PRIORITY ORDER

1. **BUG A1** (shapes can't be grouped) — foundational, affects everything else
2. **BUG B6** (empty groups auto-delete) — critical UX, feels broken now
3. **BUG B5** (copy/paste group includes children) — critical, core feature broken
4. **FEATURE C1** (Ctrl+G + Ungroup) — most requested group operation
5. **FEATURE C3** (click outside doesn't exit group mode) — fixes frustrating interaction
6. **FEATURE C2** (can add items in group mode) — completes group mode
7. **BUG B1** (box-to-text border regression) — visual quality
8. **BUG B3** (group frame follows children) — visual quality
9. **BUG B2** (header doesn't overlap content) — visual quality
10. **BUG A2** (corner handles on shapes) — QoL improvement
11. **BUG A3** (context menu delete for shapes) — QoL improvement
12. **BUG B4** (minimap collapsed group) — visual polish
13. **FEATURE C4** (nested group navigation) — later, complex
14. **BUG D1** (window position persistence) — independent, can ship anytime

---

## TEST SEQUENCE

After implementation:

1. Create a text + a pen stroke. Select both. Ctrl+G. → Both in group.
2. Enter group. Move stroke outside group bounds. → Group frame expands to include it.
3. Delete all children of a group. → Group auto-deletes.
4. Copy a group with children. Paste. → Group pastes with all children intact.
5. Right-click a group. → Ungroup option present.
6. Right-click a stroke. → Delete option present.
7. Enter group mode. Click outside group on canvas. → Stays in group mode.
8. Enter group mode. Press T. Click. → New text added as child of group.
9. Enter group mode. Press Escape. → Exits group mode.
10. Collapse a group. View minimap. → Minimap shows the tab, not full bounds.
11. Create box at 100%. Zoom to 6%. Double-click to add text. → Border stays authored width.
12. Move window to right side. Close app. Reopen. → Window appears on right side.
