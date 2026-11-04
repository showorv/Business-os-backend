import type { z } from "zod";
import type { integrationsValidation } from "./integrations.validation.js";

export type IConnectionParams = z.infer<typeof integrationsValidation.connectionParams>;
export type ICreateConnectionBody = z.infer<typeof integrationsValidation.create>;
export type IUpdateConnectionBody = z.infer<typeof integrationsValidation.update>;
export type IReauthorizeBody = z.infer<typeof integrationsValidation.reauthorize>;
export type IRunsQuery = z.infer<typeof integrationsValidation.runsQuery>;
