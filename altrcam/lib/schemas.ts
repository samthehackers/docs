import { z } from "zod";

export const PresetBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["prompt", "background", "outfit", "style"]),
  prompt: z.string().max(1000).default(""),
  imagePath: z.string().max(300).nullish(),
  settings: z.record(z.unknown()).optional(),
});
