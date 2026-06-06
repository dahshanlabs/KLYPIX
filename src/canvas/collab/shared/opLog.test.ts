import { describe, it, expect } from 'vitest';
import { OpLog } from './opLog';

describe('OpLog — convergence core', () => {
    it('stampLocal increments lamport + broadcastSeq and yields unique opIds', () => {
        const log = new OpLog({ deviceId: 'A' });
        const a = log.stampLocal();
        const b = log.stampLocal();
        expect(a.lamport).toBe(1);
        expect(b.lamport).toBe(2);
        expect(a.opId).toBe('A:1');
        expect(b.opId).toBe('A:2');
        expect(a.opId).not.toBe(b.opId);
    });

    it('hydrates from persisted lamport + broadcastSeq (monotonic across reload)', () => {
        const log = new OpLog({ deviceId: 'A', lamport: 40, broadcastSeq: 12 });
        const s = log.stampLocal();
        expect(s.lamport).toBe(41);
        expect(s.opId).toBe('A:13');
    });

    it('receive() is idempotent — a duplicate opId is applied exactly once', () => {
        const log = new OpLog({ deviceId: 'A' });
        expect(log.receive('B:1', 5)).toBe(true);   // first time → apply
        expect(log.receive('B:1', 5)).toBe(false);  // duplicate → skip
        expect(log.receive('B:1', 5)).toBe(false);  // still skipped
    });

    it('the ADD-after-DELETE resurrection a re-send would cause is blocked', () => {
        // Peer broadcasts ADD(x) [B:1], DELETE(x) [B:2], then RE-SENDS ADD(x)
        // [B:1] on a drain retry. Without idempotency the re-sent ADD would
        // resurrect x; with it, the re-send is dropped.
        const log = new OpLog({ deviceId: 'A' });
        expect(log.receive('B:1', 1)).toBe(true);   // ADD applied
        expect(log.receive('B:2', 2)).toBe(true);   // DELETE applied
        expect(log.receive('B:1', 1)).toBe(false);  // re-sent ADD → NOT resurrected
    });

    it('receive() clamps the lamport to the max seen', () => {
        const log = new OpLog({ deviceId: 'A', lamport: 3 });
        log.receive('B:1', 10);
        expect(log.lamport).toBe(10);
        log.receive('B:2', 7);                       // older → no regression
        expect(log.lamport).toBe(10);
        expect(log.stampLocal().lamport).toBe(11);   // local send is now > everything seen
    });

    it('an op with no opId is always applied (legacy peer) but still advances the clock', () => {
        const log = new OpLog({ deviceId: 'A', lamport: 2 });
        expect(log.receive(undefined, 9)).toBe(true);
        expect(log.receive(undefined, 9)).toBe(true);  // can't dedupe without an id
        expect(log.lamport).toBe(9);
    });

    it('rebaseForDrain re-stamps a queued op to a tick AFTER current state', () => {
        const log = new OpLog({ deviceId: 'A', lamport: 5 });
        log.receive('B:1', 20);                       // backfilled newer remote state
        expect(log.lamport).toBe(20);
        // A queued offline op (originally lamport 6) is rebased on drain:
        expect(log.rebaseForDrain()).toBe(21);        // now sorts AFTER the backfill, not before
        expect(log.rebaseForDrain()).toBe(22);        // each drained op gets an increasing tick
    });

    it('two peers exchanging stamped ops converge on the same lamport', () => {
        const A = new OpLog({ deviceId: 'A' });
        const B = new OpLog({ deviceId: 'B' });
        const a1 = A.stampLocal();                    // A:1 lamport 1
        B.receive(a1.opId, a1.lamport);               // B sees it → lamport 1
        const b1 = B.stampLocal();                    // B:2? no — B lamport →2, B:1
        expect(b1.lamport).toBe(2);
        A.receive(b1.opId, b1.lamport);               // A sees it → lamport 2
        expect(A.lamport).toBe(2);
        expect(B.lamport).toBe(2);                    // converged
    });

    it('bounds the seen-set (eviction) without losing recent ids', () => {
        const log = new OpLog({ deviceId: 'A', maxSeen: 100 });
        for (let i = 1; i <= 150; i++) log.receive('B:' + i, i);
        expect(log.hasSeen('B:150')).toBe(true);      // recent retained
        expect(log.hasSeen('B:1')).toBe(false);       // oldest evicted
    });
});
