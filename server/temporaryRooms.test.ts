import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTemporaryRoomsForTests,
  createTemporaryRoom,
  getTemporaryRoom,
  joinTemporaryRoom,
  leaveTemporaryRoom,
  acknowledgeTemporaryMessages,
  markTemporaryMessagesRead,
  roomCountForTests,
  sendTemporaryMessage,
  sendTemporaryMedia,
  consumeTemporaryMedia,
  setTemporaryTyping,
  subscribeToRoomUpdates,
  validateAlias,
} from "./temporaryRooms";

describe("temporary rooms", () => {
  beforeEach(() => clearTemporaryRoomsForTests());

  it("creates a room with a valid alias and no persistent storage dependency", () => {
    const room = createTemporaryRoom("ShadowFox");
    expect(room.hostAlias).toBe("ShadowFox");
    expect(room.participantCount).toBe(1);
    expect(room.expiresAt).toBeGreaterThan(Date.now());
    expect(roomCountForTests()).toBe(1);
  });

  it("accepts guests and tracks participants", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    expect(guest.participantCount).toBe(2);
    expect(guest.guestAlias).toBe("Guest");
    const third = joinTemporaryRoom(host.roomId, host.inviteToken, "Third");
    expect(third.participantCount).toBe(3);
  });

  it("delivers messages by alias and removes the room on leave", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "hello");
    const view = sendTemporaryMessage(host.roomId, host.inviteToken, guest.currentMemberId, "hi back");
    expect(view.messages.map((message) => [message.alias, message.body])).toEqual([["Host", "hello"], ["Guest", "hi back"]]);
    leaveTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId);
    expect(roomCountForTests()).toBe(0);
    expect(() => getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId)).toThrow("invalid or expired");
  });

  it("expires room access after thirty minutes", () => {
    vi.useFakeTimers();
    try {
      const room = createTemporaryRoom("Timer");
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      expect(() => getTemporaryRoom(room.roomId, room.inviteToken, room.currentMemberId)).toThrow("invalid or expired");
      expect(roomCountForTests()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires typing presence and records read receipts only in memory", () => {
    vi.useFakeTimers();
    try {
      const host = createTemporaryRoom("Host");
      const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
      setTemporaryTyping(host.roomId, host.inviteToken, host.currentMemberId, true);
      expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).typingAlias).toBe("Host");
      vi.advanceTimersByTime(6_001);
      expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).typingAlias).toBeUndefined();
      sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "read me");
      sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "not yet");
      acknowledgeTemporaryMessages(host.roomId, host.inviteToken, guest.currentMemberId);
      const received = getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).messages;
      expect(received[0]?.deliveredTo).toContain(guest.currentMemberId);
      markTemporaryMessagesRead(host.roomId, host.inviteToken, guest.currentMemberId, [received[0]!.id]);
      const afterRead = getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).messages;
      expect(afterRead[0]?.readBy).toContain(guest.currentMemberId);
      expect(afterRead[1]?.readBy).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends voice, photo, and video media that each recipient can consume once", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    const voice = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "voice", "data:audio/webm;base64,AAAA");
    const photo = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "photo", "data:image/png;base64,AAAA");
    const video = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "video", "data:video/mp4;base64,AAAA");
    expect(voice.media[0]?.kind).toBe("voice");
    expect(photo.media[1]?.kind).toBe("photo");
    expect(video.media[2]?.kind).toBe("video");
    const consumed = consumeTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, voice.media[0]!.id);
    expect(consumed.media.find((item) => item.id === voice.media[0]!.id)?.dataUrl).toBeUndefined();
    expect(() => consumeTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, voice.media[0]!.id)).toThrow("no longer available");
    expect(() => consumeTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, photo.media[1]!.id)).toThrow("Only the recipient");
    const photoConsumed = consumeTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, photo.media[1]!.id);
    expect(photoConsumed.media.find((item) => item.id === photo.media[1]!.id)?.dataUrl).toBeUndefined();
    const videoConsumed = consumeTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, video.media[2]!.id);
    expect(videoConsumed.media.find((item) => item.id === video.media[2]!.id)?.dataUrl).toBeUndefined();
  });

  it("rejects invalid media formats", () => {
    const host = createTemporaryRoom("Host");
    expect(() => sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "voice", "data:image/png;base64,AAAA")).toThrow("does not match");
    expect(() => sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "photo", "not-a-data-url")).toThrow("Unsupported media format");
  });

  it("rejects identifying-looking or malformed aliases", () => {
    expect(() => validateAlias("A")).toThrow();
    expect(() => validateAlias("email@example.com")).toThrow();
    expect(() => validateAlias("a".repeat(33))).toThrow();
  });

  it("subscribes to real-time room updates and receives instant broadcasts", () => {
    const host = createTemporaryRoom("Host");
    let updateCount = 0;
    let latestSnap: any;
    const unsub = subscribeToRoomUpdates(
      host.roomId,
      host.inviteToken,
      host.currentMemberId,
      (snap) => {
        updateCount++;
        latestSnap = snap;
      },
      () => {}
    );
    // Initial snapshot delivered immediately
    expect(updateCount).toBe(1);
    expect(latestSnap.hostAlias).toBe("Host");

    // Guest joins -> triggers update
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    expect(updateCount).toBe(2);
    expect(latestSnap.participantCount).toBe(2);

    // Guest sends message -> triggers update
    sendTemporaryMessage(host.roomId, host.inviteToken, guest.currentMemberId, "realtime message");
    expect(updateCount).toBe(3);
    expect(latestSnap.messages[0]?.body).toBe("realtime message");

    unsub();
  });
});
