import type { Request, RequestHandler } from "express";
import type { IUpdateSettingsBody } from "../platform/platform.interface.js";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IActivityQuery,
  ICouponParams,
  ICreateCouponBody,
  ICreatePlanBody,
  IPaymentsQuery,
  IPlanParams,
  ISetSubscriptionBody,
  ISuspendBody,
  IUpdateCouponBody,
  IUpdatePlanBody,
  IUsersQuery,
  IWorkspaceParams,
  IWorkspacesQuery,
} from "./platform-admin.interface.js";
import { platformAdminService as service } from "./platform-admin.service.js";

const actor = (req: Request) => req.auth!.userId;
const query = <T>(req: Request) => req.validated.query as T;

const overview: RequestHandler = async (_req, res) => sendResponse(res, 200, await service.overview());
const listWorkspaces: RequestHandler = async (req, res) => sendResponse(res, 200, await service.listWorkspaces(query<IWorkspacesQuery>(req)));
const getWorkspace: RequestHandler = async (req, res) => sendResponse(res, 200, await service.getWorkspace((req.validated.params as IWorkspaceParams).workspaceId));
const setSubscription: RequestHandler = async (req, res) =>
  sendResponse(res, 200, await service.setSubscription(actor(req), (req.validated.params as IWorkspaceParams).workspaceId, req.validated.body as ISetSubscriptionBody, getRequestContext(req)));
const suspend: RequestHandler = async (req, res) =>
  sendResponse(res, 200, await service.setSuspended(actor(req), (req.validated.params as IWorkspaceParams).workspaceId, (req.validated.body as ISuspendBody).reason, getRequestContext(req)));
const unsuspend: RequestHandler = async (req, res) =>
  sendResponse(res, 200, await service.setSuspended(actor(req), (req.validated.params as IWorkspaceParams).workspaceId, null, getRequestContext(req)));
const listUsers: RequestHandler = async (req, res) => sendResponse(res, 200, await service.listUsers(query<IUsersQuery>(req)));
const listPlans: RequestHandler = async (_req, res) => sendResponse(res, 200, await service.listPlans());
const createPlan: RequestHandler = async (req, res) => sendResponse(res, 201, await service.createPlan(actor(req), req.validated.body as ICreatePlanBody, getRequestContext(req)));
const updatePlan: RequestHandler = async (req, res) =>
  sendResponse(res, 200, await service.updatePlan(actor(req), (req.validated.params as IPlanParams).planKey, req.validated.body as IUpdatePlanBody, getRequestContext(req)));
const listCoupons: RequestHandler = async (_req, res) => sendResponse(res, 200, await service.listCoupons());
const createCoupon: RequestHandler = async (req, res) => sendResponse(res, 201, await service.createCoupon(actor(req), req.validated.body as ICreateCouponBody, getRequestContext(req)));
const updateCoupon: RequestHandler = async (req, res) =>
  sendResponse(res, 200, await service.updateCoupon(actor(req), (req.validated.params as ICouponParams).couponId, req.validated.body as IUpdateCouponBody, getRequestContext(req)));
const listPayments: RequestHandler = async (req, res) => sendResponse(res, 200, await service.listPayments(query<IPaymentsQuery>(req)));
const getSettings: RequestHandler = async (_req, res) => sendResponse(res, 200, await service.getSettings());
const updateSettings: RequestHandler = async (req, res) => sendResponse(res, 200, await service.updateSettings(actor(req), req.validated.body as IUpdateSettingsBody, getRequestContext(req)));
const activity: RequestHandler = async (req, res) => sendResponse(res, 200, await service.activity(query<IActivityQuery>(req)));

export const platformAdminController = {
  overview,
  listWorkspaces,
  getWorkspace,
  setSubscription,
  suspend,
  unsuspend,
  listUsers,
  listPlans,
  createPlan,
  updatePlan,
  listCoupons,
  createCoupon,
  updateCoupon,
  listPayments,
  getSettings,
  updateSettings,
  activity,
};
