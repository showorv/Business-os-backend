import { usersValidation } from "../modules/users/users.validation.js";
import { addPath, publicUser } from "./registry.js";

addPath("Users", { method: "get", path: "/users/me", summary: "Get my profile", response: publicUser });
addPath("Users", { method: "patch", path: "/users/me", summary: "Update name, language or digit style", body: usersValidation.updateMe, response: publicUser });
