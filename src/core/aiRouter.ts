import { askGeminiStreaming } from "../api/gemini";
import { AIModel, AVAILABLE_MODELS } from "./aiModels";

// Placeholder API Structures (no user input)
const GEMINI_API_KEY = "";
const OPENAI_API_KEY = "";
const ANTHROPIC_API_KEY = "";
const MISTRAL_API_KEY = "";

// Hybrid Router: In chat mode, most queries go to Gemini Flash.
// Future: complex queries could route to Claude for better answers.
// Currently this just logs classification for telemetry — all chat goes to Flash.
// Agent mode routing is handled separately in ClaudeAgent.

export async function routeToModel(prompt: string, imageBase64?: string | string[] | null, history: { role: string, content: string }[] = [], modelId: string = "gemini-2.5-flash", activeWindowContext?: { title: string, process: string }, isPrivacyMode: boolean = false, sessionContextSummary?: string) {
    const model = AVAILABLE_MODELS.find(m => m.id === modelId) || AVAILABLE_MODELS[0];

    if (model.status === "coming_soon") {
        // Return a mock stream for models that are 'coming_soon'
        const mockStream = async function* () {
            const message = `[System Notice]: The model **${model.name}** is currently integrated but pending API unlock. \n\nThis will be available in the upcoming update.`;
            const chunks = message.split(' ');
            for (const chunk of chunks) {
                yield { text: () => chunk + ' ' };
                await new Promise(r => setTimeout(r, 50));
            }
        };

        return { stream: mockStream() };
    }

    // Default to Gemini Flash for chat mode (cheap, fast, good for most queries)
    // The Hybrid Router in agent mode handles Flash↔Claude routing per-turn
    return askGeminiStreaming(prompt, imageBase64, history, activeWindowContext, isPrivacyMode, sessionContextSummary);
}
