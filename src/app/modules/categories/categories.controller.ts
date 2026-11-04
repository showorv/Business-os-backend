import type { RequestHandler } from "express";
import { getRequestContext } from "../../utils/requestContext.js";
import { sendResponse } from "../../utils/sendResponse.js";
import type {
  ICategoryParams,
  ICreateCategoryBody,
  IListCategoriesQuery,
  IUpdateCategoryBody,
} from "./categories.interface.js";
import { categoriesService } from "./categories.service.js";

const create: RequestHandler = async (req, res) => {
  const category = await categoriesService.create(
    req.business!,
    req.validated.body as ICreateCategoryBody,
    getRequestContext(req),
  );
  sendResponse(res, 201, category);
};

const list: RequestHandler = async (req, res) => {
  const page = await categoriesService.list(req.business!, req.validated.query as IListCategoriesQuery);
  sendResponse(res, 200, page.items, { nextCursor: page.nextCursor });
};

const update: RequestHandler = async (req, res) => {
  const { categoryId } = req.validated.params as ICategoryParams;
  const category = await categoriesService.update(
    req.business!,
    categoryId,
    req.validated.body as IUpdateCategoryBody,
    getRequestContext(req),
  );
  sendResponse(res, 200, category);
};

export const categoriesController = { create, list, update };
