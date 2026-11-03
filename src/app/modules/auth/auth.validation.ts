import { z } from "zod";
import { emailField, existingPasswordField, newPasswordField, textField, totpCodeField } from "../../utils/validationFields.js";

const register = z.object({
  name: textField(120),
  email: emailField,
  password: newPasswordField,
  locale: z.enum(["en", "bn-BD"]).optional(),
});

const login = z.object({
  email: emailField,
  password: existingPasswordField,
});

const mfaVerify = z.object({
  challengeToken: z.string().min(1).max(2000),
  code: totpCodeField,
});

const mfaSetup = z.object({ password: existingPasswordField });
const mfaCode = z.object({ code: totpCodeField });
const mfaDisable = z.object({ password: existingPasswordField, code: totpCodeField });

const changePassword = z.object({
  currentPassword: existingPasswordField,
  newPassword: newPasswordField,
});

const sessionParams = z.object({ sessionId: z.uuid() });

export const authValidation = {
  register,
  login,
  mfaVerify,
  mfaSetup,
  mfaCode,
  mfaDisable,
  changePassword,
  sessionParams,
};
