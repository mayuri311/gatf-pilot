import { z } from "zod";

/** config/config.yaml v2 (plan doc 13 §3). Non-secret settings only. */
export const configSchema = z.object({
  parkinglot: z.object({
    lot_id: z.string().min(1),
    name: z.string().min(1),
    capacity: z.number().int().positive(),
    timezone: z.string().default("America/New_York"),
    effective_capacity_pct: z.number().min(0.5).max(1).optional(),
  }),
  cameras: z
    .array(
      z.object({
        camera_id: z.string().min(1),
        direction: z.enum(["in", "out"]),
        device_id: z.string().min(1),
      }),
    )
    .min(1),
  supabase: z.object({ url: z.string().optional(), bucket: z.string().default("event-snapshots") }).partial().default({}),
  auth: z.object({ bootstrap_admin_email: z.email() }).partial().default({}),
  ai: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.string().default("openai"),
      model: z.string().default("gpt-5.6-terra"),
    })
    .default({ enabled: true, provider: "openai", model: "gpt-5.6-terra" }),
  heartbeat: z
    .object({ interval_s: z.number().default(60), offline_after_s: z.number().default(180) })
    .default({ interval_s: 60, offline_after_s: 180 }),
  retention: z
    .object({
      plate_text_days: z.number().default(30),
      crop_days: z.number().default(14),
      reads_full_days: z.number().default(7),
    })
    .default({ plate_text_days: 30, crop_days: 14, reads_full_days: 7 }),
});

export type AppConfigFile = z.infer<typeof configSchema>;
