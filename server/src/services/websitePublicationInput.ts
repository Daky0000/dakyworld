import { z } from "zod";
import type { PublicationOptions } from "../shared/websitePublication.js";

export const publicationInput: z.ZodType<PublicationOptions> = z.object({
  ifRevision: z.number().int().nonnegative().optional(),
  sourceHash: z.string().optional(),
  mode: z.enum(["commit", "pull_request"]).optional(),
  prTitle: z.string().optional(),
  forceOverride: z.boolean().optional(),
}).passthrough();
