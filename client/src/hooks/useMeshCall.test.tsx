// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveCall, RoomSnapshot } from "../../../server/temporaryRooms";
import { useMeshCall } from "./useMeshCall";

const mutationMocks = vi.hoisted(() => ({
  sendSignal: vi.fn(),
  startCall: vi.fn(),
  joinCall: vi.fn(),
  endCall: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    temporary: {
      sendSignal: {
        useMutation: () => ({ mutateAsync: mutationMocks.sendSignal }),
      },
      startCall: {
        useMutation: () => ({ mutateAsync: mutationMocks.startCall }),
      },
      joinCall: {
        useMutation: () => ({ mutateAsync: mutationMocks.joinCall }),
      },
      endCall: { useMutation: () => ({ mutateAsync: mutationMocks.endCall }) },
    },
  },
}));

type CallHook = ReturnType<typeof useMeshCall>;
type Session = Parameters<typeof useMeshCall>[0];

const session: NonNullable<Session> = {
  roomId: "room-123456789",
  inviteToken: "invite-token-123456789",
  memberId: "member-123456",
};

function makeRoom(call?: ActiveCall): RoomSnapshot {
  return {
    roomId: session.roomId,
    expiresAt: Date.now() + 30_000,
    hostAlias: "Host",
    guestAliases: ["Guest"],
    currentMemberId: session.memberId,
    currentAlias: "Host",
    participantCount: 2,
    typingAliases: [],
    messages: [],
    media: [],
    signals: [],
    call,
  };
}

function makeMediaStream() {
  const track = {
    id: "audio-track",
    kind: "audio",
    enabled: true,
    stop: vi.fn(),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
  return { stream, track };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({
  room,
  onResult,
}: {
  room: RoomSnapshot | null;
  onResult: (value: CallHook) => void;
}) {
  onResult(useMeshCall(session, room));
  return null;
}

describe("useMeshCall", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: CallHook;
  let getUserMedia: ReturnType<typeof vi.fn>;

  function render(room: RoomSnapshot | null) {
    root.render(
      <Probe
        room={room}
        onResult={value => {
          latest = value;
        }}
      />
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mutationMocks.sendSignal.mockResolvedValue({ success: true });
    mutationMocks.startCall.mockResolvedValue(makeRoom());
    mutationMocks.joinCall.mockResolvedValue(makeRoom());
    mutationMocks.endCall.mockResolvedValue(makeRoom());

    const media = makeMediaStream();
    getUserMedia = vi.fn().mockResolvedValue(media.stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("does not tear down an outgoing call when its active snapshot arrives", async () => {
    const pendingStart = deferred<RoomSnapshot>();
    mutationMocks.startCall.mockReturnValue(pendingStart.promise);
    const media = makeMediaStream();
    getUserMedia.mockResolvedValue(media.stream);

    await act(async () => render(makeRoom()));

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = latest.start("audio");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest.isInCall).toBe(true);
    expect(latest.callStatus).toBe("calling");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const activeCall: ActiveCall = {
      initiatorId: session.memberId,
      initiatorAlias: "Host",
      kind: "audio",
      startedAt: Date.now(),
      participants: [session.memberId],
    };
    await act(async () => render(makeRoom(activeCall)));
    await act(async () => {
      pendingStart.resolve(makeRoom(activeCall));
      await startPromise;
    });

    await act(async () => {
      vi.advanceTimersByTime(4_100);
    });

    expect(latest.isInCall).toBe(true);
    expect(latest.callStatus).toBe("calling");
    expect(media.track.stop).not.toHaveBeenCalled();
  });

  it("ignores duplicate call-button taps while requesting media", async () => {
    const pendingMedia = deferred<MediaStream>();
    getUserMedia.mockReturnValue(pendingMedia.promise);
    const media = makeMediaStream();

    await act(async () => render(makeRoom()));

    let firstStart!: Promise<void>;
    let secondStart!: Promise<void>;
    await act(async () => {
      firstStart = latest.start("video");
      secondStart = latest.start("video");
      await Promise.resolve();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingMedia.resolve(media.stream);
      await Promise.all([firstStart, secondStart]);
    });

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      })
    );
    expect(mutationMocks.startCall).toHaveBeenCalledTimes(1);
    expect(mutationMocks.startCall).toHaveBeenCalledWith({
      roomId: session.roomId,
      inviteToken: session.inviteToken,
      memberId: session.memberId,
      kind: "video",
    });
  });
});
