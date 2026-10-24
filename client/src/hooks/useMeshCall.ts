import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot } from "../../../server/temporaryRooms";
import { trpc } from "@/lib/trpc";

type Session = { roomId: string; inviteToken: string; memberId: string };
type CallKind = "audio" | "video";
type CallStatus = "calling" | "ringing" | "connected" | "ended";

type RemoteEntry = { memberId: string; stream: MediaStream };

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80?transport=tcp",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelay",
      credential: "openrelay",
    },
  ],
  iceCandidatePoolSize: 10,
};

export function useMeshCall(session: Session | null, room: RoomSnapshot | null | undefined) {
  const sendSignal = trpc.temporary.sendSignal.useMutation();
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
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const creatingRef = useRef(new Set<string>());
  const processedSignalsRef = useRef(new Set<string>());
  const acceptedRef = useRef(false);
  const missingCallTimerRef = useRef<number | undefined>(undefined);

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
    if (missingCallTimerRef.current) window.clearTimeout(missingCallTimerRef.current);
    missingCallTimerRef.current = undefined;
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

  const getMedia = useCallback(async (kind: CallKind) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Media devices are unavailable");
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      ...(kind === "video" ? { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } } : {}),
    });
  }, []);

  const createPeer = useCallback(async (remoteId: string, offerer: boolean) => {
    if (!session || !localRef.current || peersRef.current.has(remoteId) || creatingRef.current.has(remoteId)) return;
    creatingRef.current.add(remoteId);
    const pc = new RTCPeerConnection(rtcConfig);
    peersRef.current.set(remoteId, pc);
    // The offerer adds tracks before creating its offer. The answerer must
    // wait until setRemoteDescription(offer) so the remote transceivers are
    // matched correctly; adding tracks too early can leave the answer without
    // usable media sections and both clients stuck on "Connecting stream…".
    if (offerer) {
      localRef.current.getTracks().forEach((track) => pc.addTrack(track, localRef.current!));
    }

    pc.ontrack = (event) => {
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
      if (event.candidate) void send(remoteId, "ice", event.candidate.toJSON());
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        setCallStatus("connected");
      }
      if (pc.iceConnectionState === "failed") {
        setCallError("The call could not establish a network connection. Please try again.");
        closePeer(remoteId);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setCallStatus("connected");
      if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(remoteId);
    };

    try {
      if (offerer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send(remoteId, "offer", offer);
      }
    } finally {
      creatingRef.current.delete(remoteId);
    }
  }, [closePeer, send, session]);

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
  }, [cleanup, getMedia, joinCall, room, session]);

  const start = useCallback(async (kind: CallKind) => {
    if (!session || !room || room.participantCount < 2 || isInCall) return;
    cleanup();
    setCallError(null);
    try {
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
  }, [cleanup, getMedia, isInCall, room, session, startCall]);

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
      if (room.call.kind !== callKind && !isInCall) setCallKind(room.call.kind);
      if (room.call.initiatorId !== session.memberId && !isInCall) {
        setCallStatus("ringing");
        setIsInCall(true);
      }
      if (isInCall && localRef.current) {
        for (const remoteId of room.call.participants.filter((id) => id !== session.memberId)) {
          // Only the deterministic lower member id starts negotiation. The
          // other side creates its peer only after receiving that offer.
          // Creating idle peers on both sides first can produce offer glare and
          // leave both calls stuck at "Connecting stream…".
          if (session.memberId < remoteId) void createPeer(remoteId, true);
        }
      }
    } else if (isInCall && !missingCallTimerRef.current) {
      missingCallTimerRef.current = window.setTimeout(() => {
        missingCallTimerRef.current = undefined;
        if (!room?.call) cleanup();
      }, 4000);
    }

    const processSignals = async () => {
      for (const signal of room.signals || []) {
        if (processedSignalsRef.current.has(signal.id) || signal.senderId === session.memberId) continue;
        if (signal.receiverId !== "all" && signal.receiverId !== session.memberId) continue;
        const payload = JSON.parse(signal.payload);
        if (signal.type === "end") {
          processedSignalsRef.current.add(signal.id);
          cleanup();
          continue;
        }
        // The initiator can send an offer while the callee is still deciding
        // whether to grant microphone/camera access. Keep the signal queued by
        // leaving it unprocessed until local media exists.
        if (!localRef.current) continue;
        processedSignalsRef.current.add(signal.id);
        if (signal.type === "offer") {
          await createPeer(signal.senderId, false);
          const pc = peersRef.current.get(signal.senderId);
          if (!pc || pc.remoteDescription) continue;
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          const stream = localRef.current;
          if (stream) {
            stream.getTracks().forEach((track) => {
              if (!pc.getSenders().some((sender) => sender.track?.id === track.id)) {
                pc.addTrack(track, stream);
              }
            });
          }
          await flushIce(signal.senderId, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await send(signal.senderId, "answer", answer);
        } else if (signal.type === "answer") {
          const pc = peersRef.current.get(signal.senderId);
          if (pc && !pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload));
            await flushIce(signal.senderId, pc);
          }
        } else if (signal.type === "ice") {
          const pc = peersRef.current.get(signal.senderId);
          if (pc?.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => undefined);
          else pendingIceRef.current.set(signal.senderId, [...(pendingIceRef.current.get(signal.senderId) || []), payload]);
        }
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
            stream.getTracks().forEach((track) => {
              if (!pc.getSenders().some((sender) => sender.track?.id === track.id)) pc.addTrack(track, stream);
            });
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
    void processSignals();
  }, [callKind, cleanup, createPeer, flushIce, isInCall, room, send, session]);

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
