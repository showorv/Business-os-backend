import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { notificationsController } from "./notifications.controller.js";
import { notificationsValidation } from "./notifications.validation.js";

const router = Router();

const params = notificationsValidation.notificationParams;
const subscriptionParams = notificationsValidation.subscriptionParams;

router.get("/", requireAuth, validate({ query: notificationsValidation.listQuery }), notificationsController.list);
router.get("/unread-count", requireAuth, notificationsController.unreadCount);
router.get("/stream", requireAuth, notificationsController.stream);
router.post("/read-all", requireAuth, notificationsController.markAllRead);

router.get("/preferences", requireAuth, notificationsController.getPreferences);
router.patch("/preferences", requireAuth, validate({ body: notificationsValidation.updatePreferences }), notificationsController.updatePreferences);

router.get("/push/config", requireAuth, notificationsController.getPushConfig);
router.get("/push/subscriptions", requireAuth, notificationsController.listPushSubscriptions);
router.post("/push/subscriptions", requireAuth, validate({ body: notificationsValidation.pushSubscribe }), notificationsController.subscribePush);
router.delete("/push/subscriptions/:subscriptionId", requireAuth, validate({ params: subscriptionParams }), notificationsController.removePushSubscription);

router.post("/:notificationId/read", requireAuth, validate({ params }), notificationsController.markRead);
router.get("/:notificationId/deliveries", requireAuth, validate({ params }), notificationsController.listDeliveries);

export const notificationsRouter = router;
