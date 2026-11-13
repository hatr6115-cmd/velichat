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
  deleteTemporaryContent,
  reportTemporaryScreenshotShortcut,
  getTemporaryCallIceServers,
  setTemporaryTyping,
  startTemporaryCall,
  joinTemporaryCall,
  sendTemporaryCallSignal,
  endTemporaryCall,
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

  it("allows 50 room participants and rejects the next invite", () => {
    const host = createTemporaryRoom("Host");
    let snapshot = host;
    for (let guestNumber = 1; guestNumber <= 49; guestNumber++) {
      snapshot = joinTemporaryRoom(host.roomId, host.inviteToken, `Guest${guestNumber}`);
    }

    expect(snapshot.participantCount).toBe(50);
    expect(() => joinTemporaryRoom(host.roomId, host.inviteToken, "OneMoreGuest")).toThrow("maximum of 50 participants");
  });

  it("delivers messages to everyone in a group room", () => {
    const host = createTemporaryRoom("Host");
    const firstGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "First");
    const secondGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "Second");
    sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "Host message");
    sendTemporaryMessage(host.roomId, host.inviteToken, firstGuest.currentMemberId, "Guest message");

    const snapshots = [host.currentMemberId, firstGuest.currentMemberId, secondGuest.currentMemberId]
      .map((memberId) => getTemporaryRoom(host.roomId, host.inviteToken, memberId));
    expect(snapshots.map((snapshot) => snapshot.messages.map((item) => item.body))).toEqual([
      ["Host message", "Guest message"],
      ["Host message", "Guest message"],
      ["Host message", "Guest message"],
    ]);
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

  it("keeps mixed media and text in their actual send order when timestamps share a millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    try {
      const host = createTemporaryRoom("Host");
      sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "photo", "data:image/png;base64,AAAA");
      const afterPhoto = sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "Text after photo");
      expect(afterPhoto.messages[0]!.sentAt).toBeGreaterThan(afterPhoto.media[0]!.sentAt);

      const beforeVideo = sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "Text before video");
      const afterVideo = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "video", "data:video/mp4;base64,AAAA");
      expect(afterVideo.media[1]!.sentAt).toBeGreaterThan(beforeVideo.messages[1]!.sentAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("broadcasts possible screenshot-shortcut notices and rejects participant impersonation", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");

    expect(() => reportTemporaryScreenshotShortcut(
      host.roomId,
      host.inviteToken,
      guest.currentMemberId,
      host.memberToken,
    )).toThrow("permission");

    let guestNoticeCount = 0;
    const unsubscribe = subscribeToRoomUpdates(
      host.roomId,
      host.inviteToken,
      guest.currentMemberId,
      (snapshot) => { guestNoticeCount = snapshot.screenshotShortcutNotices.length; },
      () => {},
    );

    const hostSnapshot = reportTemporaryScreenshotShortcut(
      host.roomId,
      host.inviteToken,
      host.currentMemberId,
      host.memberToken,
    );
    expect(hostSnapshot.screenshotShortcutNotices).toHaveLength(1);
    expect(hostSnapshot.screenshotShortcutNotices[0]).toMatchObject({
      memberId: host.currentMemberId,
      alias: "Host",
    });
    expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).screenshotShortcutNotices).toEqual(
      hostSnapshot.screenshotShortcutNotices,
    );
    expect(guestNoticeCount).toBe(1);
    unsubscribe();

    const rateLimited = reportTemporaryScreenshotShortcut(
      host.roomId,
      host.inviteToken,
      host.currentMemberId,
      host.memberToken,
    );
    expect(rateLimited.screenshotShortcutNotices).toHaveLength(1);
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

  it("keeps ordinary voice notes replayable for sender and recipients", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    const voice = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "voice", "data:audio/webm;base64,AAAA");
    const voiceId = voice.media[0]!.id;

    expect(voice.media[0]?.viewOnce).toBe(false);
    expect(voice.media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
    expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
    expect(() => consumeTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, voiceId)).toThrow("Replayable voice notes");
    expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
  });

  it("consumes explicit view-once voice notes for recipients but retains the sender's copy", () => {
    const host = createTemporaryRoom("Host");
    const firstGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "First");
    const secondGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "Second");
    const voice = sendTemporaryMedia(
      host.roomId,
      host.inviteToken,
      host.currentMemberId,
      "voice",
      "data:audio/webm;base64,AAAA",
      undefined,
      undefined,
      true,
    );
    const voiceId = voice.media[0]!.id;

    expect(voice.media[0]?.viewOnce).toBe(true);
    expect(consumeTemporaryMedia(host.roomId, host.inviteToken, firstGuest.currentMemberId, voiceId).media[0]?.dataUrl).toBeUndefined();
    expect(getTemporaryRoom(host.roomId, host.inviteToken, firstGuest.currentMemberId).media[0]?.dataUrl).toBeUndefined();
    expect(getTemporaryRoom(host.roomId, host.inviteToken, secondGuest.currentMemberId).media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
    expect(() => consumeTemporaryMedia(host.roomId, host.inviteToken, firstGuest.currentMemberId, voiceId)).toThrow("no longer available");
    consumeTemporaryMedia(host.roomId, host.inviteToken, secondGuest.currentMemberId, voiceId);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).media[0]?.dataUrl).toBe("data:audio/webm;base64,AAAA");
  });

  it("consumes view-once photos and videos for each recipient before clearing them", () => {
    const host = createTemporaryRoom("Host");
    const firstGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "First");
    const secondGuest = joinTemporaryRoom(host.roomId, host.inviteToken, "Second");
    const photo = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "photo", "data:image/png;base64,AAAA");
    const video = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "video", "data:video/mp4;base64,AAAA");

    expect(() => consumeTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, photo.media[0]!.id)).toThrow("Only the recipient");
    consumeTemporaryMedia(host.roomId, host.inviteToken, firstGuest.currentMemberId, photo.media[0]!.id);
    consumeTemporaryMedia(host.roomId, host.inviteToken, firstGuest.currentMemberId, video.media[1]!.id);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, secondGuest.currentMemberId).media[0]?.dataUrl).toBe("data:image/png;base64,AAAA");
    expect(getTemporaryRoom(host.roomId, host.inviteToken, secondGuest.currentMemberId).media[1]?.dataUrl).toBe("data:video/mp4;base64,AAAA");
    consumeTemporaryMedia(host.roomId, host.inviteToken, secondGuest.currentMemberId, photo.media[0]!.id);
    consumeTemporaryMedia(host.roomId, host.inviteToken, secondGuest.currentMemberId, video.media[1]!.id);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).media[0]?.dataUrl).toBeUndefined();
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).media[1]?.dataUrl).toBeUndefined();
  });

  it("allows deletion of own messages and media only, and removes them for everyone", () => {
    const host = createTemporaryRoom("Host");
    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    const hostMessage = sendTemporaryMessage(host.roomId, host.inviteToken, host.currentMemberId, "host message").messages[0]!;
    const guestMessage = sendTemporaryMessage(host.roomId, host.inviteToken, guest.currentMemberId, "guest message").messages[1]!;
    const hostMedia = sendTemporaryMedia(host.roomId, host.inviteToken, host.currentMemberId, "voice", "data:audio/webm;base64,AAAA").media[0]!;
    const guestMedia = sendTemporaryMedia(host.roomId, host.inviteToken, guest.currentMemberId, "photo", "data:image/png;base64,AAAA").media[1]!;

    expect(host.memberToken).not.toBe(guest.memberToken);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId)).not.toHaveProperty("memberToken");
    expect(() => deleteTemporaryContent(host.roomId, host.inviteToken, guest.memberToken, "message", hostMessage.id)).toThrow("own messages");
    expect(() => deleteTemporaryContent(host.roomId, host.inviteToken, guest.memberToken, "media", hostMedia.id)).toThrow("own media");
    expect(() => deleteTemporaryContent(host.roomId, host.inviteToken, "wrong-token", "message", hostMessage.id)).toThrow("permission");

    deleteTemporaryContent(host.roomId, host.inviteToken, host.memberToken, "message", hostMessage.id);
    deleteTemporaryContent(host.roomId, host.inviteToken, guest.memberToken, "media", guestMedia.id);
    const recipientSnapshot = getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId);
    expect(recipientSnapshot.messages.map((item) => item.id)).toEqual([guestMessage.id]);
    expect(recipientSnapshot.media.map((item) => item.id)).toEqual([hostMedia.id]);
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
      const offer = JSON.stringify({ type: "offer", sdp: "ephemeral-test-offer" });
      sendTemporaryCallSignal(
        host.roomId,
        host.inviteToken,
        host.currentMemberId,
        guest.currentMemberId,
        "offer",
        offer,
      );
      const incomingOffer = getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId);
      expect(incomingOffer.signals.some((signal) => signal.type === "offer" && signal.payload === offer)).toBe(true);
      expect(incomingOffer.call?.offer).toBe(offer);

      sendTemporaryCallSignal(
        host.roomId,
        host.inviteToken,
        host.currentMemberId,
        guest.currentMemberId,
        "ice",
        JSON.stringify({ candidate: "candidate:test" }),
      );
      expect(getTemporaryRoom(host.roomId, host.inviteToken, guest.currentMemberId).signals.some((signal) => signal.type === "ice")).toBe(true);

      const answer = JSON.stringify({ type: "answer", sdp: "ephemeral-test-answer" });
      sendTemporaryCallSignal(
        host.roomId,
        host.inviteToken,
        guest.currentMemberId,
        host.currentMemberId,
        "answer",
        answer,
      );
      const incomingAnswer = getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId);
      expect(incomingAnswer.signals.some((signal) => signal.type === "answer" && signal.payload === answer)).toBe(true);
      expect(incomingAnswer.call?.answer).toBe(answer);

      endTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId);
      expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).call).toBeUndefined();
    }
  });

  it("requires a second participant and protects call signaling roles", () => {
    const host = createTemporaryRoom("Host");
    expect(() => startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "audio")).toThrow("friend must join");

    const guest = joinTemporaryRoom(host.roomId, host.inviteToken, "Guest");
    startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "audio");
    expect(() => startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "video")).toThrow("already active");
    joinTemporaryCall(host.roomId, host.inviteToken, guest.currentMemberId);

    expect(() => sendTemporaryCallSignal(
      host.roomId,
      host.inviteToken,
      guest.currentMemberId,
      host.currentMemberId,
      "offer",
      JSON.stringify({ type: "offer", sdp: "forbidden" }),
    )).toThrow("Only the caller");
    expect(() => sendTemporaryCallSignal(
      host.roomId,
      host.inviteToken,
      host.currentMemberId,
      "not-a-participant",
      "offer",
      JSON.stringify({ type: "offer", sdp: "forbidden" }),
    )).toThrow("recipient is not a participant");
  });

  it("clears an active call when one of its participants leaves", () => {
    const host = createTemporaryRoom("Host");
    const caller = joinTemporaryRoom(host.roomId, host.inviteToken, "Caller");
    joinTemporaryRoom(host.roomId, host.inviteToken, "Observer");
    startTemporaryCall(host.roomId, host.inviteToken, host.currentMemberId, "audio");
    joinTemporaryCall(host.roomId, host.inviteToken, caller.currentMemberId);

    leaveTemporaryRoom(host.roomId, host.inviteToken, caller.currentMemberId);
    expect(getTemporaryRoom(host.roomId, host.inviteToken, host.currentMemberId).call).toBeUndefined();
  });

  it("returns configured TURN relays alongside STUN servers", () => {
    vi.stubEnv("TURN_URLS", "turn:relay.example:3478, turns:relay.example:443?transport=tcp");
    vi.stubEnv("TURN_USERNAME", "turn-user");
    vi.stubEnv("TURN_CREDENTIAL", "turn-password");
    try {
      const iceServers = getTemporaryCallIceServers();
      expect(iceServers[0]?.urls).toContain("stun:stun.l.google.com:19302");
      expect(iceServers[1]).toEqual({
        urls: ["turn:relay.example:3478", "turns:relay.example:443?transport=tcp"],
        username: "turn-user",
        credential: "turn-password",
      });
    } finally {
      vi.unstubAllEnvs();
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
