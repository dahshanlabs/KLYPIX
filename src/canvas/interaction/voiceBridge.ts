// Tiny module-level bridge so `useCanvasInteraction` can trigger the
// voice controller without importing KlypixCanvas (circular dep). Same
// pattern used by CanvasLinkItem's setOpenCanvasLinkHandler.
//
// KlypixCanvas registers a `dictateInto(itemId)` handler once on mount;
// the T-tool click path in useCanvasInteraction calls it with the freshly
// created text item's id. The handler starts voice recognition and streams
// interim transcript into that item via UPDATE_ITEM.

export type DictateIntoFn = (itemId: string) => void;

let dictateIntoGlobal: DictateIntoFn = () => { /* no-op until registered */ };

export function setDictateIntoHandler(fn: DictateIntoFn): void {
    dictateIntoGlobal = fn;
}

export function dictateInto(itemId: string): void {
    dictateIntoGlobal(itemId);
}
