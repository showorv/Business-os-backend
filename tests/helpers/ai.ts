import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { env } from "../../src/app/config/env.config.js";
import { prisma } from "../../src/lib/prisma.js";
import { chatProvider, type ChatMessage, type ChatResult, type ToolDefinition } from "../../src/app/ai/provider.js";
import { api, PNG_BYTES, putFile, runPendingEvents, type FinanceSetup } from "./api.js";
import { ocrResult } from "./fake-ocr.js";

type Reply = Partial<ChatResult> | ((messages: ChatMessage[], tools: ToolDefinition[]) => Partial<ChatResult>);

// A stand-in for the AI company: replies are scripted, and every call is recorded.
export const fakeModel = {
  replies: [] as Reply[],
  calls: [] as { messages: ChatMessage[]; tools: ToolDefinition[] }[],
  chat: async (messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> => {
    fakeModel.calls.push({ messages: [...messages], tools });
    const next = fakeModel.replies.shift();
    if (!next) throw new Error("the fake model ran out of scripted replies");
    const reply = typeof next === "function" ? next(messages, tools) : next;
    return { content: null, toolCalls: [], promptTokens: 100, completionTokens: 20, model: "fake-model", ...reply };
  },
  reset: () => {
    fakeModel.replies = [];
    fakeModel.calls = [];
  },
};

// Puts the stand-in in place of the AI company. Call it before each test.
export const useFakeModel = () => {
  fakeModel.reset();
  env.AI_API_KEY = "test-key";
  return vi.spyOn(chatProvider, "chat").mockImplementation((messages, tools) => fakeModel.chat(messages, tools));
};

export const callTool = (name: string, args: object): Partial<ChatResult> => ({
  toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
});

export const say = (content: string): Partial<ChatResult> => ({ content });

// The last tool result the model was shown.
export const lastToolResult = (messages: ChatMessage[]) => JSON.parse(messages.filter((message) => message.role === "tool").at(-1)!.content!);

export const chat = (auth: string, message: string, extra: object = {}) => api().post("/api/v1/ai/chat").set("Authorization", auth).send({ message, ...extra });

// Uploads an image the fake OCR "reads" as this text, and processes it as the worker would.
export const uploadReadableDocument = async (f: FinanceSetup, text: string, type = "CONTRACT", fileName = "contract.png") => {
  const created = await api().post(`${f.base}/documents/uploads`).set("Authorization", f.auth).send({ type, fileName, mime: "image/png", sizeBytes: PNG_BYTES.length });
  await putFile(created.body.data.uploadUrl, PNG_BYTES, "image/png");
  const done = await api().post(`${f.base}/documents/${created.body.data.document.id}/complete`).set("Authorization", f.auth);
  ocrResult.text = text;
  await runPendingEvents();
  ocrResult.text = "";
  return prisma.document.findUniqueOrThrow({ where: { id: done.body.data.id } });
};
