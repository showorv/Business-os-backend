import { z } from "zod";
import { textField } from "../../utils/validationFields.js";

const updateMe = z
  .object({
    name: textField(120).optional(),
    locale: z.enum(["en", "bn-BD"]).optional(),
    digitStyle: z.enum(["latin", "bangla"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

export const usersValidation = { updateMe };
