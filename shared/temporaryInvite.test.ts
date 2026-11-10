import { describe, expect, it } from "vitest";
import { createTemporaryInvite, encodeTemporaryInvite, parseTemporaryInvite } from "./temporaryInvite";

describe("temporary invites", () => {
  const invite = createTemporaryInvite({
    roomId: "room_123456",
    inviteToken: "token_1234567890123456",
    hostAlias: "ShadowFox",
  });

  it("round-trips the shared QR payload", () => {
    expect(parseTemporaryInvite(encodeTemporaryInvite(invite))).toEqual(invite);
  });

  it("accepts legacy links that contain a past expiresAt field", () => {
    const legacyInvite = { ...invite, expiresAt: Date.now() - 60_000 };
    expect(parseTemporaryInvite(JSON.stringify(legacyInvite))).toEqual(legacyInvite);
  });

  it("rejects malformed or wrong-type payloads", () => {
    expect(() => parseTemporaryInvite("not-json")).toThrow("invitation is invalid");
    expect(() => parseTemporaryInvite(JSON.stringify({ ...invite, type: "identity" }))).toThrow("invitation is invalid");
  });
});
