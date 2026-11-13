import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Camera,
  Check,
  CheckCheck,
  Copy,
  Dice5,
  Download,
  Eye,
  FileText,
  Flame,
  Image as ImageIcon,
  Lock,
  LogOut,
  MessageSquare,
  Mic,
  Moon,
  Play,
  QrCode,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Users,
  Volume2,
  Video,
  Phone,
  WifiOff,
  PlusCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import TemporaryQr from "@/components/TemporaryQr";
import QrScannerModal from "@/components/QrScannerModal";
import { useRoomStream } from "@/hooks/useRoomStream";
import { useMeshCall } from "@/hooks/useMeshCall";
import { CallModal } from "@/components/CallModal";
import { useTheme } from "@/contexts/ThemeContext";
import {
  createTemporaryInvite,
  encodeTemporaryInvite,
  parseTemporaryInvite,
  type TemporaryInvite,
} from "@shared/temporaryInvite";

const aliasPattern = /^[A-Za-z0-9 ._-]{2,32}$/;

const ANDROID_DOWNLOAD_URL = import.meta.env.VITE_ANDROID_DOWNLOAD_URL ||
  "https://github.com/hatr6115-cmd/velichat/releases/latest/download/app-debug.apk";
const RANDOM_ALIASES = [
  "Alex",
  "Sam",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Avery",
  "Jamie",
  "Robin",
];

declare global {
  interface Window {
    VeilChatClipboard?: { copyText: (text: string) => void };
  }
}

type Session = {
  roomId: string;
  inviteToken: string;
  memberId: string;
  alias: string;
  invite: TemporaryInvite;
};

const ACTIVE_ROOM_STORAGE_KEY = "veilchat.active-room.v1";
const PENDING_ROOM_LEAVE_STORAGE_KEY = "veilchat.pending-room-leave.v1";

type PendingRoomLeave = Pick<Session, "roomId" | "inviteToken" | "memberId">;

function readSavedSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Session>;
    if (
      typeof stored.roomId !== "string" ||
      typeof stored.inviteToken !== "string" ||
      typeof stored.memberId !== "string" ||
      typeof stored.alias !== "string" ||
      !stored.invite
    ) {
      throw new Error("Invalid saved room session");
    }
    const invite = parseTemporaryInvite(JSON.stringify(stored.invite));
    if (invite.roomId !== stored.roomId || invite.inviteToken !== stored.inviteToken) {
      throw new Error("Saved room invite does not match the session");
    }
    return {
      roomId: stored.roomId,
      inviteToken: stored.inviteToken,
      memberId: stored.memberId,
      alias: stored.alias,
      invite,
    };
  } catch {
    try {
      window.localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
    } catch {
      /* browser storage can be unavailable */
    }
    return null;
  }
}

function validateAlias(alias: string) {
  const normalized = alias.trim();
  return aliasPattern.test(normalized) ? normalized : null;
}

function pingServer() {
  void fetch("/api/health", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  }).catch(() => undefined);
}

