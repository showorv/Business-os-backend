import type { z } from "zod";
import type { JournalLineInput } from "../../utils/postingRules.js";
import type { PeriodRules } from "../fiscal-periods/fiscal-periods.interface.js";
import type { journalsValidation } from "./journals.validation.js";

export type IJournalParams = z.infer<typeof journalsValidation.journalParams>;
export type ICreateJournalBody = z.infer<typeof journalsValidation.create>;
export type IReverseJournalBody = z.infer<typeof journalsValidation.reverse>;
export type IListJournalsQuery = z.infer<typeof journalsValidation.listQuery>;

export interface PostInput extends PeriodRules {
  entryDate: Date;
  kind: "STANDARD" | "REVERSAL" | "ADJUSTING" | "CLOSING" | "OPENING";
  lines: JournalLineInput[];
  memo?: string | null;
  sourceType?: string;
  sourceId?: string;
  reversesId?: string;
}

export interface ReverseOptions extends PeriodRules {
  entryDate: Date;
  memo?: string | undefined;
}
