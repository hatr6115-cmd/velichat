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
  startTemporaryCall,
  joinTemporaryCall,
  endTemporaryCall,
  sendTemporaryCallSignal,
  subscribeToRoomUpdates,
  validateAlias,
} from "./temporaryRooms";

describe("temporary rooms", () => {
  beforeEach(() => clearTemporaryRoomsForTests());

  it("creates a room with a valid alias and no persistent storage dependency", () => {
    const room = createTemporaryRoom("ShadowFox");
    expect(room.hostAlias).toBe("ShadowFox");
    expect(room.participantCount).toBe(1);
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
    expect(() => getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId)).toThrow("invalid, closed, or no longer available");
  });

  it("keeps the room available across time and closes it only when the participant logs out", () => {
    vi.useFakeTimers();
    try {
      const room = createTemporaryRoom("LongTerm");
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(getTemporaryRoom(room.roomId, room.inviteToken, room.currentMemberId).currentAlias).toBe("LongTerm");
      expect(roomCountForTests()).toBe(1);

      leaveTemporaryRoom(room.roomId, room.inviteToken, room.currentMemberId);
      expect(roomCountForTests()).toBe(0);
      expect(() => getTemporaryRoom(room.roomId, room.inviteToken, room.currentMemberId)).toThrow("no longer available");
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

  it("sets up audio/video calls with ephemeral signaling and clears them on hangup", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");

    for (const kind of ["audio", "video"] as const) {
      const ringing = startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, kind);
      expect(ringing.call?.kind).toBe(kind);
      expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).call?.initiatorAlias).toBe("Host");

      const joined = joinTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId);
      expect(joined.call?.participants).toEqual([host.currentMemberId, guest.currentMemberId]);
      sendTemporaryCallSignal(
        host.roomId,
        host.inviteToken,
        host.currentMemberId,
        guest.currentMemberId,
        "offer",
        JSON.stringify({ type: "offer", sdp: "ephemeral-test-offer" }),
      );
      expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).signals.some((signal) => signal.type === "offer")).toBe(true);

      endTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId);
      expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).call).toBeUndefined();
    }
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

  it("preserves active voice/video call negotiation and rejects competing calls", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    const started = startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "audio");

    expect(started.call?.participants).toEqual([host.currentMemberId]);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).call?.kind).toBe("audio");
    expect(() => startTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId, "video"))
      .toThrow("already active");

    // Retrying the same mutation is idempotent and must not reset the call.
    expect(startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "audio").call?.startedAt)
      .toBe(started.call?.startedAt);

    const joined = joinTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId);
    expect(joined.call?.participants).toEqual([host.currentMemberId, guest.currentMemberId]);

    const offer = JSON.stringify({ type: "offer", sdp: "host-offer" });
    sendTemporaryCallSignal(host.roomId, host.inviteToken, host.currentMemberId, guest.currentMemberId, "offer", offer);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).signals[0]?.payload).toBe(offer);

    const answer = JSON.stringify({ type: "answer", sdp: "guest-answer" });
    sendTemporaryCallSignal(host.roomId, host.inviteToken, guest.currentMemberId, host.currentMemberId, "answer", answer);
    const callerView = getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId);
    expect(callerView.call?.answer).toBe(answer);
    expect(callerView.call?.participants).toHaveLength(2);

    expect(endTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId).call).toBeUndefined();
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).signals).toEqual([]);
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
