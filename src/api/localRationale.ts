export type UserRationale = 
    | "Coding & Development"
    | "Financial Analysis & Trading"
    | "Social & Communication"
    | "Creative Design & Media"
    | "Research & Browsing"
    | "Document Editing"
    | "System Tasks"
    | "Unknown Activity";

/**
 * Detects the user's current rationale/intent based on local process and title analysis.
 * This runs entirely on the user's machine to preserve privacy.
 */
export function getLocalRationale(process: string, title: string): UserRationale {
    const lowProc = process.toLowerCase();
    const lowTitle = title.toLowerCase();

    // 1. Coding & Development
    if (
        lowProc.includes("code") || 
        lowProc.includes("cursor") || 
        lowProc.includes("vs") || 
        lowProc.includes("intellij") ||
        lowProc.includes("webstorm") ||
        lowProc.includes("pycharm") ||
        lowTitle.includes(".js") ||
        lowTitle.includes(".ts") ||
        lowTitle.includes(".py") ||
        lowTitle.includes("localhost") ||
        lowTitle.includes("github") ||
        lowTitle.includes("stackoverflow")
    ) {
        return "Coding & Development";
    }

    // 2. Financial Analysis & Trading
    if (
        lowTitle.includes("tradingview") ||
        lowTitle.includes("binance") ||
        lowTitle.includes("portfolio") ||
        lowTitle.includes("crypto") ||
        lowTitle.includes("stock") ||
        lowTitle.includes("chart") ||
        lowTitle.includes("budget") ||
        lowTitle.includes("finance") ||
        lowProc.includes("tradingview") ||
        (lowProc.includes("excel") && (lowTitle.includes("profit") || lowTitle.includes("loss") || lowTitle.includes("data")))
    ) {
        return "Financial Analysis & Trading";
    }

    // 3. Social & Communication
    if (
        lowProc.includes("slack") ||
        lowProc.includes("discord") ||
        lowProc.includes("teams") ||
        lowProc.includes("whatsapp") ||
        lowProc.includes("telegram") ||
        lowTitle.includes("slack") ||
        lowTitle.includes("discord") ||
        lowTitle.includes("whatsapp") ||
        lowTitle.includes("linkedin")
    ) {
        return "Social & Communication";
    }

    // 4. Creative Design & Media
    if (
        lowProc.includes("photoshop") ||
        lowProc.includes("illustrator") ||
        lowProc.includes("figma") ||
        lowProc.includes("premiere") ||
        lowProc.includes("aftereffects") ||
        lowProc.includes("vlc") ||
        lowProc.includes("spotify") ||
        lowTitle.includes("figma") ||
        lowTitle.includes("design")
    ) {
        return "Creative Design & Media";
    }

    // 5. Document Editing
    if (
        lowProc.includes("winword") ||
        lowProc.includes("excel") ||
        lowProc.includes("powerpnt") ||
        lowProc.includes("notepad") ||
        lowTitle.includes(".docx") ||
        lowTitle.includes(".xlsx") ||
        lowTitle.includes(".pdf")
    ) {
        return "Document Editing";
    }

    // 6. Research & Browsing
    if (
        lowProc.includes("chrome") ||
        lowProc.includes("edge") ||
        lowProc.includes("firefox")
    ) {
        return "Research & Browsing";
    }

    // 7. System Tasks
    if (
        lowProc.includes("explorer") ||
        lowProc.includes("taskmgr") ||
        lowProc.includes("cmd") ||
        lowProc.includes("powershell")
    ) {
        return "System Tasks";
    }

    return "Unknown Activity";
}
