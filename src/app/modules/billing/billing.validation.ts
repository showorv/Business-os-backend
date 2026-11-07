import { z } from "zod";

// Nothing to send yet: the plan routes only read. Payments (step 11.2) add bodies here.
const plansQuery = z.object({});

export const billingValidation = { plansQuery };
