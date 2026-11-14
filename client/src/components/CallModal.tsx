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
  onSwitchToVideo: () => void;
  isMicMuted: boolean;
  isCamOff: boolean;
  hasLocalVideo: boolean;
  isSwitchingToVideo: boolean;
}

function RemoteTile({ item, kind }: { item: RemoteStream; kind: "audio" | "video" }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const enableAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      void Promise.resolve(audio.play()).then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    } catch {
      setAudioBlocked(true);
    }
  };
  useEffect(() => {
    if (videoRef.current && kind === "video") {
      videoRef.current.srcObject = item.stream;
      void videoRef.current.play().catch(() => undefined);
    }
    if (audioRef.current) {
      audioRef.current.srcObject = item.stream;
      try {
        void Promise.resolve(audioRef.current.play()).then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
      } catch {
        setAudioBlocked(true);
      }
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
      {audioBlocked && (
        <button
          type="button"
          onClick={enableAudio}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-lg"
        >
          Tap to enable audio
        </button>
      )}
    </div>
  );
}

export const CallModal: React.FC<CallModalProps> = ({
  kind, partnerAlias = "Participant", isInitiator, localStream, remoteStreams, callError, callStatus,
  onAccept, onReject, onHangup, onToggleMic, onToggleCam, onSwitchToVideo,
  isMicMuted, isCamOff, hasLocalVideo, isSwitchingToVideo,
}) => {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  useEffect(() => {
    if (!localVideoRef.current || !localStream || !hasLocalVideo || kind !== "video") return;
    localVideoRef.current.srcObject = localStream;
    void localVideoRef.current.play().catch(() => undefined);
  }, [hasLocalVideo, isCamOff, kind, localStream]);
  useEffect(() => {
    if (callStatus !== "connected") { setCallDuration(0); return; }
    const timer = window.setInterval(() => setCallDuration((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [callStatus]);
  const duration = `${String(Math.floor(callDuration / 60)).padStart(2, "0")}:${String(callDuration % 60).padStart(2, "0")}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black p-0 sm:bg-black/80 sm:p-6">
      <div className="relative flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col overflow-hidden bg-white shadow-2xl dark:bg-zinc-900 sm:h-[88vh] sm:max-h-[720px] sm:max-w-4xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))] dark:border-zinc-800 sm:pt-3">
          <div className="min-w-0">
            <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{kind === "video" ? "Video call" : "Voice call"}</span>
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
              {isSwitchingToVideo ? "Adding video…" : callStatus === "ringing" ? `${partnerAlias} is calling` : callStatus === "connected" ? "Connected" : "Connecting…"}
            </span>
          </div>
          {callStatus === "connected" && <span className="ml-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{duration}</span>}
        </div>
        <div className={`relative grid flex-1 gap-2 bg-zinc-950 p-2 ${remoteStreams.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {remoteStreams.length ? remoteStreams.map((item) => <RemoteTile key={item.memberId} item={item} kind={kind} />) : (
            <div className="flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-400">
              <span>{callStatus === "ringing" ? `${partnerAlias} is calling` : "Connecting stream…"}</span>
              {callError && <span className="max-w-sm rounded-xl border border-red-400/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">{callError}</span>}
            </div>
          )}
          {kind === "video" && hasLocalVideo && localStream && !isCamOff && (
            <video ref={localVideoRef} autoPlay playsInline muted className="absolute right-4 top-4 z-10 h-32 w-24 rounded-xl border border-white/30 object-cover sm:h-44 sm:w-32" />
          )}
        </div>
        <div className="flex items-center justify-center gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900 sm:pb-4">
          {callStatus === "ringing" && !isInitiator ? (
            <>
              <button type="button" onClick={onReject} className="rounded-full bg-red-100 px-5 py-2 text-xs font-medium text-red-700">Decline</button>
              <button type="button" onClick={onAccept} className="rounded-full bg-emerald-600 px-6 py-2 text-xs font-medium text-white">Accept</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onToggleMic} className="rounded-full border p-3 dark:border-zinc-700" aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"} title={isMicMuted ? "Unmute microphone" : "Mute microphone"}>{isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
              {kind === "audio" && callStatus === "connected" && (
                <button
                  type="button"
                  onClick={onSwitchToVideo}
                  disabled={isSwitchingToVideo}
                  className="flex items-center gap-2 rounded-full border px-4 py-3 text-xs font-medium disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700"
                  aria-label={isSwitchingToVideo ? "Adding video to call" : "Switch to video call"}
                  title={isSwitchingToVideo ? "Adding camera to this call" : "Add your camera to this call"}
                >
                  <Video size={18} />
                  <span>{isSwitchingToVideo ? "Adding video…" : "Add video"}</span>
                </button>
              )}
              {kind === "video" && hasLocalVideo && <button type="button" onClick={onToggleCam} className="rounded-full border p-3 dark:border-zinc-700" aria-label={isCamOff ? "Turn camera on" : "Turn camera off"} title={isCamOff ? "Turn camera on" : "Turn camera off"}>{isCamOff ? <VideoOff size={18} /> : <Video size={18} />}</button>}
              {kind === "video" && !hasLocalVideo && callStatus === "connected" && (
                <button
                  type="button"
                  onClick={onSwitchToVideo}
                  disabled={isSwitchingToVideo}
                  className="flex items-center gap-2 rounded-full border px-4 py-3 text-xs font-medium disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700"
                  aria-label={isSwitchingToVideo ? "Adding your camera" : "Add your camera to the call"}
                  title="Add your camera to the call"
                >
                  <Video size={18} />
                  <span>{isSwitchingToVideo ? "Adding video…" : "Add camera"}</span>
                </button>
              )}
              <button type="button" onClick={onHangup} className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-2 text-xs font-semibold text-white"><PhoneOff size={16} /> End call</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
