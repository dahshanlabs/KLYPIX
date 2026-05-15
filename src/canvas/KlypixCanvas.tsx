import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Save, Paperclip, Pin, Copy, Home as HomeIcon } from 'lucide-react';
import { CanvasStoreProvider, useCanvasStore } from './state/canvasStore';
import { CanvasRenderer } from './CanvasRenderer';
import { Toolbar } from './interaction/Toolbar';
import { useCanvasInteraction } from './interaction/useCanvasInteraction';
import { useCanvasKeyboardShortcuts } from './interaction/useKeyboardShortcuts';
import { useAnyFile } from './file/useAnyFile';
import { fileToItem } from './file/dropHandler';
import { base64ToBytes } from './file/assetRegistry';
import { ocrImageAsset } from './file/ocrImage';
import { suggestTags } from './file/autoTag';
import { screenToWorld, worldToScreen, fitToViewport, itemsBounds } from './CanvasEngine';
import { CommandBar } from './interaction/CommandBar';
import { Breadcrumbs } from './interaction/Breadcrumbs';
import { ContextMenu } from './interaction/ContextMenu';
import { TextFormatCapsule } from './interaction/TextFormatCapsule';
import { InlinePrompt } from './interaction/InlinePrompt';
import { ChatThread } from './interaction/ChatThread';
import { CommentsPanel } from './interaction/CommentsPanel';
import { setOpenCommentsHandler } from './items/ItemBadges';
import { TabBar, type TabMeta } from './tabs/TabBar';
import { Minimap } from './layout/Minimap';
import type { EyesState } from './interaction/CanvasEyes';
import { SearchPanel } from './interaction/SearchPanel';
import { OutlineSidebar } from './layout/OutlineSidebar';
import { LayersPanel } from './layout/LayersPanel';
import { PresentationMode } from './layout/PresentationMode';
import { VersionHistoryPanel } from './layout/VersionHistoryPanel';
import { TemplatesPanel } from './layout/TemplatesPanel';
import { SmartCollectionsPanel } from './layout/SmartCollectionsPanel';
import { saveTemplate } from './file/templates';
import { setOpenCanvasLinkHandler } from './items/CanvasLinkItem';
import { CanvasDashboard } from './dashboard/CanvasDashboard';
import { ShareModal } from './cloud/ShareModal';
import { Share2 } from 'lucide-react';
import {
    suppressContainerResizeScaling,
    getContainerRenderMode,
    isTabMode,
    isDottedMode,
    getCollapsedRenderW,
    computeCapsuleRenderMetrics,
    DOT_SCREEN_PX,
} from './items/ContainerItem';
import type { CanvasLinkItem as CanvasLinkItemType } from './items/types';
import { useGridSettings, hexToRgba, gridAlphaFor, isDarkBackground, defaultTextColorFor, getCurrentGridSettings } from './gridSettings';
import { CanvasSettingsPopover } from './interaction/CanvasSettingsPopover';
import { createAudioTranscribeController, type VoiceStatus } from './interaction/audioTranscribe';
import { setDictateIntoHandler } from './interaction/voiceBridge';
import { Search as SearchIcon, List, Layers, Play, Mic, History as HistoryIcon, Stamp as StampIcon, Filter as FilterIcon, FilePlus as LinkPlusIcon, Maximize2 as FitIcon, Loader2 } from 'lucide-react';
import { newId } from './items/types';
import type { CanvasItem, ContainerItem, TextItem, StyleRun } from './items/types';
import { applyStyleToRange, getSelectionStyle, type ItemTextDefaults } from './items/styleRuns';
import type { FormatPatch } from './interaction/ContextMenu';
import { DEFAULT_TEXT_COLOR } from './items/types';

// Auto-tag a just-dropped/pasted item in the background. Only applies to
// FileItem and ImageItem (text notes are agent-tagged via a different path).
// Fire-and-forget: we don't await, and failure/empty-result is a no-op.
function kickAutoTag(item: CanvasItem, file: File, dispatch: (action: any) => void): void {
    if (item.type !== 'file' && item.type !== 'image' && item.type !== 'video' && item.type !== 'audio' && item.type !== 'code') return;
    // Build a tiny content sample only for text-ish files, to keep the
    // prompt small and the API call cheap.
    const extractSample = async (): Promise<string | undefined> => {
        if (item.type !== 'file') return undefined;
        const ext = (item.extension || '').toLowerCase();
        const TEXTY = new Set(['txt', 'md', 'csv', 'json', 'log', 'yml', 'yaml', 'xml', 'html']);
        if (TEXTY.has(ext)) {
            try {
                const text = await file.text();
                return text.slice(0, 400);
            } catch { return undefined; }
        }
        if (item.previewSheet) {
            return [
                item.previewSheet.headers.join(' | '),
                ...item.previewSheet.rows.slice(0, 4).map(r => r.join(' | ')),
            ].join('\n');
        }
        if (item.previewHtml) {
            return item.previewHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
        }
        return undefined;
    };
    (async () => {
        const sample = await extractSample();
        const fileName = (item as any).fileName || file.name;
        const extension = (item as any).extension || '';
        const tags = await suggestTags({ fileName, extension, contentSample: sample });
        if (tags.length === 0) return;
        // Merge with any pre-existing tags (user may have tagged before the
        // async call resolved); dedupe and cap.
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { tags: Array.from(new Set([...(item.tags || []), ...tags])).slice(0, 5) } as any,
        });
    })().catch(() => {});
}

// Entry point. Holds the tab list and mounts one CanvasStoreProvider per tab —
// inactive tabs stay mounted (display:none) so their in-memory state (items,
// undo stack, assets for their items, running agent runs) is preserved across
// tab switches. Only the active tab handles global side effects (file-open
// IPC, keyboard shortcuts).

interface TabInfo {
    id: string;
    // Last reported meta from the inner canvas. Mirrors CanvasState.title /
    // isDirty; updated in the child via a publish effect so the TabBar can
    // re-render on every dirty flip.
    meta: TabMeta;
    // If set, the freshly-mounted CanvasSurface will call openByPath with
    // this path once on mount then clear. Used by canvas-to-canvas link
    // clicks that want a new tab preloaded with a specific .any file.
    pendingOpenPath?: string;
}

let tabIdCounter = 0;
function makeTabId(): string {
    tabIdCounter += 1;
    return `tab_${Date.now().toString(36)}_${tabIdCounter}`;
}

interface KlypixCanvasProps {
    /** App-level visibility. False when the user is on the Chat tab — we stay
        mounted to preserve tab state, but hide visually and gate side effects. */
    appVisible?: boolean;
}

export function KlypixCanvas({ appVisible = true }: KlypixCanvasProps) {
    const canvasBg = useGridSettings().background;
    const [tabs, setTabs] = useState<TabInfo[]>(() => [{
        id: makeTabId(),
        meta: { id: '', title: 'Untitled', dirty: false },
    }]);
    const [activeId, setActiveId] = useState<string>(() => tabs[0].id);

    const onMetaChange = useCallback((tabId: string, meta: { title: string; dirty: boolean }) => {
        setTabs((ts) => {
            // No-op guard: if the published meta matches what we already have,
            // return the SAME array reference so React bails out and doesn't
            // trigger a re-render cascade. Cheap defense against render loops.
            const cur = ts.find((t) => t.id === tabId);
            if (cur && cur.meta.title === meta.title && cur.meta.dirty === meta.dirty) {
                return ts;
            }
            return ts.map((t) => t.id === tabId ? { ...t, meta: { id: tabId, ...meta } } : t);
        });
    }, []);

    const onNewTab = useCallback((pendingOpenPath?: string) => {
        const id = makeTabId();
        setTabs((ts) => [...ts, { id, meta: { id, title: 'Untitled', dirty: false }, pendingOpenPath }]);
        setActiveId(id);
    }, []);

    // Register the global canvas-link opener. Clicking a CanvasLinkItem
    // calls this with its filePath; we spawn a new tab pre-pointed at it.
    useEffect(() => {
        setOpenCanvasLinkHandler((filePath) => onNewTab(filePath));
        return () => setOpenCanvasLinkHandler(() => {});
    }, [onNewTab]);

    const onCloseTab = useCallback((id: string) => {
        setTabs((ts) => {
            const t = ts.find((x) => x.id === id);
            if (!t) return ts;
            if (t.meta.dirty && !window.confirm(`Close "${t.meta.title}"? Unsaved changes will be lost.`)) return ts;
            const next = ts.filter((x) => x.id !== id);
            // Never leave zero tabs open — spawn a fresh one.
            if (next.length === 0) {
                const fresh = makeTabId();
                setActiveId(fresh);
                return [{ id: fresh, meta: { id: fresh, title: 'Untitled', dirty: false } }];
            }
            // If we closed the active tab, jump to the neighbor to its left (or right).
            if (id === activeId) {
                const idx = ts.findIndex((x) => x.id === id);
                const pick = next[Math.max(0, idx - 1)] || next[0];
                setActiveId(pick.id);
            }
            return next;
        });
    }, [activeId]);

    const tabMetas = tabs.map((t) => t.meta);

    return (
        <div
            // `overflow: clip` (not `hidden`) — clip doesn't create a scroll
            // container, so Chromium can't auto-scroll us to keep a caret
            // visible inside a wide textarea. `overflow-hidden` still
            // accepts scrollLeft/scrollTop programmatically, which fires
            // when a user types past the viewport edge — that was moving
            // the toolbar/minimap/footer off-screen on long lines.
            className="absolute inset-0 z-[70] no-drag flex flex-col"
            style={{ overflow: 'clip', backgroundColor: canvasBg, display: appVisible ? 'flex' : 'none' }}
        >
            <TabBar
                tabs={tabMetas}
                activeId={activeId}
                onSwitch={setActiveId}
                onClose={onCloseTab}
                onNew={onNewTab}
            />
            <div className="relative flex-1">
                {tabs.map((t) => (
                    <div
                        key={t.id}
                        className="absolute inset-0"
                        style={{ display: t.id === activeId ? 'block' : 'none' }}
                    >
                        <CanvasStoreProvider>
                            <CanvasSurface
                                tabActive={t.id === activeId && appVisible}
                                onMetaChange={(meta) => onMetaChange(t.id, meta)}
                                pendingOpenPath={t.pendingOpenPath}
                            />
                        </CanvasStoreProvider>
                    </div>
                ))}
            </div>
        </div>
    );
}

interface CanvasSurfaceProps {
    tabActive?: boolean;
    onMetaChange?: (meta: { title: string; dirty: boolean }) => void;
    /** Open this .any file once on mount (used for canvas-to-canvas links). */
    pendingOpenPath?: string;
}

