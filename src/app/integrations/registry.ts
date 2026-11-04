import { isProduction } from "../config/env.config.js";
import type { IntegrationAdapter } from "./adapter.js";
import { sandboxAdapter } from "./sandbox.adapter.js";

// Add a provider by importing its adapter and listing it here. There are no live providers until you
// have merchant or API credentials for one. Statement files work without any of this.
const adapters: IntegrationAdapter[] = isProduction ? [] : [sandboxAdapter];

export const listAdapters = () => adapters;
export const findAdapter = (key: string) => adapters.find((adapter) => adapter.key === key) ?? null;
