import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
// Each import registers that module's routes. A new module adds one *.docs.ts file and one line here.
import "./auth.docs.js";
import "./users.docs.js";
import "./audit.docs.js";
import "./businesses.docs.js";
import "./finance.docs.js";
import "./contacts.docs.js";
import "./invoices.docs.js";
import "./documents.docs.js";
import "./accounting.docs.js";
import "./analytics.docs.js";
import "./tasks.docs.js";
import "./integrations.docs.js";
import "./ai.docs.js";
import "./billing.docs.js";
import "./platform-admin.docs.js";
import { registry } from "./registry.js";

export const buildOpenApiDocument = () =>
  new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Business OS API",
      version: "1.0.0",
      description: "Errors return a code, never a display sentence.",
    },
  });
