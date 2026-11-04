import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { validate } from "../../middlewares/validate.js";
import { aiController } from "./ai.controller.js";
import { aiValidation } from "./ai.validation.js";

const router = Router();

const params = aiValidation.conversationParams;
const proposalParams = aiValidation.proposalParams;

router.get("/status", requireAuth, aiController.status);
router.post("/chat", requireAuth, rateLimit({ name: "ai-chat", windowSeconds: 60, max: 20, by: "user" }), validate({ body: aiValidation.chat }), aiController.chat);
router.get("/conversations", requireAuth, validate({ query: aiValidation.listQuery }), aiController.listConversations);
router.get("/conversations/:conversationId", requireAuth, validate({ params }), aiController.getConversation);
router.get("/proposals", requireAuth, validate({ query: aiValidation.proposalsQuery }), aiController.listProposals);
router.post("/proposals/:proposalId/confirm", requireAuth, validate({ params: proposalParams, body: aiValidation.confirm }), aiController.confirmProposal);
router.post("/proposals/:proposalId/reject", requireAuth, validate({ params: proposalParams }), aiController.rejectProposal);

export const aiRouter = router;
