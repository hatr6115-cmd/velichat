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
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import TemporaryQr from "@/components/TemporaryQr";
import QrScannerModal from "@/components/QrScannerModal";
import { useRoomStream } from "@/hooks/useRoomStream";
import {
  createTemporaryInvite,
  encodeTemporaryInvite,
  parseTemporaryInvite,
  type TemporaryInvite,
} from "@shared/temporaryInvite";

const aliasPattern = /^[A-Za-z0-9 ._-]{2,32}$/;

const RANDOM_ALIASES = [
  "SilentFalcon",
  "VelvetNova",
  "GhostRider",
  "EchoMist",
  "ShadowFox",
  "LunarNomad",
  "CyberPulse",
  "NeonDrifter",
  "SolarKite",
  "AstralProwler",
  "ZenithWalker",
  "VortexWanderer",
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
        error: "This temporary chat invite is invalid or expired.",
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

  const typingTimerRef = useRef<number | undefined>(undefined);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const messageNodesRef = useRef(new Map<string, HTMLElement>());
  const messageListRef = useRef<HTMLDivElement>(null);
  const readObserverRef = useRef<IntersectionObserver | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Real-time SSE Stream
  const { data: sseData, isConnected: isSseConnected } = useRoomStream({
    roomId: session?.roomId || "",
    inviteToken: session?.inviteToken || "",
    memberId: session?.memberId || "",
    enabled: Boolean(session),
    onClosed: (reason) => {
      toast.info(reason || "Chat session ended.");
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
  }, [room?.messages?.length, room?.media?.length, room?.typingAlias]);

  // When guest connects, automatically dismiss QR modal and alert host
  useEffect(() => {
    if (room?.participantCount === 2 && isQrModalOpen) {
      setIsQrModalOpen(false);
      toast.success("Guest joined! Chat is ready.");
    }
  }, [room?.participantCount, isQrModalOpen]);

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
    const unreadIncoming = room.messages.some((item) => item.memberId !== session.memberId && !item.readBy);

    if (room.participantCount === 2 && room.messages.some((item) => item.memberId !== session.memberId && !item.deliveredBy)) {
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

        if (item && item.memberId !== session.memberId && !item.readBy && intersectsList) {
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
      if (item && item.memberId !== session.memberId && !item.readBy) {
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
      toast.success(`Found invite from ${parsed.hostAlias}`);
    } catch {
      setError("Scanned code is not a valid VeilChat invitation.");
      toast.error("Invalid QR code");
    }
  };

  async function create() {
    const cleanAlias = validateAlias(alias);
    if (!cleanAlias) {
      setError("Choose an alias between 2 and 32 characters (letters, numbers, spaces, dots, dashes).");
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
      toast.success("Temporary room created");
    } catch (cause: any) {
      setError(cause instanceof Error ? cause.message : "Could not create the room.");
    }
  }

  async function join() {
    if (!invite) return;
    const cleanAlias = validateAlias(alias);
    if (!cleanAlias) {
      setError("Choose an alias between 2 and 32 characters.");
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
      toast.success("Joined room successfully");
    } catch (cause: any) {
      setError(cause instanceof Error ? cause.message : "This invite cannot be joined.");
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
        const MAX_DIM = 1400;
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
          reader.onerror = () => reject(new Error("Could not process photo."));
          reader.readAsDataURL(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve(dataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not load photo."));
        reader.readAsDataURL(file);
      };
      img.src = objectUrl;
    });
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not process media."));
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
        toast.success("View-once photo sent");
      } catch (cause: any) {
        toast.error(cause instanceof Error ? cause.message : "Failed to send photo");
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
        toast.error(cause instanceof Error ? cause.message : "Failed to send message");
      }
    }
  }

  async function startRecording() {
    if (!session || room?.participantCount !== 2) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("Audio recording is not supported in this browser.");
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
            toast.success("Voice note sent");
          } catch (cause: any) {
            toast.error(cause instanceof Error ? cause.message : "Could not send voice note");
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
      toast.error("Microphone access denied or not available.");
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
    toast.info("Recording cancelled");
  }

  async function handlePhotoFileSelected(file: File | undefined) {
    if (!file) return;
    if (
      !file.type.match(/^image\/(jpeg|png|webp|gif|heic|heif)$/i) &&
      !file.name.match(/\.(jpe?g|png|webp|gif|heic|heif)$/i)
    ) {
      toast.error("Please choose a valid photo (JPG, PNG, WebP, GIF).");
      return;
    }
    try {
      const dataUrl = await compressImageFile(file);
      setSelectedPhoto({ file, dataUrl });
      toast.success("Photo attached (view once)");
    } catch {
      toast.error("Failed to process photo.");
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
    toast.success("Room ended and cleared from memory.");
  }

  if (session) {
    const connected = room?.participantCount === 2;
    const partnerAlias = room?.hostAlias === session.alias ? room?.guestAlias : room?.hostAlias;
    const isExpired = session.invite.expiresAt <= now;
    const remainingTime = formatRemaining(session.invite.expiresAt, now);

    return (
      <div className="flex flex-col h-[100dvh] max-h-[100dvh] w-full max-w-4xl mx-auto bg-slate-950 text-slate-100 antialiased select-none overflow-hidden">
        {/* Top Navigation Header */}
        <header className="flex items-center justify-between px-3 sm:px-5 py-2.5 sm:py-3.5 bg-slate-900/90 border-b border-slate-800/80 backdrop-blur-md z-20 shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="relative shrink-0">
              <div className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20 text-sm sm:text-base">
                {partnerAlias ? partnerAlias.charAt(0).toUpperCase() : session.alias.charAt(0).toUpperCase()}
              </div>
              <span
                className={`absolute bottom-0 right-0 w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full border-2 border-slate-900 ${
                  connected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                }`}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h2 className="text-xs sm:text-sm font-semibold text-white tracking-wide truncate max-w-[110px] sm:max-w-[200px]">
                  {connected ? partnerAlias : "Waiting for guest"}
                </h2>
                {isSseConnected && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[9px] sm:text-[10px] font-medium shrink-0">
                    <Radio size={10} className="animate-pulse" /> Live
                  </span>
                )}
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 truncate">
                <span>You: <strong className="text-slate-300 font-medium">{session.alias}</strong></span>
                <span>•</span>
                <span>{connected ? "2 participants" : "1 participant"}</span>
              </p>
            </div>
          </div>

          {/* Header Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div
              className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-xl border text-[11px] sm:text-xs font-mono font-medium ${
                session.invite.expiresAt - now < 300_000
                  ? "bg-red-500/10 border-red-500/30 text-red-400 animate-pulse"
                  : "bg-slate-800/80 border-slate-700/60 text-slate-300"
              }`}
            >
              <Clock3 size={12} />
              <span>{isExpired ? "00:00" : remainingTime}</span>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsQrModalOpen(true)}
              className="rounded-xl border-slate-700 bg-slate-800/60 hover:bg-slate-800 text-slate-200 text-xs h-8 sm:h-9 px-2 sm:px-3 gap-1.5"
            >
              <QrCode size={14} className="text-emerald-400" />
              <span className="hidden sm:inline">Invite QR</span>
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsEndModalOpen(true)}
              className="rounded-xl border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50 text-red-400 text-xs h-8 sm:h-9 px-2 sm:px-3 gap-1.5"
            >
              <LogOut size={14} />
              <span className="hidden sm:inline">End Chat</span>
            </Button>
          </div>
        </header>

        {/* Message Stream */}
        <main
          ref={messageListRef}
          className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-3.5 bg-gradient-to-b from-slate-950 via-slate-900/30 to-slate-950 overscroll-contain"
        >
          {!connected && (
            <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-900/50 border border-slate-800/80 rounded-3xl max-w-md mx-auto my-6 backdrop-blur-sm">
              <div className="flex items-center justify-center w-14 h-14 mb-4 rounded-2xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Users size={28} />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">Waiting for your guest to join</h3>
              <p className="text-xs text-slate-400 mb-5 max-w-xs leading-relaxed">
                Share this temporary invite link or show the QR code. Only one person can enter.
              </p>
              <div className="flex gap-2 w-full max-w-xs">
                <Button
                  onClick={() => setIsQrModalOpen(true)}
                  className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-9 gap-1.5 shadow-lg shadow-emerald-950/40"
                >
                  <QrCode size={14} /> Show QR Code
                </Button>
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    toast.success("Invite link copied");
                  }}
                  variant="outline"
                  className="rounded-xl border-slate-700 bg-slate-800 text-slate-200 text-xs h-9 px-3 gap-1.5"
                >
                  <Copy size={14} /> Copy
                </Button>
              </div>
            </div>
          )}

          {(room?.messages && room.messages.length > 0) || (room?.media && room.media.length > 0) ? (
            <div className="space-y-3.5 max-w-2xl mx-auto">
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
                    <div className="text-[11px] font-medium text-slate-400 mb-1 px-1 flex items-center gap-1.5">
                      <span>{isOwn ? "You" : item.alias}</span>
                      <span>•</span>
                      <span className="text-slate-400">
                        {new Date(item.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>

                    <div
                      className={`relative max-w-[85%] sm:max-w-md px-4 py-2.5 rounded-2xl text-sm leading-relaxed break-words shadow-sm ${
                        isOwn
                          ? "bg-gradient-to-br from-emerald-600 to-teal-700 text-white rounded-tr-xs shadow-emerald-950/20"
                          : "bg-slate-800/90 text-slate-100 border border-slate-700/60 rounded-tl-xs"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{item.body}</p>

                      {isOwn && (
                        <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-emerald-200/80 font-mono">
                          {item.readBy ? (
                            <span className="flex items-center gap-0.5 text-cyan-300 font-semibold" title="Read by partner">
                              <CheckCheck size={13} /> Read
                            </span>
                          ) : item.deliveredBy ? (
                            <span className="flex items-center gap-0.5 text-emerald-200" title="Delivered to partner">
                              <CheckCheck size={13} /> Delivered
                            </span>
                          ) : (
                            <span className="flex items-center gap-0.5 text-emerald-300/80" title="Sent to room">
                              <Check size={13} /> Sent
                            </span>
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
                  (item.consumedBy && item.consumedBy !== session.memberId) ||
                  !item.dataUrl;

                return (
                  <div key={item.id} className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
                    <div className="text-[11px] font-medium text-slate-400 mb-1 px-1 flex items-center gap-1.5">
                      <span>{isOwn ? "You" : item.alias}</span>
                      <span>•</span>
                      <span className="text-emerald-400 font-semibold">
                        {item.kind === "voice" ? "VOICE NOTE" : "VIEW-ONCE PHOTO"}
                      </span>
                    </div>

                    <div
                      className={`p-3 sm:p-3.5 rounded-2xl max-w-[85%] sm:max-w-sm border ${
                        isOwn
                          ? "bg-slate-900 border-emerald-500/30 text-slate-100"
                          : "bg-slate-800/90 border-slate-700/80 text-slate-100"
                      }`}
                    >
                      {item.kind === "voice" ? (
                        isConsumed ? (
                          <div className="flex items-center gap-2.5 text-xs text-slate-400 py-1">
                            <Volume2 size={16} className="text-slate-400" />
                            <span>Voice note played once</span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5 py-0.5 min-w-[180px] sm:min-w-[240px]">
                            <audio
                              controls
                              controlsList="nodownload"
                              playsInline
                              preload="auto"
                              src={item.dataUrl}
                              className="w-full h-8 accent-emerald-500 rounded-lg"
                              onEnded={() => {
                                if (!isOwn) void consumeMediaOnce(item.id);
                              }}
                            />
                            {!isOwn && (
                              <span className="text-[10px] text-slate-400 px-1">
                                Plays once • Vanishes when finished
                              </span>
                            )}
                          </div>
                        )
                      ) : isConsumed ? (
                        <div className="flex items-center gap-2.5 text-xs text-slate-400 py-1">
                          <Eye size={16} className="text-slate-400" />
                          <span>Photo viewed once</span>
                        </div>
                      ) : (
                        <Button
                          onClick={() => openViewOncePhoto(item)}
                          className="w-full rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs h-10 gap-2 shadow-md"
                        >
                          <Flame size={16} className="text-amber-300" /> View once photo
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            connected && (
              <div className="flex flex-col items-center justify-center h-48 text-center text-slate-400">
                <Sparkles size={24} className="text-emerald-400 mb-2 animate-bounce" />
                <p className="text-xs font-medium text-slate-300">Connected with {partnerAlias}</p>
                <p className="text-[11px] text-slate-400">Say hello to start the ephemeral conversation.</p>
              </div>
            )
          )}

          {room?.typingAlias && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-800 text-xs text-emerald-400 w-fit animate-pulse">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce delay-100" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce delay-200" />
              </span>
              <span>{room.typingAlias} is typing…</span>
            </div>
          )}
        </main>

        {selectedPhoto && (
          <div className="flex items-center justify-between px-5 py-2.5 bg-slate-900 border-t border-slate-800">
            <div className="flex items-center gap-3">
              <img
                src={selectedPhoto.dataUrl}
                alt="Selected preview"
                className="w-12 h-12 object-cover rounded-xl border border-slate-700"
              />
              <div>
                <p className="text-xs font-medium text-slate-200">View-Once Photo Attached</p>
                <p className="text-[11px] text-slate-400">Recipient can only view it once.</p>
              </div>
            </div>
            <button
              onClick={() => setSelectedPhoto(null)}
              className="p-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Bottom Floating Composer */}
        <footer className="p-2.5 sm:p-4 bg-slate-900/90 border-t border-slate-800/80 backdrop-blur-md shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {isRecording ? (
            <div className="flex items-center justify-between gap-2 sm:gap-3 p-2 bg-slate-950 border border-red-500/30 rounded-2xl shadow-inner max-w-3xl mx-auto w-full">
              <div className="flex items-center gap-2 sm:gap-3 pl-2 sm:pl-3 min-w-0">
                <span className="flex h-3 w-3 relative shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                </span>
                <span className="text-xs font-mono font-medium text-red-400 truncate">
                  Recording {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:
                  {String(recordingSeconds % 60).padStart(2, "0")}
                </span>

                <div className="hidden sm:flex items-center gap-1">
                  <div className="w-1 bg-red-400 rounded-full animate-wave-1" />
                  <div className="w-1 bg-red-400 rounded-full animate-wave-2" />
                  <div className="w-1 bg-red-400 rounded-full animate-wave-3" />
                  <div className="w-1 bg-red-400 rounded-full animate-wave-4" />
                  <div className="w-1 bg-red-400 rounded-full animate-wave-5" />
                </div>
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancelRecording}
                  className="rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-500/10 text-xs h-9 px-2.5 sm:px-3 gap-1"
                >
                  <X size={15} /> <span className="hidden sm:inline">Cancel</span>
                </Button>
                <Button
                  size="sm"
                  onClick={stopAndSendRecording}
                  className="rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs h-9 px-3 sm:px-4 gap-1.5 shadow-md shadow-red-950/40"
                >
                  <Send size={14} /> Send
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 sm:gap-2 max-w-3xl mx-auto w-full">
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
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!connected || isExpired}
                onClick={() => document.getElementById("photo-upload-input")?.click()}
                className="rounded-2xl h-10 w-10 sm:h-11 sm:w-11 shrink-0 border-slate-700 bg-slate-800/60 hover:bg-slate-800 text-slate-300 hover:text-emerald-400"
                aria-label="Attach view-once photo"
              >
                <Camera size={18} />
              </Button>

              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!connected || isExpired}
                onClick={startRecording}
                className="rounded-2xl h-10 w-10 sm:h-11 sm:w-11 shrink-0 border-slate-700 bg-slate-800/60 hover:bg-slate-800 text-slate-300 hover:text-emerald-400"
                aria-label="Record voice note"
              >
                <Mic size={18} />
              </Button>

              <div className="flex-1 min-w-0 relative">
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e) => handleMessageChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!connected || isExpired}
                  placeholder={
                    isExpired
                      ? "Room has expired"
                      : connected
                      ? "Write a temporary message…"
                      : "Waiting for guest to join…"
                  }
                  rows={1}
                  className="w-full px-3.5 sm:px-4 py-2.5 rounded-2xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 text-slate-100 placeholder-slate-500 text-sm resize-none max-h-32 transition-colors outline-none leading-relaxed"
                />
              </div>

              <Button
                onClick={() => void send()}
                disabled={!connected || isExpired || (!message.trim() && !selectedPhoto)}
                className="rounded-2xl h-10 w-10 sm:h-11 sm:w-11 shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:bg-slate-800 shadow-md shadow-emerald-950/30"
                aria-label="Send message"
              >
                <Send size={17} />
              </Button>
            </div>
          )}
        </footer>

        {activePhoto && (
          <div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 bg-black/95 backdrop-blur-md animate-in fade-in"
            onClick={() => setActivePhoto(null)}
          >
            <div className="flex items-center justify-between w-full max-w-lg mb-3 px-2 text-white">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                <Flame size={16} /> View Once • Closes in {photoCountdown}s
              </div>
              <button
                onClick={() => setActivePhoto(null)}
                className="p-1.5 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-300"
              >
                <X size={18} />
              </button>
            </div>

            <div className="relative max-w-full max-h-[78vh] overflow-hidden rounded-2xl border border-slate-800 shadow-2xl">
              <img
                src={activePhoto}
                alt="View-once temporary shared photo"
                className="max-h-[75vh] w-auto object-contain rounded-2xl"
              />
            </div>
            <p className="text-xs text-slate-400 mt-3">Tap anywhere to close</p>
          </div>
        )}

        {isQrModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsQrModalOpen(false);
            }}
          >
            <div className="relative w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl">
              <button
                type="button"
                onClick={() => setIsQrModalOpen(false)}
                className="absolute top-4 right-4 z-10 p-2 rounded-full text-slate-400 hover:text-white bg-slate-800/80 hover:bg-slate-800 transition-colors"
                aria-label="Back to chat"
              >
                <X size={18} />
              </button>
              <TemporaryQr
                inviteUrl={inviteUrl}
                inline={true}
                onClose={() => setIsQrModalOpen(false)}
              />
            </div>
          </div>
        )}

        {isEndModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in">
            <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl text-center">
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-3 rounded-full bg-red-500/10 text-red-400">
                <LogOut size={24} />
              </div>
              <h3 className="text-base font-bold text-white mb-1">End Temporary Chat?</h3>
              <p className="text-xs text-slate-400 mb-5 leading-relaxed">
                Ending this chat will immediately disconnect both participants and permanently clear all messages from server memory.
              </p>
              <div className="flex gap-2.5">
                <Button
                  variant="outline"
                  onClick={() => setIsEndModalOpen(false)}
                  className="flex-1 rounded-xl border-slate-700 bg-slate-800/60 hover:bg-slate-800 text-slate-300 text-xs h-10"
                >
                  Keep Chatting
                </Button>
                <Button
                  onClick={endRoom}
                  className="flex-1 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs h-10 shadow-lg shadow-red-950/40"
                >
                  End Chat Now
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const isJoin = Boolean(invite);

  return (
    <div className="min-h-[100dvh] bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-emerald-500/30 selection:text-emerald-200 overflow-x-hidden">
      <header className="flex items-center justify-between max-w-5xl w-full mx-auto px-4 sm:px-6 py-4 sm:py-5">
        <a href="/" className="flex items-center gap-2.5 text-white font-bold text-base sm:text-lg tracking-tight group">
          <div className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:scale-105 transition-transform">
            <MessageSquare size={17} />
          </div>
          <span>Veil<span className="text-emerald-400 font-extrabold">Chat</span></span>
        </a>

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => setIsScannerOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition-all shadow-sm"
          >
            <Camera size={14} className="text-emerald-400" />
            <span>Scan QR</span>
          </button>
          <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20">
            <ShieldCheck size={13} /> Zero-Trace
          </div>
        </div>
      </header>

      <main className="max-w-md w-full mx-auto px-4 sm:px-5 py-6 sm:py-8 my-auto">
        <div className="text-center mb-7">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 mb-3 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
            <Sparkles size={13} /> 2 People • 30 Minutes • No Accounts
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Chat that leaves <em className="not-italic text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-300">no trace.</em>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-2 max-w-xs mx-auto">
            Choose a nickname, share a one-time link or QR code, and chat privately in server memory.
          </p>
        </div>

        <div className="p-6 bg-slate-900/90 border border-slate-800 rounded-3xl shadow-2xl backdrop-blur-xl">
          {isJoin && (
            <div className="p-4 mb-5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-left">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                  Joining Room
                </span>
                <span className="flex items-center gap-1 text-xs text-slate-300 font-mono">
                  <Clock3 size={12} /> {invite && formatRemaining(invite.expiresAt, now)}
                </span>
              </div>
              <p className="text-sm font-semibold text-white">
                Host: <strong className="text-emerald-300">{invite?.hostAlias}</strong>
              </p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5 px-1">
                <label htmlFor="alias-input" className="text-xs font-semibold text-slate-300">
                  YOUR ALIAS (NICKNAME)
                </label>
                <button
                  type="button"
                  onClick={generateRandomAlias}
                  className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors"
                >
                  <Dice5 size={13} /> Random
                </button>
              </div>

              <Input
                id="alias-input"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void (isJoin ? join() : create());
                }}
                placeholder="e.g. ShadowFox"
                maxLength={32}
                autoComplete="off"
                className="h-12 rounded-xl bg-slate-950/80 border-slate-800 focus:border-emerald-500 focus:ring-emerald-500/30 text-white placeholder-slate-500 text-sm font-medium"
              />
              <p className="text-[11px] text-slate-400 mt-1.5 px-1">
                2–32 characters • Visible only inside this chat room
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                {error}
              </div>
            )}

            <Button
              onClick={() => void (isJoin ? join() : create())}
              disabled={createRoom.isPending || joinRoom.isPending || !alias.trim()}
              className="w-full h-12 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-sm shadow-lg shadow-emerald-950/40 transition-all hover:scale-[1.01] active:scale-[0.99]"
            >
              {isJoin ? "Join Temporary Room" : "Create Temporary Room"}
            </Button>
          </div>

          {!isJoin && (
            <div className="mt-4 pt-4 border-t border-slate-800/80 text-center">
              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-emerald-400 transition-colors"
              >
                <QrCode size={15} /> Have an invite? Scan QR Code
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2.5 mt-6 text-center">
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800/60">
            <Users size={16} className="mx-auto text-emerald-400 mb-1" />
            <p className="text-xs font-semibold text-white">2 People</p>
            <p className="text-[10px] text-slate-400">Host & guest</p>
          </div>
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800/60">
            <Clock3 size={16} className="mx-auto text-emerald-400 mb-1" />
            <p className="text-xs font-semibold text-white">30 Mins</p>
            <p className="text-[10px] text-slate-400">Auto-expires</p>
          </div>
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800/60">
            <ShieldCheck size={16} className="mx-auto text-emerald-400 mb-1" />
            <p className="text-xs font-semibold text-white">In-Memory</p>
            <p className="text-[10px] text-slate-400">Zero DB storage</p>
          </div>
        </div>
      </main>

      <footer className="max-w-md mx-auto px-6 py-4 text-center text-[11px] text-slate-400">
        <p>
          Privacy note: Room state exists in server memory and auto-purges on expiry or exit.
        </p>
      </footer>

      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScan={handleScanSuccess}
      />
    </div>
  );
}
