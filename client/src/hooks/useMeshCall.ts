import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot } from "../../../server/temporaryRooms";
import { trpc } from "@/lib/trpc";

type Session = { roomId: string; inviteToken: string; memberId: string };
type CallKind = "audio" | "video";
type CallStatus = "calling" | "ringing" | "connected" | "ended";

type RemoteEntry = { memberId: string; stream: MediaStream };

function descriptionHasVideo(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const sdp = (payload as RTCSessionDescriptionInit).sdp;
  if (typeof sdp !== "string") return false;
  return sdp.split(/\r?\n/).some((line) => {
    if (!line.startsWith("m=video ")) return false;
    const port = Number(line.split(/\s+/, 2)[1]?.split("/")[0]);
    return Number.isFinite(port) && port > 0;
  });
}

function candidateMatchesRemoteIce(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  if (!pc.remoteDescription || !candidate.usernameFragment) return Boolean(pc.remoteDescription);
  const remoteUfrags = Array.from(pc.remoteDescription.sdp?.matchAll(/^a=ice-ufrag:([^\r\n]+)/gm) || [], (match) => match[1]);
  return remoteUfrags.includes(candidate.usernameFragment);
}

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export function useMeshCall(session: Session | null, room: RoomSnapshot | null | undefined) {
  const sendSignal = trpc.temporary.sendSignal.useMutation();
  const { refetch: refetchIceServers } = trpc.temporary.iceServers.useQuery(undefined, {
    enabled: false,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const startCall = trpc.temporary.startCall.useMutation();
  const joinCall = trpc.temporary.joinCall.useMutation();
  const endCall = trpc.temporary.endCall.useMutation();

  const [isInCall, setIsInCall] = useState(false);
  const [isInitiator, setIsInitiator] = useState(false);
  const [callKind, setCallKind] = useState<CallKind>("video");
  const [callStatus, setCallStatus] = useState<CallStatus>("ended");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteEntry[]>([]);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);
  const [isSwitchingToVideo, setIsSwitchingToVideo] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  const localRef = useRef<MediaStream | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE_SERVERS);
  const iceServersLoadedAtRef = useRef(0);
  const iceServersPromiseRef = useRef<Promise<RTCIceServer[]> | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const receivedRemoteTracksRef = useRef(new Set<string>());
  const connectingTimersRef = useRef(new Map<string, number>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const creatingRef = useRef(new Set<string>());
  const processedSignalsRef = useRef(new Set<string>());
  const signalingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const disconnectTimersRef = useRef(new Map<string, number>());
  const restartTimersRef = useRef(new Map<string, number>());
  const restartingIceRef = useRef(new Set<string>());
  const videoUpgradeTimerRef = useRef<number | undefined>(undefined);
  const videoUpgradeInProgressRef = useRef(false);
  const acceptedRef = useRef(false);
  const hadActiveCallRef = useRef(false);
  const endedCallKeyRef = useRef<string | null>(null);
  const roomCallPresentRef = useRef(Boolean(room?.call));
  const roomCallKeyRef = useRef<string | null>(room?.call ? `${room.call.initiatorId}:${room.call.startedAt}` : null);
  const missingCallTimerRef = useRef<number | undefined>(undefined);
  const sessionKeyRef = useRef(session ? `${session.roomId}:${session.memberId}` : null);
  roomCallPresentRef.current = Boolean(room?.call);
  roomCallKeyRef.current = room?.call ? `${room.call.initiatorId}:${room.call.startedAt}` : null;

  const loadIceServers = useCallback(() => {
    if (iceServersPromiseRef.current) return iceServersPromiseRef.current;
    if (Date.now() - iceServersLoadedAtRef.current < 5 * 60_000) {
      return Promise.resolve(iceServersRef.current);
    }
    const request = refetchIceServers()
      .then((result) => {
        if (result.data?.length) {
          iceServersRef.current = result.data as RTCIceServer[];
          iceServersLoadedAtRef.current = Date.now();
        }
        return iceServersRef.current;
      })
      .catch((error) => {
        console.warn("Could not load TURN configuration; trying the available STUN servers:", error);
        return iceServersRef.current;
      })
      .finally(() => {
        iceServersPromiseRef.current = null;
      });
    iceServersPromiseRef.current = request;
    return request;
  }, [refetchIceServers]);

  const send = useCallback(async (receiverId: string, type: "offer" | "answer" | "ice" | "end", payload: unknown) => {
    if (!session) return;
    await sendSignal.mutateAsync({
      roomId: session.roomId,
      inviteToken: session.inviteToken,
      memberId: session.memberId,
      receiverId,
      type,
      payload: JSON.stringify(payload),
    });
  }, [sendSignal, session]);

  const removeRemote = useCallback((memberId: string) => {
    setRemoteStreams((items) => items.filter((item) => item.memberId !== memberId));
  }, []);

  const closePeer = useCallback((memberId: string) => {
    const connectingTimer = connectingTimersRef.current.get(memberId);
    if (connectingTimer !== undefined) window.clearTimeout(connectingTimer);
    connectingTimersRef.current.delete(memberId);
    const disconnectTimer = disconnectTimersRef.current.get(memberId);
    if (disconnectTimer !== undefined) window.clearTimeout(disconnectTimer);
    disconnectTimersRef.current.delete(memberId);
    const restartTimer = restartTimersRef.current.get(memberId);
    if (restartTimer !== undefined) window.clearTimeout(restartTimer);
    restartTimersRef.current.delete(memberId);
    restartingIceRef.current.delete(memberId);
    receivedRemoteTracksRef.current.delete(memberId);
    const pc = peersRef.current.get(memberId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peersRef.current.delete(memberId);
    }
    pendingIceRef.current.delete(memberId);
    creatingRef.current.delete(memberId);
    removeRemote(memberId);
  }, [removeRemote]);

  const cleanup = useCallback(() => {
    if (missingCallTimerRef.current !== undefined) window.clearTimeout(missingCallTimerRef.current);
    missingCallTimerRef.current = undefined;
    if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
    videoUpgradeTimerRef.current = undefined;
    videoUpgradeInProgressRef.current = false;
    hadActiveCallRef.current = false;
    peersRef.current.forEach((_, memberId) => closePeer(memberId));
    peersRef.current.clear();
    pendingIceRef.current.clear();
    creatingRef.current.clear();
    restartingIceRef.current.clear();
    processedSignalsRef.current.clear();
    acceptedRef.current = false;
    localRef.current?.getTracks().forEach((track) => track.stop());
    localRef.current = null;
    setLocalStream(null);
    setRemoteStreams([]);
    setIsInCall(false);
    setIsInitiator(false);
    setIsMicMuted(false);
    setIsCamOff(false);
    setIsSwitchingToVideo(false);
    setCallError(null);
    setCallStatus("ended");
  }, [closePeer]);

  useEffect(() => {
    const nextSessionKey = session ? `${session.roomId}:${session.memberId}` : null;
    if (sessionKeyRef.current !== nextSessionKey) {
      sessionKeyRef.current = nextSessionKey;
      if (localRef.current || peersRef.current.size > 0 || isInCall) cleanup();
    }
  }, [cleanup, isInCall, session]);

  useEffect(() => () => cleanup(), [cleanup]);

  const getMedia = useCallback(async (kind: CallKind) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Media devices are unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      // Ideal constraints give capable devices a clearer 720p/30fps picture,
      // while still letting the browser adapt down on older phones or weak links.
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: { ideal: 48_000 },
        channelCount: { ideal: 2 },
      },
      ...(kind === "video"
        ? {
            video: {
              facingMode: { ideal: "user" },
              width: { ideal: 1280, max: 1920 },
              height: { ideal: 720, max: 1080 },
              frameRate: { ideal: 30, max: 30 },
              aspectRatio: { ideal: 16 / 9 },
            },
          }
        : {}),
    });
    stream.getAudioTracks().forEach((track) => { track.contentHint = "speech"; });
    stream.getVideoTracks().forEach((track) => { track.contentHint = "motion"; });
    return stream;
  }, []);

  const getCameraStream = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
        aspectRatio: { ideal: 16 / 9 },
      },
    });
    stream.getVideoTracks().forEach((track) => { track.contentHint = "motion"; });
    return stream;
  }, []);

  const configureSenderQuality = useCallback(async (sender: RTCRtpSender, kind: string) => {
    try {
      const parameters = sender.getParameters();
      const encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings = encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: kind === "video" ? 2_500_000 : 128_000,
        ...(kind === "video" ? { maxFramerate: 30 } : {}),
        priority: "high" as RTCPriorityType,
      }));
      if (kind === "video") parameters.degradationPreference = "balanced";
      await sender.setParameters(parameters);
    } catch {
      // Older WebViews may not support sender tuning; negotiated WebRTC defaults still work.
    }
  }, []);

  const attachLocalTracks = useCallback(async (pc: RTCPeerConnection, stream: MediaStream) => {
    for (const track of stream.getTracks()) {
      const existingSender = pc.getTransceivers()
        .find((transceiver) => transceiver.receiver.track?.kind === track.kind && !transceiver.sender.track)
        ?.sender;
      let sender: RTCRtpSender | undefined;
      if (existingSender) {
        await existingSender.replaceTrack(track);
        sender = existingSender;
      } else if (!pc.getSenders().some((item) => item.track?.id === track.id)) {
        sender = pc.addTrack(track, stream);
      }
      if (sender) await configureSenderQuality(sender, track.kind);
    }
  }, [configureSenderQuality]);

  const restartIce = useCallback(async (remoteId: string, pc: RTCPeerConnection) => {
    const callKey = roomCallKeyRef.current;
    if (
      !session ||
      !callKey ||
      peersRef.current.get(remoteId) !== pc ||
      pc.connectionState === "closed" ||
      restartingIceRef.current.has(remoteId)
    ) return;

    restartingIceRef.current.add(remoteId);
    const operation = signalingQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          roomCallKeyRef.current !== callKey ||
          peersRef.current.get(remoteId) !== pc ||
          pc.connectionState === "closed" ||
          pc.signalingState !== "stable"
        ) {
          restartingIceRef.current.delete(remoteId);
          return;
        }

        setCallError("Connection interrupted. Trying to reconnect…");
        const offer = await pc.createOffer({ iceRestart: true });
        if (peersRef.current.get(remoteId) !== pc || pc.signalingState !== "stable") {
          restartingIceRef.current.delete(remoteId);
          return;
        }
        await pc.setLocalDescription(offer);
        await send(remoteId, "offer", offer);
        const existingTimer = restartTimersRef.current.get(remoteId);
        if (existingTimer !== undefined) window.clearTimeout(existingTimer);
        const timer = window.setTimeout(() => {
          restartTimersRef.current.delete(remoteId);
          restartingIceRef.current.delete(remoteId);
          if (
            peersRef.current.get(remoteId) === pc &&
            pc.iceConnectionState !== "connected" &&
            pc.iceConnectionState !== "completed"
          ) {
            setCallError("Automatic reconnection did not complete. Check your network or start a new call.");
          }
        }, 15_000);
        restartTimersRef.current.set(remoteId, timer);
      });
    signalingQueueRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      restartingIceRef.current.delete(remoteId);
      if (roomCallKeyRef.current === callKey && peersRef.current.get(remoteId) === pc) {
        setCallError(error instanceof Error ? error.message : "Could not restart the call connection.");
      }
    }
  }, [send, session]);

  const createPeer = useCallback(async (remoteId: string, offerer: boolean) => {
    const callKey = roomCallKeyRef.current;
    if (!session || !callKey || !localRef.current || peersRef.current.has(remoteId) || creatingRef.current.has(remoteId)) return;
    creatingRef.current.add(remoteId);
    let pc: RTCPeerConnection;
    try {
      const iceServers = await loadIceServers();
      if (!session || !localRef.current || roomCallKeyRef.current !== callKey) {
        creatingRef.current.delete(remoteId);
        return;
      }
      pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });
    } catch (error) {
      creatingRef.current.delete(remoteId);
      throw error;
    }
    peersRef.current.set(remoteId, pc);
    const clearConnectingTimer = () => {
      const timer = connectingTimersRef.current.get(remoteId);
      if (timer !== undefined) window.clearTimeout(timer);
      connectingTimersRef.current.delete(remoteId);
    };
    const clearDisconnectTimer = () => {
      const timer = disconnectTimersRef.current.get(remoteId);
      if (timer !== undefined) window.clearTimeout(timer);
      disconnectTimersRef.current.delete(remoteId);
    };
    connectingTimersRef.current.set(remoteId, window.setTimeout(() => {
      const current = peersRef.current.get(remoteId);
      if (current === pc && !receivedRemoteTracksRef.current.has(remoteId)) {
        setCallError("The call connected without receiving audio or video. Check your network and try again.");
      }
    }, 25_000));

    // Install handlers before adding tracks or starting ICE gathering so early
    // candidates and remote tracks cannot be missed.
    pc.ontrack = (event) => {
      receivedRemoteTracksRef.current.add(remoteId);
      clearConnectingTimer();
      const stream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStreams((items) => {
        const existing = items.find((item) => item.memberId === remoteId);
        if (existing) {
          if (!existing.stream.getTracks().some((track) => track.id === event.track.id)) existing.stream.addTrack(event.track);
          return [...items];
        }
        return [...items, { memberId: remoteId, stream }];
      });
      setCallStatus("connected");
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void send(remoteId, "ice", event.candidate.toJSON()).catch((error) => {
          console.error("Failed to send WebRTC ICE candidate:", error);
          setCallError("Call signaling was interrupted. Check your connection and try again.");
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        clearDisconnectTimer();
        const restartTimer = restartTimersRef.current.get(remoteId);
        if (restartTimer !== undefined) window.clearTimeout(restartTimer);
        restartTimersRef.current.delete(remoteId);
        restartingIceRef.current.delete(remoteId);
        setCallStatus("connected");
        setCallError(null);
      } else if (pc.iceConnectionState === "disconnected") {
        if (!disconnectTimersRef.current.has(remoteId)) {
          const timer = window.setTimeout(() => {
            disconnectTimersRef.current.delete(remoteId);
            if (pc.iceConnectionState === "disconnected") void restartIce(remoteId, pc);
          }, 5_000);
          disconnectTimersRef.current.set(remoteId, timer);
        }
      } else if (pc.iceConnectionState === "failed") {
        clearDisconnectTimer();
        void restartIce(remoteId, pc);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearDisconnectTimer();
        setCallStatus("connected");
        setCallError(null);
      } else if (pc.connectionState === "failed") {
        void restartIce(remoteId, pc);
      } else if (pc.connectionState === "closed") {
        closePeer(remoteId);
      }
    };

    try {
      if (offerer) {
        const stream = localRef.current;
        if (!stream) throw new Error("Microphone or camera access is no longer available.");
        // The caller offers its tracks; the answerer adds local tracks only
        // after applying the offer so the media sections match correctly.
        await attachLocalTracks(pc, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send(remoteId, "offer", offer);
      }
    } catch (error) {
      closePeer(remoteId);
      throw error;
    } finally {
      creatingRef.current.delete(remoteId);
    }
  }, [attachLocalTracks, closePeer, loadIceServers, restartIce, send, session]);

  const flushIce = useCallback(async (memberId: string, pc: RTCPeerConnection) => {
    const queued = pendingIceRef.current.get(memberId) || [];
    pendingIceRef.current.delete(memberId);
    for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
  }, []);

  const accept = useCallback(async () => {
    if (!session || !room?.call || acceptedRef.current) return;
    acceptedRef.current = true;
    setCallError(null);
    const kind = room.call.kind;
    setCallKind(kind);
    setCallStatus("calling");
    try {
      void loadIceServers();
      const stream = await getMedia(kind);
      localRef.current = stream;
      setLocalStream(stream);
      await joinCall.mutateAsync({ roomId: session.roomId, inviteToken: session.inviteToken, memberId: session.memberId });
      setIsInCall(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to access your microphone or camera.";
      cleanup();
      setCallError(message);
    }
  }, [cleanup, getMedia, joinCall, loadIceServers, room, session]);

  const start = useCallback(async (kind: CallKind) => {
    if (!session || !room || room.participantCount < 2 || isInCall) return;
    cleanup();
    setCallError(null);
    try {
      void loadIceServers();
      const stream = await getMedia(kind);
      localRef.current = stream;
      setLocalStream(stream);
      setCallKind(kind);
      setIsInitiator(true);
      setIsInCall(true);
      setCallStatus("calling");
      await startCall.mutateAsync({ roomId: session.roomId, inviteToken: session.inviteToken, memberId: session.memberId, kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start the call. Check microphone and camera permissions.";
      cleanup();
      setCallError(message);
    }
  }, [cleanup, getMedia, isInCall, loadIceServers, room, session, startCall]);

  const switchToVideo = useCallback(async () => {
    if (
      !session ||
      !room?.call ||
      !isInCall ||
      videoUpgradeInProgressRef.current ||
      callStatus !== "connected"
    ) return;

    const callKey = `${room.call.initiatorId}:${room.call.startedAt}`;
    const remoteId = room.call.participants.find((id) => id !== session.memberId);
    const currentStream = localRef.current;
    const pc = remoteId ? peersRef.current.get(remoteId) : undefined;
    if (!remoteId || !currentStream || !pc) {
      setCallError("The active call stream is not ready for a video upgrade.");
      return;
    }
    if (currentStream.getVideoTracks().some((track) => track.readyState === "live")) return;

    videoUpgradeInProgressRef.current = true;
    setIsSwitchingToVideo(true);
    setCallError(null);
    let cameraStream: MediaStream | null = null;
    let videoTrack: MediaStreamTrack | undefined;
    let localOfferSet = false;
    const upgradedStream = new MediaStream();

    try {
      cameraStream = await getCameraStream();
      videoTrack = cameraStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("No camera video track is available.");
      for (const track of [...currentStream.getTracks(), videoTrack]) upgradedStream.addTrack(track);

      const operation = signalingQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (
            roomCallKeyRef.current !== callKey ||
            peersRef.current.get(remoteId) !== pc ||
            pc.connectionState === "closed"
          ) throw new Error("The call ended before video could be added.");
          if (pc.signalingState !== "stable") throw new Error("The call is still negotiating. Try adding video again in a moment.");

          await attachLocalTracks(pc, upgradedStream);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          localOfferSet = true;
          await send(remoteId, "offer", offer);
          if (
            roomCallKeyRef.current !== callKey ||
            peersRef.current.get(remoteId) !== pc
          ) throw new Error("The call ended before video could be added.");
          localRef.current = upgradedStream;
          setLocalStream(upgradedStream);
          setCallKind("video");
        });
      signalingQueueRef.current = operation.catch((error) => {
        console.error("Failed to add video to the call:", error);
      });
      await operation;

      if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
      videoUpgradeTimerRef.current = window.setTimeout(() => {
        videoUpgradeTimerRef.current = undefined;
        videoUpgradeInProgressRef.current = false;
        setIsSwitchingToVideo(false);
        setCallError("Video has not been confirmed by the other participant yet. Your audio call may still be active.");
      }, 25_000);
    } catch (error) {
      const failedVideoTrack = videoTrack;
      const callStillActive =
        roomCallKeyRef.current === callKey &&
        peersRef.current.get(remoteId) === pc &&
        pc.connectionState !== "closed";
      if (failedVideoTrack && (!localOfferSet || !callStillActive)) {
        if (!localOfferSet && pc.connectionState !== "closed") {
          const sender = pc.getSenders().find((item) => item.track?.id === failedVideoTrack.id);
          if (sender) pc.removeTrack(sender);
        }
        failedVideoTrack.stop();
      } else if (localOfferSet && callStillActive) {
        // Keep the offered track alive if signaling failed after local SDP was
        // installed; the remote peer may still receive and answer that offer.
        localRef.current = upgradedStream;
        setLocalStream(upgradedStream);
        setCallKind("video");
      }
      videoUpgradeInProgressRef.current = false;
      setIsSwitchingToVideo(false);
      setCallError(error instanceof Error ? error.message : "Could not add video to this call.");
    }
  }, [attachLocalTracks, callStatus, getCameraStream, isInCall, room, send, session]);

  const hangup = useCallback(async () => {
    if (session) {
      await send("all", "end", {}).catch(() => undefined);
      await endCall.mutateAsync({ roomId: session.roomId, inviteToken: session.inviteToken, memberId: session.memberId }).catch(() => undefined);
    }
    cleanup();
  }, [cleanup, endCall, send, session]);

  const reject = hangup;

  useEffect(() => {
    if (!session || !room) return;
    if (room.call) {
      const callKey = `${room.call.initiatorId}:${room.call.startedAt}`;
      if (missingCallTimerRef.current !== undefined) {
        window.clearTimeout(missingCallTimerRef.current);
        missingCallTimerRef.current = undefined;
      }
      if (endedCallKeyRef.current === callKey) {
        hadActiveCallRef.current = false;
      } else {
        endedCallKeyRef.current = null;
        hadActiveCallRef.current = true;
        if (room.call.kind !== callKind && !isInCall) setCallKind(room.call.kind);
        if (room.call.kind === "video") setCallKind("video");
        if (room.call.initiatorId !== session.memberId && !isInCall) {
          setCallStatus("ringing");
          setIsInCall(true);
        }
        if (isInCall && localRef.current) {
          for (const remoteId of room.call.participants.filter((id) => id !== session.memberId)) {
            // The caller creates the initial offer. Later offers can come from
            // either peer for camera upgrades or ICE restarts.
            if (room.call.initiatorId === session.memberId) {
              void createPeer(remoteId, true).catch((error) => {
                console.error("Failed to create the WebRTC connection:", error);
                setCallError(error instanceof Error ? error.message : "Could not start the media connection.");
              });
            }
          }
        }
      }
    } else {
      endedCallKeyRef.current = null;
      if (isInCall && hadActiveCallRef.current && missingCallTimerRef.current === undefined) {
        // Only start teardown grace after an active server call was observed;
        // the initial create/start request is not a missing-call condition.
        missingCallTimerRef.current = window.setTimeout(() => {
          missingCallTimerRef.current = undefined;
          if (!roomCallPresentRef.current) cleanup();
        }, 4000);
      }
    }

    const processSignals = async () => {
      for (const signal of room.signals || []) {
        if (processedSignalsRef.current.has(signal.id) || signal.senderId === session.memberId) continue;
        if (signal.receiverId !== "all" && signal.receiverId !== session.memberId) continue;
        const payload = JSON.parse(signal.payload);
        if (signal.type === "end") {
          if (room.call) endedCallKeyRef.current = `${room.call.initiatorId}:${room.call.startedAt}`;
          cleanup();
          // cleanup resets signal bookkeeping for the next call; retain this
          // end marker until the server removes the active call snapshot.
          processedSignalsRef.current.add(signal.id);
          continue;
        }
        // The initiator can send an offer while the callee is still deciding
        // whether to grant microphone/camera access. Keep the signal queued by
        // leaving it unprocessed until local media exists.
        if (!localRef.current) continue;
        if (signal.type === "offer") {
          await createPeer(signal.senderId, false);
          const pc = peersRef.current.get(signal.senderId);
          if (!pc) continue;
          if (pc.remoteDescription?.sdp === payload.sdp) {
            processedSignalsRef.current.add(signal.id);
            continue;
          }

          // Use the standard polite/impolite offer-collision rule. It allows
          // either caller to add video or restart ICE without simultaneous
          // offers leaving both RTCPeerConnections stuck in have-local-offer.
          const offerCollision = pc.signalingState !== "stable";
          const polite = room.call?.initiatorId !== session.memberId;
          if (offerCollision && !polite) {
            processedSignalsRef.current.add(signal.id);
            continue;
          }
          if (offerCollision && polite) {
            try {
              await pc.setLocalDescription({ type: "rollback" });
            } catch {
              // Some WebViews perform rollback implicitly when applying a remote offer.
            }
          }

          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          const stream = localRef.current;
          if (stream) await attachLocalTracks(pc, stream);
          await flushIce(signal.senderId, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await send(signal.senderId, "answer", answer);
          if (descriptionHasVideo(payload)) {
            setCallKind("video");
            videoUpgradeInProgressRef.current = false;
            if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
            videoUpgradeTimerRef.current = undefined;
            setIsSwitchingToVideo(false);
          } else if (
            localRef.current?.getVideoTracks().some((track) => track.readyState === "live") &&
            pc.signalingState === "stable"
          ) {
            // A polite rollback may have chosen an audio-only offer over our
            // pending camera offer. Re-offer the retained camera track now.
            const videoOffer = await pc.createOffer();
            await pc.setLocalDescription(videoOffer);
            await send(signal.senderId, "offer", videoOffer);
          }
          restartingIceRef.current.delete(signal.senderId);
          const restartTimer = restartTimersRef.current.get(signal.senderId);
          if (restartTimer !== undefined) window.clearTimeout(restartTimer);
          restartTimersRef.current.delete(signal.senderId);
        } else if (signal.type === "answer") {
          const pc = peersRef.current.get(signal.senderId);
          if (!pc) continue;
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(payload));
            await flushIce(signal.senderId, pc);
            restartingIceRef.current.delete(signal.senderId);
            const restartTimer = restartTimersRef.current.get(signal.senderId);
            if (restartTimer !== undefined) window.clearTimeout(restartTimer);
            restartTimersRef.current.delete(signal.senderId);
            if (descriptionHasVideo(payload)) {
              setCallKind("video");
              videoUpgradeInProgressRef.current = false;
              if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
              videoUpgradeTimerRef.current = undefined;
              setIsSwitchingToVideo(false);
            }
          }
        } else if (signal.type === "ice") {
          const pc = peersRef.current.get(signal.senderId);
          if (pc && candidateMatchesRemoteIce(pc, payload)) {
            await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => undefined);
          } else {
            pendingIceRef.current.set(signal.senderId, [...(pendingIceRef.current.get(signal.senderId) || []), payload]);
          }
        }
        processedSignalsRef.current.add(signal.id);
      }

      // The server also anchors the latest offer and answer on the call
      // snapshot. Recover from a dropped SSE signal without requiring users to
      // hang up and redial.
      if (localRef.current && room.call) {
        const remoteId = room.call.participants.find((id) => id !== session.memberId);
        const offererId = room.call.offererId || room.call.initiatorId;
        if (remoteId && room.call.offer && offererId !== session.memberId) {
          await createPeer(remoteId, false);
          const pc = peersRef.current.get(remoteId);
          const offer = JSON.parse(room.call.offer);
          if (pc && pc.remoteDescription?.sdp !== offer.sdp) {
            const offerCollision = pc.signalingState !== "stable";
            const polite = room.call.initiatorId !== session.memberId;
            if (!offerCollision || polite) {
              if (offerCollision && polite) {
                try {
                  await pc.setLocalDescription({ type: "rollback" });
                } catch {
                  // Some WebViews roll back implicitly on setRemoteDescription(offer).
                }
              }
              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              const stream = localRef.current;
              if (stream) await attachLocalTracks(pc, stream);
              await flushIce(remoteId, pc);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await send(remoteId, "answer", answer);
              if (descriptionHasVideo(offer)) {
                setCallKind("video");
                videoUpgradeInProgressRef.current = false;
                if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
                videoUpgradeTimerRef.current = undefined;
                setIsSwitchingToVideo(false);
              } else if (
                localRef.current?.getVideoTracks().some((track) => track.readyState === "live") &&
                pc.signalingState === "stable"
              ) {
                const videoOffer = await pc.createOffer();
                await pc.setLocalDescription(videoOffer);
                await send(remoteId, "offer", videoOffer);
              }
              restartingIceRef.current.delete(remoteId);
              const restartTimer = restartTimersRef.current.get(remoteId);
              if (restartTimer !== undefined) window.clearTimeout(restartTimer);
              restartTimersRef.current.delete(remoteId);
            }
          }
        }
        if (remoteId && room.call.answer && room.call.answererId !== session.memberId) {
          const pc = peersRef.current.get(remoteId);
          if (pc && pc.signalingState === "have-local-offer") {
            const answer = JSON.parse(room.call.answer);
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            await flushIce(remoteId, pc);
            if (descriptionHasVideo(answer)) {
              setCallKind("video");
              videoUpgradeInProgressRef.current = false;
              if (videoUpgradeTimerRef.current !== undefined) window.clearTimeout(videoUpgradeTimerRef.current);
              videoUpgradeTimerRef.current = undefined;
              setIsSwitchingToVideo(false);
            }
            restartingIceRef.current.delete(remoteId);
            const restartTimer = restartTimersRef.current.get(remoteId);
            if (restartTimer !== undefined) window.clearTimeout(restartTimer);
            restartTimersRef.current.delete(remoteId);
          }
        }
      }
    };
    // SSE updates can arrive while an offer/answer is still being applied. Queue
    // snapshots so two effect runs never call setRemoteDescription concurrently.
    signalingQueueRef.current = signalingQueueRef.current
      .catch(() => undefined)
      .then(processSignals)
      .catch((error) => {
        console.error("Failed to process WebRTC signaling:", error);
        setCallError(error instanceof Error ? error.message : "Call setup failed. Please try again.");
      });
  }, [attachLocalTracks, callKind, cleanup, createPeer, flushIce, isInCall, room, send, session]);

  return {
    isInCall,
    isInitiator,
    callKind,
    callStatus,
    localStream,
    remoteStreams,
    callError,
    isMicMuted,
    isCamOff,
    isSwitchingToVideo,
    start,
    switchToVideo,
    accept,
    reject,
    hangup,
    toggleMic: () => {
      const track = localRef.current?.getAudioTracks()[0];
      if (track) { track.enabled = !track.enabled; setIsMicMuted(!track.enabled); }
    },
    toggleCam: () => {
      const track = localRef.current?.getVideoTracks()[0];
      if (track) { track.enabled = !track.enabled; setIsCamOff(!track.enabled); }
    },
  };
}
