// ============================================================
// aiRouter.patch.ts  —  Project Eye / ALT+Space
// Phase 3.1: Intent Engine — aiRouter.ts Integration Patch
// ============================================================
//
// HOW TO APPLY THIS PATCH:
// ─────────────────────────────────────────────────────────────
// 1. Open your existing  src/api/aiRouter.ts
// 2. Add the imports marked with  ← ADD  at the top
// 3. Find your main handleCommand() function
// 4. Insert the INTENT INTERCEPT BLOCK at the very start of
//    the function, before any existing routing logic
// 5. Update the function return type as shown
// 6. Copy the IPC handler additions into electron/main.ts
//
// This file is annotated to make the diff crystal clear.
// You do NOT replace aiRouter.ts — you add ~30 lines to it.
// ============================================================

// ────────────────────────────────────────────────────────────
// STEP 1: Add these imports to the TOP of aiRouter.ts
// ────────────────────────────────────────────────────────────

// ← ADD (alongside your existing imports)
import { classifyIntent, meetsExecutionThreshold, isObviousChatMessage } from '../engine/intentEngine';
import { WindowContext, RouterResponse, INTENT_THRESHOLD }               from '../engine/intentTypes';

// ────────────────────────────────────────────────────────────
// STEP 2: Update your handleCommand() function signature
// ────────────────────────────────────────────────────────────
//
// BEFORE (your existing signature — something like):
//   export async function handleCommand(command: string, context?: unknown): Promise<string>
//
// AFTER (add WindowContext param and update return type):
//   export async function handleCommand(
//     command: string,
//     context: WindowContext             ← ADD this parameter
//   ): Promise<RouterResponse>           ← CHANGE return type
//
// ────────────────────────────────────────────────────────────
// STEP 3: Insert the INTENT INTERCEPT BLOCK at the very START
//         of your handleCommand() function body
// ────────────────────────────────────────────────────────────

/*

  // ══════════════════════════════════════════════════════════
  // PHASE 3 — INTENT ENGINE INTERCEPT
  // Runs before any LLM routing. If a structured action intent
  // is detected with sufficient confidence, we short-circuit
  // the chat path and return an action_pending response that
  // the renderer will display in the ConfirmationModal.
  // ══════════════════════════════════════════════════════════

  // Fast path: skip Gemini classification call for obvious chat
  if (!isObviousChatMessage(command)) {
    try {
      const intent = await classifyIntent(command, context);

      if (intent && meetsExecutionThreshold(intent)) {
        console.log(`[aiRouter] Intent intercepted: ${intent.type} (${intent.confidence})`);
        return {
          type:   'action_pending',
          intent,
        };
      }
    } catch (intentErr) {
      // Intent classification failure is non-fatal — fall through to chat
      console.warn('[aiRouter] Intent classification error (falling through to chat):', intentErr);
    }
  }

  // ── Existing LLM routing continues below (unchanged) ─────────

*/

// ────────────────────────────────────────────────────────────
// STEP 4: Add this IPC handler to electron/main.ts
//         (alongside your existing ipcMain handlers)
// ────────────────────────────────────────────────────────────

/*

  // ── Phase 3: Handle action_pending response from renderer ──────────────────
  //
  // When the renderer receives { type: 'action_pending', intent }, it shows
  // the ConfirmationModal. If the user clicks Confirm, it sends this event.
  // If the user clicks Cancel, it sends 'eye:action-cancel'.

  ipcMain.handle('eye:action-confirm', async (_event, intent: Intent) => {
    try {
      // Phase 3.2 will replace this stub with the real ActionExecutor
      const result = await executeIntent(intent);   // ← stub for now
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('eye:action-cancel', async (_event, intent: Intent) => {
    console.log(`[main] User cancelled action: ${intent.type}`);
    return { cancelled: true };
  });

  // ── STUB: replace with real ActionExecutor in Phase 3.2 ────────────────────
  async function executeIntent(intent: Intent) {
    console.log('[main] [STUB] Would execute intent:', intent.type, intent.parameters);
    return { message: `[STUB] ${intent.type} not yet implemented. Coming in Phase 3.2.` };
  }

*/

// ────────────────────────────────────────────────────────────
// STEP 5: Update App.tsx / your command result handler
// ────────────────────────────────────────────────────────────
//
// Your existing result handler probably does something like:
//   const result = await window.electron.handleCommand(command);
//   setResponse(result);   // shows text in the overlay
//
// Update it to branch on the response type:

/*

  const result = await window.electron.handleCommand(command, activeWindowContext);

  if (result.type === 'action_pending') {
    // ← Phase 3.3 will replace this with the real ConfirmationModal
    // For now: log the pending intent and show a placeholder
    console.log('[App] Action pending:', result.intent);
    setPendingIntent(result.intent);    // new state variable
    setShowConfirmModal(true);          // new state variable
  } else {
    // Normal chat response — existing rendering logic unchanged
    setResponse(result.content);
  }

*/

// ────────────────────────────────────────────────────────────
// STEP 6: Add these two new state variables to App.tsx
// ────────────────────────────────────────────────────────────

/*

  // Phase 3 state (add alongside existing useState declarations)
  const [pendingIntent,    setPendingIntent]    = useState<Intent | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const handleConfirm = async () => {
    if (!pendingIntent) return;
    const result = await window.electron.confirmAction(pendingIntent);
    setShowConfirmModal(false);
    setPendingIntent(null);
    // Show success/error toast
    setResponse(result.success ? result.result.message : `Error: ${result.error}`);
  };

  const handleCancel = async () => {
    if (!pendingIntent) return;
    await window.electron.cancelAction(pendingIntent);
    setShowConfirmModal(false);
    setPendingIntent(null);
  };

*/

// ────────────────────────────────────────────────────────────
// STEP 7: Add these new preload.ts / contextBridge exposures
// ────────────────────────────────────────────────────────────

/*

  // In electron/preload.ts, add alongside existing contextBridge.exposeInMainWorld:
  confirmAction: (intent: Intent) =>
    ipcRenderer.invoke('eye:action-confirm', intent),
  cancelAction: (intent: Intent) =>
    ipcRenderer.invoke('eye:action-cancel', intent),

*/

// ════════════════════════════════════════════════════════════
// PHASE 3.1 COMPLETION CHECKLIST
// ════════════════════════════════════════════════════════════
//
//  [ ] intentTypes.ts created in src/engine/
//  [ ] intentEngine.ts created in src/engine/
//  [ ] Imports added to aiRouter.ts
//  [ ] Intent intercept block inserted in handleCommand()
//  [ ] IPC handlers added to main.ts
//  [ ] App.tsx updated with pendingIntent state + branching
//  [ ] preload.ts updated with confirmAction / cancelAction
//  [ ] callGeminiFlash() in gemini.ts accepts (systemPrompt, userText, options)
//      — if your current signature differs, adapt the call in intentEngine.ts
//
// Once all boxes are checked, test with:
//   "save this to my desktop"    → should trigger ConfirmationModal
//   "what is the weather today?" → should go to LLM chat as normal
//
// ════════════════════════════════════════════════════════════

export {};  // make this a module (TypeScript)
