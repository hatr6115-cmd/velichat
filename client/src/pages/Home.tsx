import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Camera,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  Dice5,
  Eye,
  Flame,
  Image as ImageIcon,
  Lock,
  LogOut,
  MessageSquare,
  Mic,
  Play,
  QrCode,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  Volume2,
  Video,
  Phone,
  PlusCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import TemporaryQr from "@/components/TemporaryQr";
import QrScannerModal from "@/components/QrScannerModal";
import { useRoomStream } from "@/hooks/useRoomStream";
import { CallModal } from "@/components/CallModal";
import {
  createTemporaryInvite,
  encodeTemporaryInvite,
  parseTemporaryInvite,
  type TemporaryInvite,
} from "@shared/temporaryInvite";

const aliasPattern = /^[A-Za-z0-9 ._-]{2,32}$/;

const RANDOM_ALIASES = [
  "SYS_CORE",
  "NODE_01",
  "GHOST_PKT",
  "HEX_DRIFT",
  "ZERO_TRACE",
  "CIPHER_9",
  "SYN_ACK",
  "ROOT_DAEMON",
  "DARK_RELAY",
  "PULSE_SEC",
];

type Session = {
  roomId: string;
  inviteToken: string;
  memberId: string;
  alias: string;
  invite: TemporaryInvite;
};

