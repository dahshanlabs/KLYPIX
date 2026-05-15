import React from 'react';
import type { BoxItem as BoxItemType, TextItem } from './types';
import { ResizeHandle } from '../interaction/ResizeHandle';
import { useCanvasStore } from '../state/canvasStore';
import { newId } from './types';
import { defaultTextColorFor, getCurrentGridSettings } from '../gridSettings';

interface Props {
    item: BoxItemType;
    selected: boolean;
}

export const BoxItemView = React.memo(BoxItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

function dashFor(style: string | undefined, width: number): string | undefined {
    if (style === 'dashed') return `${Math.max(6, width * 3)} ${Math.max(4, width * 2)}`;
    if (style === 'dotted') return `${width} ${Math.max(3, width * 2)}`;
    return undefined;
}

function BoxItemViewImpl({ item, selected }: Props) {
    const { dispatch, commit } = useCanvasStore();
    const shape = item.shape || 'rect';

    // Double-click a box → convert it to a bordered TextItem so the user
    // can type directly inside the frame. The frame's border color and
    // parent are preserved. Non-rect shapes (circle/triangle/diamond) keep
    // their shape but gain a text overlay anchored to the center instead
    // — we don't mutate geometric shapes into text cards because the
    // border shape wouldn't match.
    const onDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!item.shape || item.shape === 'rect') {
            // Rect → in-place convert to bordered TextItem. Same position,
            // same frame, enter edit immediately. Any arrows that pointed
            // to the box will be dropped by DELETE_ITEMS (rare for plain
            // decorative boxes; acceptable tradeoff for the cleaner UX).
            const text: TextItem = {
                id: newId('txt'),
                type: 'text',
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                zIndex: item.zIndex,
                locked: false,
                parentId: item.parentId,
                createdAt: Date.now(),
                createdBy: 'user',
                content: '',
                fontSize: 16,
                color: defaultTextColorFor(getCurrentGridSettings().background),
                border: true,
                borderColor: item.borderColor,
                heading: false,
                authoredWidth: item.w,
            };
            dispatch({ type: 'DELETE_ITEMS', ids: [item.id] });
            commit({ type: 'ADD_ITEM', item: text });
            dispatch({ type: 'SELECT', ids: [text.id] });
            dispatch({ type: 'SET_EDITING', id: text.id });
            return;
        }
        // Non-rect: keep the shape as background, drop a text child centered.
        const text: TextItem = {
            id: newId('txt'),
            type: 'text',
            x: item.x + Math.max(10, item.w * 0.15),
            y: item.y + Math.max(10, item.h / 2 - 14),
            w: Math.max(80, item.w - item.w * 0.3),
            h: 28,
            zIndex: item.zIndex + 1,
            locked: false,
            parentId: item.parentId,
            createdAt: Date.now(),
            createdBy: 'user',
            content: '',
            fontSize: 16,
            color: defaultTextColorFor(getCurrentGridSettings().background),
            border: false,
            borderColor: '#1e1e2e',
            heading: false,
        };
        commit({ type: 'ADD_ITEM', item: text });
        dispatch({ type: 'SELECT', ids: [text.id] });
        dispatch({ type: 'SET_EDITING', id: text.id });
    };
    const opacity = item.opacity ?? 1;
    const dasharray = dashFor(item.lineStyle, item.borderWidth);
    const fill = item.fillColor && item.fillColor !== 'transparent' ? item.fillColor : 'none';

    // Wrapper positions + sizes the shape. Shapes themselves render as SVG so
    // we can do circle/triangle/diamond with the same code path.
    const wrap: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        pointerEvents: 'auto',
        opacity,
        filter: selected ? 'drop-shadow(0 0 0.01px #10b981)' : undefined,
    };

    let shapeEl: React.ReactNode;
    if (shape === 'rect') {
        // Fast path: plain div. Resize handle offsets match perfectly.
        const style: React.CSSProperties = {
            position: 'absolute',
            inset: 0,
            border: `${item.borderWidth}px ${item.lineStyle || 'solid'} ${item.borderColor}`,
            background: fill === 'none' ? undefined : fill,
            borderRadius: item.borderRadius,
            boxShadow: selected ? '0 0 0 3px rgba(16,185,129,0.25)' : undefined,
        };
        shapeEl = <div style={style} />;
    } else {
        // SVG shapes. Viewbox fills the wrapper.
        const W = item.w, H = item.h;
        const common = {
            fill,
            stroke: item.borderColor,
            strokeWidth: item.borderWidth,
            strokeDasharray: dasharray,
            vectorEffect: 'non-scaling-stroke' as const,
        };
        shapeEl = (
            <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                {shape === 'circle' && (
                    <ellipse cx={W / 2} cy={H / 2} rx={(W - item.borderWidth) / 2} ry={(H - item.borderWidth) / 2} {...common} />
                )}
                {shape === 'triangle' && (
                    <polygon points={`${W / 2},${item.borderWidth} ${W - item.borderWidth},${H - item.borderWidth} ${item.borderWidth},${H - item.borderWidth}`} {...common} strokeLinejoin="round" />
                )}
                {shape === 'diamond' && (
                    <polygon points={`${W / 2},${item.borderWidth} ${W - item.borderWidth},${H / 2} ${W / 2},${H - item.borderWidth} ${item.borderWidth},${H / 2}`} {...common} strokeLinejoin="round" />
                )}
            </svg>
        );
    }

    return (
        <>
            <div data-canvas-item={item.id} style={wrap} onDoubleClick={onDoubleClick} title={shape === 'rect' ? 'Double-click to type inside' : 'Double-click to add text'}>{shapeEl}</div>
            {selected && <ResizeHandle itemId={item.id} x={item.x} y={item.y} w={item.w} h={item.h} />}
        </>
    );
}
