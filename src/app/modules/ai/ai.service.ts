import { prisma } from "../../../lib/prisma.js";
import { withBusinessScope, withRls } from "../../../lib/rls.js";
import { ask } from "../../ai/orchestrator.js";
import { aiConfigured, ProviderError } from "../../ai/provider.js";
import { env } from "../../config/env.config.js";
import { Permission } from "../../constants/permissions.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import { pageArgs, toPage } from "../../utils/pagination.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import { billingService } from "../billing/billing.service.js";
import { platformService } from "../platform/platform.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import { membersService } from "../members/members.service.js";
import { tasksService } from "../tasks/tasks.service.js";
import { transactionsService } from "../transactions/transactions.service.js";
import { usersService } from "../users/users.service.js";
import type { IChatBody, IConfirmBody, IListQuery, IProposalsQuery } from "./ai.interface.js";

// Earlier messages, so "and last month?" makes sense. Figures in them still have to come from a tool again.
const HISTORY_MESSAGES = 6;
const TITLE_LENGTH = 80;
const MAX_ANSWER_CHARS = 20_000;

const ownScope = (auth: AuthContext) => ({ userId: auth.userId, workspaceId: auth.workspaceId, businessIds: [] });

const startOfTodayUtc = () => new Date(new Date().toISOString().slice(0, 10));

const tokensUsedToday = async (workspaceId: string) => {
  const { _sum } = await prisma.aiMessage.aggregate({
    where: { workspaceId, createdAt: { gte: startOfTodayUtc() } },
    _sum: { promptTokens: true, completionTokens: true },
  });
  return (_sum.promptTokens ?? 0) + (_sum.completionTokens ?? 0);
};

// The plans of the workspaces these businesses belong to, and the day's limit: the most generous of
// those that include the assistant.
const aiAllowance = async (workspaceIds: string[]) => {
  const plans = await billingService.aiPlans(workspaceIds);
  const allowed = new Set([...plans].filter(([, plan]) => plan.aiEnabled).map(([workspaceId]) => workspaceId));
  // AI_DAILY_TOKEN_LIMIT stays as the server's own ceiling, whatever a plan says.
  const fromPlans = Math.max(0, ...[...plans.values()].filter((plan) => plan.aiEnabled).map((plan) => plan.aiDailyTokens));
  const limit = Math.min(fromPlans, env.AI_DAILY_TOKEN_LIMIT);
  return { allowed, limit };
};

const status = async (auth: AuthContext) => {
  const [used, businesses] = await Promise.all([
    tokensUsedToday(auth.workspaceId),
    membersService.listBusinessesWithPermission(auth.userId, Permission.AI_USE, false),
  ]);
  const workspaces = await prisma.business.findMany({ where: { id: { in: businesses.map((business) => business.id) } }, select: { workspaceId: true } });
  const [{ allowed, limit }, { aiEnabled }] = await Promise.all([aiAllowance(workspaces.map((business) => business.workspaceId)), platformService.settings()]);
  return {
    configured: aiConfigured(),
    // Switched off for everyone by the platform admin, for now.
    paused: !aiEnabled,
    model: aiConfigured() ? env.AI_CHAT_MODEL : null,
    // False when none of the person's businesses is on a plan with the assistant.
    planAllowsAi: allowed.size > 0,
    tokensUsedToday: used,
    dailyTokenLimit: limit,
  };
};

// Which businesses this person may ask about, worked out by the server. The client can only narrow it.
const resolveBusinesses = async (auth: AuthContext, businessId: string | undefined) => {
  const allowed = await membersService.listBusinessesWithPermission(auth.userId, Permission.AI_USE, false);
  const chosen = businessId ? allowed.filter((business) => business.id === businessId) : allowed;
  if (businessId && chosen.length === 0) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (chosen.length === 0) throw new AppError(403, ErrorCode.AI_NO_BUSINESS_ACCESS);

  const contexts = await Promise.all(chosen.map((business) => membersService.resolveContext(auth.userId, business.id)));
  const found = chosen.flatMap((business, index) => {
    const context = contexts[index];
    return context ? [{ business: context, name: business.name }] : [];
  });

  // Only businesses whose plan includes the assistant. Asked about one that doesn't, say so.
  const allowance = await aiAllowance(found.map(({ business }) => business.workspaceId));
  const onPlan = found.filter(({ business }) => allowance.allowed.has(business.workspaceId));
  if (onPlan.length === 0) throw new AppError(403, ErrorCode.PLAN_FEATURE_REQUIRED, { feature: "ai" });
  return { businesses: onPlan, dailyTokenLimit: allowance.limit };
};

