import OpenAI from "openai";

import { DEFAULT_EMBEDDING_MODEL } from "@/llm/config.js";

// Embeddings are not supported by the Bankr LLM Gateway — use OpenAI directly.
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for embeddings");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function embedText(text: string): Promise<number[] | null> {
  try {
    const response = await getClient().embeddings.create({
      model: DEFAULT_EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    });
    return response.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn("⚠️ embedText failed:", err);
    return null;
  }
}
