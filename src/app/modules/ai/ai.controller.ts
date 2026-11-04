import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IChatBody, IConfirmBody, IConversationParams, IListQuery, IProposalParams, IProposalsQuery } from "./ai.interface.js";
import { aiService } from "./ai.service.js";

const status: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await aiService.status(req.auth!));
};

const chat: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await aiService.chat(req.auth!, req.validated.body as IChatBody));
};

const listConversations: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await aiService.listConversations(req.auth!, req.validated.query as IListQuery));
};

const getConversation: RequestHandler = async (req, res) => {
  const { conversationId } = req.validated.params as IConversationParams;
  sendResponse(res, 200, await aiService.getConversation(req.auth!, conversationId));
};

const listProposals: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await aiService.listProposals(req.auth!, req.validated.query as IProposalsQuery));
};

const confirmProposal: RequestHandler = async (req, res) => {
  const { proposalId } = req.validated.params as IProposalParams;
  sendResponse(res, 200, await aiService.confirmProposal(req.auth!, proposalId, req.validated.body as IConfirmBody, getRequestContext(req)));
};

const rejectProposal: RequestHandler = async (req, res) => {
  const { proposalId } = req.validated.params as IProposalParams;
  sendResponse(res, 200, await aiService.rejectProposal(req.auth!, proposalId));
};

export const aiController = { status, chat, listConversations, getConversation, listProposals, confirmProposal, rejectProposal };
