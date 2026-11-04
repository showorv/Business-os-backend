import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type { IAcceptInvitationBody, ICreateInvitationBody, IInvitationParams } from "./invitations.interface.js";
import { invitationsService } from "./invitations.service.js";

const create: RequestHandler = async (req, res) => {
  const invitation = await invitationsService.create(
    req.business!,
    req.validated.body as ICreateInvitationBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, invitation);
};

const list: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await invitationsService.listPending(req.business!));
};

const revoke: RequestHandler = async (req, res) => {
  const { invitationId } = req.validated.params as IInvitationParams;
  await invitationsService.revoke(req.business!, invitationId, getRequestContext(req));
  sendResponse(res, 200, { revoked: true });
};

const accept: RequestHandler = async (req, res) => {
  const { token } = req.validated.body as IAcceptInvitationBody;
  sendResponse(res, 200, await invitationsService.accept(req.auth!, token, getRequestContext(req)));
};

export const invitationsController = { create, list, revoke, accept };
