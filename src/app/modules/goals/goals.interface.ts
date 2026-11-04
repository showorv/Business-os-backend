import type { z } from "zod";
import type { goalsValidation } from "./goals.validation.js";

export type IGoalParams = z.infer<typeof goalsValidation.goalParams>;
export type ICreateGoalBody = z.infer<typeof goalsValidation.create>;
export type IUpdateGoalBody = z.infer<typeof goalsValidation.update>;
export type IListGoalsQuery = z.infer<typeof goalsValidation.listQuery>;
