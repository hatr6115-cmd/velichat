import { z } from "zod";

const temporaryInviteSchema = z.object({
  version: z.literal(1),
  type: z.literal("veilchat-temporary"),
  roomId: z.string().min(8).max(64),
  inviteToken: z.string().min(16).max(96),
  hostAlias: z.string().min(2).max(32),
  // Optional for backward compatibility with links created before rooms became persistent.
  expiresAt: z.number().int().positive().optional(),
});

export type TemporaryInvite = z.infer<typeof temporaryInviteSchema>;

export function encodeTemporaryInvite(invite: TemporaryInvite) {
  return JSON.stringify(invite);
}

export function parseTemporaryInvite(raw: string): TemporaryInvite {
  try {
    const decoded = raw.startsWith("{") ? raw : decodeURIComponent(raw);
    return temporaryInviteSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("This room invitation is invalid.");
  }
}

export function createTemporaryInvite(input: Omit<TemporaryInvite, "version" | "type">) {
  return {
    version: 1 as const,
    type: "veilchat-temporary" as const,
    ...input,
  };
}
