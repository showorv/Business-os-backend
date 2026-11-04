import type { z } from "zod";
import type { categoriesValidation } from "./categories.validation.js";

export type ICategoryParams = z.infer<typeof categoriesValidation.categoryParams>;
export type ICreateCategoryBody = z.infer<typeof categoriesValidation.create>;
export type IUpdateCategoryBody = z.infer<typeof categoriesValidation.update>;
export type IListCategoriesQuery = z.infer<typeof categoriesValidation.listQuery>;

