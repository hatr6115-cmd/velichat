import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Terminal } from "lucide-react";
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
  partnerAlias = "PEER",
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

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.play().catch((e) => console.warn("Local play error:", e));
    }
  }, [localStream]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (video && remoteStream && kind === "video") {
      video.srcObject = remoteStream;
      video.play().then(() => {
        setNeedsUserTap(false);
      }).catch((err) => {
        console.warn("Autoplay was prevented on remote video:", err);
        setNeedsUserTap(true);
      });
    }
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
    if (remoteVideoRef.current) {
      remoteVideoRef.current.play().catch(console.warn);
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.play().catch(console.warn);
    }
    setNeedsUserTap(false);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/95 font-mono select-none">
      <div className="relative flex flex-col w-full max-w-xl h-[85vh] max-h-[600px] bg-black border border-green-500/40 rounded-none shadow-[0_0_20px_rgba(34,197,94,0.15)] overflow-hidden">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-black border-b border-green-500/30 text-green-500 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 animate-pulse" />
            <span className="tracking-wider uppercase font-bold">
              [P2P_{kind.toUpperCase()}_STREAM] // NO_RECORD
            </span>
          </div>
          {callStatus === "connected" && (
            <div className="text-green-400 font-bold">
              T+{formatDuration(callDuration)}
            </div>
          )}
        </div>

        {/* Video / Audio Area */}
        <div
          onClick={handleManualPlay}
          className="relative flex-1 bg-black flex items-center justify-center overflow-hidden border-b border-green-500/20 cursor-pointer"
        >
          {/* Always mount audio tag so voice stream is never blocked */}
          <audio ref={remoteAudioRef} autoPlay playsInline />

          {kind === "video" && (
            <>
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                {/* Persistent video element prevents unmount/remount race conditions */}
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={`w-full h-full object-cover ${remoteStream ? "block" : "hidden"}`}
                />
                {!remoteStream && (
                  <div className="flex flex-col items-center gap-2 text-green-500/70 text-xs">
                    <div className="border border-green-500/40 px-3 py-1 uppercase tracking-widest text-green-400">
                      {partnerAlias}
                    </div>
                    <p className="animate-pulse">
                      &gt; {callStatus === "calling" ? "DIALING..." : "AWAITING_STREAM..."}
                    </p>
                  </div>
                )}
              </div>

              {localStream && !isCamOff && (
                <div className="absolute top-3 right-3 w-24 h-32 sm:w-28 sm:h-36 border border-green-500 bg-black z-10 overflow-hidden">
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
            <div className="flex flex-col items-center justify-center gap-3 text-center p-6 text-green-500">
              <div className="border border-green-500/60 p-4 w-20 h-20 flex items-center justify-center text-xl font-bold">
                {partnerAlias.slice(0, 4).toUpperCase()}
              </div>

              <div className="space-y-1">
                <div className="text-xs uppercase tracking-widest text-green-400 font-bold">
                  &gt; {partnerAlias}
                </div>
                <p className="text-[11px] text-green-500/60">
                  {callStatus === "calling" && "STATUS: CALLING..."}
                  {callStatus === "ringing" && "STATUS: INCOMING_SIGNAL"}
                  {callStatus === "connected" && "STATUS: ENCRYPTED_AUDIO_ACTIVE"}
                  {callStatus === "ended" && "STATUS: TERMINATED"}
                </p>
              </div>
            </div>
          )}

          {needsUserTap && (
            <div className="absolute bottom-2 z-20 px-3 py-1 bg-green-500 text-black text-[11px] font-bold uppercase tracking-wider animate-pulse">
              [TAP TO PLAY MEDIA STREAM]
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-3 px-4 py-3 bg-black text-xs">
          {callStatus === "ringing" && !isInitiator ? (
            <div className="flex items-center gap-4">
              <button
                onClick={onReject}
                className="px-4 py-2 border border-red-500 text-red-500 hover:bg-red-500/20 uppercase font-bold"
              >
                [REJECT]
              </button>
              <button
                onClick={onAccept}
                className="px-4 py-2 border border-green-500 bg-green-500/10 text-green-400 hover:bg-green-500/20 uppercase font-bold animate-pulse"
              >
                [ACCEPT]
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={onToggleMic}
                className={`px-3 py-1.5 border uppercase font-bold transition-colors ${
                  isMicMuted
                    ? "border-red-500 text-red-500 bg-red-500/10"
                    : "border-green-500/50 text-green-400 hover:border-green-500"
                }`}
              >
                {isMicMuted ? "[MIC:OFF]" : "[MIC:ON]"}
              </button>

              {kind === "video" && (
                <button
                  onClick={onToggleCam}
                  className={`px-3 py-1.5 border uppercase font-bold transition-colors ${
                    isCamOff
                      ? "border-red-500 text-red-500 bg-red-500/10"
                      : "border-green-500/50 text-green-400 hover:border-green-500"
                  }`}
                >
                  {isCamOff ? "[CAM:OFF]" : "[CAM:ON]"}
                </button>
              )}

              <button
                onClick={onHangup}
                className="px-4 py-1.5 border border-red-500 text-red-500 hover:bg-red-500/20 uppercase font-bold"
              >
                [HANGUP]
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
