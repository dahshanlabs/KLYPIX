import { describe, it, expect } from 'vitest';
import {
    isGenericSignoff, looksLikeRefusal, refusalTone, refusalArrowColor,
    pickSubstantiveReply, NON_MUTATING_TOOLS,
} from './replyClassify';

// The bug: a meaningful refusal vanished as a toast while a content-free
// "Translation request completed." sign-off was pinned as a durable card.
// These tests lock the routing: sign-offs are dropped, refusals are kept and
// flagged so they become a Note card, not a fake-success card.

const GIBBERISH_REFUSAL = 'The selected text does not appear to be translatable. Please provide meaningful text.';

describe('isGenericSignoff — content-free sign-offs are dropped', () => {
    it('flags the exact bug message and common sign-offs', () => {
        for (const s of ['Translation request completed.', 'Done.', 'Done', 'Completed.', 'Task completed successfully.', 'Summary complete.', 'OK', '']) {
            expect(isGenericSignoff(s), s).toBe(true);
        }
    });
    it('does NOT flag the refusal or a real answer as a sign-off', () => {
        expect(isGenericSignoff(GIBBERISH_REFUSAL)).toBe(false);
        expect(isGenericSignoff('Peace be upon you, how are you?')).toBe(false);
        expect(isGenericSignoff('Rows 3 and 7 differ in the total column.')).toBe(false);
    });
});

describe('looksLikeRefusal — the high-value message that must persist', () => {
    it('catches refusals / no-ops', () => {
        for (const s of [GIBBERISH_REFUSAL, "I can't translate this — it isn't meaningful text.", 'Nothing to summarize here.', 'Unable to compare: only one item selected.', 'No translatable content found.']) {
            expect(looksLikeRefusal(s), s).toBe(true);
        }
    });
    it('does NOT misclassify a real answer as a refusal', () => {
        expect(looksLikeRefusal('Peace be upon you, how are you?')).toBe(false);
        expect(looksLikeRefusal('The document argues that remote work boosts retention.')).toBe(false);
        // A long answer that merely contains "cannot" somewhere is not a refusal.
        const longAnswer = 'The proposal is strong overall. '.repeat(12) + 'One area we cannot yet measure is churn.';
        expect(looksLikeRefusal(longAnswer)).toBe(false);
    });
});

describe('refusalTone — amber (actionable) vs slate (FYI)', () => {
    it('actionable refusal → amber, pure no-op → slate', () => {
        expect(refusalTone(GIBBERISH_REFUSAL)).toBe('amber');     // "provide meaningful text"
        expect(refusalTone('Please select items first.')).toBe('amber');
        expect(refusalTone('Nothing to summarize here.')).toBe('slate');
    });
    it('arrow color matches the tone', () => {
        expect(refusalArrowColor('amber')).toBe('#f59e0b');
        expect(refusalArrowColor('slate')).toBe('#9ca3af');
    });
});

describe('pickSubstantiveReply — the routing decision', () => {
    it('THE BUG: refusal-via-toast + "completed"-via-done → keeps the refusal, drops the sign-off', () => {
        const agentSaid = [GIBBERISH_REFUSAL];
        const doneMessage = 'Translation request completed.';
        const reply = pickSubstantiveReply([...agentSaid, doneMessage]);
        expect(reply).toBe(GIBBERISH_REFUSAL);
        expect(looksLikeRefusal(reply)).toBe(true);
        expect(refusalTone(reply)).toBe('amber');
    });
    it('only a sign-off → empty (→ nothing pinned / failure report)', () => {
        expect(pickSubstantiveReply(['Done.'])).toBe('');
        expect(pickSubstantiveReply(['', 'Completed.'])).toBe('');
    });
    it('a real answer is kept and returned', () => {
        expect(pickSubstantiveReply(['Peace be upon you, how are you?'])).toBe('Peace be upon you, how are you?');
    });
    it('picks the most substantive when several were said', () => {
        expect(pickSubstantiveReply(['Done.', 'Found 3 issues: orphans, duplicates, and an untagged card.'])).toBe('Found 3 issues: orphans, duplicates, and an untagged card.');
    });
});

describe('NON_MUTATING_TOOLS — used to tell empty runs from silent work', () => {
    it('reads + toast + done + ask are non-mutating; create/organize/tag are mutating', () => {
        for (const t of ['canvas_get_items', 'canvas_read_item', 'canvas_create_toast', 'canvas_done', 'canvas_ask_user', 'canvas_find_issues']) {
            expect(NON_MUTATING_TOOLS.has(t), t).toBe(true);
        }
        for (const t of ['canvas_create_card', 'canvas_organize', 'canvas_set_tags', 'canvas_connect_items']) {
            expect(NON_MUTATING_TOOLS.has(t), t).toBe(false);
        }
    });
});