export default function Home() {
  const [, setLocation] = useLocation();
  const { theme, toggleTheme } = useTheme();

  const [inviteState] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get("invite");
    if (!raw) return { invite: null as TemporaryInvite | null, error: "" };
    try {
      return { invite: parseTemporaryInvite(raw), error: "" };
    } catch {
      return {
        invite: null as TemporaryInvite | null,
        error: "Invite link is invalid."
      };
    }
  });

  const [invite, setInvite] = useState<TemporaryInvite | null>(inviteState.invite);
  const [alias, setAlias] = useState("");
  const [session, setSession] = useState<Session | null>(() => readSavedSession());
  const [message, setMessage] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [roomConnectionError, setRoomConnectionError] = useState<string | null>(null);
  const [error, setError] = useState(inviteState.error);

  // Modals & Extras
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isEndModalOpen, setIsEndModalOpen] = useState(false);

  // Ephemeral Media States
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [selectedPhoto, setSelectedPhoto] = useState<{ file: File; dataUrl: string } | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<{ file: File; dataUrl: string } | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<{ file: File; dataUrl: string } | null>(null);
  const [activePhoto, setActivePhoto] = useState<string | null>(null);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);
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

  const typingTimerRef = useRef<number | undefined>(undefined);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const messageNodesRef = useRef(new Map<string, HTMLElement>());
  const messageListRef = useRef<HTMLDivElement>(null);
  const readObserverRef = useRef<IntersectionObserver | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingLeaveInFlightRef = useRef(false);

  function closeActivePhoto() {
    setActivePhoto(null);
  }

  function closeActiveVideo() {
    setActiveVideo(null);
  }

  // Dismiss view-once media when a browser tab/app is backgrounded. Native
  // Android additionally applies FLAG_SECURE to block OS screenshots/recording.
  useEffect(() => {
    const hideProtectedMedia = () => {
      if (document.visibilityState !== "visible") {
        closeActivePhoto();
        closeActiveVideo();
      }
    };
    document.addEventListener("visibilitychange", hideProtectedMedia);
    return () => {
      document.removeEventListener("visibilitychange", hideProtectedMedia);
    };
  }, []);

  // Real-time SSE Stream
  const { data: sseData, isConnected: isSseConnected } = useRoomStream({
    roomId: session?.roomId || "",
    inviteToken: session?.inviteToken || "",
    memberId: session?.memberId || "",
    enabled: Boolean(session),
    onClosed: (reason) => {
      setError(reason);
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

  // Keep the room credentials on this device so a refresh can restore the same
  // participant instead of accidentally joining as a duplicate guest.
  useEffect(() => {
    try {
      if (session) window.localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
    } catch {
      /* browser storage can be unavailable; the in-memory room still works */
    }
  }, [session]);

  useEffect(() => {
    const flushPendingRoomLeave = async () => {
      if (!navigator.onLine || pendingLeaveInFlightRef.current) return;

      let raw: string | null;
      try {
        raw = window.localStorage.getItem(PENDING_ROOM_LEAVE_STORAGE_KEY);
      } catch {
        return;
      }
      if (!raw) return;

      let pendingLeave: PendingRoomLeave;
      try {
        const stored = JSON.parse(raw) as Partial<PendingRoomLeave>;
        if (
          typeof stored.roomId !== "string" ||
          typeof stored.inviteToken !== "string" ||
          typeof stored.memberId !== "string"
        ) {
          throw new Error("Invalid pending room leave");
        }
        pendingLeave = {
          roomId: stored.roomId,
          inviteToken: stored.inviteToken,
          memberId: stored.memberId,
        };
      } catch {
        try {
          window.localStorage.removeItem(PENDING_ROOM_LEAVE_STORAGE_KEY);
        } catch {
          /* browser storage can be unavailable */
        }
        return;
      }

      pendingLeaveInFlightRef.current = true;
      try {
        await leaveRoom.mutateAsync(pendingLeave);
        if (window.localStorage.getItem(PENDING_ROOM_LEAVE_STORAGE_KEY) === raw) {
          window.localStorage.removeItem(PENDING_ROOM_LEAVE_STORAGE_KEY);
        }
      } catch (leaveError) {
        const message = leaveError instanceof Error ? leaveError.message : "";
        if (/invalid, closed, or no longer available|not a participant in this room/i.test(message)) {
          try {
            window.localStorage.removeItem(PENDING_ROOM_LEAVE_STORAGE_KEY);
          } catch {
            /* browser storage can be unavailable */
          }
        }
      } finally {
        pendingLeaveInFlightRef.current = false;
      }
    };

    const retryPendingRoomLeave = () => void flushPendingRoomLeave();
    const retryTimer = window.setInterval(retryPendingRoomLeave, 15_000);
    window.addEventListener("online", retryPendingRoomLeave);
    retryPendingRoomLeave();
    return () => {
      window.clearInterval(retryTimer);
      window.removeEventListener("online", retryPendingRoomLeave);
    };
  }, [leaveRoom.mutateAsync]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const copyMessage = async (messageId: string, body: string) => {
    let copied = false;
    try {
      if (window.VeilChatClipboard) {
        window.VeilChatClipboard.copyText(body);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = body;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "0";
      textarea.style.width = "1px";
      textarea.style.height = "1px";
      textarea.style.fontSize = "16px";
      textarea.style.opacity = "0.01";
      document.body.appendChild(textarea);
      textarea.focus({ preventScroll: true });
      textarea.select();
      copied = document.execCommand("copy");
      textarea.remove();
    }

    if (!copied) {
      toast.error("Could not copy. Select the message text to copy it.");
      return;
    }
    setCopiedMessageId(messageId);
    window.setTimeout(() => setCopiedMessageId(current => current === messageId ? null : current), 1400);
  };

  const {
    isInCall, isInitiator, callKind, callStatus, localStream, remoteStreams, callError,
    isMicMuted, isCamOff, start: startCall, accept: acceptCall, reject: rejectCall,
    hangup: hangupCall, toggleMic, toggleCam,
  } = useMeshCall(session ? { roomId: session.roomId, inviteToken: session.inviteToken, memberId: session.memberId } : null, room);

  // Wake a sleeping Render instance when the app opens, then keep it warm while open.
  useEffect(() => {
    const firstPing = window.setTimeout(pingServer, 2_000);
    const keepAlive = window.setInterval(pingServer, 5 * 60 * 1_000);
    pingServer();
    return () => {
      window.clearTimeout(firstPing);
      window.clearInterval(keepAlive);
    };
  }, []);


  // Keep the session intact through network failures. SSE and the fallback query
  // reconnect in the background, while the saved credentials restore the room on refresh.
  useEffect(() => {
    if (roomQuery.error && !isSseConnected) {
      setRoomConnectionError(roomQuery.error.message);
    } else if (isSseConnected || roomQuery.data) {
      setRoomConnectionError(null);
    }
  }, [roomQuery.error, roomQuery.data, isSseConnected]);

  useEffect(() => {
    if (callError) toast.error(callError);
  }, [callError]);

  // Auto-scroll message feed
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [room?.messages?.length, room?.media?.length]);

  // When guest connects, automatically dismiss QR modal
  useEffect(() => {
    if (room?.participantCount === 2 && isQrModalOpen) {
      setIsQrModalOpen(false);
    }
  }, [room?.participantCount, isQrModalOpen]);

  // Dismiss modals on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isQrModalOpen) setIsQrModalOpen(false);
        if (isEndModalOpen) setIsEndModalOpen(false);
        if (activePhoto) closeActivePhoto();
        if (activeVideo) closeActiveVideo();
        if (isScannerOpen) setIsScannerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isQrModalOpen, isEndModalOpen, activePhoto, activeVideo, isScannerOpen]);

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
    } catch {
      setError("ERR: INVALID_QR_STREAM");
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
      });
      setSession({
        roomId: result.roomId,
        inviteToken: result.inviteToken,
        memberId: result.currentMemberId,
        alias: result.currentAlias,
        invite: roomInvite,
      });
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
    if (!isOnline) {
      toast.error("You’re offline. Your message will stay here until you reconnect.");
      return;
    }

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
      } catch (cause: any) {
        console.warn("Error sending photo:", cause);
      }
    }

    if (selectedVideo) {
      try {
        await sendMedia.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          kind: "video",
          dataUrl: selectedVideo.dataUrl,
        });
        setSelectedVideo(null);
      } catch (cause: any) {
        console.warn("Error sending video:", cause);
      }
    }

    if (selectedDocument) {
      try {
        await sendMedia.mutateAsync({
          roomId: session.roomId,
          inviteToken: session.inviteToken,
          memberId: session.memberId,
          kind: "document",
          dataUrl: selectedDocument.dataUrl,
          fileName: selectedDocument.file.name,
          mimeType: selectedDocument.file.type || "application/octet-stream",
        });
        setSelectedDocument(null);
      } catch (cause: any) {
        console.warn("Error sending document:", cause);
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
        if (textareaRef.current) textareaRef.current.style.height = "40px";
      } catch (cause: any) {
        console.warn("Error sending message:", cause);
      }
    }
  }

  async function startRecording() {
    if (!session || (room?.participantCount ?? 1) < 2) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
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
          } catch (cause: any) {
            console.warn("Error transmitting voice note:", cause);
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
      console.warn("Microphone access denied or error");
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
  }

  async function handlePhotoFileSelected(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file);
      setSelectedPhoto({ file, dataUrl });
    } catch {
      console.warn("Error processing image file");
    }
  }

  async function handleVideoFileSelected(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      alert("Video must be under 25MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setSelectedVideo({ file, dataUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
  }

  function handleDocumentFileSelected(file: File | undefined) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      alert("Document must be under 20MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setSelectedDocument({ file, dataUrl: reader.result });
    };
    reader.readAsDataURL(file);
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

  function openViewOncePhoto(item: { id: string; dataUrl?: string }) {
    if (!item.dataUrl) return;
    closeActivePhoto();
    closeActiveVideo();
    setActivePhoto(item.dataUrl);
    void consumeMediaOnce(item.id);
  }

  function openViewOnceVideo(item: { id: string; dataUrl?: string }) {
    if (!item.dataUrl) return;
    closeActivePhoto();
    closeActiveVideo();
    setActiveVideo(item.dataUrl);
    void consumeMediaOnce(item.id);
  }

  async function endRoom() {
    if (!session) return;
    const pendingLeave: PendingRoomLeave = {
      roomId: session.roomId,
      inviteToken: session.inviteToken,
      memberId: session.memberId,
    };
    const serializedPendingLeave = JSON.stringify(pendingLeave);
    try {
      window.localStorage.setItem(PENDING_ROOM_LEAVE_STORAGE_KEY, serializedPendingLeave);
    } catch {
      /* The server leave is still attempted if local storage is unavailable. */
    }

    pendingLeaveInFlightRef.current = true;
    setSession(null);
    setInvite(null);
    setAlias("");
    setIsEndModalOpen(false);
    setLocation("/");

    // Clear this device immediately; retry the server leave when connectivity returns.
    try {
      await leaveRoom.mutateAsync(pendingLeave);
      if (window.localStorage.getItem(PENDING_ROOM_LEAVE_STORAGE_KEY) === serializedPendingLeave) {
        window.localStorage.removeItem(PENDING_ROOM_LEAVE_STORAGE_KEY);
      }
    } catch {
      /* The pending request is retried on reconnect, app start, and periodically. */
    } finally {
      pendingLeaveInFlightRef.current = false;
    }
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

    return (
      <div className="flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-zinc-50 font-sans text-zinc-900 transition-colors dark:bg-zinc-950 dark:text-zinc-100 sm:mx-auto sm:max-w-3xl">
        {/* Conversation header */}
        <header className="z-20 flex shrink-0 flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] shadow-xs dark:border-zinc-800 dark:bg-zinc-900 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3 sm:pt-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="relative shrink-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white shadow-sm">
                {(connected ? partnerAlias || "Friend" : "Wait").slice(0, 2).toUpperCase()}
              </div>
              <span
                className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-zinc-900 ${
                  connected && isOnline && !roomConnectionError ? "bg-emerald-500" : !isOnline || roomConnectionError ? "bg-amber-500" : "bg-zinc-400"
                }`}
              />
            </div>

            <div className="min-w-0 max-w-[70vw] sm:max-w-none">
              <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {connected ? partnerAlias : !isOnline || roomConnectionError ? "Reconnecting to your room" : room ? "Waiting for your friend" : "Restoring your room…"}
              </span>
              <span className="block min-h-4 truncate text-[11px] text-zinc-500 dark:text-zinc-400" role="status" aria-live="polite">
                {!isOnline || roomConnectionError ? "Reconnecting automatically" : room?.typingAliases?.length ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-blue-600 dark:text-blue-400">
                    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-600" />
                    </span>
                    <span className="truncate">
                      {room.typingAliases.length === 1
                        ? `${room.typingAliases[0]} is typing…`
                        : `${room.typingAliases.join(", ")} are typing…`}
                    </span>
                  </span>
                ) : connected ? `${pCount} online` : room ? "Share an invite link to start" : "Your saved session is loading…"}
              </span>
            </div>
          </div>

          <div className="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-end sm:gap-1.5">
            {connected && room?.call && room.call.participants.length >= 2 && !room.call.participants.includes(session.memberId) && (
              <span className="hidden items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 sm:flex">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Line busy
              </span>
            )}

            {connected && (
              <>
                <button
                  type="button"
                  onClick={() => startCall("audio")}
                  disabled={!isOnline || isInCall || Boolean(room?.call)}
                  title="Start voice call"
                  aria-label="Start voice call"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-35 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-blue-400"
                >
                  <Phone className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => startCall("video")}
                  disabled={!isOnline || isInCall || Boolean(room?.call)}
                  title="Start video call"
                  aria-label="Start video call"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-35 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-blue-400"
                >
                  <Video className="h-4 w-4" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setIsQrModalOpen(true)}
              title="Show QR code"
              aria-label="Show QR code"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-blue-600 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-blue-400"
            >
              <QrCode className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => setIsEndModalOpen(true)}
              title="Log out of room"
              aria-label="Log out of room"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        {(roomConnectionError || !isOnline) && (
          <div
            role="status"
            title={roomConnectionError || undefined}
            className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 sm:px-4"
          >
            <WifiOff className="h-4 w-4 shrink-0" />
            <span>
              {!isOnline
                ? "You’re offline. Your room session is saved and will reconnect when you’re back online."
                : "Connection interrupted. Reconnecting to your room automatically…"}
            </span>
          </div>
        )}

        {/* Message Feed */}
        <main
          ref={messageListRef}
          className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-3 bg-zinc-100/70 dark:bg-zinc-950 overscroll-contain text-sm"
        >
          {!connected && (
            <div className="mx-auto my-6 max-w-sm space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 text-center shadow-xs dark:border-zinc-800 dark:bg-zinc-900 sm:my-8 sm:p-6">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                {!room || !isOnline || roomConnectionError ? <WifiOff className="h-6 w-6" /> : <Users className="h-6 w-6" />}
              </div>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {!room || !isOnline || roomConnectionError ? "Restoring your room" : "Waiting for Someone to Join"}
              </h3>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                {!room || !isOnline || roomConnectionError
                  ? "Your saved room session will reconnect automatically when the service is reachable."
                  : "Share your invite link or let them scan the QR code to start chatting."}
              </p>
              <div className="flex gap-2 justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setIsQrModalOpen(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-xs transition-colors"
                >
                  <QrCode className="w-3.5 h-3.5" /> Show QR
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    toast.success("Invite link copied to clipboard");
                  }}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs font-medium shadow-xs transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy Link
                </button>
              </div>
            </div>
          )}

          {connected && !room?.messages.length && !room?.media.length && (
            <div className="mx-auto flex min-h-[45vh] max-w-sm flex-col items-center justify-center px-6 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600/10 text-blue-600 dark:text-blue-400">
                <MessageSquare className="h-5 w-5" />
              </div>
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">You’re connected</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">Send a message, share a view-once photo, or start a call.</p>
            </div>
          )}

          {(room?.messages && room.messages.length > 0) || (room?.media && room.media.length > 0) ? (
            <div className="mx-auto max-w-2xl space-y-3">
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
                    {!isOwn && (
                      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 ml-1 mb-1">
                        {item.alias}
                      </span>
                    )}

                    <div
                      className={`max-w-[85%] sm:max-w-[80%] px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl shadow-xs transition-all ${
                        isOwn
                          ? "bg-blue-600 text-white rounded-br-xs"
                          : "bg-white dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-xs"
                      }`}
                    >
                      <p className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{item.body}</p>

                      <div
                        className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
                          isOwn ? "text-blue-100" : "text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        <span>
                          {new Date(item.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>

                        {isOwn && (
                          <span>
                            {item.readBy.length >= room.participantCount - 1 && room.participantCount > 1 ? (
                              <CheckCheck className="w-3.5 h-3.5 text-blue-200 inline" />
                            ) : item.deliveredTo.length > 0 ? (
                              <CheckCheck className="w-3.5 h-3.5 opacity-70 inline" />
                            ) : (
                              <Check className="w-3.5 h-3.5 opacity-60 inline" />
                            )}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void copyMessage(item.id, item.body)}
                          className={`ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors ${
                            isOwn
                              ? "text-blue-100 hover:bg-blue-500 hover:text-white"
                              : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          }`}
                          aria-label={copiedMessageId === item.id ? "Message copied" : "Copy message"}
                          title="Copy message"
                        >
                          <Copy className="h-3 w-3" />
                          <span>{copiedMessageId === item.id ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {room?.media?.map((item) => {
                const isOwn = item.memberId === session.memberId;
                const isConsumed =
                  item.kind !== "document" && (
                    consumedMediaIds.has(item.id) ||
                    (item.consumedBy && item.consumedBy.includes(session.memberId)) ||
                    !item.dataUrl
                  );

                return (
                  <div key={item.id} className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
                    {!isOwn && (
                      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 ml-1 mb-1">
                        {item.alias}
                      </span>
                    )}

                    <div
                      className={`p-2.5 sm:p-3 rounded-2xl shadow-xs border ${
                        isOwn
                          ? "bg-blue-600/10 border-blue-500/20 text-blue-950 dark:text-blue-100 rounded-br-xs"
                          : "bg-white dark:bg-zinc-900 border-zinc-200/80 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-xs"
                      }`}
                    >
                      {item.kind === "document" ? (
                        <a
                          href={item.dataUrl}
                          download={item.fileName || "document"}
                          className="flex min-w-[220px] max-w-[min(80vw,360px)] items-center gap-3 rounded-xl px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
                            <FileText className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{item.fileName || "Document"}</span>
                            <span className="mt-0.5 block text-[10px] text-zinc-500 dark:text-zinc-400">Download document</span>
                          </span>
                          <Download className="h-4 w-4 shrink-0 text-zinc-400" />
                        </a>
                      ) : item.kind === "voice" ? (
                        isConsumed ? (
                          <div className="flex items-center gap-2 text-xs text-zinc-400 italic py-1 px-2">
                            <Volume2 className="w-4 h-4 opacity-50" />
                            <span>Voice message expired</span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5 min-w-[200px] sm:min-w-[220px]">
                            <audio
                              controls
                              controlsList="nodownload"
                              playsInline
                              preload="auto"
                              src={item.dataUrl}
                              className="w-full h-8"
                              onEnded={() => {
                                if (!isOwn) void consumeMediaOnce(item.id);
                              }}
                            />
                            {!isOwn && (
                              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 px-1">
                                Plays once then disappears
                              </span>
                            )}
                          </div>
                        )
                      ) : item.kind === "photo" ? (
                        isConsumed ? (
                          <div className="flex items-center gap-2 text-xs text-zinc-400 italic py-1 px-2">
                            <Eye className="w-4 h-4 opacity-50" />
                            <span>Photo already viewed</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openViewOncePhoto(item)}
                            className="flex items-center gap-2 px-3.5 sm:px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-xs transition-colors"
                          >
                            <Eye className="w-4 h-4" /> View photo (once)
                          </button>
                        )
                      ) : (
                        isConsumed ? (
                          <div className="flex items-center gap-2 text-xs text-zinc-400 italic py-1 px-2">
                            <Video className="w-4 h-4 opacity-50" />
                            <span>Video already viewed</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openViewOnceVideo(item)}
                            className="flex items-center gap-2 px-3.5 sm:px-4 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-xs transition-colors"
                          >
                            <Video className="w-4 h-4" /> Watch video (once)
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

        </main>

        {/* Floating preview for selected photo */}
        {selectedPhoto && (
          <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-blue-50 dark:bg-blue-950/40 border-t border-blue-200 dark:border-blue-900/50 text-xs text-blue-900 dark:text-blue-200">
            <span className="flex items-center gap-1.5 font-medium truncate">
              <ImageIcon className="w-4 h-4 shrink-0" />
              <span className="truncate">Photo attached (view-once)</span>
            </span>
            <button
              type="button"
              onClick={() => setSelectedPhoto(null)}
              className="text-red-500 hover:text-red-600 p-1 rounded-full font-bold shrink-0 ml-2"
              aria-label="Remove photo"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Floating preview for selected video */}
        {selectedVideo && (
          <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-blue-50 dark:bg-blue-950/40 border-t border-blue-200 dark:border-blue-900/50 text-xs text-blue-900 dark:text-blue-200">
            <span className="flex items-center gap-1.5 font-medium truncate">
              <Video className="w-4 h-4 shrink-0" />
              <span className="truncate">Video attached (view-once)</span>
            </span>
            <button
              type="button"
              onClick={() => setSelectedVideo(null)}
              className="text-red-500 hover:text-red-600 p-1 rounded-full font-bold shrink-0 ml-2"
              aria-label="Remove video"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {selectedDocument && (
          <div className="flex items-center justify-between border-t border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200 sm:px-4">
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{selectedDocument.file.name}</span>
              <span className="shrink-0 text-[10px] opacity-70">(document)</span>
            </span>
            <button type="button" onClick={() => setSelectedDocument(null)} className="ml-2 shrink-0 rounded-full p-1 font-bold text-red-500 hover:text-red-600" aria-label="Remove document">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Composer */}
        <footer className="shrink-0 border-t border-zinc-200 bg-white p-2.5 pb-[calc(0.65rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900 sm:p-3">
          {isRecording ? (
            <div className="flex items-center justify-between gap-2 p-2 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 text-xs">
              <span className="flex items-center gap-1.5 font-medium pl-1 truncate">
                <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse shrink-0" />
                <span className="truncate">Recording... ({String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")})</span>
              </span>
              <div className="flex gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={cancelRecording}
                  className="px-2.5 py-1 rounded-full border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={stopAndSendRecording}
                  className="px-3.5 py-1 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-medium shadow-xs"
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 sm:gap-2 max-w-2xl mx-auto w-full">
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
                disabled={!connected || !isOnline}
                onClick={() => document.getElementById("photo-upload-input")?.click()}
                className="flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-blue-400 sm:w-10"
                title="Send view-once photo"
                aria-label="Attach a view-once photo"
              >
                <ImageIcon className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              <input
                id="video-upload-input"
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  void handleVideoFileSelected(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />

              <button
                type="button"
                disabled={!connected || !isOnline}
                onClick={() => document.getElementById("video-upload-input")?.click()}
                className="flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-blue-400 sm:w-10"
                title="Send view-once video"
                aria-label="Attach a view-once video"
              >
                <Video className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              <input
                id="document-upload-input"
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.json,.md,application/*,text/*"
                className="hidden"
                onChange={(e) => {
                  handleDocumentFileSelected(e.currentTarget.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />

              <button
                type="button"
                disabled={!connected || !isOnline}
                onClick={() => document.getElementById("document-upload-input")?.click()}
                className="flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-blue-400 sm:w-10"
                title="Send document"
                aria-label="Attach a document"
              >
                <FileText className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>

              <button
                type="button"
                disabled={!connected || !isOnline}
                onClick={startRecording}
                className="flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-blue-600 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-blue-400 sm:w-10"
                title="Record voice note"
                aria-label="Record a voice note"
              >
                <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              <div className="min-w-0 flex-1">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={message}
                  onChange={(event) => {
                    handleMessageChange(event.currentTarget.value);
                    event.currentTarget.style.height = "40px";
                    event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 120)}px`;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!connected || !isOnline}
                  placeholder={!isOnline ? "Reconnect to send messages…" : connected ? "Type a message…" : "Waiting for friend to connect…"}
                  aria-label="Message"
                  className="min-h-10 max-h-[120px] w-full resize-none overflow-y-auto rounded-2xl border border-zinc-200 bg-zinc-100 px-3.5 py-2 text-sm text-zinc-900 transition-all placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-100"
                />
              </div>

              <button
                type="button"
                onClick={() => void send()}
                disabled={!connected || !isOnline || (!message.trim() && !selectedPhoto && !selectedVideo && !selectedDocument)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-xs transition-colors hover:bg-blue-700 disabled:opacity-40"
                title="Send"
                aria-label="Send message"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          )}
        </footer>

        {/* View Once Photo Overlay */}
        {activePhoto && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="View-once photo"
            className="protected-media fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95 p-4 backdrop-blur-md"
            onClick={closeActivePhoto}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
          >
            <div className="flex items-center justify-between w-full max-w-md mb-3 text-white text-xs font-medium">
              <span className="flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-blue-400" /> View-once photo
              </span>
              <button
                onClick={closeActivePhoto}
                className="rounded-full bg-white/10 px-3 py-1 font-medium text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>
            <div className="max-h-[75vh] overflow-hidden rounded-2xl border border-white/10 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <img src={activePhoto} alt="View-once photo" draggable={false} className="max-h-[70vh] select-none object-contain" />
            </div>
          </div>
        )}

        {/* View Once Video Overlay */}
        {activeVideo && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="View-once video"
            className="protected-media fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95 p-4 backdrop-blur-md"
            onClick={closeActiveVideo}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
          >
            <div
              className="flex items-center justify-between w-full max-w-lg mb-3 text-white text-xs font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="flex items-center gap-1.5">
                <Video className="w-4 h-4 text-blue-400" /> View-once video
              </span>
              <button
                onClick={closeActiveVideo}
                className="rounded-full bg-white/10 px-3 py-1 font-medium text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>
            <div
              className="rounded-2xl overflow-hidden border border-white/10 max-h-[75vh] max-w-lg w-full shadow-2xl bg-black flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <video
                src={activeVideo}
                autoPlay
                playsInline
                controls
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture
                disableRemotePlayback
                draggable={false}
                onContextMenu={(event) => event.preventDefault()}
                onDragStart={(event) => event.preventDefault()}
                onEnded={closeActiveVideo}
                className="max-h-[70vh] w-full select-none object-contain"
              />
            </div>
          </div>
        )}

        {/* Call Modal */}
        {isInCall && (
          <CallModal
            kind={callKind}
            partnerAlias={partnerAlias}
            isInitiator={isInitiator || room?.call?.initiatorId === session.memberId}
            localStream={localStream}
            remoteStreams={remoteStreams}
            callError={callError}
            callStatus={callStatus}
            onAccept={acceptCall}
            onReject={rejectCall}
            onHangup={hangupCall}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            isMicMuted={isMicMuted}
            isCamOff={isCamOff}
          />
        )}

        {/* QR Invite Modal */}
        {isQrModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsQrModalOpen(false);
            }}
          >
            <div className="relative w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 shadow-2xl text-center">
              <button
                type="button"
                onClick={() => setIsQrModalOpen(false)}
                className="absolute top-4 right-4 p-1.5 rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>

              <TemporaryQr
                inviteUrl={inviteUrl}
                inline={true}
                onClose={() => setIsQrModalOpen(false)}
              />
            </div>
          </div>
        )}

        {/* End Room Modal */}
        {isEndModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-200">
            <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 text-center space-y-4 shadow-2xl">
              <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center mx-auto">
                <LogOut className="w-6 h-6" />
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Log out of this room?</h3>
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  Your saved session will be removed from this device. When online, VeilChat will notify the room that you left.
                </p>
              </div>

              <div className="flex gap-2 justify-center pt-2">
                <button
                  onClick={() => setIsEndModalOpen(false)}
                  className="px-4 py-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 text-xs font-medium transition-colors"
                >
                  Stay
                </button>
                <button
                  onClick={endRoom}
                  className="px-5 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-xs transition-colors"
                >
                  Log out & leave
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
    <div className="flex min-h-[100dvh] flex-col bg-zinc-50 p-4 pt-[calc(1rem+env(safe-area-inset-top))] text-zinc-900 transition-colors selection:bg-blue-600 selection:text-white dark:bg-zinc-950 dark:text-zinc-100 sm:p-6">
      {/* Header */}
      <header className="flex items-center justify-between max-w-2xl w-full mx-auto py-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
            <Lock className="w-4 h-4" />
          </div>
          <span className="font-bold text-base tracking-tight text-zinc-900 dark:text-zinc-100">
            VeilChat
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Light / Dark Mode Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-zinc-700" />}
            <span className="text-[11px] font-medium">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>

          <button
            onClick={() => setIsScannerOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
          >
            <Camera className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Scan QR</span>
          </button>
        </div>
      </header>

      {/* Main Card */}
      <main className="max-w-sm w-full mx-auto my-auto py-8">
        <div className="p-5 sm:p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-sm space-y-5">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isJoin ? "Join Private Chat" : "Start Private Chat"}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {isJoin
                ? `You were invited to chat with ${invite?.hostAlias || "a friend"}.`
                : "Private room. It stays available until you leave."}
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-sm">
                <label htmlFor="alias-input" className="font-medium text-zinc-700 dark:text-zinc-300">
                  Your Nickname
                </label>
                <button
                  type="button"
                  onClick={generateRandomAlias}
                  className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                    <Dice5 className="w-3.5 h-3.5" /> Randomize
                </button>
              </div>

              <input
                id="alias-input"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void (isJoin ? join() : create());
                }}
                placeholder="Enter a display name..."
                maxLength={32}
                autoComplete="off"
                className="w-full bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 text-xs">
                {error}
              </div>
            )}

            <button
              onClick={() => void (isJoin ? join() : create())}
              disabled={createRoom.isPending || joinRoom.isPending || !alias.trim()}
              className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isJoin ? "Join Conversation" : "Create New Room"}
            </button>
          </div>

          <div className="border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <a href={ANDROID_DOWNLOAD_URL} download className="text-blue-600 hover:underline dark:text-blue-400">Download Android app</a>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>Android blocks system screenshots and recording. Browsers can’t guarantee capture prevention.</span>
            </p>
          </div>
        </div>
      </main>

      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScan={handleScanSuccess}
      />
    </div>
  );
}
