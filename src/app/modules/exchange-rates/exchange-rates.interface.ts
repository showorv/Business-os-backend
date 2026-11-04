import type { z } from "zod";
import type { exchangeRatesValidation } from "./exchange-rates.validation.js";

export type ISaveRateBody = z.infer<typeof exchangeRatesValidation.save>;
export type IListRatesQuery = z.infer<typeof exchangeRatesValidation.listQuery>;

export interface ResolvedRate {
  rate: string;
  rateDate: string | null;
  inverted: boolean;
}
