import { env } from "../config/env.config.js";

// The only place that knows which AI company is in use. Anything with an OpenAI-style API fits, so
// changing company means changing three settings.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult>;
}

export type ProviderFailure = "NOT_CONFIGURED" | "BUSY" | "FAILED";

export class ProviderError extends Error {
  constructor(
    public readonly failure: ProviderFailure,
    public readonly retryAfterSeconds?: number,
  ) {
    super(failure);
    this.name = "ProviderError";
  }
}

const TIMEOUT_MS = 60_000;

const toWire = (message: ChatMessage) => ({
  role: message.role,
  content: message.content,
  ...(message.toolCalls?.length
    ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
    : {}),
  ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
});

interface WireResponse {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// A free plan's per-minute limit often clears within seconds, and a short wait beats an error. A longer
// one, such as the day's limit being used up, is reported straight away instead of holding the request.
const MAX_WAIT_SECONDS = 30;
const MAX_ATTEMPTS = 3;

const send = async (requestBody: string): Promise<Response> => {
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AI_API_KEY}` },
        body: requestBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError("FAILED");
    }
    if (response.status !== 429) return response;

    const retryAfter = Number(response.headers.get("retry-after")) || undefined;
    if (attempt >= MAX_ATTEMPTS || retryAfter === undefined || retryAfter > MAX_WAIT_SECONDS) throw new ProviderError("BUSY", retryAfter);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
};

const openAiCompatible: ChatProvider = {
  chat: async (messages, tools) => {
    if (!env.AI_API_KEY) throw new ProviderError("NOT_CONFIGURED");

    const response = await send(
      JSON.stringify({
        model: env.AI_CHAT_MODEL,
        temperature: 0,
        messages: messages.map(toWire),
        ...(tools.length > 0
          ? { tools: tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })), tool_choice: "auto" }
          : {}),
      }),
    );
    if (!response.ok) throw new ProviderError(response.status === 401 || response.status === 403 ? "NOT_CONFIGURED" : "FAILED");

    const body = (await response.json()) as WireResponse;
    const message = body.choices?.[0]?.message;
    if (!message) throw new ProviderError("FAILED");

    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      model: body.model ?? env.AI_CHAT_MODEL,
    };
  },
};

export const chatProvider = openAiCompatible;
export const aiConfigured = () => Boolean(env.AI_API_KEY);
