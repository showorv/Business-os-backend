import type { z } from "zod";
import type { statementLinesValidation } from "./statement-lines.validation.js";

export type ILineParams = z.infer<typeof statementLinesValidation.lineParams>;
export type IListLinesQuery = z.infer<typeof statementLinesValidation.listQuery>;
export type ISummaryQuery = z.infer<typeof statementLinesValidation.summaryQuery>;
export type IMatchBody = z.infer<typeof statementLinesValidation.match>;
export type ICategorizeBody = z.infer<typeof statementLinesValidation.categorize>;
export type ISplitBody = z.infer<typeof statementLinesValidation.split>;
export type IRunMatcherBody = z.infer<typeof statementLinesValidation.runMatcher>;

export type MatchedBy = "REFERENCE" | "AMOUNT_DATE" | "RULE" | "MANUAL";