function CanvasSurface({ tabActive = true, onMetaChange, pendingOpenPath }: CanvasSurfaceProps = {}) {
    const { state, dispatch, commit, pushSnapshot, undo } = useCanvasStore();
    // Banner shown when a drag auto-grew a parent because a child overflowed.
    // Lets the user pick: deparent (Yes), keep + extend (No), or revert
    // the drag entirely (Cancel). Auto-times-out to "No" after 5 s.
    const [deparentPrompt, setDeparentPrompt] = useState<{
        parentId: string;
        childIds: string[];
    } | null>(null);
    const {
        setSurfaceRef, onPointerDown, onPointerMove, onPointerUp, onWheel,
        marqueeRect, connectPendingId, connectHoverWorld, spaceHeld, snapGuides, toast: hintToast, cancelConnect,
    } = useCanvasInteraction({
        onChildOverflow: (info) => setDeparentPrompt(info),
    });
    // Auto-dismiss the deparent banner ~5 s after it appears. Same effect
    // as clicking "No" — the auto-grow is already committed, so doing
    // nothing means "keep the new layout."
    useEffect(() => {
        if (!deparentPrompt) return;
        const t = setTimeout(() => setDeparentPrompt(null), 5000);
        return () => clearTimeout(t);
    }, [deparentPrompt]);
    // Mirror surfaceRef locally so overlays that render with `position: fixed`
    // (ChatThread) can convert surface-local coords → viewport coords by
    // adding the surface's top/left offset. The TabBar above the canvas makes
    // this offset non-zero (~32px).
    const surfaceElRef = useRef<HTMLDivElement | null>(null);
    const setSurfaceRefs = useCallback((el: HTMLDivElement | null) => {
        surfaceElRef.current = el;
        setSurfaceRef(el);
    }, [setSurfaceRef]);

    // Keep the meta publisher in a ref so the effect below doesn't re-fire on
    // every render just because the parent passes a new inline arrow. Without
    // this, publishing → parent setTabs → re-render → new onMetaChange prop →
    // effect re-runs → ∞ loop, which silently drops UI events.
    const onMetaChangeRef = useRef(onMetaChange);
    onMetaChangeRef.current = onMetaChange;
    // stateRef used by the paste handler so we don't retrigger the effect on
    // every state change (keeps the window listener stable).
    const stateRef = useRef(state);
    stateRef.current = state;
    const file = useAnyFile(tabActive);
    // Consume pendingOpenPath (set by canvas-to-canvas link clicks) exactly
    // once — a ref prevents StrictMode's double-mount from opening twice.
    const pendingConsumedRef = useRef(false);
    useEffect(() => {
        if (!pendingOpenPath || pendingConsumedRef.current) return;
        pendingConsumedRef.current = true;
        file.openByPath(pendingOpenPath).catch(() => {});
    }, [pendingOpenPath, file]);

    // Hidden <input> that we focus briefly on mount / tab activation —
    // then blur and focus the canvas surface. A plain surface.focus()
    // sets DOM focus but Windows' OS keyboard binding doesn't always
    // attach to a `tabIndex=0` div on the very first launch of the
    // window; typing silently goes nowhere until the user focuses a
    // real editable element (Windows search bar, etc.). Focusing an
    // actual <input> for a single frame wakes up that binding, after
    // which the surface div accepts keystrokes normally. Standard
    // Chromium-on-Windows workaround for frameless + alwaysOnTop
    // overlay windows. The input stays in the DOM permanently (cheap,
    // and tab re-activation can re-claim if needed).
    const focusStealRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (!tabActive) return;
        let cancelled = false;
        const claim = () => {
            if (cancelled) return;
            const fs = focusStealRef.current;
            const surf = surfaceElRef.current;
            if (!fs || !surf) return;
            try { fs.focus({ preventScroll: true }); } catch { /* no-op */ }
            requestAnimationFrame(() => {
                if (cancelled) return;
                try { fs.blur(); } catch { /* no-op */ }
                try { surf.focus({ preventScroll: true }); } catch { /* no-op */ }
            });
        };
        // First claim as soon as React commits. Subsequent retries cover the
        // Chromium init race where the window's webContents isn't fully
        // ready at mount time — 60ms and 300ms are well past any sane first
        // paint, and no-op if the first claim already attached the hook.
        claim();
        const t1 = setTimeout(claim, 60);
        const t2 = setTimeout(claim, 300);
        return () => {
            cancelled = true;
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [tabActive]);

    // Group the current selection (items + lines + strokes) into one
    // container. Computes bbox from EVERY selected thing so drawings stay
    // visually inside the new frame. Drawings don't use authoredInParent
    // (the vector-scale machine is item-only for now) but they still get
    // parentId so focus-mode, ungroup, auto-delete-empty, and copy-
    // descendants treat them as children.
    const groupSelection = useCallback(() => {
        const s = state;
        const itemIds = s.selectedIds;
        const lineIds = s.selectedLineIds;
        const strokeIds = s.selectedStrokeIds;
        if (itemIds.length === 0 && lineIds.length === 0 && strokeIds.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of itemIds) {
            const it = s.items[id];
            if (!it) continue;
            if (it.x < minX) minX = it.x;
            if (it.y < minY) minY = it.y;
            if (it.x + it.w > maxX) maxX = it.x + it.w;
            if (it.y + it.h > maxY) maxY = it.y + it.h;
        }
        for (const id of lineIds) {
            const ln = s.lines[id];
            if (!ln) continue;
            const lx1 = Math.min(ln.x1, ln.x2), ly1 = Math.min(ln.y1, ln.y2);
            const lx2 = Math.max(ln.x1, ln.x2), ly2 = Math.max(ln.y1, ln.y2);
            if (lx1 < minX) minX = lx1;
            if (ly1 < minY) minY = ly1;
            if (lx2 > maxX) maxX = lx2;
            if (ly2 > maxY) maxY = ly2;
        }
        for (const id of strokeIds) {
            const st = s.strokes[id];
            if (!st) continue;
            for (const pt of st.points) {
                if (pt.x < minX) minX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y > maxY) maxY = pt.y;
            }
        }
        if (!isFinite(minX)) return;

        const PAD = 24;
        const TITLE = 28;
        // Auto-name: "Group 1", "Group 2", … using the monotonic counter
        // in state (spec Issue 5). Counter persists across saves via
        // anyFormat.ts and never decrements on rename/delete, so a user
        // who renames "Group 1" still gets "Group 3" on the next create.
        const groupNumber = s.nextGroupNumber || 1;
        const container: ContainerItem = {
            id: newId('ctn'),
            type: 'container',
            x: minX - PAD,
            y: minY - PAD - TITLE,
            w: (maxX - minX) + PAD * 2,
            h: (maxY - minY) + PAD * 2 + TITLE,
            zIndex: 0,
            locked: false,
            parentId: null,
            createdAt: Date.now(),
            createdBy: 'user',
            title: `Group ${groupNumber}`,
            collapsed: false,
            scopeLocked: false,
            borderColor: 'rgba(16,185,129,0.35)',
        };
        commit({ type: 'ADD_ITEM', item: container });
        dispatch({ type: 'INCREMENT_GROUP_COUNTER' });
        for (const id of itemIds) {
            dispatch({
                type: 'UPDATE_ITEM',
                id,
                patch: { parentId: container.id, authoredInParent: undefined } as Partial<CanvasItem>,
            });
        }
        for (const id of lineIds) {
            dispatch({ type: 'UPDATE_LINE', id, patch: { parentId: container.id } });
        }
        for (const id of strokeIds) {
            dispatch({ type: 'UPDATE_STROKE', id, patch: { parentId: container.id } });
        }
        dispatch({ type: 'SELECT', ids: [container.id] });
    }, [state, commit, dispatch]);

    const ungroupSelection = useCallback(() => {
        // Ungroup just the first selected container. Nested sub-groups
        // stay grouped; this is per-layer un-nesting, not recursive.
        for (const id of state.selectedIds) {
            const it = state.items[id];
            if (it && it.type === 'container') {
                commit({ type: 'UNGROUP_CONTAINER', id });
                return;
            }
        }
    }, [state.selectedIds, state.items, commit]);

    // Pick a .any file and drop a CanvasLinkItem at viewport center. Reuses
    // the canvas:open IPC to get the file path, but DOESN'T load it into
    // this tab — it just wants the path to embed.
    const insertCanvasLink = useCallback(async () => {
        const api: any = (window as any).electron?.canvas;
        if (!api?.open) return;
        const res = await api.open();
        if (!res?.ok || !res.filePath) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const worldX = (vw / 2 - state.view.panX) / state.view.zoom;
        const worldY = (vh / 2 - state.view.panY) / state.view.zoom;
        const fileName = res.filePath.split(/[\\/]/).pop() || res.filePath;
        const link: CanvasLinkItemType = {
            id: newId('clink'),
            type: 'canvas-link',
            x: worldX - 150,
            y: worldY - 35,
            w: 300,
            h: 70,
            zIndex: state.order.length,
            locked: false,
            parentId: null,
            createdAt: Date.now(),
            createdBy: 'user',
            filePath: res.filePath,
            title: fileName.replace(/\.(klypix|any)$/i, ''),
        };
        commit({ type: 'ADD_ITEM', item: link });
        dispatch({ type: 'SELECT', ids: [link.id] });
    }, [state.view, state.order.length, commit, dispatch]);

    // OCR-in-flight tracking. The right-click menu entry shows "Extracting…"
    // and disables itself while the image's id is in this set, preventing
    // a slow Gemini call from being re-launched. Cleared on success/failure.
    const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set());

    /** Right-click → Extract text (OCR) on the single selected image. Drops
     *  a bordered TextItem with the extracted text positioned to the right
     *  of the source image, then selects it. Errors / empty results surface
     *  as a toast. */
    const extractTextFromImage = useCallback(async (imageId: string) => {
        const it = state.items[imageId];
        if (!it || it.type !== 'image' || !it.assetId) return;
        if (extractingIds.has(imageId)) return;
        setExtractingIds(prev => { const next = new Set(prev); next.add(imageId); return next; });
        setToast({ text: 'Extracting text…', id: Date.now() });
        try {
            const text = await ocrImageAsset(it.assetId);
            if (!text) {
                setToast({ text: 'OCR failed — try again or check API key', id: Date.now() });
                return;
            }
            const isEmpty = /^\(no text detected\)$/i.test(text.trim());
            // Land the result card to the right of the image with a small
            // gap; clamp width so a tiny thumbnail still gets a readable
            // text card. Height auto-grows on first render via TextItem's
            // ResizeObserver.
            const GAP = 24;
            const w = Math.max(280, Math.min(it.w, 480));
            const node: TextItem = {
                id: newId('ocr'),
                type: 'text',
                x: it.x + it.w + GAP,
                y: it.y,
                w,
                h: 80,
                zIndex: state.order.length,
                locked: false,
                parentId: it.parentId ?? null,
                createdAt: Date.now(),
                createdBy: 'agent',
                content: isEmpty ? '(no text detected)' : text,
                fontSize: 14,
                color: defaultTextColorFor(getCurrentGridSettings().background),
                border: true,
                borderColor: 'rgba(16,185,129,0.45)',
                borderWidth: 1,
                lineStyle: 'solid',
                fillColor: 'rgba(18,18,26,0.8)',
                heading: false,
                tags: ['ocr'],
            };
            commit({ type: 'ADD_ITEM', item: node });
            dispatch({ type: 'SELECT', ids: [node.id] });
            setToast({ text: isEmpty ? 'No text detected' : 'Text extracted', id: Date.now() });
        } catch (err) {
            console.error('[canvas OCR]', err);
            setToast({ text: 'OCR failed', id: Date.now() });
        } finally {
            setExtractingIds(prev => { const next = new Set(prev); next.delete(imageId); return next; });
        }
    }, [state.items, state.order.length, extractingIds, commit, dispatch]);

    useCanvasKeyboardShortcuts(tabActive, {
        onOpenSearch: () => setSearchOpen(true),
        onVoice: () => toggleVoice(),
        onToggleOutline: () => setOutlineOpen((v) => !v),
        onGroup: () => groupSelection(),
        onUngroup: () => ungroupSelection(),
    });

    // Publish title + dirty upward so the TabBar can show them. Deliberately
    // excludes the callback from the dep list — we read it off a ref so an
    // unstable parent prop can't retrigger this effect.
    useEffect(() => {
        onMetaChangeRef.current?.({ title: state.title || 'Untitled', dirty: state.isDirty });
    }, [state.title, state.isDirty]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);
    const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
    // Final on-screen rect of the right-click context menu, reported by
    // ContextMenu after its own viewport-edge clamp (it can flip upward
    // when the click lands near the bottom). Drives TextFormatCapsule's
    // anchoring so the capsule tracks the menu's actual position rather
    // than the click point — matters for clicks near the viewport edges.
    const [ctxMenuRect, setCtxMenuRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    // Modal text prompt used by Add tag / Add comment / Save as template.
    // Electron disables window.prompt(), so every prompt-requiring action
    // funnels through this state + InlinePrompt overlay.
    const [inlinePrompt, setInlinePrompt] = useState<{
        title: string;
        placeholder?: string;
        defaultValue?: string;
        submitLabel?: string;
        onSubmit: (value: string) => void;
    } | null>(null);
    // Captured character range inside an editing text item when the user
    // right-clicked with an active selection. Read by the ContextMenu's
    // Format section; cleared when the menu closes. The textarea's own
    // selection may be cleared by the menu's focus grab — this frozen
    // copy survives that and lets the user apply multiple formats.
    const [pendingTextSelection, setPendingTextSelection] = useState<
        { itemId: string; start: number; end: number } | null
    >(null);
    const [eyesState, setEyesState] = useState<EyesState>('idle');
    const [eyesBubble, setEyesBubble] = useState<string | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [outlineOpen, setOutlineOpen] = useState(false);
    const [layersOpen, setLayersOpen] = useState(false);
    const [presenting, setPresenting] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [templatesOpen, setTemplatesOpen] = useState(false);
    const [collectionsOpen, setCollectionsOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    // Manual Home-button override for the canvas dashboard. The dashboard
    // auto-shows on empty canvases; this lets the user pop it open on
    // demand without losing their current work — clicking a row, "New",
    // or pressing Esc dismisses it back to whatever they were doing.
    const [manualDashboardOpen, setManualDashboardOpen] = useState(false);
    const [threadItemId, setThreadItemId] = useState<string | null>(null);
    const [commentsItemId, setCommentsItemId] = useState<string | null>(null);
    // Register the comments opener so ItemBadges can call it from outside
    // the React tree (badges render at many nesting depths). Tab-active
    // ensures only the visible tab wins if multiple canvases are mounted.
    useEffect(() => {
        if (!tabActive) return;
        setOpenCommentsHandler((id) => setCommentsItemId(id));
        return () => setOpenCommentsHandler(() => {});
    }, [tabActive]);
    // Auto-close the thread panel if the item it's attached to gets deleted.
    useEffect(() => {
        if (threadItemId && !state.items[threadItemId]) setThreadItemId(null);
    }, [threadItemId, state.items]);
    useEffect(() => {
        if (commentsItemId && !state.items[commentsItemId]) setCommentsItemId(null);
    }, [commentsItemId, state.items]);

    // Chat→Canvas drain. Triggered when the active tab is shown AND the
    // autosave-restore decision has fully settled — we mustn't add cards
    // before the user has chosen to restore a previous session, otherwise
    // their items get wiped by the RESTORE action that follows. Reads the
    // queue once per (tabActive, restoreSettled) flip, clears it, and
    // dispatches one TextItem per entry, staggered around viewport center
    // so multiple items don't perfectly overlap.
    useEffect(() => {
        if (!tabActive || !file.restoreSettled) return;
        let raw: string | null = null;
        try { raw = localStorage.getItem('klypix:pendingCanvasItems'); } catch { return; }
        if (!raw) return;
        let queue: Array<{ content: string; timestamp: number }> = [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('not array');
            queue = parsed.filter(e => e && typeof e.content === 'string' && e.content.trim().length > 0);
        } catch {
            try { localStorage.removeItem('klypix:pendingCanvasItems'); } catch { /* ignore */ }
            return;
        }
        if (queue.length === 0) {
            try { localStorage.removeItem('klypix:pendingCanvasItems'); } catch { /* ignore */ }
            return;
        }
        // Clear FIRST so a dispatch exception doesn't strand items in the
        // queue, where they'd re-fire on the next canvas activation.
        try { localStorage.removeItem('klypix:pendingCanvasItems'); } catch { /* ignore */ }

        const snap = stateRef.current;
        const surf = surfaceElRef.current;
        const rect = surf?.getBoundingClientRect();
        const cw = rect?.width ?? 800;
        const ch = rect?.height ?? 600;
        const zoom = snap.view.zoom || 1;
        // screen.x = world.x * zoom + panX  ⇒  world.x = (screen.x - panX) / zoom
        const cx = (cw / 2 - snap.view.panX) / zoom;
        const cy = (ch / 2 - snap.view.panY) / zoom;

        const baseW = 360;
        const baseH = 120;
        const bgColor = getCurrentGridSettings().background;
        const baseZ = snap.order.length;
        // Single undo snapshot for the whole batch so Ctrl+Z removes all
        // added items at once rather than one per press.
        pushSnapshot();
        let created = 0;
        queue.forEach((entry, i) => {
            const stagger = i * 28;
            const stamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
            const timeStr = stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const node: TextItem = {
                id: newId('chat'),
                type: 'text',
                x: cx - baseW / 2 + stagger,
                y: cy - baseH / 2 + stagger,
                w: baseW,
                h: baseH,
                zIndex: baseZ + i,
                locked: false,
                parentId: null,
                createdAt: Date.now(),
                createdBy: 'user',
                content: `From chat · ${timeStr}\n\n${entry.content}`,
                fontSize: 13,
                color: defaultTextColorFor(bgColor),
                border: true,
                borderColor: 'rgba(16,185,129,0.4)',
                fillColor: 'rgba(18,18,26,0.85)',
                heading: false,
            };
            dispatch({ type: 'ADD_ITEM', item: node });
            created++;
        });
        if (created > 0) {
            setToast({
                text: created === 1 ? 'Added from chat' : `Added ${created} from chat`,
                id: Date.now(),
            });
        }
        // Only re-run on tabActive / restoreSettled transitions. Intentionally
        // omit state/dispatch/setToast — depending on state would re-fire on
        // every store change and duplicate items.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabActive, file.restoreSettled]);

    const voiceRef = useRef<ReturnType<typeof createAudioTranscribeController> | null>(null);
    if (!voiceRef.current) voiceRef.current = createAudioTranscribeController();

    // Where a completed transcript goes. Set before start(), reset when the
    // flow ends (success OR error).
    //   'item'   — drop full text into an existing text item (T-tool flow).
    //   'card'   — keep text in the floating card; user picks Copy / Pin.
    //   'center' — default: drop a new item at viewport center.
    type VoiceSink =
        | { kind: 'item'; itemId: string }
        | { kind: 'card' }
        | { kind: 'center' };
    const sinkRef = useRef<VoiceSink>({ kind: 'center' });

    // UI state driven by the recorder. `voiceStatus` gates the FAB look
    // (idle / recording / transcribing). `voiceLevel` drives the FAB
    // waveform bars. `transcription` owns the floating card contents —
    // status variants let the card render Listening / Transcribing / final
    // text / error with one render tree.
    const [voiceStatus, setVoiceStatus] = useState<'idle' | VoiceStatus>('idle');
    const [voiceLevel, setVoiceLevel] = useState(0);
    type CardState =
        | { status: 'listening' }
        | { status: 'transcribing' }
        | { status: 'done'; text: string }
        | { status: 'error'; message: string };
    const [transcription, setTranscription] = useState<CardState | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);

    // `recording` is the button's visual gate — red/pulse from start
    // through transcribing. Derived, not stored separately.
    const recording = voiceStatus === 'recording' || voiceStatus === 'transcribing';

    // Shared start: install the sink, wire recorder callbacks that dispatch
    // based on sinkRef.current (read at completion, not closed over, so a
    // rapid re-entry picks up the latest sink).
    const startVoiceStream = async (sink: VoiceSink): Promise<boolean> => {
        const rec = voiceRef.current!;
        sinkRef.current = sink;
        if (sink.kind === 'card') setTranscription({ status: 'listening' });
        // Optimistically flip the FAB to recording state so the button
        // turns red the instant the user clicks. getUserMedia can take
        // a few hundred ms on Windows; without this the button feels
        // unresponsive. If start fails, the catch below reverts.
        setVoiceStatus('recording');

        const ok = await rec.start({
            onLevel: (lvl) => setVoiceLevel(lvl),
            onStatus: (s) => {
                setVoiceStatus(s);
                if (sinkRef.current.kind === 'card' && s === 'transcribing') {
                    setTranscription({ status: 'transcribing' });
                }
            },
            onFinal: (text) => {
                const s = sinkRef.current;
                if (s.kind === 'item') {
                    dispatch({ type: 'UPDATE_ITEM', id: s.itemId, patch: { content: text } as any });
                    if (text.startsWith('/')) setCommandOpen(true);
                } else if (s.kind === 'card') {
                    setTranscription({ status: 'done', text });
                } else if (text) {
                    if (text.startsWith('/')) {
                        setCommandOpen(true);
                    } else {
                        const cx = -state.view.panX / state.view.zoom + (window.innerWidth / 2) / state.view.zoom;
                        const cy = -state.view.panY / state.view.zoom + (window.innerHeight / 2) / state.view.zoom;
                        const item: TextItem = {
                            id: newId('vtx'),
                            type: 'text',
                            x: cx - 130,
                            y: cy - 14,
                            w: 260,
                            h: 28,
                            zIndex: state.order.length,
                            locked: false,
                            parentId: null,
                            createdAt: Date.now(),
                            createdBy: 'user',
                            content: text,
                            fontSize: 16,
                            color: defaultTextColorFor(getCurrentGridSettings().background),
                            border: false,
                            borderColor: '#1e1e2e',
                            heading: false,
                        };
                        commit({ type: 'ADD_ITEM', item });
                    }
                }
                // Leave the card mounted if it was a card-sink run so the
                // user can still Copy/Pin — otherwise reset to idle.
                if (sinkRef.current.kind !== 'card') {
                    setVoiceStatus('idle');
                    sinkRef.current = { kind: 'center' };
                } else {
                    setVoiceStatus('idle');
                }
            },
            onError: (err) => {
                console.error('[canvas voice]', err);
                if (sinkRef.current.kind === 'card') {
                    setTranscription({ status: 'error', message: err.message || 'Transcription failed' });
                } else {
                    window.alert(`Voice error: ${err.message || 'Transcription failed'}`);
                }
                setVoiceStatus('idle');
                sinkRef.current = { kind: 'center' };
            },
        });
        if (!ok) {
            setVoiceStatus('idle');
            sinkRef.current = { kind: 'center' };
            if (sink.kind === 'card') setTranscription(null);
            window.alert('Microphone access denied. Please allow microphone access in system settings.');
        }
        return ok;
    };

    const toggleVoice = (targetItemId?: string) => {
        const rec = voiceRef.current!;
        if (rec.isRecording()) {
            rec.stop();
            return;
        }
        void startVoiceStream(targetItemId ? { kind: 'item', itemId: targetItemId } : { kind: 'center' });
    };

    const toggleVoiceToCard = () => {
        const rec = voiceRef.current!;
        if (rec.isRecording()) {
            // Stop capture; onstop → transcription pass → onFinal lands
            // the text in the card. No UI change needed here.
            rec.stop();
            return;
        }
        void startVoiceStream({ kind: 'card' });
    };

    const dismissTranscriptionCard = () => {
        const rec = voiceRef.current;
        if (rec?.isRecording()) rec.stop();
        setVoiceStatus('idle');
        sinkRef.current = { kind: 'center' };
        setTranscription(null);
    };

    // Publish a stable handler so useCanvasInteraction (via the module-level
    // voiceBridge) can start a dictation into a freshly-created text item.
    useEffect(() => {
        if (!tabActive) return;
        setDictateIntoHandler((id) => toggleVoice(id));
        return () => setDictateIntoHandler(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabActive]);

    // Universal focus-pull: any pointerdown anywhere in the canvas (not
    // just the canvas surface) triggers an OS-level focus request. Belt-
    // and-braces against the `transparent+alwaysOnTop` Windows focus
    // quirk — clicking the Toolbar T button, a panel header, etc. all
    // reliably pull keyboard focus to the webContents so the NEXT text
    // input lands keystrokes.
    useEffect(() => {
        if (!tabActive) return;
        const pull = () => {
            try { (window as any).electron?.focusWindow?.(); } catch { /* no-op */ }
        };
        document.addEventListener('pointerdown', pull, true);
        return () => document.removeEventListener('pointerdown', pull, true);
    }, [tabActive]);

    // Escape cancels a pending connect.
    useEffect(() => {
        if (!connectPendingId) return;
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelConnect(); };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [connectPendingId, cancelConnect]);

    // --- File drop: dropped files become canvas items at the cursor position ---
    const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        // Only handle file drags; ignore intra-app drags (item reorder etc).
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    }, []);
    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
    }, []);
    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        // Only flip state when leaving the surface entirely, not crossing children.
        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
        setIsDragOver(false);
    }, []);
    const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        // Compute drop position in world coords from the event's client coords.
        const target = e.currentTarget as HTMLDivElement;
        const rect = target.getBoundingClientRect();
        const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const world = screenToWorld(screen, state.view);

        const files = Array.from(e.dataTransfer.files);
        const zStart = state.order.length;
        for (let i = 0; i < files.length; i++) {
            const item = await fileToItem(files[i], { x: world.x, y: world.y, zIndexStart: zStart, viewZoom: stateRef.current.view.zoom }, i);
            if (item) {
                commit({ type: 'ADD_ITEM', item });
                kickAutoTag(item, files[i], dispatch);
            }
        }
    }, [state.view, state.order.length, commit]);

    // Ctrl+V / Cmd+V paste into the canvas. Handles the three common cases:
    //   - Files from file explorer (pasted after copy) → route through
    //     fileToItem for full drop-flow treatment (PDF/DOCX previews, asset
    //     registry bytes, etc).
    //   - Screenshot or image on clipboard → same flow with a synthetic File.
    //   - Plain text on clipboard → new plain TextItem.
    // Skipped while a textarea/input is focused (paste belongs there), while
    // the tab is inactive (other tab shouldn't swallow), and while the
    // command bar or a chat thread is handling its own paste.
    useEffect(() => {
        if (!tabActive) return;
        const handler = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
            const data = e.clipboardData;
            if (!data) return;

            // Paste anchor: center of the surface in world coords.
            const el = surfaceElRef.current;
            const rect = el?.getBoundingClientRect();
            const cx = rect ? rect.width / 2 : window.innerWidth / 2;
            const cy = rect ? rect.height / 2 : window.innerHeight / 2;
            const world = screenToWorld({ x: cx, y: cy }, stateRef.current.view);
            const zStart = stateRef.current.order.length;

            // Files (Explorer copy, Slack image, browser "Copy image", etc.)
            // take priority — if they exist, ignore the text side entirely.
            const files: File[] = [];
            if (data.files && data.files.length) {
                for (let i = 0; i < data.files.length; i++) files.push(data.files[i]);
            } else {
                // DataTransferItem list — screenshot pastes land here as image
                // types but with no entry in data.files in some shells.
                for (let i = 0; i < data.items.length; i++) {
                    const it = data.items[i];
                    if (it.kind === 'file') {
                        const f = it.getAsFile();
                        if (f) files.push(f);
                    }
                }
            }

            if (files.length > 0) {
                e.preventDefault();
                (async () => {
                    for (let i = 0; i < files.length; i++) {
                        const item = await fileToItem(files[i], { x: world.x, y: world.y, zIndexStart: zStart, viewZoom: stateRef.current.view.zoom }, i);
                        if (item) {
                            commit({ type: 'ADD_ITEM', item });
                            kickAutoTag(item, files[i], dispatch);
                        }
                    }
                })().catch((err) => console.warn('[canvas paste] file ingest failed:', err));
                return;
            }

            const text = data.getData('text/plain');

            // Windows Explorer copy (Ctrl+C on a file) never populates
            // clipboardData.files — Chromium only exposes that for drag.
            // If the ClipboardEvent has no files AND no usable text, ask the
            // main process whether CF_HDROP carries file paths, then ingest
            // each via fileToItem (same pipeline as drag-and-drop, so PDF
            // previews / image thumbs / asset registration all work).
            // Primarily serves right-click paste — Ctrl+V already goes
            // through the keyboard-shortcut path which does its own CF_HDROP
            // read before falling back to this listener.
            const api: any = (window as any).electron;
            if ((!text || !text.trim()) && api?.readClipboard && api?.readFileBytes) {
                e.preventDefault();
                (async () => {
                    try {
                        const res = await api.readClipboard();
                        const paths: string[] = Array.isArray(res?.filePaths) ? res.filePaths : [];
                        if (paths.length === 0) return;
                        const newIds: string[] = [];
                        for (let i = 0; i < paths.length; i++) {
                            const r = await api.readFileBytes(paths[i]).catch(() => null);
                            if (!r?.success || !r.base64 || !r.name) continue;
                            try {
                                const bytes = base64ToBytes(r.base64);
                                const file = new File([new Blob([bytes as any])], r.name, { type: '' });
                                const item = await fileToItem(file, { x: world.x, y: world.y, zIndexStart: zStart, viewZoom: stateRef.current.view.zoom }, i);
                                if (item) {
                                    commit({ type: 'ADD_ITEM', item });
                                    kickAutoTag(item, file, dispatch);
                                    newIds.push(item.id);
                                }
                            } catch { /* skip and try next */ }
                        }
                        if (newIds.length > 0) dispatch({ type: 'SELECT', ids: newIds });
                    } catch (err) {
                        console.warn('[canvas paste] CF_HDROP ingest failed:', err);
                    }
                })();
                return;
            }

            if (text && text.trim()) {
                e.preventDefault();
                const node: TextItem = {
                    id: newId('txt'),
                    type: 'text',
                    x: world.x - 130,
                    y: world.y - 10,
                    w: 260,
                    h: 28,
                    zIndex: zStart,
                    locked: false,
                    parentId: null,
                    createdAt: Date.now(),
                    createdBy: 'user',
                    content: text,
                    fontSize: 16,
                    color: defaultTextColorFor(getCurrentGridSettings().background),
                    border: false,
                    borderColor: '#1e1e2e',
                    heading: false,
                };
                commit({ type: 'ADD_ITEM', item: node });
            }
        };
        window.addEventListener('paste', handler);
        return () => window.removeEventListener('paste', handler);
    }, [tabActive, commit]);


    // Empty-container sweeper: removes groups left with zero children by
    // paths that bypass the reducer's DELETE_* auto-delete cascade — e.g.
    // dragging the last child out of a group via an UPDATE_ITEM parentId
    // change. Grace window prevents auto-deleting a container the user
    // just created (ADD_ITEM + UPDATE_ITEM burst can briefly see the
    // container with no children before the child-reparents commit).
    useEffect(() => {
        const EMPTY_CONTAINER_GRACE_MS = 2000;
        const now = Date.now();
        const emptyIds: string[] = [];
        for (const id of state.order) {
            const it = state.items[id];
            if (!it || it.type !== 'container') continue;
            if (now - (it.createdAt || 0) < EMPTY_CONTAINER_GRACE_MS) continue;
            let hasChild = false;
            for (const c of Object.values(state.items)) {
                if (c.parentId === id) { hasChild = true; break; }
            }
            if (!hasChild) {
                for (const ln of Object.values(state.lines)) {
                    if (ln.parentId === id) { hasChild = true; break; }
                }
            }
            if (!hasChild) {
                for (const st of Object.values(state.strokes)) {
                    if (st.parentId === id) { hasChild = true; break; }
                }
            }
            if (!hasChild) emptyIds.push(id);
        }
        if (emptyIds.length > 0) {
            dispatch({ type: 'DELETE_ITEMS', ids: emptyIds });
        }
    }, [state.items, state.order, state.lines, state.strokes, dispatch]);

    // Empty-placeholder sweeper: removes any text item that has no content and
    // isn't currently being edited. onBlur isn't reliable when React unmounts a
    // focused textarea (creating a new item can swap editingId before the old
    // textarea's blur fires), so this useEffect is the source of truth. If
    // undo restores empty items, the sweeper re-removes them — net effect: a
    // single Ctrl+Z undoes the whole create+type session.
    useEffect(() => {
        const now = Date.now();
        const stale: string[] = [];
        for (const id of state.order) {
            const item = state.items[id];
            if (!item || item.type !== 'text') continue;
            if (item.content !== '') continue;
            if (state.editingId === id) continue;
            // Grace period: if the item was just created (within ~1s), leave it
            // alone. Protects against a race where ADD_ITEM commits before
            // SET_EDITING in the same event burst — without this the sweeper
            // would delete the brand-new text item before it ever gets its
            // textarea focused, which manifests as "T tool does nothing".
            if (now - item.createdAt < 1000) continue;
            stale.push(id);
        }
        if (stale.length > 0) dispatch({ type: 'DELETE_ITEMS', ids: stale });
    }, [state.editingId, state.items, state.order, dispatch]);

    // `/` opens the agent command bar. Only when not already in a field.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (commandOpen) return;
            const target = e.target as HTMLElement | null;
            const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
            if (inField) return;
            if (e.key === '/') {
                e.preventDefault();
                setCommandOpen(true);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [commandOpen]);

    // File shortcuts — scoped to the canvas surface so they don't fight chat's
    // shortcuts. We attach at window level but gate via tag check.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
            if (inField) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = e.key.toLowerCase();
            if (k === 's') {
                e.preventDefault();
                if (e.shiftKey) file.saveAs();
                else file.save();
            } else if (k === 'o') {
                e.preventDefault();
                file.open();
            } else if (k === 'n') {
                e.preventDefault();
                file.newFile();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [file]);

    // Space-held hand-pan wins over the tool's native cursor.
    const cursor =
        spaceHeld ? 'grab' :
        state.tool === 'type' ? 'text' :
        state.tool === 'select' ? 'default' :
        'crosshair';

    // Grid follows pan/zoom via background-position math. Style + color
    // come from settings (useGridSettings). Alpha auto-adjusts based on
    // background luminance so dots stay readable on both dark and paper.
    const gridSettings = useGridSettings();
    const gridSize = 24 * state.view.zoom;
    const gridColor = hexToRgba(gridSettings.color, gridAlphaFor(gridSettings.background));
    const gridImage = (() => {
        if (gridSettings.style === 'off' || state.view.zoom <= 0.4) return 'none';
        if (gridSettings.style === 'lines') {
            return `linear-gradient(to right, ${gridColor} 1px, transparent 1px), linear-gradient(to bottom, ${gridColor} 1px, transparent 1px)`;
        }
        return `radial-gradient(circle, ${gridColor} 1px, transparent 1px)`;
    })();
    const gridStyle: React.CSSProperties = {
        backgroundImage: gridImage,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${state.view.panX}px ${state.view.panY}px`,
    };

    // "Truly empty" includes strokes, lines, and connections — not just items.
    // Without these, drawing with the pen tool leaves isEmpty=true and the
    // "click anywhere to start typing" hint stays on top of visible strokes.
    const isEmpty =
        state.order.length === 0
        && Object.keys(state.lines).length === 0
        && Object.keys(state.strokes).length === 0
        && Object.keys(state.connections).length === 0;

    // Item count displayed in the bottom-right indicator. Excludes empty
    // text items — these are ghosts from T-tool clicks the user didn't
    // type into yet, and the sweeper removes them after the 1s grace
    // window. Including them makes the counter bounce (3 → 1) even though
    // the user hasn't created "3 real items".
    const displayedItemCount = state.order.reduce((acc, id) => {
        const it = state.items[id];
        if (!it) return acc;
        if (it.type === 'text' && (it.content ?? '') === '') return acc;
        return acc + 1;
    }, 0);

    // Rendered world-bounds for any item. For containers in tab mode
    // (user-collapsed or zoom-collapsed) this returns the capsule dims
    // instead of the expanded w/h — so overlays that anchor to item
    // bounds (connect-tool indicator, ChatThread, CommentsPanel) track
    // the visible capsule instead of the invisible expanded rectangle.
    // Single source of truth shared with ContainerItemView/HeaderView
    // via computeCapsuleRenderMetrics.
    const resolveItemRenderBounds = (it: CanvasItem): { w: number; h: number } => {
        if (it.type !== 'container') return { w: it.w, h: it.h };
        const mode = getContainerRenderMode(it, state.view.zoom, state.items, {
            zoomCollapsedIds: state.zoomCollapsedIds,
            userOverrideExpandedIds: state.userOverrideExpandedIds,
        });
        if (isDottedMode(mode)) {
            const dotWorld = DOT_SCREEN_PX / Math.max(0.01, state.view.zoom);
            return { w: dotWorld, h: dotWorld };
        }
        if (!isTabMode(mode)) return { w: it.w, h: it.h };
        const isFocused = state.focusedContainerId === it.id;
        const metrics = computeCapsuleRenderMetrics(it, state.view.zoom, state.items, isFocused);
        return {
            w: getCollapsedRenderW(it, state.view.zoom),
            h: metrics.titleBarH,
        };
    };

    return (
        <div
            ref={setSurfaceRefs}
            // Make the surface keyboard-focusable. Without tabIndex the
            // canvas div isn't a focus target, so on first launch the
            // Electron window sits without a DOM focus anchor and
            // keystrokes go nowhere until the user clicks something the
            // browser treats as "real" (an input, a button). tabIndex=0
            // wires the canvas into the tab order and lets us call
            // surfaceEl.focus() programmatically on mount / click.
            tabIndex={0}
            className="absolute inset-0 select-none no-drag focus:outline-none"
            style={{ cursor, outline: 'none', ...gridStyle }}
            onPointerDown={(e) => {
                // Always grab DOM focus on any canvas pointer-down. Keeps
                // keystrokes flowing to the canvas even after the user
                // clicks outside and back, and fixes the "first-launch
                // nothing is focused" case where the window has focus
                // but no element within it does.
                surfaceElRef.current?.focus({ preventScroll: true });
                onPointerDown(e);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(e) => {
                e.preventDefault();
                // Right-click while a non-Select tool is active exits
                // that tool back to Select instead of opening the
                // context menu. Natural "done drawing" gesture — keeps
                // Type/Eraser multi-use but lets the user bail with
                // one click. SET_TOOL also clears selection, which is
                // what we want here (no selection existed during the
                // tool anyway).
                if (state.tool !== 'select') {
                    dispatch({ type: 'SET_TOOL', tool: 'select' });
                    return;
                }
                const target = e.target as HTMLElement;
                const itemEl = target.closest?.('[data-canvas-item]') as HTMLElement | null;
                const itemId = itemEl?.getAttribute('data-canvas-item') || null;
                // Right-click on a connection arrow? Select it so the
                // context-menu Delete has something to act on.
                const connEl = target.closest?.('[data-canvas-connection]') as HTMLElement | null;
                const connId = !itemId ? (connEl?.getAttribute('data-canvas-connection') || null) : null;
                if (itemId && !state.selectedIds.includes(itemId)) {
                    dispatch({ type: 'SELECT', ids: [itemId] });
                } else if (connId && !state.selectedConnectionIds.includes(connId)) {
                    dispatch({ type: 'SELECT_CONNECTIONS', ids: [connId] });
                }
                // Surface the floating text-format capsule above the
                // right-clicked text item (top-level OR inside a container).
                // Nothing else opens the capsule — selection alone never
                // does, so it stays out of the way during normal use.
                const rcItem = itemId ? state.items[itemId] : undefined;
                if (rcItem && rcItem.type === 'text') {
                    dispatch({ type: 'SET_TEXT_CAPSULE_ANCHOR', id: itemId });
                } else {
                    dispatch({ type: 'SET_TEXT_CAPSULE_ANCHOR', id: null });
                }
                // If the right-click landed on an editing text item's
                // textarea with a live selection, freeze the range so
                // the Format section can act on it. Read directly off
                // the DOM element — React doesn't surface textarea
                // selection in synthetic events.
                const ta = (e.target instanceof HTMLTextAreaElement) ? (e.target as HTMLTextAreaElement) : null;
                const editId = ta?.getAttribute('data-canvas-text-edit-id') || null;
                if (ta && editId && ta.selectionStart !== ta.selectionEnd) {
                    setPendingTextSelection({
                        itemId: editId,
                        start: Math.min(ta.selectionStart, ta.selectionEnd),
                        end: Math.max(ta.selectionStart, ta.selectionEnd),
                    });
                } else {
                    setPendingTextSelection(null);
                }
                setCtxMenu({ x: e.clientX, y: e.clientY });
            }}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <CanvasRenderer connectPendingId={connectPendingId} connectHoverWorld={connectHoverWorld} />

            {/* Hidden focus-steal input — offscreen, pointer-inert. Focused
                once on mount via the effect above to wake the OS keyboard
                binding, then immediately blurred. Do not remove: plain
                surface.focus() alone is insufficient on first launch of
                frameless+alwaysOnTop Electron windows on Windows. */}
            <input
                ref={focusStealRef}
                tabIndex={-1}
                aria-hidden="true"
                readOnly
                style={{
                    position: 'absolute',
                    top: -9999,
                    left: -9999,
                    width: 1,
                    height: 1,
                    opacity: 0,
                    pointerEvents: 'none',
                    border: 'none',
                    outline: 'none',
                }}
            />

            <Breadcrumbs />

            <Toolbar />

            <TextFormatCapsule
                ctxMenuOpen={ctxMenu != null}
                ctxMenuRect={ctxMenu != null ? ctxMenuRect : null}
            />

            {/* Transient hint toast for silent-looking canvas actions
                (zoom-to-author aborted a drag-draw, etc.). Different
                from the agent-response toast below — this one is
                anchored to the cursor and clamped to the viewport. */}
            {hintToast && (
                <div
                    data-canvas-ui="1"
                    className="absolute z-30 pointer-events-none"
                    style={{
                        left: Math.min(Math.max(hintToast.x - 60, 8), window.innerWidth - 180),
                        top: Math.max(hintToast.y - 40, 8),
                    }}
                >
                    <div className="px-3 py-1.5 rounded-full bg-black/80 border border-white/10 backdrop-blur text-[12px] text-white/90 tracking-wide shadow-[0_6px_20px_rgba(0,0,0,0.5)]">
                        {hintToast.text}
                    </div>
                </div>
            )}

            {/* Empty-state: dashboard takes over when no canvas is loaded
                in this tab; the lightweight click-to-type hint stays for
                "started a new canvas, ready to type" so muscle-memory users
                aren't blocked by an overlay.
                tabActive guard is critical: dashboard renders via portal to
                document.body, so without it inactive tabs (e.g. canvas mode
                hidden while user is in chat) would punch the dashboard onto
                document.body over the chat UI. */}
            {tabActive && (manualDashboardOpen || (isEmpty && !state.filePath)) && (
                <CanvasDashboard
                    onOpenRecent={(p) => { setManualDashboardOpen(false); return file.openByPath(p); }}
                    onOpenFile={() => { setManualDashboardOpen(false); return file.open(); }}
                    onNewCanvas={() => { setManualDashboardOpen(false); file.newFile(); }}
                    onDismiss={manualDashboardOpen ? () => setManualDashboardOpen(false) : undefined}
                />
            )}
            {isEmpty && state.filePath && (() => {
                // Placeholder flips between light-on-dark and dark-on-light
                // so the hint stays readable on Paper and custom light
                // canvas backgrounds — white/70 was washing out on cream.
                const dark = isDarkBackground(gridSettings.background);
                const primary = dark ? 'rgba(255,255,255,0.72)' : 'rgba(20,20,28,0.72)';
                const secondary = dark ? 'rgba(255,255,255,0.32)' : 'rgba(20,20,28,0.42)';
                return (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="text-center">
                            <div className="text-sm font-medium tracking-wide" style={{ color: primary }}>click anywhere to start typing</div>
                            <div className="text-[11px] tracking-[0.18em] uppercase mt-2" style={{ color: secondary }}>
                                T V B L P C · drop files · / for agent · ctrl+0 fit
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Snap / alignment guides while dragging items (spec §20Q) */}
            {snapGuides.length > 0 && (
                <svg
                    className="absolute inset-0 pointer-events-none z-20"
                    style={{ width: '100%', height: '100%' }}
                >
                    {snapGuides.map((g, i) => {
                        if (g.orientation === 'vertical') {
                            const { x: sx } = worldToScreen({ x: g.coord, y: 0 }, state.view);
                            const { y: sy1 } = worldToScreen({ x: 0, y: g.min }, state.view);
                            const { y: sy2 } = worldToScreen({ x: 0, y: g.max }, state.view);
                            return (
                                <line key={i}
                                    x1={sx} y1={sy1 - 16} x2={sx} y2={sy2 + 16}
                                    stroke="#ff47c3" strokeWidth={1} strokeDasharray="3 3" opacity={0.85}
                                />
                            );
                        }
                        const { y: sy } = worldToScreen({ x: 0, y: g.coord }, state.view);
                        const { x: sx1 } = worldToScreen({ x: g.min, y: 0 }, state.view);
                        const { x: sx2 } = worldToScreen({ x: g.max, y: 0 }, state.view);
                        return (
                            <line key={i}
                                x1={sx1 - 16} y1={sy} x2={sx2 + 16} y2={sy}
                                stroke="#ff47c3" strokeWidth={1} strokeDasharray="3 3" opacity={0.85}
                            />
                        );
                    })}
                </svg>
            )}

            {/* Marquee rectangle (select mode drag) */}
            {marqueeRect && (() => {
                const tl = worldToScreen({ x: marqueeRect.x, y: marqueeRect.y }, state.view);
                const w = marqueeRect.w * state.view.zoom;
                const h = marqueeRect.h * state.view.zoom;
                return (
                    <div
                        className="absolute z-20 pointer-events-none border border-emerald-400/60 bg-emerald-400/10"
                        style={{ left: tl.x, top: tl.y, width: w, height: h }}
                    />
                );
            })()}

            {deparentPrompt && (() => {
                const firstId = deparentPrompt.childIds[0];
                const firstItem = state.items[firstId];
                if (!firstItem) return null;
                // Anchor banner just below the dragged item's bottom-center.
                const sw = worldToScreen(
                    { x: firstItem.x + firstItem.w / 2, y: firstItem.y + firstItem.h },
                    state.view,
                );
                const closeBanner = () => setDeparentPrompt(null);
                const onYes = () => {
                    // Capture each child's CURRENT world position (post-drag,
                    // post-grow). Revert via undo() — that pops the drag's
                    // snapshot. Then defer the deparent re-apply to the next
                    // tick so React has flushed the RESTORE, otherwise the
                    // store's stateRef is stale and pushSnapshot would
                    // capture the post-grow state instead of pre-drag.
                    const captured: { id: string; x: number; y: number }[] = [];
                    for (const cid of deparentPrompt.childIds) {
                        const it = state.items[cid];
                        if (it) captured.push({ id: cid, x: it.x, y: it.y });
                    }
                    undo();
                    closeBanner();
                    setTimeout(() => {
                        pushSnapshot();
                        for (const c of captured) {
                            dispatch({
                                type: 'UPDATE_ITEM',
                                id: c.id,
                                patch: {
                                    parentId: null,
                                    x: c.x,
                                    y: c.y,
                                    authoredInParent: undefined,
                                } as any,
                            });
                        }
                    }, 0);
                };
                const onNo = closeBanner;  // current behavior already applied
                const onCancel = () => {
                    undo();
                    closeBanner();
                };
                return (
                    <div
                        data-canvas-ui="1"
                        // Stop pointer events from reaching the canvas
                        // surface — without this the surface's pointerdown
                        // sets pointer capture and swallows the button's
                        // click. Same pattern as ContextMenu / capsule.
                        onPointerDown={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onWheel={(e) => e.stopPropagation()}
                        className="absolute z-30 -translate-x-1/2 mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#12121a]/95 border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.55)] backdrop-blur-md text-[12px] text-white/85 animate-in fade-in duration-150"
                        style={{ left: sw.x, top: sw.y }}
                    >
                        <span className="text-white/60 mr-1">Move out of group?</span>
                        <button
                            onClick={onYes}
                            className="px-2 py-1 rounded-md bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35 transition-colors font-medium"
                        >
                            Yes
                        </button>
                        <button
                            onClick={onNo}
                            className="px-2 py-1 rounded-md bg-white/8 text-white/75 hover:bg-white/15 transition-colors"
                        >
                            No
                        </button>
                        <button
                            onClick={onCancel}
                            className="px-2 py-1 rounded-md text-white/55 hover:text-white/85 hover:bg-white/8 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                );
            })()}

            {/* Connect-tool pending indicator. For containers in tab mode
                (user-collapsed or zoom-collapsed) the indicator must use the
                rendered capsule bounds — the same dims ContainerItem draws
                at — otherwise it outlines the expanded bounds and produces
                a dashed ghost rectangle below the capsule. */}
            {connectPendingId && state.items[connectPendingId] && (() => {
                const it = state.items[connectPendingId];
                const bounds = resolveItemRenderBounds(it);
                const tl = worldToScreen({ x: it.x - 4, y: it.y - 4 }, state.view);
                const w = (bounds.w + 8) * state.view.zoom;
                const h = (bounds.h + 8) * state.view.zoom;
                return (
                    <div
                        className="absolute z-20 pointer-events-none rounded-lg border-2 border-dashed border-emerald-400 animate-pulse"
                        style={{ left: tl.x, top: tl.y, width: w, height: h }}
                    />
                );
            })()}

            {/* Inline text prompt (replaces window.prompt) */}
            {inlinePrompt && (
                <InlinePrompt
                    title={inlinePrompt.title}
                    placeholder={inlinePrompt.placeholder}
                    defaultValue={inlinePrompt.defaultValue}
                    submitLabel={inlinePrompt.submitLabel}
                    onSubmit={inlinePrompt.onSubmit}
                    onCancel={() => setInlinePrompt(null)}
                />
            )}

            {/* Right-click context menu */}
            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    hasSelection={
                        state.selectedIds.length > 0
                        || state.selectedLineIds.length > 0
                        || state.selectedStrokeIds.length > 0
                        || state.selectedConnectionIds.length > 0
                    }
                    onPositioned={setCtxMenuRect}
                    onClose={() => { setCtxMenu(null); setCtxMenuRect(null); setPendingTextSelection(null); }}
                    canApplyFormat={(() => {
                        if (!pendingTextSelection) return false;
                        const it = state.items[pendingTextSelection.itemId];
                        return !!(it && it.type === 'text');
                    })()}
                    formatState={(() => {
                        if (!pendingTextSelection) return undefined;
                        const it = state.items[pendingTextSelection.itemId];
                        if (!it || it.type !== 'text') return undefined;
                        const defaults: ItemTextDefaults = {
                            color: it.color ?? DEFAULT_TEXT_COLOR,
                            bold: it.fontWeight === 'bold' || !!it.heading,
                            italic: it.fontStyle === 'italic',
                            underline: it.textDecoration === 'underline',
                            strikethrough: !!it.strikethrough,
                            fontSize: it.fontSize,
                            fontFamily: it.fontFamily ?? 'Virgil',
                        };
                        return getSelectionStyle(
                            it.styleRuns || [],
                            pendingTextSelection.start,
                            pendingTextSelection.end,
                            defaults,
                        );
                    })()}
                    onApplyFormat={(patch: FormatPatch) => {
                        if (!pendingTextSelection) return;
                        const it = state.items[pendingTextSelection.itemId];
                        if (!it || it.type !== 'text') return;
                        const defaults: ItemTextDefaults = {
                            color: it.color ?? DEFAULT_TEXT_COLOR,
                            bold: it.fontWeight === 'bold' || !!it.heading,
                            italic: it.fontStyle === 'italic',
                            underline: it.textDecoration === 'underline',
                            strikethrough: !!it.strikethrough,
                            fontSize: it.fontSize,
                            fontFamily: it.fontFamily ?? 'Virgil',
                        };
                        const newRuns = applyStyleToRange(
                            it.styleRuns || [],
                            pendingTextSelection.start,
                            pendingTextSelection.end,
                            patch,
                            it.content.length,
                            defaults,
                        );
                        // Whole-text uniform promotion: if the selection
                        // covers the entire string AND every run matches,
                        // we could instead rewrite item-level fields and
                        // drop runs. Skipped for now — normalizeRuns
                        // already collapses adjacent matching runs; the
                        // one-run-for-whole-string case renders identically
                        // to the item-level promotion. Revisit if storage
                        // bloat ever matters.
                        commit({ type: 'UPDATE_ITEM', id: it.id, patch: { styleRuns: newRuns } as any });
                        // Exit edit mode so the styled result is visible —
                        // the textarea can't render per-range styles, so
                        // there's no reason to keep the user in edit mode
                        // after committing a format change.
                        dispatch({ type: 'SET_EDITING', id: null });
                        setPendingTextSelection(null);
                    }}
                    onDelete={() => {
                        // Mixed-selection safe delete: fire all applicable
                        // actions in one commit boundary so a single undo
                        // restores everything.
                        const hasConns = state.selectedConnectionIds.length > 0;
                        const hasItems = state.selectedIds.length > 0;
                        const hasLines = state.selectedLineIds.length > 0;
                        const hasStrokes = state.selectedStrokeIds.length > 0;
                        let first = true;
                        const send = (a: any) => {
                            if (first) { commit(a); first = false; } else dispatch(a);
                        };
                        if (hasConns) send({ type: 'DELETE_CONNECTIONS', ids: state.selectedConnectionIds });
                        if (hasItems) send({ type: 'DELETE_ITEMS', ids: state.selectedIds });
                        if (hasLines) send({ type: 'DELETE_LINES', ids: state.selectedLineIds });
                        if (hasStrokes) send({ type: 'DELETE_STROKES', ids: state.selectedStrokeIds });
                    }}
                    onUngroup={ungroupSelection}
                    canUngroup={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        return !!(it && it.type === 'container');
                    })()}
                    canSetTextAlignment={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        return !!(it && it.type === 'text' && it.border);
                    })()}
                    currentTextAlignH={(() => {
                        if (state.selectedIds.length !== 1) return 'left';
                        const it = state.items[state.selectedIds[0]];
                        return (it && it.type === 'text' ? (it.textAlign ?? 'left') : 'left');
                    })()}
                    currentTextAlignV={(() => {
                        if (state.selectedIds.length !== 1) return 'top';
                        const it = state.items[state.selectedIds[0]];
                        return (it && it.type === 'text' ? (it.verticalAlign ?? 'top') : 'top');
                    })()}
                    onSetTextAlignment={(h, v) => {
                        if (state.selectedIds.length !== 1) return;
                        const id = state.selectedIds[0];
                        const it = state.items[id];
                        if (!it || it.type !== 'text') return;
                        commit({ type: 'UPDATE_ITEM', id, patch: { textAlign: h, verticalAlign: v } as any });
                    }}
                    onScaleSelection={(factor: number) => {
                        // Lazy import keeps the right-click path quick on
                        // first paint and matches how other one-shot
                        // helpers are wired in this file.
                        import('./interaction/scaleSelection').then(({ scaleSelection }) => {
                            scaleSelection({ state, dispatch, pushSnapshot }, factor);
                        });
                    }}
                    onExtractText={(() => {
                        if (state.selectedIds.length !== 1) return undefined;
                        const id = state.selectedIds[0];
                        const it = state.items[id];
                        if (!it || it.type !== 'image' || !it.assetId) return undefined;
                        return () => extractTextFromImage(id);
                    })()}
                    canExtractText={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        return !!(it && it.type === 'image' && it.assetId);
                    })()}
                    extractingText={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        return extractingIds.has(state.selectedIds[0]);
                    })()}
                    onAlignItems={(op) => {
                        // Lazy import keeps the right-click open-path light;
                        // alignSelection is only loaded when the user
                        // actually picks an alignment op.
                        import('./interaction/alignItems').then(({ alignSelection }) => {
                            alignSelection({ state, dispatch, pushSnapshot }, op);
                        });
                    }}
                    canAlignItems={(() => {
                        // ≥2 items, after dropping children whose parent
                        // is also selected (those get derived positions
                        // from the container's vector scale, so a direct
                        // patch would be lost on next resize).
                        if (state.selectedIds.length < 2) return false;
                        const selected = new Set(state.selectedIds);
                        let n = 0;
                        for (const id of state.selectedIds) {
                            const it = state.items[id];
                            if (!it) continue;
                            if (it.parentId && selected.has(it.parentId)) continue;
                            n++;
                            if (n >= 2) return true;
                        }
                        return false;
                    })()}
                    canDistributeItems={(() => {
                        if (state.selectedIds.length < 3) return false;
                        const selected = new Set(state.selectedIds);
                        let n = 0;
                        for (const id of state.selectedIds) {
                            const it = state.items[id];
                            if (!it) continue;
                            if (it.parentId && selected.has(it.parentId)) continue;
                            n++;
                            if (n >= 3) return true;
                        }
                        return false;
                    })()}
                    onArrange={(mode) => {
                        // v3 unified arrange: items + strokes + lines all
                        // share one z-order namespace per parent, so the
                        // action carries every selected entity.
                        if (
                            state.selectedIds.length === 0
                            && state.selectedLineIds.length === 0
                            && state.selectedStrokeIds.length === 0
                        ) return;
                        commit({
                            type: 'REORDER_ITEMS',
                            ids: state.selectedIds,
                            lineIds: state.selectedLineIds,
                            strokeIds: state.selectedStrokeIds,
                            mode,
                        });
                    }}
                    onDuplicate={() => commit({ type: 'DUPLICATE_ITEMS', ids: state.selectedIds, offset: { dx: 24, dy: 24 } })}
                    onAddBorder={() => {
                        // Preserve the visible text area across the toggle.
                        // Text items use box-sizing: border-box, so the
                        // content area = item.w - (padding + border) per side.
                        //   Plain:    padding 2px, transparent border 1px
                        //             → chrome 4 + 2 = 6 (H & V)
                        //   Bordered: padding 10px/8px, border = borderWidth
                        //             → chrome H = 20 + 2*bw, V = 16 + 2*bw
                        // Without dynamic compensation, inheriting the
                        // toolbar's strokeWidth (default 2) would shave 2px
                        // off the content area and wrap the last character.
                        // Decide the target state once for the whole selection
                        // so mixed selections converge instead of each item
                        // flipping independently — the menu label says either
                        // "Add border" or "Remove border", and the action has
                        // to match.
                        const textItems = state.selectedIds
                            .map(id => state.items[id])
                            .filter((it): it is Extract<typeof it, { type: 'text' }> => it?.type === 'text');
                        if (textItems.length === 0) return;
                        const targetBorder = !textItems.every(it => it.border);
                        for (const it of textItems) {
                            if (it.border === targetBorder) continue;  // already at target
                            const turningOn = targetBorder;
                            const prevBw = it.border ? (it.borderWidth ?? 1) : 1;
                            const nextBw = turningOn ? state.strokeWidth : 1;
                            const prevChromeH = (it.border ? 20 : 4) + prevBw * 2;
                            const prevChromeV = (it.border ? 16 : 4) + prevBw * 2;
                            const nextChromeH = (turningOn ? 20 : 4) + nextBw * 2;
                            const nextChromeV = (turningOn ? 16 : 4) + nextBw * 2;
                            const dw = nextChromeH - prevChromeH;
                            const dh = nextChromeV - prevChromeV;
                            const patch: any = {
                                border: targetBorder,
                                w: Math.max(20, it.w + dw),
                                h: Math.max(16, it.h + dh),
                            };
                            if (it.authoredWidth != null) {
                                patch.authoredWidth = Math.max(20, it.authoredWidth + dw);
                            }
                            // Inherit current toolbar stroke + fill on turn-ON
                            // so the bordered text reflects WHATEVER colors
                            // the user sees selected in the sidebar swatches.
                            // Always use the raw state colors regardless of
                            // enabled flags — the user's mental model is
                            // "take what I see there", not "honor a hidden
                            // on/off flag."
                            if (turningOn) {
                                patch.borderColor = state.color;
                                patch.borderWidth = state.strokeWidth;
                                patch.lineStyle = state.lineStyle;
                                patch.fillColor = state.fillColor;
                            }
                            dispatch({ type: 'UPDATE_ITEM', id: it.id, patch });
                        }
                    }}
                    selectionAllHaveBorder={(() => {
                        const textItems = state.selectedIds
                            .map(id => state.items[id])
                            .filter(it => it?.type === 'text');
                        if (textItems.length === 0) return false;
                        return textItems.every(it => (it as any).border);
                    })()}
                    onAskAgent={() => setCommandOpen(true)}
                    onSetStatus={(s) => {
                        for (const id of state.selectedIds) {
                            dispatch({ type: 'UPDATE_ITEM', id, patch: { status: s } as any });
                        }
                    }}
                    onAddTag={() => {
                        const ids = [...state.selectedIds];
                        if (ids.length === 0) return;
                        setInlinePrompt({
                            title: 'Add tag',
                            placeholder: 'lowercase, no spaces',
                            submitLabel: 'Add',
                            onSubmit: (raw) => {
                                const tag = raw.toLowerCase().replace(/\s+/g, '-');
                                for (const id of ids) {
                                    const it = state.items[id];
                                    if (!it) continue;
                                    const tags = Array.from(new Set([...(it.tags || []), tag]));
                                    dispatch({ type: 'UPDATE_ITEM', id, patch: { tags } as any });
                                }
                                setInlinePrompt(null);
                            },
                        });
                    }}
                    onAddComment={() => {
                        const ids = [...state.selectedIds];
                        if (ids.length === 0) return;
                        setInlinePrompt({
                            title: 'Add comment',
                            placeholder: 'Type your comment…',
                            submitLabel: 'Post',
                            onSubmit: (text) => {
                                for (const id of ids) {
                                    const it = state.items[id];
                                    if (!it) continue;
                                    const comments = [...(it.comments || []), {
                                        id: newId('cmt'),
                                        author: 'You',
                                        text,
                                        timestamp: Date.now(),
                                    }];
                                    dispatch({ type: 'UPDATE_ITEM', id, patch: { comments } as any });
                                }
                                setInlinePrompt(null);
                            },
                        });
                    }}
                    canOpenThread={state.selectedIds.length === 1}
                    onOpenThread={() => {
                        if (state.selectedIds.length !== 1) return;
                        setThreadItemId(state.selectedIds[0]);
                    }}
                    canEnterGroup={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        if (!it || it.type !== 'container') return false;
                        return state.focusedContainerId !== it.id;
                    })()}
                    onEnterGroup={() => {
                        if (state.selectedIds.length !== 1) return;
                        const it = state.items[state.selectedIds[0]];
                        if (!it || it.type !== 'container') return;
                        dispatch({ type: 'SET_FOCUSED_CONTAINER', id: it.id });
                    }}
                    canExitGroup={state.focusedContainerId !== null}
                    onExitGroup={() => dispatch({ type: 'SET_FOCUSED_CONTAINER', id: null })}
                    canFitContents={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        return !!(it && it.type === 'container');
                    })()}
                    onFitContents={() => {
                        if (state.selectedIds.length !== 1) return;
                        const container = state.items[state.selectedIds[0]];
                        if (!container || container.type !== 'container') return;
                        // Compute a tight bounding rect around direct children.
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        let kids = 0;
                        for (const id of state.order) {
                            const c = state.items[id];
                            if (!c || c.parentId !== container.id) continue;
                            kids++;
                            if (c.x < minX) minX = c.x;
                            if (c.y < minY) minY = c.y;
                            if (c.x + c.w > maxX) maxX = c.x + c.w;
                            if (c.y + c.h > maxY) maxY = c.y + c.h;
                        }
                        if (kids === 0) return;  // nothing to fit
                        const PAD = 24;
                        const TITLE = 28;
                        // Skip the auto-scaling effect for THIS resize —
                        // children are already at their final positions.
                        suppressContainerResizeScaling(container.id);
                        commit({
                            type: 'UPDATE_ITEM',
                            id: container.id,
                            patch: {
                                x: minX - PAD,
                                y: minY - PAD - TITLE,
                                w: (maxX - minX) + PAD * 2,
                                h: (maxY - minY) + PAD * 2 + TITLE,
                            } as any,
                        });
                    }}
                    onSaveAsTemplate={() => {
                        if (state.selectedIds.length === 0) return;
                        const selectedSet = new Set(state.selectedIds);
                        const items = state.selectedIds
                            .map(id => state.items[id])
                            .filter(Boolean) as CanvasItem[];
                        const connections = Object.values(state.connections)
                            .filter(c => selectedSet.has(c.fromId) && selectedSet.has(c.toId));
                        setInlinePrompt({
                            title: 'Save as template',
                            placeholder: 'Template name',
                            defaultValue: `Template ${new Date().toLocaleDateString()}`,
                            submitLabel: 'Save',
                            onSubmit: (name) => {
                                try {
                                    saveTemplate(name, items, connections);
                                } catch (err: any) {
                                    window.alert('Save failed: ' + (err?.message || String(err)));
                                }
                                setInlinePrompt(null);
                            },
                        });
                    }}
                    canConvertToLink={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        if (!it || it.type !== 'text') return false;
                        return /\bhttps?:\/\/[^\s<>"]+/i.test(it.content);
                    })()}
                    onConvertToLink={() => {
                        if (state.selectedIds.length !== 1) return;
                        const it = state.items[state.selectedIds[0]];
                        if (!it || it.type !== 'text') return;
                        const m = /\bhttps?:\/\/[^\s<>"]+/i.exec(it.content);
                        if (!m) return;
                        const url = m[0];
                        // Replace the text item with a link item at the same
                        // position. Start in `loading` state; the metadata
                        // fetch below hydrates it when the IPC returns.
                        const link: CanvasItem = {
                            id: newId('link'),
                            type: 'link',
                            x: it.x,
                            y: it.y,
                            w: Math.max(it.w, 320),
                            h: Math.max(it.h, 140),
                            zIndex: state.order.length,
                            locked: false,
                            parentId: it.parentId ?? null,
                            createdAt: Date.now(),
                            createdBy: 'user',
                            url,
                            loading: true,
                        } as CanvasItem;
                        commit({ type: 'DELETE_ITEMS', ids: [it.id] });
                        commit({ type: 'ADD_ITEM', item: link });
                        dispatch({ type: 'SELECT', ids: [link.id] });
                        const api: any = (window as any).electron?.canvas;
                        if (api?.fetchLinkMetadata) {
                            api.fetchLinkMetadata(url).then((res: any) => {
                                if (res?.ok) {
                                    dispatch({ type: 'UPDATE_ITEM', id: link.id, patch: {
                                        title: res.title,
                                        description: res.description,
                                        imageUrl: res.imageUrl,
                                        siteName: res.siteName,
                                        favicon: res.favicon,
                                        fetchedAt: Date.now(),
                                        loading: false,
                                        error: undefined,
                                    } as any });
                                } else {
                                    dispatch({ type: 'UPDATE_ITEM', id: link.id, patch: {
                                        loading: false,
                                        error: res?.error || 'fetch failed',
                                    } as any });
                                }
                            }).catch((err: any) => {
                                dispatch({ type: 'UPDATE_ITEM', id: link.id, patch: {
                                    loading: false,
                                    error: err?.message || String(err),
                                } as any });
                            });
                        }
                    }}
                    canConvertToText={(() => {
                        if (state.selectedIds.length !== 1) return false;
                        const it = state.items[state.selectedIds[0]];
                        return !!(it && it.type === 'link');
                    })()}
                    onConvertToText={() => {
                        if (state.selectedIds.length !== 1) return;
                        const it = state.items[state.selectedIds[0]];
                        if (!it || it.type !== 'link') return;
                        const text: CanvasItem = {
                            id: newId('txt'),
                            type: 'text',
                            x: it.x,
                            y: it.y,
                            w: 260,
                            h: 28,
                            zIndex: state.order.length,
                            locked: false,
                            parentId: it.parentId ?? null,
                            createdAt: Date.now(),
                            createdBy: 'user',
                            content: it.url,
                            fontSize: 16,
                            color: defaultTextColorFor(getCurrentGridSettings().background),
                            border: false,
                            borderColor: '#1e1e2e',
                            heading: false,
                        } as CanvasItem;
                        commit({ type: 'DELETE_ITEMS', ids: [it.id] });
                        commit({ type: 'ADD_ITEM', item: text });
                        dispatch({ type: 'SELECT', ids: [text.id] });
                    }}
                    onGroup={() => groupSelection()}
                />
            )}

            {/* Minimap */}
            <Minimap />

            {/* Chat thread (per-item mini conversation) */}
            {(() => {
                if (!threadItemId) return null;
                const it = state.items[threadItemId];
                if (!it) return null;
                // worldToScreen returns coords relative to the canvas surface;
                // ChatThread uses position:fixed so we add the surface's
                // viewport offset (non-zero due to the TabBar above).
                const rect = surfaceElRef.current?.getBoundingClientRect();
                const offX = rect?.left ?? 0;
                const offY = rect?.top ?? 0;
                const topLeft = worldToScreen({ x: it.x, y: it.y }, state.view);
                const bounds = resolveItemRenderBounds(it);
                const itemW = bounds.w * state.view.zoom;
                const itemH = bounds.h * state.view.zoom;
                return (
                    <ChatThread
                        item={it}
                        screenX={topLeft.x + offX}
                        screenY={topLeft.y + offY}
                        itemScreenW={itemW}
                        itemScreenH={itemH}
                        onClose={() => setThreadItemId(null)}
                    />
                );
            })()}

            {/* Comments panel — opened by clicking the amber comment badge */}
            {(() => {
                if (!commentsItemId) return null;
                const it = state.items[commentsItemId];
                if (!it) return null;
                const rect = surfaceElRef.current?.getBoundingClientRect();
                const offX = rect?.left ?? 0;
                const offY = rect?.top ?? 0;
                const topLeft = worldToScreen({ x: it.x, y: it.y }, state.view);
                const bounds = resolveItemRenderBounds(it);
                const itemW = bounds.w * state.view.zoom;
                const itemH = bounds.h * state.view.zoom;
                return (
                    <CommentsPanel
                        item={it}
                        screenX={topLeft.x + offX}
                        screenY={topLeft.y + offY}
                        itemScreenW={itemW}
                        itemScreenH={itemH}
                        onClose={() => setCommentsItemId(null)}
                    />
                );
            })()}

            {/* Panels */}
            <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} />
            {shareOpen && (
                <ShareModal
                    canvasFilePath={state.filePath || null}
                    canvasTitle={state.title || 'Untitled'}
                    onClose={() => setShareOpen(false)}
                />
            )}
            <OutlineSidebar open={outlineOpen} onClose={() => setOutlineOpen(false)} />
            <LayersPanel open={layersOpen} onClose={() => setLayersOpen(false)} />
            <PresentationMode open={presenting} onClose={() => setPresenting(false)} />
            <VersionHistoryPanel open={versionsOpen} onClose={() => setVersionsOpen(false)} />
            <TemplatesPanel open={templatesOpen} onClose={() => setTemplatesOpen(false)} />
            <SmartCollectionsPanel open={collectionsOpen} onClose={() => setCollectionsOpen(false)} />

            {/* KLYPIX Eyes removed for now — state setters remain wired so
                reintroducing the mascot later is a one-line re-add. */}

            {/* Agent command bar — `/` to open */}
            <CommandBar
                open={commandOpen}
                onClose={() => setCommandOpen(false)}
                onToast={(text) => setToast({ text, id: Date.now() })}
                onProgress={(p) => {
                    if (!p) { setEyesState('idle'); return; }
                    if (p.tool === 'canvas_get_items' || p.tool === 'canvas_read_item' || p.tool === 'canvas_search' || p.tool === 'canvas_read_file') {
                        setEyesState('reading');
                    } else if (p.tool === 'canvas_done') {
                        setEyesState('success');
                        setEyesBubble('done');
                    } else if (p.tool) {
                        setEyesState('working');
                    } else {
                        setEyesState('thinking');
                    }
                }}
                onError={(msg) => {
                    setEyesState('error');
                    setEyesBubble(msg || 'hmm…');
                    setTimeout(() => setEyesState('idle'), 3000);
                }}
            />

            {/* Agent toast — short answers float and auto-dismiss; pin converts to permanent card */}
            {toast && (
                <AgentToast
                    text={toast.text}
                    keyVal={toast.id}
                    onDismiss={() => setToast(null)}
                    onPin={() => {
                        const pinned: TextItem = {
                            id: newId('agent'),
                            type: 'text',
                            x: 80,
                            y: 80,
                            w: 420,
                            h: 120,
                            zIndex: state.order.length,
                            locked: false,
                            parentId: null,
                            createdAt: Date.now(),
                            createdBy: 'agent',
                            content: toast.text,
                            fontSize: 14,
                            color: defaultTextColorFor(getCurrentGridSettings().background),
                            border: true,
                            borderColor: 'rgba(16,185,129,0.5)',
                            heading: false,
                        };
                        commit({ type: 'ADD_ITEM', item: pinned });
                        setToast(null);
                    }}
                />
            )}

            {/* Drop indicator — shown while dragging files over the canvas.
                Colors flip with the canvas background so the text reads on
                cream / light themes, not just the dark one. The dashed
                emerald border + icon backplate keep the emerald accent
                consistent across themes. */}
            {isDragOver && (() => {
                const dark = isDarkBackground(gridSettings.background);
                return (
                    <div
                        className="absolute inset-4 z-30 rounded-2xl border-2 border-dashed border-emerald-400/70 flex flex-col items-center justify-center pointer-events-none animate-in fade-in duration-150"
                        style={{ background: dark ? 'rgba(16,185,129,0.05)' : 'rgba(16,185,129,0.10)' }}
                    >
                        <div className="w-14 h-14 rounded-2xl bg-emerald-500/25 flex items-center justify-center mb-3">
                            <Paperclip size={24} className={dark ? 'text-emerald-300' : 'text-emerald-700'} />
                        </div>
                        <div
                            className="text-sm font-medium"
                            style={{ color: dark ? 'rgba(255,255,255,0.9)' : 'rgba(20,30,25,0.85)' }}
                        >
                            drop to add to canvas
                        </div>
                        <div
                            className="text-[11px] tracking-wide mt-1"
                            style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(20,30,25,0.55)' }}
                        >
                            images, pdfs, docs — anything
                        </div>
                    </div>
                );
            })()}

            {/* File ops + nav — top left. Mic lives separately as a bottom-
                center FAB (see below) so dictation has its own space and
                doesn't get lost in the file-ops cluster. */}
            <div data-canvas-ui="1" className="absolute top-3 left-3 z-20 no-drag flex items-center gap-1 px-1 py-1 rounded-full bg-black/60 border border-white/10">
                <FileOpButton label="Home (Recent + Shared)" onClick={() => setManualDashboardOpen(true)}><HomeIcon size={13} /></FileOpButton>
                <span className="w-px h-4 bg-white/10 mx-0.5" />
                <FileOpButton label="New (Ctrl+N)" onClick={file.newFile}><FilePlus2 size={13} /></FileOpButton>
                <FileOpButton label="Open (Ctrl+O)" onClick={file.open}><FolderOpen size={13} /></FileOpButton>
                <FileOpButton label="Save (Ctrl+S)" onClick={file.save}><Save size={13} /></FileOpButton>
                <FileOpButton label={state.filePath ? 'Share canvas' : 'Save first, then share'} onClick={() => setShareOpen(true)}><Share2 size={13} /></FileOpButton>
                <span className="w-px h-4 bg-white/10 mx-0.5" />
                <FileOpButton label="Search (Ctrl+F)" onClick={() => setSearchOpen(true)}><SearchIcon size={13} /></FileOpButton>
                <FileOpButton label="Outline" onClick={() => setOutlineOpen(v => !v)}><List size={13} /></FileOpButton>
                <FileOpButton label="Layers" onClick={() => setLayersOpen(v => !v)}><Layers size={13} /></FileOpButton>
                <FileOpButton label="Present" onClick={() => setPresenting(true)}><Play size={13} /></FileOpButton>
                <FileOpButton label="Version history" onClick={() => setVersionsOpen(v => !v)}><HistoryIcon size={13} /></FileOpButton>
                <FileOpButton label="Templates" onClick={() => setTemplatesOpen(v => !v)}><StampIcon size={13} /></FileOpButton>
                <FileOpButton label={state.statusFilterHidden.length > 0 ? `Smart collections — ${state.statusFilterHidden.length} status${state.statusFilterHidden.length === 1 ? '' : 'es'} hidden` : 'Smart collections'} onClick={() => setCollectionsOpen(v => !v)} indicator={state.statusFilterHidden.length > 0}><FilterIcon size={13} /></FileOpButton>
                <FileOpButton label="Link to canvas" onClick={insertCanvasLink}><LinkPlusIcon size={13} /></FileOpButton>
                <span className="w-px h-4 bg-white/10 mx-0.5" />
                <CanvasSettingsPopover />
            </div>

            {/* File title + tool/zoom/item indicator — bottom right */}
            <div data-canvas-ui="1" className="absolute bottom-3 right-3 z-20 no-drag flex items-center gap-2 px-2.5 py-1 rounded-full bg-black/60 border border-white/10 text-[10px] text-white/50 font-medium tracking-wider uppercase">
                <span className={state.isDirty ? 'text-amber-300' : 'text-white/70'}>
                    {state.isDirty ? '• ' : ''}{state.title}
                </span>
                <span className="text-white/20">·</span>
                <span className="text-emerald-300">{state.tool}</span>
                <span className="text-white/20">·</span>
                <ZoomControl
                    zoom={state.view.zoom}
                    onZoomTo={(target) => {
                        // ZOOM action takes cx/cy in surface-relative screen
                        // coords and a factor. Fold "set to target" into a
                        // single factor so the zoom anchor (surface center)
                        // stays locked while the magnitude changes.
                        const rect = surfaceElRef.current?.getBoundingClientRect();
                        const cx = rect ? rect.width / 2 : window.innerWidth / 2;
                        const cy = rect ? rect.height / 2 : window.innerHeight / 2;
                        const curr = state.view.zoom;
                        if (curr <= 0) return;
                        dispatch({ type: 'ZOOM', factor: target / curr, cx, cy });
                    }}
                    onFit={() => {
                        // Same math as the Ctrl+0 shortcut: fit every item's
                        // bounding rect to the surface viewport.
                        const itemsArr = state.order.map(id => state.items[id]).filter(Boolean);
                        const bounds = itemsBounds(itemsArr as { x: number; y: number; w: number; h: number }[]);
                        if (!bounds) return;
                        const rect = surfaceElRef.current?.getBoundingClientRect();
                        const view = fitToViewport(
                            bounds,
                            { w: rect?.width ?? window.innerWidth, h: rect?.height ?? window.innerHeight },
                        );
                        dispatch({ type: 'SET_VIEW', view });
                    }}
                />
                <span className="text-white/20">·</span>
                <span>{displayedItemCount} {displayedItemCount === 1 ? 'item' : 'items'}</span>
            </div>

            {/* Voice FAB — bottom-center. Centered normally; slides to
                bottom-right when the agent command bar is open so the two
                don't collide. Clicking streams dictation into the focused
                text item (state.editingId) if there is one, otherwise into
                the floating transcription card below. */}
            <div
                data-canvas-ui="1"
                className="absolute bottom-3 left-1/2 z-30 no-drag"
                style={{
                    transform: commandOpen
                        ? 'translateX(calc(50vw - 52px))'
                        : 'translateX(-50%)',
                    transition: 'transform 200ms ease-out',
                }}
            >
                <button
                    onClick={() => {
                        const rec = voiceRef.current!;
                        if (rec.isRecording()) {
                            rec.stop();
                            return;
                        }
                        if (state.editingId) {
                            toggleVoice(state.editingId);
                        } else {
                            toggleVoiceToCard();
                        }
                    }}
                    title={
                        voiceStatus === 'recording' ? 'Stop & transcribe' :
                        voiceStatus === 'transcribing' ? 'Transcribing…' :
                        'Voice (Ctrl+M)'
                    }
                    disabled={voiceStatus === 'transcribing'}
                    className={`w-10 h-10 flex items-center justify-center rounded-full border transition-colors cursor-pointer shadow-[0_6px_20px_rgba(0,0,0,0.4)] ${
                        voiceStatus === 'recording'
                            ? 'bg-red-500/90 border-red-400/70 text-white'
                            : voiceStatus === 'transcribing'
                            ? 'bg-emerald-500/80 border-emerald-400/70 text-white cursor-wait'
                            : 'bg-[#12121a]/90 border-white/15 text-white/75 hover:text-white hover:bg-[#1a1a22]/95'
                    }`}
                >
                    {voiceStatus === 'recording' ? <AudioBars level={voiceLevel} />
                        : voiceStatus === 'transcribing' ? <Loader2 size={16} className="animate-spin" />
                        : <Mic size={16} />}
                </button>
            </div>

            {/* Transcription card — appears while the mic is streaming to
                the card sink (no text item is being edited). Lets the user
                copy the text or pin it to the canvas at the card's world
                position. Persists after recording ends so slow readers can
                still act on the final transcript. */}
            {transcription && (() => {
                const doneText = transcription.status === 'done' ? transcription.text : '';
                const canAct = !!doneText;
                return (
                <div
                    ref={cardRef}
                    data-canvas-ui="1"
                    className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 w-[min(520px,85vw)] no-drag"
                >
                    <div className={`animate-in slide-in-from-bottom-2 fade-in duration-150 bg-[#1a1a2a]/95 backdrop-blur-xl border ${
                        transcription.status === 'error' ? 'border-red-500/50' : 'border-emerald-500/40'
                    } rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] px-4 py-3 flex items-start gap-3`}>
                        <div className="flex-1 text-[13px] leading-relaxed whitespace-pre-wrap min-h-[20px]">
                            {transcription.status === 'listening' && (
                                <span className="text-white/50 italic flex items-center gap-2">
                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                    Listening…
                                </span>
                            )}
                            {transcription.status === 'transcribing' && (
                                <span className="text-white/60 italic flex items-center gap-2">
                                    <Loader2 size={12} className="animate-spin text-emerald-400" />
                                    Transcribing…
                                </span>
                            )}
                            {transcription.status === 'done' && (
                                <span className="text-white/90">{transcription.text || <span className="text-white/30 italic">(no speech detected)</span>}</span>
                            )}
                            {transcription.status === 'error' && (
                                <span className="text-red-300/90">⚠ {transcription.message}</span>
                            )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                            <button
                                onClick={() => {
                                    if (!doneText) return;
                                    // Use Electron's main-process clipboard — navigator.clipboard
                                    // silently fails in this renderer when focus shifts away
                                    // (which happens the moment the user clicks the FAB).
                                    (window as any).electron?.copyToClipboard?.({ text: doneText, html: doneText });
                                    dismissTranscriptionCard();
                                }}
                                title="Copy"
                                disabled={!canAct}
                                className="p-1.5 rounded-md text-white/40 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all disabled:opacity-30 disabled:hover:text-white/40 disabled:hover:bg-transparent"
                            >
                                <Copy size={14} />
                            </button>
                            <button
                                onClick={() => {
                                    const card = cardRef.current;
                                    const surface = surfaceElRef.current;
                                    if (!card || !surface || !doneText) return;
                                    // Translate card's top-left from screen to world so the pinned
                                    // text lands exactly where the card was visually sitting.
                                    const cardRect = card.getBoundingClientRect();
                                    const surfRect = surface.getBoundingClientRect();
                                    const world = screenToWorld(
                                        { x: cardRect.left - surfRect.left, y: cardRect.top - surfRect.top },
                                        state.view,
                                    );
                                    const item: TextItem = {
                                        id: newId('vtx'),
                                        type: 'text',
                                        x: world.x,
                                        y: world.y,
                                        // Keep the pinned item's on-screen footprint close to the
                                        // card's footprint regardless of current zoom.
                                        w: 420 / state.view.zoom,
                                        h: 60 / state.view.zoom,
                                        zIndex: state.order.length,
                                        locked: false,
                                        parentId: null,
                                        createdAt: Date.now(),
                                        createdBy: 'user',
                                        content: doneText,
                                        fontSize: 14,
                                        color: defaultTextColorFor(getCurrentGridSettings().background),
                                        border: false,
                                        borderColor: '#1e1e2e',
                                        heading: false,
                                    };
                                    commit({ type: 'ADD_ITEM', item });
                                    dismissTranscriptionCard();
                                }}
                                title="Pin to canvas"
                                disabled={!canAct}
                                className="p-1.5 rounded-md text-white/40 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all disabled:opacity-30 disabled:hover:text-white/40 disabled:hover:bg-transparent"
                            >
                                <Pin size={14} />
                            </button>
                            <button
                                onClick={dismissTranscriptionCard}
                                title="Dismiss"
                                className="p-1.5 rounded-md text-white/30 hover:text-white/70 hover:bg-white/5 transition-all"
                            >
                                ×
                            </button>
                        </div>
                    </div>
                </div>
                );
            })()}
        </div>
    );
}

// Waveform inside the voice FAB while recording. Driven by the actual
// mic amplitude (0..1) from the AudioContext analyser — matches the
// chat-side mic's feel. Per-bar scale factors shape the middle bars
// taller so it reads as a waveform rather than a flat bar chart.
function AudioBars({ level }: { level: number }) {
    const scales = [0.6, 1, 0.7, 0.9, 0.5];
    // Below this level, treat as silence and render uniform short bars
    // so the rest state is a clean flat row instead of a residual wave.
    const REST_THRESHOLD = 0.08;
    const isResting = level < REST_THRESHOLD;
    return (
        <div className="flex items-end gap-[2px] h-4">
            {scales.map((scale, i) => (
                <span
                    key={i}
                    className="w-[2px] bg-white rounded-full"
                    style={{
                        height: isResting ? '3px' : `${Math.max(3, level * scale * 16)}px`,
                        opacity: isResting ? 0.5 : 0.5 + level * 0.5,
                    }}
                />
            ))}
        </div>
    );
}

interface AgentToastProps {
    text: string;
    keyVal: number;
    onDismiss: () => void;
    onPin: () => void;
}

function AgentToast({ text, keyVal, onDismiss, onPin }: AgentToastProps) {
    const [hovered, setHovered] = useState(false);
    useEffect(() => {
        if (hovered) return;
        const t = setTimeout(onDismiss, 10_000);
        return () => clearTimeout(t);
    }, [hovered, keyVal, onDismiss]);

    return (
        <div
            data-canvas-ui="1"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 w-[min(520px,85vw)] no-drag animate-in slide-in-from-bottom-2 fade-in duration-200"
        >
            <div className="bg-[#1a1a2a]/95 backdrop-blur-xl border border-emerald-500/30 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] px-4 py-3 flex items-start gap-3">
                <div className="flex-1 text-[13px] text-white/90 leading-relaxed whitespace-pre-wrap">{text}</div>
                <div className="flex items-center gap-1 shrink-0">
                    <button onClick={onPin} title="Pin to canvas" className="p-1.5 rounded-md text-white/40 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all"><Pin size={14} /></button>
                    <button onClick={onDismiss} title="Dismiss" className="p-1.5 rounded-md text-white/30 hover:text-white/70 hover:bg-white/5 transition-all">×</button>
                </div>
            </div>
        </div>
    );
}

interface ZoomControlProps {
    zoom: number;
    onZoomTo: (target: number) => void;
    onFit: () => void;
}

// Editable zoom percentage. Click / focus to type, Enter to commit,
// Escape to revert. Clamped to the store's [0.02, 4.0] range. Flanking
// buttons: Fit (Ctrl+0 equivalent — fit all items to viewport) and
// 100% (reset to 1:1 around viewport center).
const ZOOM_MIN_PCT = 2;
const ZOOM_MAX_PCT = 400;
function ZoomControl({ zoom, onZoomTo, onFit }: ZoomControlProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const currentPct = Math.round(zoom * 100);

    const commit = () => {
        // Accept "120", "120%", " 120 ". Reject anything else quietly.
        const cleaned = draft.trim().replace(/%$/, '');
        const n = Number(cleaned);
        if (Number.isFinite(n)) {
            const clamped = Math.max(ZOOM_MIN_PCT, Math.min(ZOOM_MAX_PCT, n));
            onZoomTo(clamped / 100);
        }
        setEditing(false);
    };

    return (
        <span className="flex items-center gap-1">
            <button
                onClick={onFit}
                title="Fit all (Ctrl+0)"
                className="w-5 h-5 flex items-center justify-center rounded text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            >
                <FitIcon size={10} />
            </button>
            {editing ? (
                <input
                    ref={inputRef}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commit();
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(false);
                        }
                        e.stopPropagation();
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-12 bg-transparent border border-emerald-400/40 rounded px-1 text-[10px] text-white outline-none text-center"
                />
            ) : (
                <button
                    onClick={() => { setDraft(String(currentPct)); setEditing(true); }}
                    title="Click to set zoom (2–400%)"
                    className="px-1 rounded hover:bg-white/10 hover:text-white transition-colors cursor-text"
                >
                    {currentPct}%
                </button>
            )}
            <button
                onClick={() => onZoomTo(1)}
                title="Reset zoom (100%)"
                className="px-1 h-5 flex items-center justify-center rounded text-white/50 hover:text-white hover:bg-white/10 transition-colors text-[9px] tracking-normal"
            >
                1:1
            </button>
        </span>
    );
}

interface FileOpButtonProps {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
    // Subtle dot in the upper-right of the button — used to flag that a
    // panel has an active filter / unsaved change without forcing the
    // user to open it. Currently lit when the status filter is hiding
    // anything, so users notice why items are missing from the canvas.
    indicator?: boolean;
}
function FileOpButton({ label, onClick, children, indicator }: FileOpButtonProps) {
    return (
        <button
            onClick={onClick}
            title={label}
            className="relative w-7 h-7 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
        >
            {children}
            {indicator && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
            )}
        </button>
    );
}