function formatRemaining(expiresAt: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function validateAlias(alias: string) {
  const normalized = alias.trim();
  return aliasPattern.test(normalized) ? normalized : null;
}

export default function Home() {
  const [, setLocation] = useLocation();

  const [inviteState] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("invite");
    if (!raw) return { invite: null as TemporaryInvite | null, error: "" };
    try {
      return { invite: parseTemporaryInvite(raw), error: "" };
    } catch {
      return {
        invite: null as TemporaryInvite | null,
        error: "ERR: INVITE_TOKEN_INVALID_OR_EXPIRED",
      };
    }
  });

  const [invite, setInvite] = useState<TemporaryInvite | null>(inviteState.invite);
  const [alias, setAlias] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(inviteState.error);

  // Modals & Extras
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isEndModalOpen, setIsEndModalOpen] = useState(false);

  // Ephemeral Media States
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [selectedPhoto, setSelectedPhoto] = useState<{ file: File; dataUrl: string } | null>(null);
  const [activePhoto, setActivePhoto] = useState<string | null>(null);
  const [photoCountdown, setPhotoCountdown] = useState(10);
  const [consumedMediaIds, setConsumedMediaIds] = useState<Set<string>>(() => new Set());

  // tRPC mutations
  const createRoom = trpc.temporary.create.useMutation();
  const joinRoom = trpc.temporary.join.useMutation();
  const sendMessage = trpc.temporary.send.useMutation();
  const sendMedia = trpc.temporary.sendMedia.useMutation();
  const consumeMedia = trpc.temporary.consumeMedia.useMutation();
  const setTyping = trpc.temporary.typing.useMutation();
  const acknowledge = trpc.temporary.acknowledge.useMutation();
  const markRead = trpc.temporary.markRead.useMutation();
  const leaveRoom = trpc.temporary.leave.useMutation();
  const startCallMutation = trpc.temporary.startCall.useMutation();
  const joinCallMutation = trpc.temporary.joinCall.useMutation();
  const endCallMutation = trpc.temporary.endCall.useMutation();
  const sendSignalMutation = trpc.temporary.sendSignal.useMutation();
  const extendExpiryMutation = trpc.temporary.extendExpiry.useMutation();

  const typingTimerRef = useRef<number | undefined>(undefined);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const messageNodesRef = useRef(new Map<string, HTMLElement>());
  const messageListRef = useRef<HTMLDivElement>(null);
  const readObserverRef = useRef<IntersectionObserver | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // WebRTC Call States
  const [isInCall, setIsInCall] = useState(false);
  const [callKind, setCallKind] = useState<"audio" | "video">("video");
  const [callStatus, setCallStatus] = useState<"calling" | "ringing" | "connected" | "ended">("calling");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const processedSignalIdsRef = useRef<Set<string>>(new Set());
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  // Real-time SSE Stream
  const { data: sseData, isConnected: isSseConnected } = useRoomStream({
    roomId: session?.roomId || "",
    inviteToken: session?.inviteToken || "",
    memberId: session?.memberId || "",
    enabled: Boolean(session),
    onClosed: (reason) => {
      toast.info(reason || "SESSION_CLOSED");
      setSession(null);
      setInvite(null);
      setLocation("/");
    },
  });

  // Fallback Polling Query
  const roomQuery = trpc.temporary.get.useQuery(
    session
      ? { roomId: session.roomId, inviteToken: session.inviteToken, memberId: session.memberId }
      : { roomId: "", inviteToken: "", memberId: "" },
    {
      enabled: Boolean(session && !isSseConnected),
      refetchInterval: 1500,
    }
  );

  const room = sseData || roomQuery.data;

  // Sync active clock
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Handle room query errors
  useEffect(() => {
    if (roomQuery.error && !isSseConnected) {
      setError(roomQuery.error.message);
      setSession(null);
    }
  }, [roomQuery.error, isSseConnected]);

  // Auto-scroll message feed
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [room?.messages?.length, room?.media?.length, room?.typingAliases && room.typingAliases.length > 0]);

  // When guest connects, automatically dismiss QR modal
  useEffect(() => {
    if (room?.participantCount === 2 && isQrModalOpen) {
      setIsQrModalOpen(false);
      toast.success("PEER_CONNECTED");
    }
  }, [room?.participantCount, isQrModalOpen]);

  // WebRTC ICE Servers with high availability public STUNs
  const iceServers: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:openrelay.metered.ca:80" },
    ],
    iceCandidatePoolSize: 10,
  };

  const getMediaStream = async (kind: "audio" | "video"): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video:
          kind === "video"
            ? {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 },
              }
            : false,
      });
    } catch (err) {
      console.warn("Failed with ideal constraints, trying basic constraints:", err);
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === "video",
      });
    }
  };

  const cleanupCall = () => {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    setIsInCall(false);
    setCallStatus("ended");
    setIsMicMuted(false);
    setIsCamOff(false);
    processedSignalIdsRef.current.clear();
    pendingIceCandidatesRef.current = [];
  };

  const handleStartCall = async (kind: "audio" | "video") => {
    if (!session || !room || room.participantCount < 2) {
      toast.error("AWAITING_PEER_CONNECTION");
      return;
    }
    try {
      cleanupCall();
      const stream = await getMediaStream(kind);
      setLocalStream(stream);
      setCallKind(kind);
      setIsInCall(true);
      setCallStatus("calling");

      const pc = new RTCPeerConnection(iceServers);
      peerConnectionRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        console.log("[WebRTC Caller] ontrack:", event.track.kind);
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
        } else {
          setRemoteStream((prev) => {
            const s = prev ? new MediaStream(prev.getTracks()) : new MediaStream();
            s.addTrack(event.track);
            return s;
          });
        }
        setCallStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && session) {
          void sendSignalMutation.mutateAsync({
            roomId: session.roomId,
            inviteToken: session.inviteToken,
            memberId: session.memberId,
            receiverId: "all",
            type: "ice",
            payload: JSON.stringify(event.candidate),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("[WebRTC Caller] connectionState:", pc.connectionState);
        if (pc.connectionState === "connected") {
          setCallStatus("connected");
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: kind === "video",
      });
      await pc.setLocalDescription(offer);

      await startCallMutation.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
        kind,
        offer: JSON.stringify(offer),
      });

      await sendSignalMutation.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
        receiverId: "all",
        type: "offer",
        payload: JSON.stringify(offer),
      });
    } catch (err: any) {
      console.error("Start call error:", err);
      toast.error("PERMISSION_DENIED: MEDIA_HARDWARE");
      cleanupCall();
    }
  };

  const handleAcceptCall = async () => {
    if (!session || !room?.call) return;
    try {
      const callData = room.call;
      const stream = await getMediaStream(callData.kind);
      setLocalStream(stream);
      setCallKind(callData.kind);
      setIsInCall(true);

      const pc = new RTCPeerConnection(iceServers);
      peerConnectionRef.current = pc;

      // Add receiver stream tracks so caller receives receiver voice and video
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        console.log("[WebRTC Receiver] ontrack:", event.track.kind);
        if (event.streams && event.streams[0]) {
          setRemoteStream(event.streams[0]);
        } else {
          setRemoteStream((prev) => {
            const s = prev ? new MediaStream(prev.getTracks()) : new MediaStream();
            s.addTrack(event.track);
            return s;
          });
        }
        setCallStatus("connected");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && session) {
          void sendSignalMutation.mutateAsync({
            roomId: session.roomId,
            inviteToken: session.inviteToken,
            memberId: session.memberId,
            receiverId: callData.initiatorId || "all",
            type: "ice",
            payload: JSON.stringify(event.candidate),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("[WebRTC Receiver] connectionState:", pc.connectionState);
        if (pc.connectionState === "connected") {
          setCallStatus("connected");
        }
      };

      await joinCallMutation.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
      });

      const offerPayload = callData.offer || (room.signals || []).find((s) => s.type === "offer")?.payload;
      if (offerPayload) {
        const offerDesc = JSON.parse(offerPayload);
        await pc.setRemoteDescription(new RTCSessionDescription(offerDesc));

        for (const candidate of pendingIceCandidatesRef.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn("Adding queued ICE candidate error:", e);
          }
        }
        pendingIceCandidatesRef.current = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await sendSignalMutation.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          receiverId: callData.initiatorId,
          type: "answer",
          payload: JSON.stringify(answer),
        });
        setCallStatus("connected");
      }
    } catch (err: any) {
      console.error("Failed to accept call:", err);
      toast.error("ERR: FAILED_TO_ACCEPT_CALL");
      handleRejectCall();
    }
  };

  const handleRejectCall = async () => {
    if (!session) return;
    try {
      await endCallMutation.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
      });
    } catch {
      /* ignore */
    }
    cleanupCall();
  };

  const handleHangup = async () => {
    if (session) {
      try {
        await endCallMutation.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
        });
      } catch {
        /* ignore */
      }
    }
    cleanupCall();
  };

  const toggleMic = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleCam = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCamOff(!videoTrack.enabled);
      }
    }
  };

  // Extend Room Time handler
  const handleExtendRoomTime = async (minutes = 15) => {
    if (!session) return;
    try {
      await extendExpiryMutation.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
        minutes,
      });
      toast.success(`+${minutes}M ADDED_TO_ROOM`);
    } catch (err: any) {
      toast.error(err.message || "ERR_EXTENDING_TIME");
    }
  };

  // Process incoming Call signals & Active Call state
  useEffect(() => {
    if (!session || !room) return;

    // Detect incoming call for non-initiator
    if (room.call && room.call.initiatorId !== session.memberId && !isInCall) {
      setIsInCall(true);
      setCallKind(room.call.kind);
      setCallStatus("ringing");
    }

    // Call was terminated remotely
    if (!room.call && isInCall && callStatus !== "ended") {
      cleanupCall();
      toast.info("CALL_TERMINATED");
      return;
    }

    const pc = peerConnectionRef.current;

    // Caller: if answer is attached to room.call but pc has no remoteDescription yet
    if (
      room.call &&
      room.call.initiatorId === session.memberId &&
      room.call.answer &&
      pc &&
      !pc.remoteDescription
    ) {
      (async () => {
        try {
          console.log("[WebRTC Caller] applying answer from room.call.answer");
          const answerDesc = JSON.parse(room.call!.answer!);
          await pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
          setCallStatus("connected");

          for (const candidate of pendingIceCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
          }
          pendingIceCandidatesRef.current = [];
        } catch (e) {
          console.error("Error setting answer from call object:", e);
        }
      })();
    }

    // Receiver: if accepted and offer arrives after accept
    if (
      room.call &&
      room.call.initiatorId !== session.memberId &&
      room.call.offer &&
      pc &&
      !pc.remoteDescription
    ) {
      (async () => {
        try {
          console.log("[WebRTC Receiver] applying offer from room.call.offer");
          const offerDesc = JSON.parse(room.call!.offer!);
          await pc.setRemoteDescription(new RTCSessionDescription(offerDesc));

          for (const candidate of pendingIceCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
          }
          pendingIceCandidatesRef.current = [];

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          await sendSignalMutation.mutateAsync({
            roomId: session.roomId,
            inviteToken: session.inviteToken,
            memberId: session.memberId,
            receiverId: room.call!.initiatorId,
            type: "answer",
            payload: JSON.stringify(answer),
          });
          setCallStatus("connected");
        } catch (e) {
          console.error("Error creating answer in effect:", e);
        }
      })();
    }

    // Process signals in sequential order
    if (room.signals && room.signals.length > 0) {
      const processSignals = async () => {
        for (const signal of room.signals) {
          if (processedSignalIdsRef.current.has(signal.id)) continue;
          processedSignalIdsRef.current.add(signal.id);

          const currentPc = peerConnectionRef.current;

          if (signal.type === "answer" && currentPc) {
            try {
              if (!currentPc.remoteDescription) {
                console.log("[WebRTC] Applying answer signal");
                const answerDesc = JSON.parse(signal.payload);
                await currentPc.setRemoteDescription(new RTCSessionDescription(answerDesc));
                setCallStatus("connected");

                for (const candidate of pendingIceCandidatesRef.current) {
                  await currentPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
                }
                pendingIceCandidatesRef.current = [];
              }
            } catch (e) {
              console.error("Error setting answer signal:", e);
            }
          } else if (signal.type === "ice") {
            try {
              const candidateInit = JSON.parse(signal.payload);
              if (currentPc && currentPc.remoteDescription) {
                await currentPc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(console.warn);
              } else {
                pendingIceCandidatesRef.current.push(candidateInit);
              }
            } catch (e) {
              console.error("Error adding ice candidate:", e);
            }
          }
        }
      };
      void processSignals();
    }
  }, [room?.call, room?.signals, session, isInCall, callStatus]);

  // Dismiss modals on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isQrModalOpen) setIsQrModalOpen(false);
        if (isEndModalOpen) setIsEndModalOpen(false);
        if (activePhoto) setActivePhoto(null);
        if (isScannerOpen) setIsScannerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isQrModalOpen, isEndModalOpen, activePhoto, isScannerOpen]);

  // Read receipts tracking via IntersectionObserver
  useEffect(() => {
    if (!session || !room) return;
    const unreadIncoming = room.messages.some((item) => item.memberId !== session.memberId && !item.readBy.includes(session.memberId));

    if (room.participantCount > 1 && room.messages.some((item) => item.memberId !== session.memberId && !item.deliveredTo.includes(session.memberId))) {
      void acknowledge.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
      });
    }

    const markVisibleAsRead = () => {
      if (document.visibilityState !== "visible" || !unreadIncoming) return;
      const listRect = messageListRef.current?.getBoundingClientRect();
      if (!listRect) return;

      const visibleUnreadIds: string[] = [];
      messageNodesRef.current.forEach((node, messageId) => {
        const item = room.messages.find((m) => m.id === messageId);
        const rect = node.getBoundingClientRect();
        const intersectsList =
          rect.top < listRect.bottom &&
          rect.bottom > listRect.top &&
          rect.left < listRect.right &&
          rect.right > listRect.left;

        if (item && item.memberId !== session.memberId && !item.readBy.includes(session.memberId) && intersectsList) {
          visibleUnreadIds.push(messageId);
        }
      });

      if (visibleUnreadIds.length > 0) {
        void markRead.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          messageIds: visibleUnreadIds,
        });
      }
    };

    readObserverRef.current?.disconnect();
    readObserverRef.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) markVisibleAsRead();
      },
      { root: messageListRef.current, threshold: 0.35 }
    );

    messageNodesRef.current.forEach((node, messageId) => {
      const item = room.messages.find((m) => m.id === messageId);
      if (item && item.memberId !== session.memberId && !item.readBy.includes(session.memberId)) {
        readObserverRef.current?.observe(node);
      }
    });

    document.addEventListener("visibilitychange", markVisibleAsRead);
    markVisibleAsRead();

    return () => {
      readObserverRef.current?.disconnect();
      document.removeEventListener("visibilitychange", markVisibleAsRead);
    };
  }, [room?.messages, room?.participantCount, session]);

  const inviteUrl = useMemo(() => {
    if (!session) return "";
    return `${window.location.origin}/?invite=${encodeURIComponent(encodeTemporaryInvite(session.invite))}`;
  }, [session]);

  const generateRandomAlias = () => {
    const random = RANDOM_ALIASES[Math.floor(Math.random() * RANDOM_ALIASES.length)];
    setAlias(random);
  };

  const handleScanSuccess = (code: string) => {
    try {
      let invitePayload = code;
      if (code.includes("invite=")) {
        const url = new URL(code);
        invitePayload = url.searchParams.get("invite") || code;
      }
      const parsed = parseTemporaryInvite(invitePayload);
      setInvite(parsed);
      setError("");
      toast.success(`INVITE_RESOLVED: ${parsed.hostAlias}`);
    } catch {
      setError("ERR: INVALID_QR_STREAM");
      toast.error("INVALID_QR");
    }
  };

  async function create() {
    const cleanAlias = validateAlias(alias);
    if (!cleanAlias) {
      setError("ALIAS_FORMAT_ERR: 2-32 CHARS REQUIRED");
      return;
    }
    setError("");
    try {
      const result = await createRoom.mutateAsync({ alias: cleanAlias });
      const roomInvite = createTemporaryInvite({
        roomId: result.roomId,
        inviteToken: result.inviteToken,
        hostAlias: result.hostAlias,
        expiresAt: result.expiresAt,
      });
      setSession({
        roomId: result.roomId,
        inviteToken: result.inviteToken,
        memberId: result.currentMemberId,
        alias: result.currentAlias,
        invite: roomInvite,
      });
      toast.success("ROOM_INITIALIZED");
    } catch (cause: any) {
      setError(cause instanceof Error ? cause.message : "ERR_ROOM_GEN_FAILED");
    }
  }

  async function join() {
    if (!invite) return;
    const cleanAlias = validateAlias(alias);
    if (!cleanAlias) {
      setError("ALIAS_FORMAT_ERR: 2-32 CHARS REQUIRED");
      return;
    }
    setError("");
    try {
      const result = await joinRoom.mutateAsync({
        roomId: invite.roomId,
        inviteToken: invite.inviteToken,
        alias: cleanAlias,
      });
      setSession({
        roomId: result.roomId,
        inviteToken: invite.inviteToken,
        memberId: result.currentMemberId,
        alias: result.currentAlias,
        invite,
      });
      toast.success("ROOM_ATTACHED");
    } catch (cause: any) {
      setError(cause instanceof Error ? cause.message : "INVITE_EXPIRED_OR_INVALID");
    }
  }

  function handleMessageChange(value: string) {
    setMessage(value);
    if (!session) return;
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    void setTyping.mutateAsync({
      roomId: session.roomId,
      inviteToken: session.inviteToken,
      memberId: session.memberId,
      isTyping: Boolean(value.trim()),
    });
    if (value.trim()) {
      typingTimerRef.current = window.setTimeout(() => {
        void setTyping.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          isTyping: false,
        });
      }, 2000);
    }
  }

  function getBestAudioMimeType(): string {
    if (typeof window === "undefined" || !window.MediaRecorder) return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/aac",
      "audio/ogg;codecs=opus",
      "audio/wav",
    ];
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  async function compressImageFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX_DIM = 1200;
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("IMAGE_ERR"));
          reader.readAsDataURL(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        resolve(dataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("IMAGE_LOAD_ERR"));
        reader.readAsDataURL(file);
      };
      img.src = objectUrl;
    });
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("AUDIO_ERR"));
      reader.readAsDataURL(blob);
    });
  }

  async function send() {
    if (!session) return;

    if (selectedPhoto) {
      try {
        await sendMedia.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          kind: "photo",
          dataUrl: selectedPhoto.dataUrl,
        });
        setSelectedPhoto(null);
        toast.success("MEDIA_DISPATCHED (VIEW_ONCE)");
      } catch (cause: any) {
        toast.error(cause instanceof Error ? cause.message : "ERR_SENDING_MEDIA");
      }
    }

    if (message.trim()) {
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      try {
        await setTyping.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          isTyping: false,
        });
        await sendMessage.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          body: message.trim(),
        });
        setMessage("");
      } catch (cause: any) {
        toast.error(cause instanceof Error ? cause.message : "ERR_SENDING_PACKET");
      }
    }
  }

  async function startRecording() {
    if (!session || room?.participantCount !== 2) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("HARDWARE_NOT_SUPPORTED");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const preferredMime = getBestAudioMimeType();
      const options = preferredMime ? { mimeType: preferredMime } : undefined;
      const recorder = options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (audioChunksRef.current.length > 0) {
          try {
            const recordedType = recorder.mimeType || preferredMime || "audio/webm";
            const cleanType = recordedType.split(";")[0].trim() || "audio/webm";
            const audioBlob = new Blob(audioChunksRef.current, { type: cleanType });
            const dataUrl = await blobToDataUrl(audioBlob);
            await sendMedia.mutateAsync({
              roomId: session.roomId,
              inviteToken: session.inviteToken,
              memberId: session.memberId,
              kind: "voice",
              dataUrl,
            });
            toast.success("VOICE_PACKET_SENT");
          } catch (cause: any) {
            toast.error(cause instanceof Error ? cause.message : "VOICE_TRANSMIT_ERR");
          }
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);

      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch {
      toast.error("MIC_ACCESS_DENIED");
    }
  }

  function stopAndSendRecording() {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    setIsRecording(false);
    mediaRecorderRef.current?.stop();
  }

  function cancelRecording() {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    audioChunksRef.current = [];
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
    toast.info("RECORDING_ABORTED");
  }

  async function handlePhotoFileSelected(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file);
      setSelectedPhoto({ file, dataUrl });
      toast.success("PHOTO_ENCRYPTED_FOR_VIEW_ONCE");
    } catch {
      toast.error("IMAGE_PROCESS_ERR");
    }
  }

  async function consumeMediaOnce(mediaId: string) {
    if (!session || consumedMediaIds.has(mediaId)) return;
    try {
      await consumeMedia.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
        mediaId,
      });
      setConsumedMediaIds((prev) => new Set(prev).add(mediaId));
    } catch {
      /* ignore */
    }
  }

  async function openViewOncePhoto(item: { id: string; dataUrl?: string }) {
    if (!item.dataUrl) return;
    const url = item.dataUrl;
    setActivePhoto(url);
    setPhotoCountdown(10);
    void consumeMediaOnce(item.id);

    const timer = setInterval(() => {
      setPhotoCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setActivePhoto(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function endRoom() {
    if (!session) return;
    try {
      await leaveRoom.mutateAsync({
        roomId: session.roomId,
        inviteToken: session.inviteToken,
        memberId: session.memberId,
      });
    } catch {
      /* ignore */
    }
    setSession(null);
    setInvite(null);
    setAlias("");
    setIsEndModalOpen(false);
    setLocation("/");
    toast.success("TERMINATED: MEMORY_PURGED");
  }

  if (session) {
    const pCount = room?.participantCount ?? 1;
    const connected = pCount > 1;
    const otherAliases = room
      ? session.alias === room.hostAlias
        ? room.guestAliases
        : [room.hostAlias, ...(room.guestAliases || []).filter((a) => a !== session.alias)]
      : [];
    const partnerAlias = pCount === 2 ? otherAliases[0] : pCount > 2 ? `${pCount - 1} NODES` : undefined;
    const roomExpiresAt = room?.expiresAt || session.invite.expiresAt;
    const isExpired = roomExpiresAt <= now;
    const remainingTime = formatRemaining(roomExpiresAt, now);
    const isAboutToExpire = roomExpiresAt - now <= 5 * 60 * 1000; // <= 5 minutes

    return (
      <div className="flex flex-col h-[100dvh] max-h-[100dvh] w-full max-w-4xl mx-auto bg-black text-green-500 font-mono select-none overflow-hidden">
        {/* Terminal Header */}
        <header className="flex items-center justify-between px-3 py-2 bg-black border-b border-green-500/30 z-20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2 h-2 ${connected ? "bg-green-500 animate-pulse" : "bg-green-800"}`} />
            <div className="min-w-0">
              <span className="text-xs font-bold uppercase tracking-wider text-green-400 truncate block">
                &gt; {connected ? partnerAlias : "WAITING_PEER..."}
              </span>
              <span className="text-[10px] text-green-700 block">
                UID: {session.alias} [{connected ? `${pCount}P` : "1P"}]
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 shrink-0 text-xs">
            {/* Expiry Counter & +Time Button */}
            <div className="flex items-center gap-1">
              <span
                className={`px-2 py-0.5 border text-[11px] font-bold ${
                  isAboutToExpire
                    ? "border-red-500 text-red-500 animate-pulse"
                    : "border-green-500/40 text-green-400"
                }`}
              >
                {isExpired ? "00:00" : remainingTime}
              </span>

              {/* Add Time button - Enabled especially when under 5 minutes */}
              <button
                type="button"
                onClick={() => void handleExtendRoomTime(15)}
                disabled={extendExpiryMutation.isPending}
                title="Add 15 minutes to session"
                className={`px-2 py-0.5 border text-[10px] uppercase font-bold transition-colors ${
                  isAboutToExpire
                    ? "border-green-400 bg-green-500/20 text-green-300 animate-bounce"
                    : "border-green-500/30 text-green-600 hover:text-green-400 hover:border-green-500"
                }`}
              >
                +15M
              </button>
            </div>

            {/* Call Buttons */}
            <button
              onClick={() => handleStartCall("audio")}
              disabled={!connected || isExpired || isInCall}
              title="Encrypted Audio Call"
              className="px-2 py-0.5 border border-green-500/50 hover:border-green-400 text-green-400 hover:bg-green-500/10 text-[11px] disabled:opacity-30 uppercase"
            >
              [CALL]
            </button>

            <button
              onClick={() => handleStartCall("video")}
              disabled={!connected || isExpired || isInCall}
              title="Encrypted Video Call"
              className="px-2 py-0.5 border border-green-500/50 hover:border-green-400 text-green-400 hover:bg-green-500/10 text-[11px] disabled:opacity-30 uppercase"
            >
              [VID]
            </button>

            <button
              onClick={() => setIsQrModalOpen(true)}
              className="px-2 py-0.5 border border-green-500/50 hover:border-green-400 text-green-400 hover:bg-green-500/10 text-[11px] uppercase"
            >
              [QR]
            </button>

            <button
              onClick={() => setIsEndModalOpen(true)}
              className="px-2 py-0.5 border border-red-500/60 hover:border-red-400 text-red-500 hover:bg-red-500/10 text-[11px] uppercase"
            >
              [EXIT]
            </button>
          </div>
        </header>

        {/* Message Feed */}
        <main
          ref={messageListRef}
          className="flex-1 overflow-y-auto p-3 space-y-2 bg-black overscroll-contain text-xs"
        >
          {!connected && (
            <div className="border border-dashed border-green-500/30 p-6 text-center max-w-sm mx-auto my-8">
              <p className="text-green-400 font-bold uppercase mb-2">&gt; AWAITING_PEER_CONNECTION</p>
              <p className="text-[11px] text-green-700 mb-4">SHARE_INVITE_TOKEN_OR_SCAN_MATRIX</p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => setIsQrModalOpen(true)}
                  className="px-3 py-1.5 border border-green-500 bg-green-500/10 text-green-400 text-xs uppercase hover:bg-green-500/20"
                >
                  [SHOW_QR]
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    toast.success("TOKEN_COPIED");
                  }}
                  className="px-3 py-1.5 border border-green-500/50 text-green-500 text-xs uppercase hover:border-green-400"
                >
                  [COPY_LINK]
                </button>
              </div>
            </div>
          )}

          {(room?.messages && room.messages.length > 0) || (room?.media && room.media.length > 0) ? (
            <div className="space-y-2 max-w-3xl mx-auto">
              {room?.messages?.map((item) => {
                const isOwn = item.memberId === session.memberId;
                return (
                  <div
                    key={item.id}
                    ref={(node) => {
                      if (node) messageNodesRef.current.set(item.id, node);
                      else messageNodesRef.current.delete(item.id);
                    }}
                    className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
                  >
                    <div className="text-[10px] text-green-700 mb-0.5">
                      [{new Date(item.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] {isOwn ? "LOCAL" : item.alias}
                    </div>

                    <div
                      className={`max-w-[88%] p-2 border ${
                        isOwn
                          ? "bg-black border-green-500/80 text-green-400 shadow-[0_0_8px_rgba(34,197,94,0.1)]"
                          : "bg-black border-green-900 text-green-300"
                      }`}
                    >
                      <p className="whitespace-pre-wrap leading-relaxed">{item.body}</p>

                      {isOwn && (
                        <div className="text-[9px] text-green-700 text-right mt-1">
                          {item.readBy.length >= room.participantCount - 1 && room.participantCount > 1 ? (
                            <span className="text-green-400">[ACK:READ]</span>
                          ) : item.deliveredTo.length > 0 ? (
                            <span className="text-green-600">[ACK:DELIVERED]</span>
                          ) : (
                            <span className="text-green-800">[TRANSMITTED]</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {room?.media?.map((item) => {
                const isOwn = item.memberId === session.memberId;
                const isConsumed =
                  consumedMediaIds.has(item.id) ||
                  (item.consumedBy && item.consumedBy.includes(session.memberId)) ||
                  !item.dataUrl;

                return (
                  <div key={item.id} className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
                    <div className="text-[10px] text-green-700 mb-0.5">
                      [{new Date(item.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] {isOwn ? "LOCAL" : item.alias} : {item.kind.toUpperCase()}
                    </div>

                    <div className="p-2 border border-green-500/50 bg-black text-xs">
                      {item.kind === "voice" ? (
                        isConsumed ? (
                          <span className="text-green-800">[VOICE_PACKET_CONSUMED]</span>
                        ) : (
                          <div className="flex flex-col gap-1 min-w-[200px]">
                            <audio
                              controls
                              controlsList="nodownload"
                              playsInline
                              preload="auto"
                              src={item.dataUrl}
                              className="w-full h-7 invert"
                              onEnded={() => {
                                if (!isOwn) void consumeMediaOnce(item.id);
                              }}
                            />
                            {!isOwn && (
                              <span className="text-[9px] text-green-700">&gt; PLAYS_ONCE // AUTO_PURGE</span>
                            )}
                          </div>
                        )
                      ) : isConsumed ? (
                        <span className="text-green-800">[IMAGE_PACKET_PURGED]</span>
                      ) : (
                        <button
                          onClick={() => openViewOncePhoto(item)}
                          className="px-3 py-1.5 border border-green-500 bg-green-500/10 text-green-400 uppercase font-bold hover:bg-green-500/20 text-xs"
                        >
                          [VIEW_IMAGE_ONCE]
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {room?.typingAliases && room.typingAliases.length > 0 && (
            <div className="text-[10px] text-green-500 animate-pulse">
              &gt; {room.typingAliases.join(", ")} TYPING...
            </div>
          )}
        </main>

        {/* Floating preview for selected photo */}
        {selectedPhoto && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-black border-t border-green-500/40 text-xs">
            <span className="text-green-400">&gt; ATTACHED_IMAGE [VIEW_ONCE]</span>
            <button
              onClick={() => setSelectedPhoto(null)}
              className="text-red-500 hover:text-red-400 font-bold"
            >
              [X]
            </button>
          </div>
        )}

        {/* Input Bar */}
        <footer className="p-2 bg-black border-t border-green-500/30 shrink-0">
          {isRecording ? (
            <div className="flex items-center justify-between gap-2 p-1.5 border border-red-500 text-red-500 text-xs">
              <span className="animate-pulse">
                ● REC {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")}
              </span>
              <div className="flex gap-2">
                <button onClick={cancelRecording} className="px-2 py-0.5 border border-red-500 hover:bg-red-500/20 uppercase">
                  [ABORT]
                </button>
                <button onClick={stopAndSendRecording} className="px-2 py-0.5 border border-green-500 text-green-400 hover:bg-green-500/20 uppercase">
                  [SEND]
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 max-w-3xl mx-auto w-full">
              <input
                id="photo-upload-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void handlePhotoFileSelected(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                disabled={!connected || isExpired}
                onClick={() => document.getElementById("photo-upload-input")?.click()}
                className="px-2 py-1.5 border border-green-500/40 text-green-500 hover:border-green-400 hover:text-green-300 disabled:opacity-30 uppercase text-xs"
                title="Attach View-Once Photo"
              >
                [IMG]
              </button>

              <button
                type="button"
                disabled={!connected || isExpired}
                onClick={startRecording}
                className="px-2 py-1.5 border border-green-500/40 text-green-500 hover:border-green-400 hover:text-green-300 disabled:opacity-30 uppercase text-xs"
                title="Record Ephemeral Audio"
              >
                [MIC]
              </button>

              <div className="flex-1 min-w-0 relative flex items-center">
                <span className="text-green-600 mr-1.5">&gt;</span>
                <input
                  ref={textareaRef as any}
                  value={message}
                  onChange={(e) => handleMessageChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!connected || isExpired}
                  placeholder={connected ? "type packet..." : "awaiting peer..."}
                  className="w-full bg-black border border-green-500/40 focus:border-green-400 px-2 py-1 text-xs text-green-400 placeholder-green-800 outline-none font-mono"
                />
              </div>

              <button
                onClick={() => void send()}
                disabled={!connected || isExpired || (!message.trim() && !selectedPhoto)}
                className="px-3 py-1 border border-green-500 bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-30 uppercase text-xs font-bold"
              >
                [SEND]
              </button>
            </div>
          )}
        </footer>

        {/* View Once Photo Overlay */}
        {activePhoto && (
          <div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 bg-black/98"
            onClick={() => setActivePhoto(null)}
          >
            <div className="flex items-center justify-between w-full max-w-md mb-2 text-green-500 text-xs">
              <span className="animate-pulse">&gt; VIEW_ONCE: CLOSES_IN_{photoCountdown}S</span>
              <button onClick={() => setActivePhoto(null)} className="text-red-500 font-bold">
                [CLOSE]
              </button>
            </div>
            <div className="border border-green-500/50 max-h-[75vh] overflow-hidden">
              <img src={activePhoto} alt="Ephemeral packet" className="max-h-[70vh] object-contain" />
            </div>
          </div>
        )}

        {/* Call Modal */}
        {isInCall && (
          <CallModal
            kind={callKind}
            partnerAlias={partnerAlias}
            isInitiator={room?.call?.initiatorId === session.memberId}
            localStream={localStream}
            remoteStream={remoteStream}
            callStatus={callStatus}
            onAccept={handleAcceptCall}
            onReject={handleRejectCall}
            onHangup={handleHangup}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            isMicMuted={isMicMuted}
            isCamOff={isCamOff}
          />
        )}

        {/* QR Invite Modal */}
        {isQrModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 font-mono"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsQrModalOpen(false);
            }}
          >
            <div className="relative w-full max-w-xs bg-black border border-green-500 p-5 text-center">
              <div className="flex justify-between items-center mb-3 text-xs text-green-500">
                <span className="font-bold">&gt; PEER_QR_TOKEN</span>
                <button
                  type="button"
                  onClick={() => setIsQrModalOpen(false)}
                  className="text-red-500 font-bold"
                >
                  [X]
                </button>
              </div>
              <div className="p-2 bg-white inline-block">
                <TemporaryQr
                  inviteUrl={inviteUrl}
                  inline={true}
                  onClose={() => setIsQrModalOpen(false)}
                />
              </div>
              <p className="text-[10px] text-green-700 mt-3">&gt; SCAN_TO_ATTACH_PEER</p>
            </div>
          </div>
        )}

        {/* End Room Modal */}
        {isEndModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 font-mono">
            <div className="w-full max-w-sm bg-black border border-red-500 p-5 text-center space-y-3">
              <p className="text-red-500 font-bold text-sm">&gt; PURGE_SESSION_DATA?</p>
              <p className="text-xs text-green-800">
                IMMEDIATE_DISCONNECT // ZERO_MEMORY_PERSISTENCE
              </p>
              <div className="flex gap-3 justify-center pt-2">
                <button
                  onClick={() => setIsEndModalOpen(false)}
                  className="px-3 py-1.5 border border-green-500 text-green-500 text-xs uppercase"
                >
                  [CANCEL]
                </button>
                <button
                  onClick={endRoom}
                  className="px-3 py-1.5 border border-red-500 bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs uppercase font-bold"
                >
                  [CONFIRM_PURGE]
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isJoin = Boolean(invite);

  return (
    <div className="min-h-[100dvh] bg-black text-green-500 font-mono flex flex-col justify-between p-4 selection:bg-green-500 selection:text-black">
      {/* Terminal Topline */}
      <header className="flex items-center justify-between max-w-xl w-full mx-auto py-2 border-b border-green-500/30 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 animate-pulse" />
          <span className="font-bold tracking-widest text-green-400">VEILCHAT // TERMINAL_V2</span>
        </div>
        <button
          onClick={() => setIsScannerOpen(true)}
          className="border border-green-500/50 px-2 py-0.5 text-[11px] text-green-400 hover:bg-green-500/10 uppercase"
        >
          [SCAN_QR]
        </button>
      </header>

      {/* Main Terminal Form */}
      <main className="max-w-sm w-full mx-auto my-auto py-6">
        <div className="border border-green-500/50 p-5 bg-black shadow-[0_0_15px_rgba(34,197,94,0.1)] space-y-4">
          <div className="text-xs text-green-600 border-b border-green-500/20 pb-2">
            &gt; ZERO_TRACE_IN_MEMORY_STREAM<br />
            &gt; ENCRYPTION: DTLS-SRTP_P2P<br />
            &gt; STORAGE: NULL
          </div>

          {isJoin && (
            <div className="p-2 border border-green-500/30 text-xs space-y-1">
              <div className="text-green-400 font-bold">&gt; ATTACHING_TO_ROOM</div>
              <div className="text-[11px] text-green-700">HOST: {invite?.hostAlias}</div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-green-600">
              <label htmlFor="alias-input">&gt; CALLSIGN (ALIAS)</label>
              <button
                type="button"
                onClick={generateRandomAlias}
                className="text-green-400 hover:underline"
              >
                [RND]
              </button>
            </div>

            <input
              id="alias-input"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void (isJoin ? join() : create());
              }}
              placeholder="e.g. NODE_01"
              maxLength={32}
              autoComplete="off"
              className="w-full bg-black border border-green-500 px-3 py-2 text-green-400 placeholder-green-800 text-xs font-mono outline-none focus:ring-1 focus:ring-green-400"
            />
          </div>

          {error && (
            <div className="p-2 border border-red-500/60 text-red-500 text-[11px]">
              &gt; {error}
            </div>
          )}

          <button
            onClick={() => void (isJoin ? join() : create())}
            disabled={createRoom.isPending || joinRoom.isPending || !alias.trim()}
            className="w-full py-2 border border-green-400 bg-green-500/10 text-green-300 hover:bg-green-500/20 text-xs uppercase font-bold tracking-wider disabled:opacity-30 transition-all"
          >
            {isJoin ? "[ATTACH_TO_ROOM]" : "[INITIALIZE_ROOM]"}
          </button>
        </div>
      </main>

      {/* Terminal Footer */}
      <footer className="text-center text-[10px] text-green-800 py-2">
        VEILCHAT_CORE // NO_LOGS // NO_STORAGE // EPHEMERAL
      </footer>

      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScan={handleScanSuccess}
      />
    </div>
  );
}
