import { prisma } from "../../lib/prisma.js";
import { Permission } from "../constants/permissions.js";
import { membersService } from "../modules/members/members.service.js";
import { NotificationType } from "../modules/notifications/notifications.interface.js";
import { notificationsService } from "../modules/notifications/notifications.service.js";
import { usersService } from "../modules/users/users.service.js";
import type { EventJob } from "./eventTypes.js";

// Each function here turns something that happened into who should hear about it. The event id is in
// each key, so a job delivered twice still notifies once.
const owner = (event: EventJob) => ({ workspaceId: event.workspaceId, businessId: event.businessId });

export const tellTaskAssignee = async (event: EventJob) => {
  const { taskId, assigneeId } = event.payload as { taskId: string; assigneeId: string };
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true } });
  if (!task) return;

  await notificationsService.notify([
    {
      ...owner(event),
      type: NotificationType.TASK_ASSIGNED,
      userId: assigneeId,
      params: { taskId, title: task.title },
      entityType: "task",
      entityId: taskId,
      dedupeKey: `${NotificationType.TASK_ASSIGNED}:${event.eventId}`,
    },
  ]);
};

// Everyone involved in the task, except the person who wrote the comment.
export const tellTaskPeople = async (event: EventJob) => {
  const { taskId } = event.payload as { taskId: string };
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true, assigneeId: true, createdBy: true } });
  if (!task) return;

  const author = await prisma.user.findUnique({ where: { id: event.actorUserId }, select: { name: true } });
  const recipients = new Set([task.assigneeId, task.createdBy].filter((id): id is string => id !== null && id !== event.actorUserId));

  await notificationsService.notify(
    [...recipients].map((userId) => ({
      ...owner(event),
      type: NotificationType.TASK_COMMENTED,
      userId,
      params: { taskId, title: task.title, authorName: author?.name ?? "" },
      entityType: "task",
      entityId: taskId,
      dedupeKey: `${NotificationType.TASK_COMMENTED}:${event.eventId}:${userId}`,
    })),
  );
};

// Everyone who can approve, except whoever submitted it: nobody may approve their own.
export const tellApprovers = async (event: EventJob) => {
  const { transactionId } = event.payload as { transactionId: string };
  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { number: true, amountMinor: true, currency: true },
  });
  if (!transaction) return;

  const approvers = await membersService.listUserIdsWithPermission(event.businessId, Permission.TRANSACTIONS_APPROVE);
  await notificationsService.notify(
    approvers
      .filter((userId) => userId !== event.actorUserId)
      .map((userId) => ({
        ...owner(event),
        type: NotificationType.TRANSACTION_PENDING_APPROVAL,
        userId,
        params: {
          transactionId,
          number: transaction.number,
          amountMinor: transaction.amountMinor.toString(),
          currency: transaction.currency,
        },
        entityType: "transaction",
        entityId: transactionId,
        dedupeKey: `${NotificationType.TRANSACTION_PENDING_APPROVAL}:${event.eventId}:${userId}`,
      })),
  );
};

export const tellAboutBudget = async (event: EventJob) => {
  const { budgetId, budgetLineId, percent } = event.payload as unknown as { budgetId: string; budgetLineId: string; percent: number };
  const line = await prisma.budgetLine.findUnique({
    where: { id: budgetLineId },
    select: {
      amountMinor: true,
      budget: { select: { name: true, business: { select: { baseCurrency: true } } } },
      category: { select: { name: true } },
      alerts: { where: { percent }, select: { actualMinor: true } },
    },
  });
  if (!line) return;

  const readers = await membersService.listUserIdsWithPermission(event.businessId, Permission.FINANCE_READ);
  await notificationsService.notify(
    readers.map((userId) => ({
      ...owner(event),
      type: NotificationType.BUDGET_THRESHOLD,
      userId,
      params: {
        budgetId,
        budgetName: line.budget.name,
        categoryName: line.category.name,
        percent,
        actualMinor: (line.alerts[0]?.actualMinor ?? 0n).toString(),
        amountMinor: line.amountMinor.toString(),
        currency: line.budget.business.baseCurrency,
      },
      entityType: "budget",
      entityId: budgetId,
      dedupeKey: `${NotificationType.BUDGET_THRESHOLD}:${event.eventId}:${userId}`,
    })),
  );
};

export const tellAboutGoal = async (event: EventJob) => {
  const { goalId } = event.payload as { goalId: string };
  const goal = await prisma.goal.findUnique({ where: { id: goalId }, select: { name: true } });
  if (!goal) return;

  const readers = await membersService.listUserIdsWithPermission(event.businessId, Permission.FINANCE_READ);
  await notificationsService.notify(
    readers.map((userId) => ({
      ...owner(event),
      type: NotificationType.GOAL_ACHIEVED,
      userId,
      params: { goalId, goalName: goal.name },
      entityType: "goal",
      entityId: goalId,
      dedupeKey: `${NotificationType.GOAL_ACHIEVED}:${event.eventId}:${userId}`,
    })),
  );
};

export const emailInvitation = async (event: EventJob) => {
  const { invitationId, tokenEncrypted } = event.payload as { invitationId: string; tokenEncrypted: string };
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: { email: true, revokedAt: true, acceptedAt: true, business: { select: { name: true } } },
  });
  // A replaced invitation's link no longer works, so it isn't worth sending.
  if (!invitation || invitation.revokedAt || invitation.acceptedAt) return;

  // Written in the invitee's language if they already have an account, otherwise the inviter's.
  const [invitee, inviter] = await Promise.all([
    usersService.findByEmail(invitation.email),
    prisma.user.findUnique({ where: { id: event.actorUserId }, select: { name: true, locale: true } }),
  ]);

  await notificationsService.notify([
    {
      ...owner(event),
      type: NotificationType.INVITATION,
      email: invitation.email,
      locale: invitee?.locale ?? inviter?.locale ?? "en",
      params: { businessName: invitation.business.name, inviterName: inviter?.name ?? "", tokenEncrypted },
      entityType: "invitation",
      entityId: invitationId,
      dedupeKey: `${NotificationType.INVITATION}:${invitationId}`,
    },
  ]);
};
