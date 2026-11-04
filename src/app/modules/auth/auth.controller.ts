import type { RequestHandler, Response } from "express";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../../utils/cookies.js";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  IChangePasswordBody,
  IForgotPasswordBody,
  ILoginBody,
  IMfaCodeBody,
  IMfaDisableBody,
  IMfaSetupBody,
  IMfaVerifyBody,
  IRegisterBody,
  IResetPasswordBody,
  ISessionParams,
  IssuedTokens,
} from "./auth.interface.js";
import { authService } from "./auth.service.js";

// The refresh token only ever travels in its httpOnly cookie, never in a response body.
const sendTokens = (res: Response, status: number, tokens: IssuedTokens & { mfaRequired?: false }) => {
  const { refreshToken, ...rest } = tokens;
  const csrfToken = setAuthCookies(res, refreshToken);
  sendResponse(res, status, { ...rest, csrfToken });
};

const register: RequestHandler = async (req, res) => {
  const tokens = await authService.register(req.validated.body as IRegisterBody, getRequestContext(req));
  sendTokens(res, 201, tokens);
};

const login: RequestHandler = async (req, res) => {
  const result = await authService.login(req.validated.body as ILoginBody, getRequestContext(req));
  if (result.mfaRequired) {
    sendResponse(res, 200, result);
    return;
  }
  sendTokens(res, 200, result);
};

const verifyMfa: RequestHandler = async (req, res) => {
  const tokens = await authService.verifyMfaLogin(req.validated.body as IMfaVerifyBody, getRequestContext(req));
  sendTokens(res, 200, tokens);
};

const refresh: RequestHandler = async (req, res) => {
  try {
    const tokens = await authService.refresh(req.cookies?.[REFRESH_COOKIE], getRequestContext(req));
    sendTokens(res, 200, tokens);
  } catch (error) {
    clearAuthCookies(res);
    throw error;
  }
};

const logout: RequestHandler = async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE], getRequestContext(req));
  clearAuthCookies(res);
  sendResponse(res, 200, { loggedOut: true });
};

const logoutAll: RequestHandler = async (req, res) => {
  await authService.logoutAll(req.auth!, getRequestContext(req));
  clearAuthCookies(res);
  sendResponse(res, 200, { loggedOut: true });
};

const listSessions: RequestHandler = async (req, res) => {
  sendResponse(res, 200, await authService.listSessions(req.auth!));
};

const revokeSession: RequestHandler = async (req, res) => {
  const { sessionId } = req.validated.params as ISessionParams;
  await authService.revokeSession(req.auth!, sessionId, getRequestContext(req));
  sendResponse(res, 200, { revoked: true });
};

const startMfaSetup: RequestHandler = async (req, res) => {
  const { password } = req.validated.body as IMfaSetupBody;
  sendResponse(res, 200, await authService.startMfaSetup(req.auth!, password, getRequestContext(req)));
};

const confirmMfaSetup: RequestHandler = async (req, res) => {
  const { code } = req.validated.body as IMfaCodeBody;
  await authService.confirmMfaSetup(req.auth!, code, getRequestContext(req));
  sendResponse(res, 200, { mfaEnabled: true });
};

const disableMfa: RequestHandler = async (req, res) => {
  await authService.disableMfa(req.auth!, req.validated.body as IMfaDisableBody, getRequestContext(req));
  sendResponse(res, 200, { mfaEnabled: false });
};

const stepUpMfa: RequestHandler = async (req, res) => {
  const { code } = req.validated.body as IMfaCodeBody;
  sendResponse(res, 200, await authService.stepUpMfa(req.auth!, code, getRequestContext(req)));
};

const changePassword: RequestHandler = async (req, res) => {
  await authService.changePassword(req.auth!, req.validated.body as IChangePasswordBody, getRequestContext(req));
  clearAuthCookies(res);
  sendResponse(res, 200, { passwordChanged: true });
};

const forgotPassword: RequestHandler = async (req, res) => {
  await authService.forgotPassword((req.validated.body as IForgotPasswordBody).email, getRequestContext(req));
  sendResponse(res, 202, { accepted: true });
};

const resetPassword: RequestHandler = async (req, res) => {
  await authService.resetPassword(req.validated.body as IResetPasswordBody, getRequestContext(req));
  sendResponse(res, 200, { passwordChanged: true });
};

export const authController = {
  forgotPassword,
  resetPassword,
  register,
  login,
  verifyMfa,
  refresh,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  startMfaSetup,
  confirmMfaSetup,
  disableMfa,
  stepUpMfa,
  changePassword,
};
