import fs from "node:fs";
import dotenv from "dotenv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTIONS, type EvalQuestion } from "../evaluation/questions.js";
import { numbersIn } from "../src/app/ai/guard.js";
import { env } from "../src/app/config/env.config.js";
import { prisma } from "../src/lib/prisma.js";
import { chat, callTool, fakeModel, lastToolResult, say, uploadReadableDocument, useFakeModel } from "./helpers/ai.js";
import { LEASE_TEXT, seedEvalBooks } from "./helpers/eval-books.js";

const LIVE = Boolean(process.env.AI_EVAL_LIVE);
// The whole set uses most of a day's free quota, so a live run samples it unless told otherwise.
const LIVE_LIMIT = Number(process.env.AI_EVAL_LIMIT ?? 12);
// Groq's free plan allows 8,000 tokens a minute, so a live run spaces its questions out.
const LIVE_PAUSE_MS = Number(process.env.AI_EVAL_PAUSE_MS ?? 15_000);

if (LIVE) {
  // .env.test has no key on purpose. A live run borrows only the AI settings from your own .env.
  const parsed = dotenv.parse(fs.existsSync(".env") ? fs.readFileSync(".env") : "");
  if (parsed.AI_API_KEY) env.AI_API_KEY = parsed.AI_API_KEY;
  if (parsed.AI_BASE_URL) env.AI_BASE_URL = parsed.AI_BASE_URL;
  if (parsed.AI_CHAT_MODEL) env.AI_CHAT_MODEL = parsed.AI_CHAT_MODEL;
}

// Compares figures whatever digits or separators they were written in.
const answerHas = (answer: string, expected: string) => {
  if (!/\d/.test(expected)) return answer.toLowerCase().includes(expected.toLowerCase());
  const wanted = numbersIn(expected);
  const found = new Set(numbersIn(answer));
  return wanted.every((number) => found.has(number));
};

let books: Awaited<ReturnType<typeof seedEvalBooks>>;

const seed = async () => {
  books = await seedEvalBooks();
  const document = await uploadReadableDocument(books.f, LEASE_TEXT);
  expect(document.ingestStatus).toBe("READY");
};

// The scripted run proves everything except the model's own choices: that each question's correct tool
// gives the correct figure, and that the checks around the model hold.
const scriptFor = (question: EvalQuestion) => {
  if (!question.tool) return;
  fakeModel.replies.push(callTool(question.tool, question.args!(books.ids)));
  fakeModel.replies.push((messages) => {
    const result = lastToolResult(messages);
    return say(result.error ? "I don't have access to that." : JSON.stringify(result));
  });
};

if (!LIVE) {
  describe("the evaluation set, with a scripted model", () => {
    // tests/setup.ts empties the database before each test, so each one gets its own books.
    beforeEach(async () => {
      vi.restoreAllMocks();
      useFakeModel();
      await seed();
    }, 60_000);

    it("has at least 50 questions, in both languages, each with what it needs", () => {
      expect(QUESTIONS.length).toBeGreaterThanOrEqual(50);
      expect(QUESTIONS.filter((question) => question.language === "bn").length).toBeGreaterThanOrEqual(15);
      expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(QUESTIONS.length);
      for (const question of QUESTIONS) {
        if (question.tool) expect(question.args, question.id).toBeTypeOf("function");
        if (!question.outcome || question.outcome === "PROPOSAL") expect(question.expects?.length, question.id).toBeGreaterThan(0);
      }
    });

    for (const question of QUESTIONS) {
      it(`${question.id}: ${question.question}`, async () => {
        scriptFor(question);
        const res = await chat(books.f.auth, question.question, { businessId: books.ids.businessId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data.language).toBe(question.language);

        if (question.outcome === "BLOCKED") {
          expect(res.body.data.guardStatus).toBe("blocked");
          expect(fakeModel.calls).toHaveLength(0);
          return;
        }
        if (question.outcome === "NO_ACCESS") {
          expect(lastToolResult(fakeModel.calls.at(-1)!.messages)).toEqual({ error: "NO_ACCESS" });
          return;
        }
        expect(res.body.data.guardStatus).toBe("ok");
        for (const expected of question.expects ?? []) expect(answerHas(res.body.data.content, expected), `${expected} in ${res.body.data.content}`).toBe(true);
        if (question.outcome === "PROPOSAL") {
          expect(res.body.data.proposals).toHaveLength(1);
          expect(res.body.data.proposals[0].status).toBe("PENDING");
        }
      });
    }
  });
} else {
  describe("the evaluation set, with the real model", () => {
    it("scores the real model and saves a report", async () => {
      if (!env.AI_API_KEY) throw new Error("Add AI_API_KEY to your .env first");
      await seed();

      // An even spread: both languages and every kind of question.
      const step = Math.max(1, Math.floor(QUESTIONS.length / LIVE_LIMIT));
      const sample = QUESTIONS.filter((_question, index) => index % step === 0).slice(0, LIVE_LIMIT);
      const results = [];

      for (const question of sample) {
        const res = await chat(books.f.auth, question.question);
        if (res.status !== 200) {
          results.push({ id: question.id, question: question.question, passed: false, reason: `HTTP ${res.status} ${res.body.error?.code}` });
          continue;
        }
        const message = await prisma.aiMessage.findUniqueOrThrow({ where: { id: res.body.data.messageId }, include: { toolCalls: true } });
        const tools = message.toolCalls.map((call) => call.tool);
        const data = res.body.data;

        const problems: string[] = [];
        if (data.language !== question.language) problems.push(`language ${data.language}`);
        if (question.outcome === "BLOCKED" && data.guardStatus !== "blocked") problems.push("not blocked");
        if (question.tool && question.outcome !== "NO_ACCESS" && !tools.includes(question.tool)) problems.push(`used ${tools.join(",") || "no tool"}`);
        if (data.guardStatus === "fallback") problems.push("failed the number check twice");
        for (const expected of question.expects ?? []) if (!answerHas(data.content, expected)) problems.push(`missing ${expected}`);
        if (question.outcome === "PROPOSAL" && data.proposals.length !== 1) problems.push("no proposal");

        results.push({ id: question.id, language: question.language, question: question.question, passed: problems.length === 0, problems, tools, guard: data.guardStatus, answer: data.content, tokens: data.usage });
        await new Promise((resolve) => setTimeout(resolve, LIVE_PAUSE_MS));
      }

      const passed = results.filter((result) => result.passed).length;
      const report = { model: env.AI_CHAT_MODEL, ranAt: new Date().toISOString(), passed, total: results.length, results };
      fs.writeFileSync("evaluation/last-report.json", JSON.stringify(report, null, 2));
      process.stdout.write(`\nAI evaluation: ${passed} of ${results.length} passed. Details are in evaluation/last-report.json\n\n`);
      for (const result of results) process.stdout.write(`${result.passed ? "PASS" : "FAIL"}  ${result.id}  ${result.passed ? "" : JSON.stringify(result.problems ?? result.reason)}\n`);
      expect(results.length).toBeGreaterThan(0);
    });
  });
}
