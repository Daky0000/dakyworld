import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { summarise, toolStatuses } from "../services/toolRegistry.js";

/** What each tool is for, whether it works, and what it still needs. */
export const toolsRouter = Router();

toolsRouter.use(requireRole("OWNER"));

toolsRouter.get("/", async (_req, res, next) => {
  try {
    const tools = await toolStatuses();
    res.json({ tools, summary: summarise(tools) });
  } catch (err) {
    next(err);
  }
});
