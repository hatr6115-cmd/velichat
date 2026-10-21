import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CallModalProps {
  kind: "audio" | "video";
  partnerAlias?: string;
  isInitiator: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  callStatus: "calling" | "ringing" | "connected" | "ended";
  onAccept?: () => void;
  onReject?: () => void;
  onHangup: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  isMicMuted: boolean;
  isCamOff: boolean;
}

export const CallModal: React.FC<CallModalProps> = ({
  kind,
  partnerAlias = "Participant",
  isInitiator,
  localStream,
  remoteStream,
  callStatus,
  onAccept,
  onReject,
  onHangup,
  onToggleMic,
  onToggleCam,
  isMicMuted,
  isCamOff,
}) => {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [needsUserTap, setNeedsUserTap] = useState(false);

  const hasRemoteVideo = Boolean(
    remoteStream &&
    remoteStream.getVideoTracks().length > 0 &&
    remoteStream.getVideoTracks().some((t) => t.enabled && t.readyState === "live")
  );

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      const v = localVideoRef.current;
      v.muted = true;
      v.playsInline = true;
      v.srcObject = localStream;
      v.play().catch((e) => console.warn("Local play error:", e));
    }
  }, [localStream, isCamOff]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (video && remoteStream && kind === "video") {
      video.muted = true;
      video.playsInline = true;
      video.srcObject = remoteStream;
      video.play().catch((err) => {
        console.warn("Remote video play error:", err);
      });
    }
  }, [remoteStream, kind, hasRemoteVideo]);

  // Listen to track additions on remote stream
  useEffect(() => {
    if (!remoteStream) return;
    const handleTrackAdded = () => {
      if (remoteVideoRef.current && kind === "video") {
        const v = remoteVideoRef.current;
        v.muted = true;
        v.playsInline = true;
        v.srcObject = remoteStream;
        v.play().catch(console.warn);
      }
      if (remoteAudioRef.current) {
        const a = remoteAudioRef.current;
        a.srcObject = remoteStream;
        a.play().catch(console.warn);
      }
    };
    remoteStream.addEventListener("addtrack", handleTrackAdded);
    return () => {
      remoteStream.removeEventListener("addtrack", handleTrackAdded);
    };
  }, [remoteStream, kind]);

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (audio && remoteStream) {
      audio.srcObject = remoteStream;
      audio.play().then(() => {
        setNeedsUserTap(false);
      }).catch((err) => {
        console.warn("Autoplay was prevented on remote audio:", err);
        setNeedsUserTap(true);
      });
    }
  }, [remoteStream, kind]);

  const handleManualPlay = () => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.play().then(() => setNeedsUserTap(false)).catch(console.warn);
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.play().catch(console.warn);
    }
  };

  useEffect(() => {
    let timer: number | undefined;
    if (callStatus === "connected") {
      timer = window.setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(timer);
  }, [callStatus]);

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(mins).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6 bg-black/80 backdrop-blur-md select-none transition-all">
      <div className="relative flex flex-col w-full max-w-xl h-[88vh] sm:h-[80vh] max-h-[640px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-3.5 bg-zinc-50 dark:bg-zinc-900/90 border-b border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100">
          <div className="flex items-center gap-2 sm:gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-semibold tracking-tight">
              {kind === "video" ? "Video Call" : "Voice Call"}
            </span>
          </div>
          {callStatus === "connected" && (
            <div className="text-xs font-mono font-medium px-2.5 py-1 rounded-full bg-zinc-200/60 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
              {formatDuration(callDuration)}
            </div>
          )}
        </div>

        {/* Video / Audio Area */}
        <div
          onClick={handleManualPlay}
          className="relative flex-1 bg-zinc-950 flex items-center justify-center overflow-hidden"
        >
          {/* Audio element for stream playback */}
          <audio ref={remoteAudioRef} autoPlay playsInline />

          {kind === "video" && (
            <>
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${hasRemoteVideo ? "block" : "hidden"}`}
                />
                {!hasRemoteVideo && (
                  <div className="flex flex-col items-center gap-3 text-zinc-400">
                    <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-xl font-bold text-white shadow-lg">
                      {partnerAlias.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-zinc-200">{partnerAlias}</p>
                      <p className="text-xs text-zinc-400 animate-pulse mt-0.5">
                        {callStatus === "calling" ? "Calling..." : "Connecting stream..."}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {localStream && !isCamOff && (
                <div className="absolute top-3 right-3 sm:top-4 sm:right-4 w-24 h-32 sm:w-32 sm:h-44 rounded-2xl border-2 border-white/20 bg-zinc-900 shadow-xl overflow-hidden z-10">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
            </>
          )}

          {kind === "audio" && (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-6 sm:p-8">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-2xl sm:text-3xl font-bold text-white shadow-xl ring-4 ring-white/10">
                {partnerAlias.slice(0, 2).toUpperCase()}
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-semibold text-white">
                  {partnerAlias}
                </h3>
                <p className="text-xs text-zinc-400">
                  {callStatus === "calling" && "Calling..."}
                  {callStatus === "ringing" && "Incoming call..."}
                  {callStatus === "connected" && "Call in progress"}
                  {callStatus === "ended" && "Call ended"}
                </p>
              </div>
            </div>
          )}

          {needsUserTap && (
            <div className="absolute bottom-4 z-20 px-4 py-2 rounded-full bg-white text-zinc-950 text-xs font-semibold shadow-lg animate-bounce">
              Tap anywhere to play audio/video
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-2.5 sm:gap-4 px-3 sm:px-6 py-3 sm:py-4 bg-zinc-50 dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800">
          {callStatus === "ringing" && !isInitiator ? (
            <div className="flex items-center gap-3 sm:gap-5">
              <button
                type="button"
                onClick={onReject}
                className="flex items-center gap-1.5 sm:gap-2 px-4 sm:px-5 py-2 sm:py-2.5 rounded-full bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 font-medium text-xs transition-colors"
              >
                <PhoneOff className="w-4 h-4" /> Decline
              </button>
              <button
                type="button"
                onClick={onAccept}
                className="flex items-center gap-1.5 sm:gap-2 px-5 sm:px-6 py-2 sm:py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-md transition-all animate-pulse"
              >
                <Phone className="w-4 h-4" /> Accept
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={onToggleMic}
                className={`flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full border transition-all ${
                  isMicMuted
                    ? "bg-red-500/10 border-red-500/30 text-red-500"
                    : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                }`}
                title={isMicMuted ? "Unmute microphone" : "Mute microphone"}
              >
                {isMicMuted ? <MicOff className="w-4 h-4 sm:w-5 sm:h-5" /> : <Mic className="w-4 h-4 sm:w-5 sm:h-5" />}
              </button>

              {kind === "video" && (
                <button
                  type="button"
                  onClick={onToggleCam}
                  className={`flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full border transition-all ${
                    isCamOff
                      ? "bg-red-500/10 border-red-500/30 text-red-500"
                      : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                  }`}
                  title={isCamOff ? "Turn on camera" : "Turn off camera"}
                >
                  {isCamOff ? <VideoOff className="w-4 h-4 sm:w-5 sm:h-5" /> : <Video className="w-4 h-4 sm:w-5 sm:h-5" />}
                </button>
              )}

              <button
                type="button"
                onClick={onHangup}
                className="flex items-center gap-1.5 sm:gap-2 px-4 sm:px-5 py-2 sm:py-2.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-md transition-all ml-1 sm:ml-2"
              >
                <PhoneOff className="w-4 h-4" /> End Call
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
