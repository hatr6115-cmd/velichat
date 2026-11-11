// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveCall,
  CallSignal,
  RoomSnapshot,
} from "../../../server/temporaryRooms";
import { useMeshCall } from "./useMeshCall";
import { FakeRTCPeerConnection, fakeStream } from "@/test/fakeWebRtc";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    temporary: {
      sendSignal: {
        useMutation: () => ({ mutateAsync: mutations.sendSignal }),
      },
      startCall: { useMutation: () => ({ mutateAsync: mutations.startCall }) },
      joinCall: { useMutation: () => ({ mutateAsync: mutations.joinCall }) },
      endCall: { useMutation: () => ({ mutateAsync: mutations.endCall }) },
    },
  },
}));

type Session = NonNullable<Parameters<typeof useMeshCall>[0]>;
type CallHook = ReturnType<typeof useMeshCall>;

type FakeServer = {
  startCall: (input: {
    memberId: string;
    kind: "audio" | "video";
  }) => Promise<RoomSnapshot>;
  joinCall: (input: { memberId: string }) => Promise<RoomSnapshot>;
  sendSignal: (input: {
    memberId: string;
    receiverId: string;
    type: CallSignal["type"];
  }) => Promise<unknown>;
  endCall: (input: { memberId: string }) => Promise<RoomSnapshot>;
  subscribe: (
    memberId: string,
    onChange: (snapshot: RoomSnapshot) => void
  ) => () => void;
  setHalfOpen: (value: boolean) => void;
  duplicateOffer: (memberId: string) => void;
};

const mutations = {
  startCall: vi.fn(),
  joinCall: vi.fn(),
  sendSignal: vi.fn(),
  endCall: vi.fn(),
};

let currentServer: FakeServer;

function createFakeServer(members: Session[]): FakeServer {
  let call: ActiveCall | undefined;
  let signals: CallSignal[] = [];
  const subscribers = new Map<string, Set<(snapshot: RoomSnapshot) => void>>();
  let halfOpen = false;

  const aliases: Record<string, string> = {};
  members.forEach((member, index) => {
    aliases[member.memberId] = index === 0 ? "Host" : "Guest";
  });

  const snapshotFor = (memberId: string): RoomSnapshot => ({
    roomId: "room-123456789",
    hostAlias: "Host",
    guestAlias: "Guest",
    guestAliases: ["Guest"],
    currentMemberId: memberId,
    currentAlias: aliases[memberId],
    participantCount: members.length,
    typingAliases: [],
    messages: [],
    media: [],
    call: call ? { ...call, participants: [...call.participants] } : undefined,
    signals: signals.filter(
      signal => signal.receiverId === memberId || signal.receiverId === "all"
    ),
  });

  const notify = () => {
    subscribers.forEach((set, memberId) => {
      set.forEach(listener => listener(snapshotFor(memberId)));
    });
  };

  return {
    startCall: async input => {
      if (call) {
        if (call.initiatorId === input.memberId && call.kind === input.kind)
          return snapshotFor(input.memberId);
        throw new Error("A call is already active in this room.");
      }
      call = {
        initiatorId: input.memberId,
        initiatorAlias: aliases[input.memberId],
        kind: input.kind,
        startedAt: Date.now(),
        participants: [input.memberId],
      };
      signals = [];
      notify();
      return snapshotFor(input.memberId);
    },
    joinCall: async input => {
      if (!call) throw new Error("No active call in this room.");
      if (!call.participants.includes(input.memberId))
        call.participants = [...call.participants, input.memberId];
      notify();
      return snapshotFor(input.memberId);
    },
    sendSignal: async input => {
      const signal: CallSignal = {
        id: `signal-${signals.length}-${input.type}`,
        senderId: input.memberId,
        receiverId: input.receiverId,
        type: input.type,
        payload: (
          mutations.sendSignal.mock.calls.at(-1)?.[0] as { payload: string }
        ).payload,
        timestamp: Date.now(),
      };
      if (call) {
        if (input.type === "offer") call.offer = signal.payload;
        if (input.type === "answer") call.answer = signal.payload;
      }
      signals.push(signal);
      if (halfOpen) {
        // Mimic a flaky SSE stream: the signal is stored server-side but the
        // receiver never gets told about it.
        return { success: true };
      }
      notify();
      return { success: true };
    },
    endCall: async () => {
      call = undefined;
      signals = [];
      notify();
      return snapshotFor(members[0].memberId);
    },
    subscribe: (memberId, onChange) => {
      if (!subscribers.has(memberId)) subscribers.set(memberId, new Set());
      subscribers.get(memberId)!.add(onChange);
      // The real SSE endpoint sends the current snapshot immediately.
      onChange(snapshotFor(memberId));
      return () => subscribers.get(memberId)?.delete(onChange);
    },
    setHalfOpen: value => {
      halfOpen = value;
    },
    duplicateOffer: memberId => {
      const offer = signals.find(signal => signal.type === "offer");
      if (!offer) return;
      signals.push({ ...offer, id: `${offer.id}-dup` });
      subscribers
        .get(memberId)
        ?.forEach(listener => listener(snapshotFor(memberId)));
    },
  };
}