const toAppError = (error: unknown) => {
  if (!(error instanceof ProviderError)) return error;
  if (error.failure === "NOT_CONFIGURED") return new AppError(503, ErrorCode.AI_NOT_CONFIGURED);
  if (error.failure === "BUSY") return new AppError(503, ErrorCode.AI_PROVIDER_BUSY, { retryAfterSeconds: error.retryAfterSeconds ?? 60 });
  return new AppError(502, ErrorCode.AI_PROVIDER_FAILED);
};

const chat = async (auth: AuthContext, body: IChatBody) => {
  if (!aiConfigured()) throw new AppError(503, ErrorCode.AI_NOT_CONFIGURED);
  if (!(await platformService.settings()).aiEnabled) throw new AppError(503, ErrorCode.AI_PAUSED);

  const { businesses, dailyTokenLimit } = await resolveBusinesses(auth, body.businessId);
  const used = await tokensUsedToday(auth.workspaceId);
  if (used >= dailyTokenLimit) {
    throw new AppError(429, ErrorCode.AI_BUDGET_EXCEEDED, { used, limit: dailyTokenLimit });
  }

  const user = await usersService.getMe(auth.userId);

  const { conversation, history } = await withRls(ownScope(auth), async (tx) => {
    const found = body.conversationId
      ? await tx.aiConversation.findFirst({ where: { id: body.conversationId, userId: auth.userId } })
      : await tx.aiConversation.create({ data: { workspaceId: auth.workspaceId, userId: auth.userId, title: body.message.slice(0, TITLE_LENGTH) } });
    if (!found) throw new AppError(404, ErrorCode.NOT_FOUND);

    const recent = await tx.aiMessage.findMany({
      where: { conversationId: found.id },
      orderBy: { id: "desc" },
      take: HISTORY_MESSAGES,
      select: { role: true, content: true },
    });
    return { conversation: found, history: recent.reverse() };
  });

  const firstBusiness = await prisma.business.findUnique({ where: { id: businesses[0]!.business.businessId }, select: { settings: true } });
  const settings = firstBusiness?.settings as { numberGrouping?: "lakh" | "western" } | undefined;
  const started = Date.now();
  let answer: Awaited<ReturnType<typeof ask>>;
  try {
    answer = await ask({
      question: body.message,
      history,
      businesses,
      context: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        businesses: businesses.map(({ business }) => business),
        digitStyle: user.digitStyle as "latin" | "bangla",
        grouping: settings?.numberGrouping ?? "lakh",
        conversationId: conversation.id,
      },
    });
  } catch (error) {
    throw toAppError(error);
  }
  const latencyMs = Date.now() - started;

  const assistantMessage = await withRls(ownScope(auth), async (tx) => {
    const owner = { conversationId: conversation.id, workspaceId: auth.workspaceId, userId: auth.userId };
    await tx.aiMessage.create({ data: { ...owner, role: "USER", content: body.message, language: answer.language } });
    const saved = await tx.aiMessage.create({
      data: {
        ...owner,
        role: "ASSISTANT",
        content: answer.content.slice(0, MAX_ANSWER_CHARS),
        language: answer.language,
        sources: JSON.parse(JSON.stringify(answer.sources)),
        guardStatus: answer.guardStatus,
        model: answer.model,
        promptTokens: answer.promptTokens,
        completionTokens: answer.completionTokens,
        latencyMs,
      },
    });
    if (answer.toolCalls.length > 0) {
      await tx.aiToolCall.createMany({
        data: answer.toolCalls.map((call) => ({
          messageId: saved.id,
          userId: auth.userId,
          tool: call.tool,
          input: JSON.parse(JSON.stringify(call.input ?? {})),
          rowCount: call.rowCount,
          latencyMs: call.latencyMs,
          errorCode: call.errorCode,
        })),
      });
    }
    return saved;
  });

  const proposals = answer.proposalIds.length
    ? await withRls(ownScope(auth), (tx) => tx.aiProposal.findMany({ where: { id: { in: answer.proposalIds } }, select: proposalFields }))
    : [];

  return {
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    content: answer.content,
    language: answer.language,
    guardStatus: answer.guardStatus,
    sources: answer.sources,
    proposals,
    usage: { promptTokens: answer.promptTokens, completionTokens: answer.completionTokens },
  };
};

