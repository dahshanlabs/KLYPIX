import { useEffect } from 'react';
import { useCanvasStore } from '../state/canvasStore';
import { fitToViewport, itemsBounds } from '../CanvasEngine';
import type { CanvasItem, Connection, DrawnLine, FreehandStroke, ImageItem, TextItem } from '../items/types';
import { newId } from '../items/types';
import { base64ToBytes, registerAsset } from '../file/assetRegistry';
import { fileToItem } from '../file/dropHandler';
import { defaultTextColorFor, getCurrentGridSettings } from '../gridSettings';

// Paste sizing + placement policy (spec'd by product):
//   RULE 1 — paste position = current viewport center.
//   RULE 2 — paste size = scaled so the item (or bounding box) renders
//            at ~TARGET_PASTE_SCREEN_W screen-px at current zoom.
//   RULE 3 — view NEVER changes on paste. No auto-zoom, no pan, no tween.
// User controls the camera; the paste adapts to fit what they see.
// Target screen-px used ONLY for OS-clipboard image/text pastes, where the
// incoming content has no canvas context to size itself against. Canvas-to-
// canvas paste (pasteCanvasItems) is now strictly 1:1 world-px — items keep
// their authored size regardless of view zoom.
const TARGET_PASTE_SCREEN_W = 300;
const PASTE_OFFSET_SCREEN_PX = 20;    // screen-px — repeat-paste stagger
const PASTE_REPEAT_RESET_MS = 2000;   // reset stagger counter after this idle time

let pasteRepeatCount = 0;
let lastPasteAt = 0;

// In-memory clipboard for canvas items. Not OS-level — simpler and works
// across canvases within one KLYPIX session. Tracks connections AND
// drawings between copied items so arrow relationships + child strokes
// survive paste with remapped IDs. A copied group transitively brings
// every descendant (items + drawings), so paste reconstructs the whole
// sub-tree (spec B5).
const canvasClipboard: {
    items: CanvasItem[];
    connections: Connection[];
    lines: DrawnLine[];
    strokes: FreehandStroke[];
} = {
    items: [],
    connections: [],
    lines: [],
    strokes: [],
};

// Canvas copy flow. Snapshots the current selection into the in-memory
// clipboard (items AND any connections whose BOTH endpoints are in the
// selection), claims OS-clipboard ownership via the main-process flag,
// and writes any text content through `navigator.clipboard.writeText`
// so external apps can still paste the text.
function performCanvasCopy(state: any): void {
    // Expand selection to include descendants of any copied container so
    // pasting a group reconstructs the whole sub-tree (items + drawings).
    // Operates on parentId chains — every item/line/stroke whose ancestor
    // chain passes through a selected container is pulled in.
    const selectedItemSet = new Set<string>(state.selectedIds);
    const selectedLineSet = new Set<string>(state.selectedLineIds);
    const selectedStrokeSet = new Set<string>(state.selectedStrokeIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const it of Object.values(state.items as Record<string, CanvasItem>)) {
            if (!it.parentId) continue;
            if (selectedItemSet.has(it.id)) continue;
            if (selectedItemSet.has(it.parentId)) {
                selectedItemSet.add(it.id);
                changed = true;
            }
        }
        for (const ln of Object.values(state.lines as Record<string, DrawnLine>)) {
            if (!ln.parentId) continue;
            if (selectedLineSet.has(ln.id)) continue;
            if (selectedItemSet.has(ln.parentId)) {
                selectedLineSet.add(ln.id);
                changed = true;
            }
        }
        for (const st of Object.values(state.strokes as Record<string, FreehandStroke>)) {
            if (!st.parentId) continue;
            if (selectedStrokeSet.has(st.id)) continue;
            if (selectedItemSet.has(st.parentId)) {
                selectedStrokeSet.add(st.id);
                changed = true;
            }
        }
    }

    canvasClipboard.items = Array.from(selectedItemSet)
        .map((id) => state.items[id])
        .filter(Boolean) as CanvasItem[];
    canvasClipboard.lines = Array.from(selectedLineSet)
        .map((id) => state.lines[id])
        .filter(Boolean) as DrawnLine[];
    canvasClipboard.strokes = Array.from(selectedStrokeSet)
        .map((id) => state.strokes[id])
        .filter(Boolean) as FreehandStroke[];
    // Capture intra-selection connections. Connections that cross the
    // boundary (one endpoint selected, one not) are intentionally
    // dropped — there's nothing coherent to paste them against.
    canvasClipboard.connections = Object.values(state.connections as Record<string, Connection>)
        .filter((c) => selectedItemSet.has(c.fromId) && selectedItemSet.has(c.toId));
    const textForOs = canvasClipboard.items
        .filter((it: CanvasItem) => it.type === 'text')
        .map((it: any) => it.content || '')
        .join('\n')
        .trim();
    const api: any = (window as any).electron;
    try { api?.canvas?.claimClipboard?.(textForOs.length > 0); } catch { /* no-op */ }
    if (textForOs) {
        try { navigator.clipboard.writeText(textForOs).catch(() => {}); } catch { /* no-op */ }
    }
    // Copying resets the paste-stagger counter — the user has a new
    // intent and repeat-paste offsets shouldn't carry over.
    pasteRepeatCount = 0;
}

