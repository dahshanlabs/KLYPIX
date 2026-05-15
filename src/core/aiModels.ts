export type ModelStatus = "active" | "coming_soon";

export interface AIModel {
    id: string;
    name: string;
    provider: "google" | "anthropic" | "openai" | "mistral";
    status: ModelStatus;
}

export const AVAILABLE_MODELS: AIModel[] = [
    {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        provider: "google",
        status: "active"
    },
    {
        id: "claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
        provider: "anthropic",
        status: "coming_soon"
    },
    {
        id: "chatgpt-4o",
        name: "ChatGPT-4o",
        provider: "openai",
        status: "coming_soon"
    },
    {
        id: "gpt-4.1",
        name: "GPT-4.1",
        provider: "openai",
        status: "coming_soon"
    },
    {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        provider: "google",
        status: "coming_soon"
    },
    {
        id: "mistral-large",
        name: "Mistral Large",
        provider: "mistral",
        status: "coming_soon"
    },
];
