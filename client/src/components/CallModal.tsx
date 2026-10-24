import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, Phone, PhoneOff } from "lucide-react";

type RemoteStream = { memberId: string; stream: MediaStream };

interface CallModalProps {
  kind: "audio" | "video";
  partnerAlias?: string;
  isInitiator: boolean;
  localStream: MediaStream | null;
  remoteStreams: RemoteStream[];
  callError?: string | null;
  callStatus: "calling" | "ringing" | "connected" | "ended";
  onAccept?: () => void;
  onReject?: () => void;
  onHangup: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  isMicMuted: boolean;
  isCamOff: boolean;
}

function RemoteTile({ item, kind }: { item: RemoteStream; kind: "audio" | "video" }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (videoRef.current && kind === "video") {
      videoRef.current.srcObject = item.stream;
      void videoRef.current.play().catch(() => undefined);
    }
    if (audioRef.current) {
      audioRef.current.srcObject = item.stream;
      void audioRef.current.play().catch(() => undefined);
    }
  }, [item.stream, kind]);
  return (
    <div className="relative min-h-0 overflow-hidden rounded-2xl bg-zinc-900">
      <audio ref={audioRef} autoPlay playsInline />
      {kind === "video" ? (
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full min-h-40 items-center justify-center text-3xl font-semibold text-white">{item.memberId.slice(0, 2).toUpperCase()}</div>
      )}
    </div>
  );
}

export const CallModal: React.FC<CallModalProps> = ({
  kind, partnerAlias = "Participant", isInitiator, localStream, remoteStreams, callError, callStatus,
  onAccept, onReject, onHangup, onToggleMic, onToggleCam, isMicMuted, isCamOff,
}) => {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  useEffect(() => {
    if (!localVideoRef.current || !localStream) return;
    localVideoRef.current.srcObject = localStream;
    void localVideoRef.current.play().catch(() => undefined);
  }, [localStream, isCamOff]);
  useEffect(() => {
    if (callStatus !== "connected") { setCallDuration(0); return; }
    const timer = window.setInterval(() => setCallDuration((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [callStatus]);
  const duration = `${String(Math.floor(callDuration / 60)).padStart(2, "0")}:${String(callDuration % 60).padStart(2, "0")}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-6">
      <div className="relative flex h-[88vh] max-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{kind === "video" ? "Video call" : "Voice call"}</span>
          {callStatus === "connected" && <span className="font-mono text-xs text-zinc-500">{duration}</span>}
        </div>
        <div className={`relative grid flex-1 gap-2 bg-zinc-950 p-2 ${remoteStreams.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {remoteStreams.length ? remoteStreams.map((item) => <RemoteTile key={item.memberId} item={item} kind={kind} />) : (
            <div className="flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-400">
              <span>{callStatus === "ringing" ? `${partnerAlias} is calling` : "Connecting stream…"}</span>
              {callError && <span className="max-w-sm rounded-xl border border-red-400/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">{callError}</span>}
            </div>
          )}
          {kind === "video" && localStream && !isCamOff && (
            <video ref={localVideoRef} autoPlay playsInline muted className="absolute right-4 top-4 z-10 h-32 w-24 rounded-xl border border-white/30 object-cover sm:h-44 sm:w-32" />
          )}
        </div>
        <div className="flex items-center justify-center gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          {callStatus === "ringing" && !isInitiator ? (
            <>
              <button type="button" onClick={onReject} className="rounded-full bg-red-100 px-5 py-2 text-xs font-medium text-red-700">Decline</button>
              <button type="button" onClick={onAccept} className="rounded-full bg-emerald-600 px-6 py-2 text-xs font-medium text-white">Accept</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onToggleMic} className="rounded-full border p-3 dark:border-zinc-700">{isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
              {kind === "video" && <button type="button" onClick={onToggleCam} className="rounded-full border p-3 dark:border-zinc-700">{isCamOff ? <VideoOff size={18} /> : <Video size={18} />}</button>}
              <button type="button" onClick={onHangup} className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-2 text-xs font-semibold text-white"><PhoneOff size={16} /> End call</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
