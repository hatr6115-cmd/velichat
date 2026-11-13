import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot } from "../../../server/temporaryRooms";
import { trpc } from "@/lib/trpc";

type Session = { roomId: string; inviteToken: string; memberId: string };
type CallKind = "audio" | "video";
type CallStatus = "calling" | "ringing" | "connected" | "ended";

type RemoteEntry = { memberId: string; stream: MediaStream };

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
    hadActiveCallRef.current = false;
    peersRef.current.forEach((_, memberId) => closePeer(memberId));
    peersRef.current.clear();
    pendingIceRef.current.clear();
    creatingRef.current.clear();
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
        setCallStatus("connected");
        setCallError(null);
      }
      if (pc.iceConnectionState === "failed") {
        setCallError("The call could not establish a network connection. Please try again.");
        closePeer(remoteId);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setCallStatus("connected");
        setCallError(null);
      }
      if (pc.connectionState === "failed") {
        setCallError("The call connection failed. Check your network and try again.");
        closePeer(remoteId);
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
  }, [attachLocalTracks, closePeer, loadIceServers, send, session]);

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
        if (room.call.initiatorId !== session.memberId && !isInCall) {
          setCallStatus("ringing");
          setIsInCall(true);
        }
        if (isInCall && localRef.current) {
          for (const remoteId of room.call.participants.filter((id) => id !== session.memberId)) {
            // The actual caller owns offer creation. The receiver creates its
            // peer only after receiving that offer, which prevents offer glare
            // and ensures the caller's audio/video tracks are in the offer.
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
          if (pc.remoteDescription) {
            processedSignalsRef.current.add(signal.id);
            continue;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          const stream = localRef.current;
          if (stream) await attachLocalTracks(pc, stream);
          await flushIce(signal.senderId, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await send(signal.senderId, "answer", answer);
        } else if (signal.type === "answer") {
          const pc = peersRef.current.get(signal.senderId);
          if (!pc) continue;
          if (!pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload));
            await flushIce(signal.senderId, pc);
          }
        } else if (signal.type === "ice") {
          const pc = peersRef.current.get(signal.senderId);
          if (pc?.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => undefined);
          else pendingIceRef.current.set(signal.senderId, [...(pendingIceRef.current.get(signal.senderId) || []), payload]);
        }
        processedSignalsRef.current.add(signal.id);
      }

      // The server also anchors the latest offer and answer on the call
      // snapshot. Recover from a dropped SSE signal without requiring users to
      // hang up and redial.
      if (localRef.current && room.call) {
        const remoteId = room.call.participants.find((id) => id !== session.memberId);
        if (remoteId && room.call.initiatorId !== session.memberId && room.call.offer) {
          await createPeer(remoteId, false);
          const pc = peersRef.current.get(remoteId);
          if (pc && !pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(room.call.offer)));
            const stream = localRef.current;
            await attachLocalTracks(pc, stream);
            await flushIce(remoteId, pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await send(remoteId, "answer", answer);
          }
        }
        if (remoteId && room.call.initiatorId === session.memberId && room.call.answer) {
          const pc = peersRef.current.get(remoteId);
          if (pc && !pc.remoteDescription && pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(room.call.answer)));
            await flushIce(remoteId, pc);
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
    start,
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
