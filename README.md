<div align="center">
  <img src="public/logo.png" alt="ALT+Space Logo" width="128" height="128">

  # ALT+Space
  **AI Frictionless Layer & Helper for Windows**
</div>

ALT+Space is a lightning-fast, transparent, and context-aware AI assistant designed to live alongside your workflow. Trigger it instantly from anywhere on Windows, and let it see what's on your screen or strictly focus on your active document to provide rapid insights, risk analysis, task breakdowns, or completely custom answers using the latest AI models.

## 🚀 Key Features

* **Instant Global Hotkey Activation**
  Summon the assistant by pressing `Alt+Space` (or any custom shortcut) while in any application. The UI gracefully overlays onto your active screen.

* **Context-Aware Screensight**
  Quickly take a partial snip or full screenshot of your current monitor and ask questions about the exact visual context you're analyzing.

* **Deep File Reading Mode**
  Enable "Deep File Mode" allowing the AI to automatically look at the exact document, PDF, Excel sheet, or browser tab you currently have focused, grabbing the text payload securely and bringing it into your conversation.

* **Multi-Document Analysis**
  Click the "Add Files" icon to scan your currently opened documents across your OS and check multiple of them to run a comparative analysis or combine contexts.

* **One-Click Expert Workflows**
  Built-in AI modes for common, high-value tasks:
  * ⚖️ **Decision Briefs**: Rapid risk analysis and choices.
  * 🔍 **Extract Info**: Pull structured data, entities, and metrics.
  * ✅ **Action Items**: Turn meeting notes or emails into a clean to-do list.
  * 🔄 **Rewrite**: Polish, shorten, or clarify text.
  * 📈 **Trading/Market Insight**: Market structure and indicator breakdown.
  
* **Local Conversation Memory & Pinning**
  Conversations persist locally. Pin important conversations so you can instantly switch back to an ongoing research thread. 

## 🛠 Tech Stack

* **Frontend**: React 19, Vite, TailwindCSS, Lucide Icons, Markdown parsing.
* **Backend Shell**: Electron 33 (Node.js backend IPC), `screenshot-desktop`, UIAutomation API / PowerShell integration for advanced window scraping.
* **AI Engine**: Google Generative AI (`@google/generative-ai`) dynamically targeting models like `gemini-2.5-flash`.

## 📦 Installation & Setup

### Development
1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the `.env.example` to `.env` and configure your API keys (e.g., `VITE_GEMINI_API_KEY=AIzaSy...`).
4. Run the development environment:
   ```bash
   npm run dev
   ```

### Building for Production
To package the app into a full Windows Installer (`.exe`):
```bash
npm run build
```
This will compile the Vite frontend, run the TypeScript compiler for the Electron backend, and then use `electron-builder` to generate a professional NSIS installer inside the `release/` folder.

## ⚙️ Configuration

Inside the app settings (cog icon), you can:
- **Set a Custom Hotkey** to replace `Alt+Space` if it conflicts with another app.
- **Provide API Keys** directly in the UI if not set in `.env`.
- **Select Models** to use different tiers like `gemini-1.5-pro` (if enabled in your tier list).
- **Toggle Voice Features** like Dictation or Text-to-Speech replies.

## 🛡 Privacy Note
All conversation history and settings are stored locally on your machine via standard Electron local storage mechanisms. Screenshots are taken on-device and strictly securely proxied to the AI provider specifically for analysis when requested.
