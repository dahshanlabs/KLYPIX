# ⚠️ SUPERSEDED — see CLAUDE.md

# Agent Mode: Action-Oriented Suggestion Patterns (Future Use)

This document preserves the "Action-Oriented" language patterns for ALT+Space's future Agent Mode. When implemented, these patterns will trigger autonomous system actions rather than just chat responses.

## Action Categories

### 1. File & Document Management
- **Open [Document Name]**: Directly launch a specific file or URL.
- **Close [App Name]**: Terminate a specific process or close a redundant window.
- **Export to [Format]**: Convert current data (e.g., "Export selection to Excel").
- **Rename [File]**: Batch rename files based on discovered context.

### 2. Workspace Optimization
- **Split Screen**: Arrange specific windows side-by-side for comparison.
- **Focus Mode**: Minimize all non-primary application windows.
- **Group Tabs**: Categorize browser tabs into functional groups.

### 3. Content Modification
- **Edit [Section]**: Directly modify text in a Word/Markdown document.
- **Insert [Data]**: Paste extracted context into an active field or sheet.
- **Clear Metadata**: Remove sensitive info from a document before sharing.

## Prompting Strategy (for future implementation)
When switching to Agent Mode, the `gemini.ts` instructions should be updated from:
*"Suggest actions the user would want to run on this content"*
to:
*"Suggest executable system commands or macro sequences that achieve the user's likely goal."*

## Example Action Output
```json
[
  "Open project_roadmap.pdf",
  "Close all background Chrome tabs except 'Jira'",
  "Extract this pricing table to 'competitors.xlsx'",
  "Group these 5 tabs into 'Research'",
  "Add 'Review Required' tag to this document"
]
```
