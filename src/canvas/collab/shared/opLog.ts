// opLog — the pure, framework-free convergence core for op-sync.
//
// No React, no Supabase, no localStorage. It owns the CAUSALITY decisions that
// determine whether two peers converge: the Lamport clock, op idempotency (a
// seen-set keyed by a unique opId), and offline-drain rebase. Because it is
// pure, it can be unit-tested headlessly (vitest) and reused by the collab
// simulator — the hook (useOpSync) keeps hydration/persistence + dispatch, and
// delegates every "should this apply / what tick" question here.
//
// Why this exists (audit findings it fixes):
//  - IDEMPOTENCY: broadcasts can be re-sent (drain retry, flush retry). Without
//    a per-op id, a re-sent ADD after a DELETE resurrects the item. opId + a
//    bounded seen-set make application exactly-once.
//  - DRAIN REBASE: ops queued offline carry a STALE lamport; on reconnect they
//    sort BEFORE newer remote state and clobber it under last-write-wins.
//    rebaseForDrain() re-stamps them to the current tick so they sort AFTER.

export interface StampedOp {
    /** Globally-unique id: "<deviceId>:<broadcastSeq>". Travels on the op so
     *  every peer can dedupe it across broadcast AND server backfill. */
    opId: string;
    /** Lamport tick for approximate causal ordering. */
    lamport: number;
}

export interface OpLogInit {
    deviceId: string;
    /** Hydrated from persistence so a reloaded tab continues monotonically. */
    lamport?: number;
    broadcastSeq?: number;
    /** Max opIds retained for idempotency (bounded so memory can't grow without
     *  end on a long session). Older ids are evicted FIFO. */
    maxSeen?: number;
}

export class OpLog {
    lamport: number;
    broadcastSeq: number;
    private readonly deviceId: string;
    private readonly seen = new Set<string>();
    private readonly seenOrder: string[] = [];
    private readonly maxSeen: number;

    constructor(init: OpLogInit) {
        this.deviceId = init.deviceId;
        this.lamport = Math.max(0, init.lamport ?? 0);
        this.broadcastSeq = Math.max(0, init.broadcastSeq ?? 0);
        this.maxSeen = Math.max(100, init.maxSeen ?? 4000);
    }

    /** Stamp a locally-originated op for broadcast: a unique opId + the next
     *  lamport tick. Records the opId as seen so if it ever round-trips back
     *  (e.g. via server backfill) we don't re-apply our own op. */
    stampLocal(): StampedOp {
        this.lamport += 1;
        this.broadcastSeq += 1;
        const opId = this.deviceId + ':' + this.broadcastSeq;
        this.markSeen(opId);
        return { opId, lamport: this.lamport };
    }

    /** Re-stamp a queued offline op when draining on reconnect, so it sorts
     *  AFTER any backfilled remote state instead of clobbering it with the
     *  stale offline lamport it was first queued with. The op's opId is
     *  unchanged (still deduped if a peer already saw it). */
    rebaseForDrain(): number {
        this.lamport += 1;
        return this.lamport;
    }

    /** Decide whether an INBOUND op should be applied, and clamp the clock.
     *  Returns false for a duplicate opId (idempotency) — the caller skips it.
     *  An op with no opId (legacy peer / pre-opId backfill row) is always
     *  applied (can't dedupe it) but still advances the clock. */
    receive(opId: string | undefined | null, lamport: number | undefined | null): boolean {
        if (opId) {
            if (this.seen.has(opId)) return false;
            this.markSeen(opId);
        }
        if (typeof lamport === 'number' && lamport > this.lamport) this.lamport = lamport;
        return true;
    }

    /** Record an applied opId, evicting the oldest when over capacity. */
    markSeen(opId: string): void {
        if (this.seen.has(opId)) return;
        this.seen.add(opId);
        this.seenOrder.push(opId);
        if (this.seenOrder.length > this.maxSeen) {
            const evict = this.seenOrder.shift();
            if (evict !== undefined) this.seen.delete(evict);
        }
    }

    hasSeen(opId: string): boolean { return this.seen.has(opId); }
}