// Compute the viewport center in world coords + a repeat-paste stagger
// offset so rapid pastes don't stack invisibly on top of each other.
// The stagger resets after PASTE_REPEAT_RESET_MS of paste inactivity.
function nextPasteCenter(view: { panX: number; panY: number; zoom: number }): { x: number; y: number } {
    const now = Date.now();
    if (now - lastPasteAt > PASTE_REPEAT_RESET_MS) pasteRepeatCount = 0;
    lastPasteAt = now;
    const z = Math.max(0.01, view.zoom);
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const centerScreenX = vw / 2;
    const centerScreenY = vh / 2;
    // Screen → world
    const cx = (centerScreenX - view.panX) / z;
    const cy = (centerScreenY - view.panY) / z;
    const offsetWorld = (pasteRepeatCount * PASTE_OFFSET_SCREEN_PX) / z;
    pasteRepeatCount++;
    return { x: cx + offsetWorld, y: cy + offsetWorld };
}

// Paste canvas-clipboard items into the store at `center` in world coords,
// scaling the (optional) bounding box so its WIDTH renders at
// TARGET_PASTE_SCREEN_W screen-px at the current zoom. Preserves relative
// layout of multi-item pastes, remaps parent + connection IDs.
// NEVER changes the view — the caller must not call SET_VIEW here.
function pasteCanvasItems(
    items: CanvasItem[],
    connections: Connection[],
    center: { x: number; y: number },
    ctx: { state: any; commit: (a: any) => void; dispatch: (a: any) => void },
    lines: DrawnLine[] = [],
    strokes: FreehandStroke[] = [],
) {
    if (items.length === 0 && lines.length === 0 && strokes.length === 0) return;
    const zoom = Math.max(0.01, ctx.state.view.zoom);

    // Bounding box of the source content in world coords — includes drawings
    // so a group made of only strokes still centers correctly on paste.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        if (it.x < minX) minX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.x + it.w > maxX) maxX = it.x + it.w;
        if (it.y + it.h > maxY) maxY = it.y + it.h;
    }
    for (const ln of lines) {
        const lx1 = Math.min(ln.x1, ln.x2), ly1 = Math.min(ln.y1, ln.y2);
        const lx2 = Math.max(ln.x1, ln.x2), ly2 = Math.max(ln.y1, ln.y2);
        if (lx1 < minX) minX = lx1;
        if (ly1 < minY) minY = ly1;
        if (lx2 > maxX) maxX = lx2;
        if (ly2 > maxY) maxY = ly2;
    }
    for (const st of strokes) {
        for (const pt of st.points) {
            if (pt.x < minX) minX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y > maxY) maxY = pt.y;
        }
    }
    if (!isFinite(minX)) return;
    const originalW = Math.max(1, maxX - minX);
    const originalH = Math.max(1, maxY - minY);

    // Canvas-to-canvas paste is strictly 1:1 in world-px. Items keep their
    // authored size; zoom is just magnification. Previously the paste had a
    // rescue-band that up-scaled sources < 100 screen-px and down-scaled
    // sources > 600 screen-px at current zoom — surprising: a small group
    // copied at 79% zoom came back noticeably bigger than the original.
    const scaleRatio = 1;
    const targetWorldW = originalW;
    const scaledH = originalH;

    // Offsets so the (scaled or original) bounding box is centered on `center`.
    const offsetX = center.x - targetWorldW / 2 - minX * scaleRatio;
    const offsetY = center.y - scaledH / 2 - minY * scaleRatio;

    // ID remap — every copied item gets a fresh id. Parent references
    // between copied items and connections use the remap so relationships
    // survive. Items whose parent WASN'T copied become top-level on paste.
    const now = Date.now();
    const idMap = new Map<string, string>();
    for (let i = 0; i < items.length; i++) {
        idMap.set(items[i].id, `paste_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`);
    }

    const newIds: string[] = [];
    const topLevelIds: string[] = [];
    for (const src of items) {
        const newId = idMap.get(src.id)!;
        const parentId = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId)! : null;
        if (parentId === null) topLevelIds.push(newId);
        const patch: any = {
            ...src,
            id: newId,
            parentId,
            x: src.x * scaleRatio + offsetX,
            y: src.y * scaleRatio + offsetY,
            w: Math.max(1, src.w * scaleRatio),
            h: Math.max(1, src.h * scaleRatio),
            zIndex: ctx.state.order.length,
            createdAt: now,
            // authoredInParent is tied to the source container. Clear
            // it — the new parent (if any) will re-seed on the next
            // vector-scale effect pass.
            authoredInParent: undefined,
        };
        if (src.type === 'text') {
            patch.fontSize = Math.max(1, (src.fontSize || 16) * scaleRatio);
            if ((src as TextItem).authoredWidth != null) {
                patch.authoredWidth = (src as TextItem).authoredWidth! * scaleRatio;
            }
        }
        if (src.type === 'box') {
            patch.borderWidth = Math.max(0.5, (src.borderWidth || 2) * scaleRatio);
        }
        if (src.type === 'container') {
            // 1:1 paste — preserve the authored baseline from the source
            // so the vector-scale system keeps the same scale ratio (and
            // child derivation) the user had.
            patch.authoredW = src.authoredW ?? src.w;
            patch.authoredH = src.authoredH ?? src.h;
            // Drop cosmetic collapsed tab width — belonged to the old
            // position; user can set a new one if they collapse.
            patch.collapsedW = undefined;
        }
        ctx.commit({ type: 'ADD_ITEM', item: patch as CanvasItem });
        newIds.push(newId);
    }

    // Re-create connections whose BOTH endpoints were in the paste set.
    // Connections to items outside the set are dropped on purpose.
    for (let i = 0; i < connections.length; i++) {
        const c = connections[i];
        const from = idMap.get(c.fromId);
        const to = idMap.get(c.toId);
        if (!from || !to) continue;
        ctx.commit({
            type: 'ADD_CONNECTION',
            connection: {
                ...c,
                id: `pasteconn_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                fromId: from,
                toId: to,
            },
        });
    }

    // Re-create pasted drawings (lines + pen strokes). Their positions
    // are transformed through the same scale+offset as items so a
    // mixed paste keeps its relative layout. parentId is remapped only
    // if the container was also in the paste set; otherwise the
    // drawing becomes top-level.
    for (let i = 0; i < lines.length; i++) {
        const src = lines[i];
        const newParent = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId)! : null;
        ctx.commit({
            type: 'ADD_LINE',
            line: {
                ...src,
                id: `pasteln_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                x1: src.x1 * scaleRatio + offsetX,
                y1: src.y1 * scaleRatio + offsetY,
                x2: src.x2 * scaleRatio + offsetX,
                y2: src.y2 * scaleRatio + offsetY,
                width: Math.max(0.5, src.width * scaleRatio),
                parentId: newParent,
            },
        });
    }
    for (let i = 0; i < strokes.length; i++) {
        const src = strokes[i];
        const newParent = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId)! : null;
        ctx.commit({
            type: 'ADD_STROKE',
            stroke: {
                ...src,
                id: `pastest_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                points: src.points.map(p => ({
                    ...p,
                    x: p.x * scaleRatio + offsetX,
                    y: p.y * scaleRatio + offsetY,
                })),
                width: Math.max(0.5, src.width * scaleRatio),
                parentId: newParent,
            },
        });
    }

    // Select only top-level pasted items so a pasted group leaves just the
    // container selected (not its text children, which would pop the
    // text-format capsule and look like an "select all" expansion).
    const selectIds = topLevelIds.length > 0 ? topLevelIds : newIds;
    ctx.dispatch({ type: 'SELECT', ids: selectIds });
}

// Viewport-center world coords used by legacy paths (retained for
// anything that still wants a raw center without the paste-stagger logic).
function viewportCenterWorld(view: { panX: number; panY: number; zoom: number }): { x: number; y: number } {
    const z = Math.max(view.zoom, 0.0001);
    const cx = (typeof window !== 'undefined' ? window.innerWidth / 2 : 400);
    const cy = (typeof window !== 'undefined' ? window.innerHeight / 2 : 300);
    return { x: (cx - view.panX) / z, y: (cy - view.panY) / z };
}

async function imageNaturalSize(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
        img.onerror = () => resolve({ w: 300, h: 200 });
        img.src = src;
    });
}

// Paste handler. Reads OS clipboard via the electron IPC, decides whether
// to spawn an ImageItem (screenshot), a TextItem (external text that wasn't
// already covered by a canvas-item copy), or fall through to the in-memory
// canvasClipboard duplicate flow.
interface PasteCtx {
    state: any;
    commit: (action: any) => void;
    dispatch: (action: any) => void;
}
async function pasteFromClipboard({ state, commit, dispatch }: PasteCtx): Promise<void> {
    const api: any = (window as any).electron;
    let imageBase64: string | null = null;
    let osText: string | null = null;
    let filePaths: string[] = [];
    let lastFormat: 'text' | 'image' | 'files' | 'none' = 'none';
    let canvasOwns = false;
    try {
        if (api?.readClipboard) {
            const res = await api.readClipboard();
            imageBase64 = res?.imageBase64 || null;
            osText = typeof res?.text === 'string' && res.text.trim() ? res.text : null;
            filePaths = Array.isArray(res?.filePaths) ? res.filePaths : [];
            lastFormat = (res?.lastFormat as 'text' | 'image' | 'files' | 'none') || 'none';
            canvasOwns = !!res?.canvasOwnsClipboard;
        }
    } catch { /* main-process read failed; fall through */ }

    // Single paste-center for every path below. Viewport-center in world
    // coords + a repeat-paste stagger offset so rapid pastes don't stack
    // invisibly. NEVER change the view from here — Rule 3.
    const center = nextPasteCenter(state.view);
    const zoom = Math.max(0.01, state.view.zoom);
    const targetWorldW = TARGET_PASTE_SCREEN_W / zoom;

    // Canvas owns the clipboard (renderer did a canvas copy and no external
    // change has been observed since). Short-circuit to the in-canvas
    // paste path — includes connections and preserves relative layout.
    if (canvasOwns && canvasClipboard.items.length > 0) {
        pasteCanvasItems(canvasClipboard.items, canvasClipboard.connections, center, { state, commit, dispatch }, canvasClipboard.lines, canvasClipboard.strokes);
        return;
    }

    // Files copied from Explorer (Ctrl+C on a file) land here via the
    // Windows CF_HDROP clipboard format. Route through the same
    // fileToItem pipeline drag-and-drop uses so PDFs, images, code,
    // video, audio, XLSX, DOCX etc. all get their rich previews +
    // asset-registry persistence in the .any ZIP. Falls through only
    // if every path fails to read.
    if (filePaths.length > 0 && api?.readFileBytes) {
        const zStart = state.order.length;
        let added = 0;
        const newIds: string[] = [];
        for (let i = 0; i < filePaths.length; i++) {
            const res = await api.readFileBytes(filePaths[i]).catch(() => null);
            if (!res?.success || !res.base64 || !res.name) continue;
            try {
                const bytes = base64ToBytes(res.base64);
                // Blob → File so fileToItem's arrayBuffer/text APIs work.
                const blob = new Blob([bytes as any]);
                const file = new File([blob], res.name, { type: '' });
                const item = await fileToItem(
                    file,
                    { x: center.x, y: center.y, zIndexStart: zStart, viewZoom: state.view.zoom },
                    i,
                );
                if (item) {
                    commit({ type: 'ADD_ITEM', item });
                    newIds.push(item.id);
                    added++;
                }
            } catch { /* skip this file, try next */ }
        }
        if (added > 0) {
            dispatch({ type: 'SELECT', ids: newIds });
            return;
        }
        // else: couldn't read any paths → fall through to image/text paths.
    }

    // Use whichever format was LAST WRITTEN to the clipboard. If user
    // copied text most recently → paste text; screenshotted → paste
    // image. No priority games; honour the user's last copy.
    const prefer: 'text' | 'image' =
        lastFormat === 'image' ? 'image'
      : lastFormat === 'text' ? 'text'
      : (osText ? 'text' : 'image');

    if (prefer === 'text' && osText) {
        const canvasTextMatch = canvasClipboard.items.some(it => it.type === 'text' && it.content === osText);
        if (!canvasTextMatch) {
            // Canonical world-px sizing — text pasted from OS clipboard
            // lands at the same size as T-tool text: fontSize 14, width
            // 300, regardless of current view zoom.
            const fontSize = 14;
            const textWidth = 300;
            const text: TextItem = {
                id: newId('txt'),
                type: 'text',
                x: center.x - textWidth / 2,
                y: center.y - fontSize / 2,
                w: textWidth,
                h: Math.max(fontSize * 1.8, 28),
                zIndex: state.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'user',
                content: osText,
                fontSize,
                color: defaultTextColorFor(getCurrentGridSettings().background),
                border: false,
                borderColor: 'rgba(16,185,129,0.5)',
                heading: false,
            };
            commit({ type: 'ADD_ITEM', item: text });
            dispatch({ type: 'SELECT', ids: [text.id] });
            return;
        }
    }

    if (prefer === 'image' && imageBase64) {
        try {
            const bytes = base64ToBytes(imageBase64);
            const asset = registerAsset({
                mime: 'image/png',
                extension: 'png',
                bytes,
                fileName: `clipboard_${Date.now()}.png`,
            });
            const { w: nw, h: nh } = await imageNaturalSize(asset.blobUrl);
            // Scale so the image's WIDTH equals targetWorldW — i.e.
            // renders at TARGET_PASTE_SCREEN_W at current zoom. Height
            // preserves aspect. The same rule as canvas-item paste, so
            // OS-image and canvas-item pastes feel consistent.
            const scale = targetWorldW / Math.max(1, nw);
            const displayW = Math.max(1, Math.round(nw * scale));
            const displayH = Math.max(1, Math.round(nh * scale));
            const image: ImageItem = {
                id: newId('img'),
                type: 'image',
                x: center.x - displayW / 2,
                y: center.y - displayH / 2,
                w: displayW,
                h: displayH,
                zIndex: state.order.length,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'user',
                src: '',
                assetId: asset.id,
                originalWidth: nw,
                originalHeight: nh,
                fileName: 'Pasted image',
            };
            commit({ type: 'ADD_ITEM', item: image });
            dispatch({ type: 'SELECT', ids: [image.id] });
            return;
        } catch { /* fall through on failure */ }
    }

    // Fallback to in-canvas paste path (no canvas ownership + no usable
    // OS content). If the canvas clipboard has items from an earlier
    // copy this session, paste those.
    pasteCanvasItems(canvasClipboard.items, canvasClipboard.connections, center, { state, commit, dispatch }, canvasClipboard.lines, canvasClipboard.strokes);
}

// True if there's a live text selection whose anchor lives inside a
// [data-thread-panel] element. Used to let browser-native Ctrl+C pass through
// instead of being hijacked by the canvas-item copy shortcut.
function isTextSelectionInThread(): boolean {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const anchor = sel.anchorNode;
    if (!anchor) return false;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    return !!el?.closest('[data-thread-panel]');
}

// Global keyboard shortcuts — only wired while the canvas is active (the caller
// mounts this hook conditionally). Intentionally doesn't swallow keys while the
// user is typing inside a text item (focus is on a textarea/input).

interface ShortcutCallbacks {
    onOpenSearch?: () => void;
    onVoice?: () => void;
    onToggleOutline?: () => void;
    onGroup?: () => void;
    onUngroup?: () => void;
}

export function useCanvasKeyboardShortcuts(active: boolean, cbs: ShortcutCallbacks = {}) {
    const { state, dispatch, commit, undo, redo } = useCanvasStore();

    useEffect(() => {
        if (!active) return;
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const typingIntoField =
                target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

            // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y always run canvas undo/redo — even
            // while typing inside a text item. The tradeoff: we lose the browser's
            // per-character typing undo. But controlled textareas make that
            // unreliable anyway (native undo fires input events that revert
            // state.content one char at a time, which *looks* like undo is
            // broken when it's really browser undo fighting canvas undo).
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) {
                e.preventDefault();
                redo();
                return;
            }

            // Text formatting for the currently-editing text item. Works inside
            // the textarea (Ctrl+B / Ctrl+I would otherwise do browser defaults).
            const kForFmt = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && (kForFmt === 'b' || kForFmt === 'i') && state.editingId) {
                const it = state.items[state.editingId];
                if (it && it.type === 'text') {
                    e.preventDefault();
                    if (kForFmt === 'b') {
                        dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { fontWeight: it.fontWeight === 'bold' ? 'normal' : 'bold' } });
                    } else {
                        dispatch({ type: 'UPDATE_ITEM', id: it.id, patch: { fontStyle: it.fontStyle === 'italic' ? 'normal' : 'italic' } });
                    }
                    return;
                }
            }

            if (typingIntoField) return;

            // Escape clears focus mode (Enter Group). Handle this BEFORE
            // later typingIntoField-gated shortcuts — always responsive.
            if (e.key === 'Escape' && state.focusedContainerId) {
                e.preventDefault();
                dispatch({ type: 'SET_FOCUSED_CONTAINER', id: null });
                return;
            }

            // Zoom / fit shortcuts.
            if ((e.ctrlKey || e.metaKey) && e.key === '0') {
                e.preventDefault();
                const itemsArr = state.order.map(id => state.items[id]).filter(Boolean);
                const bounds = itemsBounds(itemsArr as { x: number; y: number; w: number; h: number }[]);
                if (bounds) {
                    const view = fitToViewport(bounds, { w: window.innerWidth, h: window.innerHeight });
                    dispatch({ type: 'SET_VIEW', view });
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
                e.preventDefault();
                dispatch({ type: 'ZOOM', factor: 1.2, cx: window.innerWidth / 2, cy: window.innerHeight / 2 });
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === '-') {
                e.preventDefault();
                dispatch({ type: 'ZOOM', factor: 1 / 1.2, cx: window.innerWidth / 2, cy: window.innerHeight / 2 });
                return;
            }
            // Ctrl+F open search panel.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                cbs.onOpenSearch?.();
                return;
            }
            // Ctrl+M voice input toggle.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                cbs.onVoice?.();
                return;
            }

            // Ctrl+H → toggle the outline / hierarchy sidebar (spec §24J).
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && !e.shiftKey && !typingIntoField) {
                e.preventDefault();
                cbs.onToggleOutline?.();
                return;
            }
            // Ctrl+G overloaded: with selection → Group (handled below).
            // Without selection AND non-shift → jump-to-last-agent-item.
            // Previously this block unconditionally consumed Ctrl+G, which
            // stole the event before the group shortcut at the bottom of
            // this handler could fire (spec Issue 4a — Ctrl+G on a
            // selected stroke did nothing). Guard: only agent-jump when
            // nothing is selected.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && !e.shiftKey) {
                const anySelection =
                    state.selectedIds.length > 0
                    || state.selectedLineIds.length > 0
                    || state.selectedStrokeIds.length > 0
                    || state.selectedConnectionIds.length > 0;
                if (!anySelection) {
                    e.preventDefault();
                    const agent = state.order
                        .map(id => state.items[id])
                        .filter(it => it && it.createdBy === 'agent')
                        .sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0))[0];
                    if (agent) {
                        const view = fitToViewport(
                            { x: agent.x - 200, y: agent.y - 200, w: agent.w + 400, h: agent.h + 400 },
                            { w: window.innerWidth, h: window.innerHeight },
                        );
                        dispatch({ type: 'SET_VIEW', view });
                        dispatch({ type: 'SELECT', ids: [agent.id] });
                    }
                    return;
                }
                // else: fall through to the group handler later in this switch
            }
            // Ctrl+1..9 bookmarks. Shift saves, plain jumps.
            if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const slot = parseInt(e.key, 10);
                if (e.shiftKey) {
                    // Save current view.
                    dispatch({ type: 'SET_BOOKMARK', slot, view: state.view });
                } else {
                    // Jump to saved view.
                    const bm = state.bookmarks[slot];
                    if (bm) dispatch({ type: 'SET_VIEW', view: bm });
                }
                return;
            }

            // Escape: cancel editing / clear selection.
            if (e.key === 'Escape') {
                if (state.editingId) dispatch({ type: 'SET_EDITING', id: null });
                else dispatch({ type: 'CLEAR_SELECTION' });
                return;
            }

            // Delete selected items / connections / drawings. A marquee
            // can produce a mixed selection (item + stroke + line), so all
            // three categories get dispatched in one pass — but only the
            // first dispatch counts as the undo boundary; the rest are
            // plain dispatches to keep it atomic.
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const hasConns = state.selectedConnectionIds.length > 0;
                const hasItems = state.selectedIds.length > 0;
                const hasLines = state.selectedLineIds.length > 0;
                const hasStrokes = state.selectedStrokeIds.length > 0;
                if (!hasConns && !hasItems && !hasLines && !hasStrokes) return;
                e.preventDefault();
                let firstCommitted = false;
                const send = (action: any) => {
                    if (!firstCommitted) { commit(action); firstCommitted = true; }
                    else dispatch(action);
                };
                if (hasConns) send({ type: 'DELETE_CONNECTIONS', ids: state.selectedConnectionIds });
                if (hasItems) send({ type: 'DELETE_ITEMS', ids: state.selectedIds });
                if (hasLines) send({ type: 'DELETE_LINES', ids: state.selectedLineIds });
                if (hasStrokes) send({ type: 'DELETE_STROKES', ids: state.selectedStrokeIds });
                return;
            }

            // Tool switches — only on a bare key press. A modifier combo
            // (Ctrl+V for paste, Ctrl+T for text…) must fall through to the
            // Ctrl-* branches below instead of being swallowed by these
            // single-letter shortcuts.
            const k = e.key.toLowerCase();
            const noMod = !(e.ctrlKey || e.metaKey || e.altKey);
            if (noMod && k === 't') dispatch({ type: 'SET_TOOL', tool: 'type' });
            else if (noMod && k === 'v') dispatch({ type: 'SET_TOOL', tool: 'select' });
            else if (noMod && k === 'b') dispatch({ type: 'SET_TOOL', tool: 'box' });
            else if (noMod && k === 'l') dispatch({ type: 'SET_TOOL', tool: 'line' });
            else if (noMod && k === 'p') dispatch({ type: 'SET_TOOL', tool: 'pen' });
            else if (noMod && k === 'c') dispatch({ type: 'SET_TOOL', tool: 'connect' });
            else if (noMod && k === 'e') dispatch({ type: 'SET_TOOL', tool: 'eraser' });
            else if ((e.ctrlKey || e.metaKey) && k === 'c') {
                // If the user has a live text selection inside the per-item
                // chat thread panel, let the browser handle native copy —
                // don't hijack it with canvas-item copy.
                if (isTextSelectionInThread()) return;
                // Copy selection into the canvas clipboard. Only hijack the
                // native copy if we actually have a selection — otherwise
                // let the browser copy whatever text is selected.
                if (state.selectedIds.length > 0) {
                    e.preventDefault();
                    performCanvasCopy(state);
                }
            } else if ((e.ctrlKey || e.metaKey) && k === 'x') {
                // Cut = copy + delete the whole selection (items + drawings
                // + every descendant of any selected container). Previously
                // this passed `state.selectedIds` straight to DELETE_ITEMS,
                // which for a group selection deleted only the container
                // itself — the reducer's orphan-rescue then kept children
                // alive at top level. That broke the "Cut → Paste restores
                // the whole group" flow. Here we expand to descendants via
                // the same parentId walk `performCanvasCopy` uses so the
                // delete matches the clipboard contents exactly.
                const anySel =
                    state.selectedIds.length > 0
                    || state.selectedLineIds.length > 0
                    || state.selectedStrokeIds.length > 0;
                if (!anySel) return;
                e.preventDefault();
                performCanvasCopy(state);
                const doomItems = new Set<string>(state.selectedIds);
                const doomLines = new Set<string>(state.selectedLineIds);
                const doomStrokes = new Set<string>(state.selectedStrokeIds);
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const it of Object.values(state.items as Record<string, CanvasItem>)) {
                        if (!it.parentId || doomItems.has(it.id)) continue;
                        if (doomItems.has(it.parentId)) { doomItems.add(it.id); changed = true; }
                    }
                    for (const [lid, ln] of Object.entries(state.lines as Record<string, DrawnLine>)) {
                        if (!ln.parentId || doomLines.has(lid)) continue;
                        if (doomItems.has(ln.parentId)) { doomLines.add(lid); changed = true; }
                    }
                    for (const [sid, st] of Object.entries(state.strokes as Record<string, FreehandStroke>)) {
                        if (!st.parentId || doomStrokes.has(sid)) continue;
                        if (doomItems.has(st.parentId)) { doomStrokes.add(sid); changed = true; }
                    }
                }
                let first = true;
                const send = (a: any) => { if (first) { commit(a); first = false; } else dispatch(a); };
                if (doomItems.size > 0) send({ type: 'DELETE_ITEMS', ids: Array.from(doomItems) });
                if (doomLines.size > 0) send({ type: 'DELETE_LINES', ids: Array.from(doomLines) });
                if (doomStrokes.size > 0) send({ type: 'DELETE_STROKES', ids: Array.from(doomStrokes) });
            } else if ((e.ctrlKey || e.metaKey) && k === 'v') {
                // Paste: prefer OS clipboard (latest screenshot / external text)
                // over the in-memory canvas clipboard. Canvas clipboard is
                // only used when the OS clipboard has nothing relevant —
                // otherwise in-canvas copy would shadow every external paste.
                e.preventDefault();
                pasteFromClipboard({ state, commit, dispatch });
            } else if ((e.ctrlKey || e.metaKey) && k === 'd') {
                // Duplicate selected items.
                if (state.selectedIds.length > 0) {
                    e.preventDefault();
                    commit({ type: 'DUPLICATE_ITEMS', ids: state.selectedIds, offset: { dx: 24, dy: 24 } });
                }
            } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
                e.preventDefault();
                dispatch({ type: 'SELECT', ids: [...state.order] });
            } else if ((e.ctrlKey || e.metaKey) && k === 'g' && e.shiftKey) {
                e.preventDefault();
                cbs.onUngroup?.();
            } else if ((e.ctrlKey || e.metaKey) && k === 'g' && !e.shiftKey) {
                e.preventDefault();
                cbs.onGroup?.();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === ']' || e.key === '[')) {
                // Z-order shortcuts (Figma convention):
                //   Ctrl+]        Bring Forward
                //   Ctrl+[        Send Backward
                //   Ctrl+Shift+]  Bring to Front
                //   Ctrl+Shift+[  Send to Back
                // Reorder operates on item selection only — connections live
                // in their own render layer and lines/strokes don't have a
                // sibling-aware z-order yet.
                if (state.selectedIds.length === 0) return;
                e.preventDefault();
                const front = e.key === ']';
                const big = e.shiftKey;
                const mode = big
                    ? (front ? 'front' : 'back')
                    : (front ? 'forward' : 'backward');
                commit({ type: 'REORDER_ITEMS', ids: state.selectedIds, mode });
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [
        active,
        state.editingId,
        state.selectedIds,
        state.selectedConnectionIds,
        state.selectedLineIds,
        state.selectedStrokeIds,
        dispatch,
        commit,
        undo,
        redo,
    ]);
}