const caller: Session = {
  roomId: "room-123456789",
  inviteToken: "invite-token-123456789",
  memberId: "caller-123456",
};
const callee: Session = {
  roomId: "room-123456789",
  inviteToken: "invite-token-123456789",
  memberId: "callee-123456",
};

function Peer({
  session,
  onSnapshot,
  onResult,
}: {
  session: Session;
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onResult: (hook: CallHook) => void;
}) {
  const [room, setRoom] = React.useState<RoomSnapshot | null>(null);
  const streamRef = React.useRef(onSnapshot);
  streamRef.current = onSnapshot;
  React.useEffect(() => {
    return currentServer.subscribe(session.memberId, snapshot => {
      setRoom(snapshot);
      streamRef.current(snapshot);
    });
  }, [session.memberId]);
  onResult(useMeshCall(session, room));
  return null;
}

function makeRoot() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("mesh call negotiation", () => {
  let callerRoot: Root;
  let calleeRoot: Root;
  let callerHook: CallHook;
  let calleeHook: CallHook;
  let getUserMedia: ReturnType<typeof vi.fn>;

  function renderPeer(
    root: Root,
    session: Session,
    assign: (hook: CallHook) => void
  ) {
    root.render(
      <Peer session={session} onSnapshot={() => undefined} onResult={assign} />
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    FakeRTCPeerConnection.reset();
    (
      globalThis as unknown as { RTCPeerConnection: unknown }
    ).RTCPeerConnection = FakeRTCPeerConnection;
    (
      globalThis as unknown as { RTCSessionDescription: unknown }
    ).RTCSessionDescription = class {
      type: string;
      sdp: string;
      constructor(init: { type: string; sdp: string }) {
        this.type = init.type;
        this.sdp = init.sdp;
      }
    };
    (globalThis as unknown as { RTCIceCandidate: unknown }).RTCIceCandidate =
      class {
        candidate: string;
        constructor(init: { candidate: string }) {
          this.candidate = init.candidate;
        }
      };

    currentServer = createFakeServer([caller, callee]);
    mutations.startCall.mockImplementation(currentServer.startCall);
    mutations.joinCall.mockImplementation(currentServer.joinCall);
    mutations.sendSignal.mockImplementation(currentServer.sendSignal);
    mutations.endCall.mockImplementation(currentServer.endCall);

    getUserMedia = vi.fn(async () => fakeStream("audio", "video"));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const callerRootRef = makeRoot();
    const calleeRootRef = makeRoot();
    callerRoot = callerRootRef.root;
    calleeRoot = calleeRootRef.root;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      callerRoot.unmount();
      calleeRoot.unmount();
    });
    vi.useRealTimers();
  });

  async function connect(kind: "audio" | "video") {
    await act(async () => {
      renderPeer(callerRoot, caller, hook => {
        callerHook = hook;
      });
      renderPeer(calleeRoot, callee, hook => {
        calleeHook = hook;
      });
      await settle();
    });

    await act(async () => {
      await callerHook.start(kind);
      await settle();
    });

    await act(async () => {
      calleeHook.accept();
      await settle(40);
    });
  }

  it("delivers both directions of a video call", async () => {
    await connect("video");

    expect(calleeHook.callStatus).toBe("connected");
    expect(callerHook.callStatus).toBe("connected");

    // The caller must also receive the receiver's camera, not just send its own.
    const callerRemote = callerHook.remoteStreams[0]?.stream;
    expect(callerRemote, "caller never received a remote stream").toBeDefined();
    expect(callerRemote!.getAudioTracks()).toHaveLength(1);
    expect(callerRemote!.getVideoTracks()).toHaveLength(1);
    const calleeRemote = calleeHook.remoteStreams[0]?.stream;
    expect(
      calleeRemote,
      "receiver never received a remote stream"
    ).toBeDefined();
    expect(calleeRemote!.getAudioTracks()).toHaveLength(1);
    expect(calleeRemote!.getVideoTracks()).toHaveLength(1);

    for (const connection of FakeRTCPeerConnection.registry) {
      const sending = connection
        .getTransceivers()
        .filter(transceiver => transceiver.sender.track);
      expect(sending.length).toBeGreaterThan(0);
      for (const transceiver of sending) {
        // A track attached to a recvonly transceiver is never transmitted.
        expect(transceiver.currentDirection).toBe("sendrecv");
      }
    }
  });

  it("delivers audio only for a voice call", async () => {
    getUserMedia.mockResolvedValue(fakeStream("audio"));
    await connect("audio");

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.not.objectContaining({ video: expect.anything() })
    );
    expect(callerHook.callStatus).toBe("connected");
    expect(calleeHook.callStatus).toBe("connected");
    expect(
      callerHook.remoteStreams[0],
      "caller never received a remote stream"
    ).toBeDefined();
    expect(
      calleeHook.remoteStreams[0],
      "receiver never received a remote stream"
    ).toBeDefined();
    expect(callerHook.remoteStreams[0].stream.getAudioTracks()).toHaveLength(1);
    expect(calleeHook.remoteStreams[0].stream.getAudioTracks()).toHaveLength(1);
    expect(callerHook.remoteStreams[0].stream.getVideoTracks()).toHaveLength(0);
  });

  it("does not duplicate media sections when the offer arrives twice", async () => {
    await act(async () => {
      renderPeer(callerRoot, caller, hook => {
        callerHook = hook;
      });
      renderPeer(calleeRoot, callee, hook => {
        calleeHook = hook;
      });
      await settle();
    });

    await act(async () => {
      await callerHook.start("video");
      await settle();
    });

    // The answerer misses the offer, then the server snapshot replays it while
    // the offer signal itself is delivered again: both paths run concurrently.
    currentServer.setHalfOpen(true);
    await act(async () => {
      calleeHook.accept();
      await settle();
    });
    currentServer.setHalfOpen(false);
    await act(async () => {
      currentServer.duplicateOffer(callee.memberId);
      await settle(40);
    });

    expect(calleeHook.callStatus).toBe("connected");
    expect(
      callerHook.remoteStreams[0],
      "caller never received a remote stream"
    ).toBeDefined();

    // Exactly one audio and one video section, so the camera is not re-sent on
    // an unnegotiated m-line (which would leave the caller without video).
    const answerer = FakeRTCPeerConnection.registry.find(
      connection => connection.localDescription?.type === "answer"
    );
    expect(answerer).toBeDefined();
    const kinds = answerer!
      .getTransceivers()
      .map(transceiver => transceiver.receiver.track.kind);
    expect(kinds.filter(kind => kind === "video")).toHaveLength(1);
    expect(kinds.filter(kind => kind === "audio")).toHaveLength(1);
  });

  it("recovers when the receiver misses the offer signal", async () => {
    await act(async () => {
      renderPeer(callerRoot, caller, hook => {
        callerHook = hook;
      });
      renderPeer(calleeRoot, callee, hook => {
        calleeHook = hook;
      });
      await settle();
    });

    // The server stores the offer but the callee's SSE stream drops it.
    currentServer.setHalfOpen(true);
    await act(async () => {
      await callerHook.start("video");
      await settle();
    });

    currentServer.setHalfOpen(false);
    await act(async () => {
      calleeHook.accept();
      await settle(40);
    });

    expect(calleeHook.callStatus).toBe("connected");
    expect(callerHook.callStatus).toBe("connected");
    expect(
      callerHook.remoteStreams[0],
      "caller never received a remote stream"
    ).toBeDefined();
    expect(
      calleeHook.remoteStreams[0],
      "receiver never received a remote stream"
    ).toBeDefined();
    expect(callerHook.remoteStreams[0].stream.getVideoTracks()).toHaveLength(1);
    expect(calleeHook.remoteStreams[0].stream.getVideoTracks()).toHaveLength(1);
  });
});
