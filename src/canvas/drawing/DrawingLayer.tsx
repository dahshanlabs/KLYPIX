import React from 'react';
import { getStroke } from 'perfect-freehand';
import type { DrawnLine, FreehandStroke } from '../items/types';

// User-drawn straight lines and freehand pen strokes.
//
// Pre-v3 these all rendered together in a single SVG layer that sat above
// every item. v3 unified the z-order namespace — items, lines, and strokes
// can be interleaved by zKey via the Arrange menu. So each drawing now
// renders as its own standalone SVG element interleaved with items in the
// CanvasRenderer's transform layer, instead of being batched.
//
// The cost is one extra SVG element per drawing (cheap — empty SVGs are
// ~50 bytes of DOM and the path inside is the bulk). The win is being able
// to send a stroke behind a box, which was structurally impossible before.
//
// Strokes are drawn with `perfect-freehand`: it returns the outline polygon
// of an ink-style stroke that tapers based on pressure / velocity. We
// render that as a single filled <path>, not a stroked one — the variable-
// width effect is what gives it the "real ink" feel.

interface StrokeViewProps {
    stroke: FreehandStroke;
}

export const StrokeView = React.memo(function StrokeView({ stroke }: StrokeViewProps) {
    // SVG viewport must be non-zero — even with overflow:visible, an SVG
    // sized 0x0 has no rendering surface and content paths get clipped to
    // nothing. Same 100000x100000 trick the original batched DrawingLayer
    // used: large enough to contain any realistic canvas content, with
    // overflow:visible covering the rest. Cheap because empty SVG regions
    // don't allocate raster memory until something paints there.
    return (
        <svg
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100000px',
                height: '100000px',
                overflow: 'visible',
                pointerEvents: 'none',
            }}
        >
            <path d={strokePath(stroke)} fill={stroke.color} />
        </svg>
    );
});

interface LineViewProps {
    line: DrawnLine;
}

export const LineView = React.memo(function LineView({ line }: LineViewProps) {
    // Each line carries its own marker-id so two LineViews on the same
    // canvas don't collide on the marker symbol when colors differ.
    const markerId = `klpx-line-arrow-${line.id}`;
    // See StrokeView for why width/height are 100000 instead of 0.
    return (
        <svg
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100000px',
                height: '100000px',
                overflow: 'visible',
                pointerEvents: 'none',
            }}
        >
            {line.arrowHead && (
                <defs>
                    <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill={line.color} />
                    </marker>
                </defs>
            )}
            <line
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={line.color}
                strokeWidth={line.width}
                strokeLinecap="round"
                markerEnd={line.arrowHead ? `url(#${markerId})` : undefined}
            />
        </svg>
    );
});

// perfect-freehand options tuned for KLYPIX:
// - size = stroke width (max thickness when pressure is at peak)
// - thinning 0.5: moderate taper — strokes feel inky without ghosting at low pressure
// - smoothing/streamline 0.5: default smoothing of jitter (pen) and easing toward
//   the cursor (mouse). Higher streamline lags behind the cursor more visibly.
// - simulatePressure true: when real pressure is constant (mouse), derive pressure
//   from point velocity so even mouse strokes get the taper effect.
function strokePath(s: FreehandStroke): string {
    if (s.points.length === 0) return '';
    const outline = getStroke(s.points, {
        size: s.width,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: true,
        last: true,
    });
    return svgPathFromOutline(outline);
}

// Standard perfect-freehand outline → SVG path conversion. The outline is a
// closed polygon; we render it as a quadratic-bezier loop so adjacent vertices
// are smoothed.
function svgPathFromOutline(outline: number[][]): string {
    if (outline.length === 0) return '';
    const len = outline.length;
    const first = outline[0];
    let d = `M ${first[0]} ${first[1]} Q`;
    for (let i = 0; i < len; i++) {
        const [x0, y0] = outline[i];
        const [x1, y1] = outline[(i + 1) % len];
        d += ` ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
    }
    d += ' Z';
    return d;
}
