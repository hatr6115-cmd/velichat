/**
 * Minimal, spec-shaped fake of the WebRTC peer connection API.
 *
 * Node has no RTCPeerConnection, so the call hook can only be exercised
 * end-to-end if we model the parts of the spec it depends on:
 *
 *  - addTrack() creates/uses a sending transceiver.
 *  - A transceiver created by setRemoteDescription(offer) has direction
 *    "recvonly": it receives the remote offer's media section.
 *  - replaceTrack() attaches a local track to a sender but does NOT change the
 *    transceiver direction, so an answer to a recvonly transceiver is still
 *    recvonly and sends nothing. Only changing `direction` makes it send.
 *  - ontrack fires when a remote media section becomes available: on the
 *    answerer when the offer is applied, on the offerer when the answer is
 *    applied and the answer says the peer sends.
 *  - ICE (and therefore the connection) only completes once both sides have
 *    each other's descriptions and candidates.
 *
 * These rules are what make the "Connecting stream…" failure reproducible.
 */

type Kind = "audio" | "video";
type Direction = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export type FakeScenario = {
  /** Fail ICE, e.g. to mimic a blocked network. */
  failConnect?: boolean;
};

class FakeTrack extends EventTarget {
  id = `track-${Math.random().toString(36).slice(2)}`;
  enabled = true;
  readyState: "live" | "ended" = "live";
  constructor(public kind: Kind) {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
  clone() {
    return this;
  }
}

export class FakeMediaStream {
  id = `stream-${Math.random().toString(36).slice(2)}`;
  private tracks: FakeTrack[] = [];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter(t => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter(t => t.kind === "video");
  }
  addTrack(track: FakeTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
}

export function fakeStream(...kinds: Kind[]) {
  return new FakeMediaStream(
    kinds.map(k => new FakeTrack(k))
  ) as unknown as MediaStream;
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(track: FakeTrack | null) {
    this.track = track;
  }
  getParameters() {
    return { encodings: [] };
  }
}

class FakeReceiver {
  track: FakeTrack;
  constructor(kind: Kind) {
    this.track = new FakeTrack(kind);
  }
}

class FakeTransceiver {
  sender: FakeSender;
  receiver: FakeReceiver;
  direction: Direction;
  currentDirection: Direction | null = null;
  mid: string | null = null;
  constructor(
    public kind: Kind,
    senderTrack: FakeTrack | null,
    direction: Direction
  ) {
    this.sender = new FakeSender(senderTrack);
    this.receiver = new FakeReceiver(kind);
    this.direction = direction;
  }
  get sends() {
    return (
      Boolean(this.sender.track) &&
      (this.direction === "sendrecv" || this.direction === "sendonly")
    );
  }
}

type Description = { type: "offer" | "answer"; sdp: string };
export type Candidate = {
  candidate: string;
  toJSON: () => { candidate: string };
};

function parseSections(sdp: string): { kind: Kind; direction: Direction }[] {
  const sections: { kind: Kind; direction: Direction }[] = [];
  for (const line of sdp.split("\r\n")) {
    const media = /^m=(audio|video)/.exec(line);
    if (media) sections.push({ kind: media[1] as Kind, direction: "recvonly" });
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)/.exec(line);
    if (direction && sections.length)
      sections[sections.length - 1].direction = direction[1] as Direction;
  }
  return sections;
}

function buildSdp(sections: { kind: Kind; direction: Direction }[]) {
  return sections
    .map(
      section =>
        `m=${section.kind} 9 UDP/TLS/RTP/SAVPF\r\na=${section.direction}`
    )
    .join("\r\n");
}

export class FakeRTCPeerConnection extends EventTarget {
  static registry: FakeRTCPeerConnection[] = [];

  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  signalingState = "stable";
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  ontrack:
    | ((event: { track: FakeTrack; streams: FakeMediaStream[] }) => void)
    | null = null;
  onicecandidate: ((event: { candidate: Candidate | null }) => void) | null =
    null;
  onicecandidateerror: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  private transceivers: FakeTransceiver[] = [];
  private remoteCandidates: Candidate[] = [];
  private scenario: FakeScenario;

  constructor(
    public config?: unknown,
    scenario: FakeScenario = {}
  ) {
    super();
    this.scenario = scenario;
    FakeRTCPeerConnection.registry.push(this);
  }

  static reset() {
    FakeRTCPeerConnection.registry = [];
  }

