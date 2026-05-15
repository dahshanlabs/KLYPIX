import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = "AIzaSyD4ETYT7RkSLt_sE_U6ltBz0a2CdFFx5pg";
const genAI = new GoogleGenerativeAI(API_KEY);

async function listModels() {
    try {
        console.log("Listing available models...");
        // Use the default v1 API for listing
        const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${API_KEY}`);
        const data = await response.json();

        if (data.models) {
            data.models.forEach((m: any) => {
                console.log(`- ${m.name} (${m.supportedGenerationMethods.join(", ")})`);
            });
        } else {
            console.log("No models found or error:", data);
        }
    } catch (error: any) {
        console.error("List Error:", error.message);
    }
}

listModels();