const listConversations = async (auth: AuthContext, query: IListQuery) => {
  const rows = await withRls(ownScope(auth), (tx) =>
    tx.aiConversation.findMany({
      where: { userId: auth.userId },
      orderBy: { id: "desc" },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const getConversation = (auth: AuthContext, conversationId: string) =>
  withRls(ownScope(auth), async (tx) => {
    const conversation = await tx.aiConversation.findFirst({
      where: { id: conversationId, userId: auth.userId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        messages: {
          orderBy: { id: "asc" },
          select: { id: true, role: true, content: true, language: true, sources: true, guardStatus: true, createdAt: true },
        },
      },
    });
    if (!conversation) throw new AppError(404, ErrorCode.NOT_FOUND);
    return conversation;
  });

const proposalFields = {
  id: true,
  businessId: true,
  conversationId: true,
  kind: true,
  payload: true,
  status: true,
  resultId: true,
  expiresAt: true,
  decidedAt: true,
  createdAt: true,
} as const;

const listProposals = async (auth: AuthContext, query: IProposalsQuery) => {
  const rows = await withRls(ownScope(auth), (tx) =>
    tx.aiProposal.findMany({
      where: { userId: auth.userId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { id: "desc" },
      select: proposalFields,
      ...pageArgs(query),
    }),
  );
  return toPage(rows, query.limit);
};

const ACTIVE_PERMISSION = { TRANSACTION: Permission.FINANCE_WRITE, TASK: Permission.TASKS_WRITE } as const;

// The person's decision, not the model's. It runs through the normal service with its usual checks,
// using what the person may do now, and the audit log records it came through the AI.
const confirmProposal = async (auth: AuthContext, proposalId: string, body: IConfirmBody, context: RequestContext) => {
  const found = await withRls(ownScope(auth), (tx) => tx.aiProposal.findFirst({ where: { id: proposalId, userId: auth.userId }, select: { businessId: true, kind: true } }));
  if (!found) throw new AppError(404, ErrorCode.NOT_FOUND);

  const business = await membersService.resolveContext(auth.userId, found.businessId);
  if (!business) throw new AppError(404, ErrorCode.NOT_FOUND);
  if (business.businessStatus !== "ACTIVE") throw new AppError(409, ErrorCode.BUSINESS_NOT_ACTIVE, { status: business.businessStatus });
  if (business.planLocked) throw new AppError(403, ErrorCode.PLAN_BUSINESS_LOCKED);
  if (!business.permissions.includes(ACTIVE_PERMISSION[found.kind])) {
    throw new AppError(403, ErrorCode.PERMISSION_DENIED, { permission: ACTIVE_PERMISSION[found.kind] });
  }

  const viaAi: RequestContext = { ...context, actorVia: "ai" };

  return withBusinessScope(business, async (tx) => {
    // The lock means two clicks can't create two transactions.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM ai_proposals WHERE id = ${proposalId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError(404, ErrorCode.NOT_FOUND);

    const proposal = await tx.aiProposal.findUniqueOrThrow({ where: { id: proposalId } });
    if (proposal.status !== "PENDING") throw new AppError(409, ErrorCode.AI_PROPOSAL_NOT_PENDING, { status: proposal.status });
    if (proposal.expiresAt < new Date()) {
      await tx.aiProposal.update({ where: { id: proposalId }, data: { status: "EXPIRED", decidedAt: new Date() } });
      throw new AppError(409, ErrorCode.AI_PROPOSAL_NOT_PENDING, { status: "EXPIRED" });
    }

    const payload = proposal.payload as Record<string, string>;
    let resultId: string;
    if (proposal.kind === "TRANSACTION") {
      const transaction = await transactionsService.createWithin(
        tx,
        business,
        {
          type: payload.type as "INCOME" | "EXPENSE",
          accountId: payload.accountId!,
          categoryId: payload.categoryId!,
          amountMinor: payload.amountMinor!,
          feeMinor: "0",
          txnDate: payload.txnDate!,
          ...(payload.description ? { description: payload.description } : {}),
          postNow: body.postNow,
        },
        viaAi,
        { source: "AI", providerTxnId: `ai:${proposalId}` },
      );
      resultId = transaction.id;
    } else {
      const task = await tasksService.createWithin(
        tx,
        business,
        {
          title: payload.title!,
          priority: (payload.priority ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.dueAt ? { dueAt: payload.dueAt } : {}),
        },
        viaAi,
      );
      resultId = task.id;
    }

    const confirmed = await tx.aiProposal.update({
      where: { id: proposalId },
      data: { status: "CONFIRMED", decidedAt: new Date(), resultId },
      select: proposalFields,
    });
    await auditService.recordForBusiness(tx, business, {
      action: "ai.proposal_confirmed",
      context: viaAi,
      entityType: proposal.kind === "TRANSACTION" ? "transaction" : "task",
      entityId: resultId,
      after: { proposalId, kind: proposal.kind, postNow: body.postNow },
    });
    return confirmed;
  });
};

const rejectProposal = (auth: AuthContext, proposalId: string) =>
  withRls(ownScope(auth), async (tx) => {
    const { count } = await tx.aiProposal.updateMany({
      where: { id: proposalId, userId: auth.userId, status: "PENDING" },
      data: { status: "REJECTED", decidedAt: new Date() },
    });
    if (count === 0) throw new AppError(409, ErrorCode.AI_PROPOSAL_NOT_PENDING);
    return { rejected: true };
  });

export const aiService = { status, chat, listConversations, getConversation, listProposals, confirmProposal, rejectProposal };