  addTrack(track: FakeTrack, stream?: FakeMediaStream) {
    void stream;
    // Reuse a compatible transceiver that is not already sending, mirroring
    // how browsers avoid creating needless additional media sections.
    const reusable = this.transceivers.find(
      t => t.kind === track.kind && !t.sender.track
    );
    if (reusable) {
      reusable.sender.track = track;
      reusable.direction =
        reusable.direction === "recvonly" ? "sendrecv" : reusable.direction;
      if (reusable.direction === "inactive") reusable.direction = "sendonly";
      return reusable.sender as unknown as RTCRtpSender;
    }
    const transceiver = new FakeTransceiver(track.kind, track, "sendrecv");
    this.transceivers.push(transceiver);
    return transceiver.sender as unknown as RTCRtpSender;
  }

  getSenders() {
    return this.transceivers.map(t => t.sender) as unknown as RTCRtpSender[];
  }

  getTransceivers() {
    return this.transceivers as unknown as RTCRtpTransceiver[];
  }

  getReceivers() {
    return this.transceivers.map(
      t => t.receiver
    ) as unknown as RTCRtpReceiver[];
  }

  async createOffer() {
    if (!this.transceivers.length) {
      this.transceivers.push(new FakeTransceiver("audio", null, "recvonly"));
      this.transceivers.push(new FakeTransceiver("video", null, "recvonly"));
    }
    const sdp = buildSdp(
      this.transceivers.map(t => ({
        kind: t.kind,
        direction: t.sends
          ? t.direction === "sendonly"
            ? "sendonly"
            : "sendrecv"
          : "recvonly",
      }))
    );
    return { type: "offer", sdp } as RTCSessionDescriptionInit;
  }

  async createAnswer() {
    const sdp = buildSdp(
      this.transceivers.map(t => ({ kind: t.kind, direction: t.direction }))
    );
    return { type: "answer", sdp } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(description: Description) {
    if (description.type === "offer" && this.signalingState !== "stable") {
      throw new Error(`cannot offer in ${this.signalingState}`);
    }
    if (
      description.type === "answer" &&
      this.signalingState !== "have-remote-offer"
    ) {
      throw new Error(`cannot answer in ${this.signalingState}`);
    }
    this.localDescription = description;
    this.signalingState =
      description.type === "offer" ? "have-local-offer" : "stable";
    this.transceivers.forEach((transceiver, index) => {
      transceiver.mid = String(index);
      transceiver.currentDirection = transceiver.direction;
    });
    this.emitCandidates();
    this.maybeConnect();
  }

  async setRemoteDescription(description: Description) {
    this.remoteDescription = description;

    if (description.type === "offer") {
      this.signalingState = "have-remote-offer";
      parseSections(description.sdp).forEach((section, index) => {
        const existing = this.transceivers.find(t => t.kind === section.kind);
        const transceiver =
          existing ?? new FakeTransceiver(section.kind, null, "recvonly");
        if (!existing) this.transceivers.push(transceiver);
        transceiver.mid = String(index);
        this.ontrack?.({
          track: transceiver.receiver.track,
          streams: [new FakeMediaStream([transceiver.receiver.track])],
        });
      });
    } else {
      this.signalingState = "stable";
      // The offerer learns from the answer which media sections the answerer
      // will actually send on. Only those fire ontrack.
      const sections = parseSections(description.sdp);
      sections.forEach((section, index) => {
        const transceiver = this.transceivers[index];
        if (!transceiver) return;
        transceiver.currentDirection = section.direction;
        if (
          section.direction === "sendrecv" ||
          section.direction === "sendonly"
        ) {
          this.ontrack?.({
            track: transceiver.receiver.track,
            streams: [new FakeMediaStream([transceiver.receiver.track])],
          });
        }
      });
    }

    this.emitCandidates();
    this.maybeConnect();
  }

  async addIceCandidate(candidate: Candidate) {
    this.remoteCandidates.push(candidate);
    this.maybeConnect();
  }

  private emitCandidates() {
    if (!this.localDescription) return;
    this.iceGatheringState = "gathering";
    for (let i = 0; i < 2; i += 1) {
      const value = `candidate:${i}`;
      this.onicecandidate?.({
        candidate: { candidate: value, toJSON: () => ({ candidate: value }) },
      });
    }
    this.onicecandidate?.({ candidate: null });
    this.iceGatheringState = "complete";
  }

  private setConnection(state: "connecting" | "connected" | "failed") {
    this.connectionState = state;
    this.iceConnectionState = state;
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  private maybeConnect() {
    if (
      this.connectionState === "connected" ||
      this.connectionState === "failed"
    )
      return;
    if (this.scenario.failConnect) {
      this.setConnection("failed");
      return;
    }
    if (
      !this.localDescription ||
      !this.remoteDescription ||
      !this.remoteCandidates.length
    )
      return;
    this.setConnection("connected");
  }

  close() {
    this.connectionState = "closed";
    this.signalingState = "closed";
    this.ontrack = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
  }
}
