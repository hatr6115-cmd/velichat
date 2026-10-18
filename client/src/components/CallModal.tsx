import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, ShieldCheck, Users } from "lucide-react";
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
  const [callDuration, setCallDuration] = useState(0);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/90 backdrop-blur-xl animate-in fade-in select-none">
      <div className="relative flex flex-col w-full max-w-2xl h-[85vh] max-h-[700px] bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-slate-900/90 border-b border-slate-800/80 z-20">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400">
              <ShieldCheck size={16} />
            </div>
            <div>
              <span className="text-xs font-semibold text-white tracking-wide flex items-center gap-1.5">
                Peer-to-Peer Encrypted {kind === "video" ? "Video" : "Voice"} Call
              </span>
              <p className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Anti-Record Protected
              </p>
            </div>
          </div>
          {callStatus === "connected" && (
            <div className="px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700/80 text-emerald-400 font-mono text-xs font-semibold">
              {formatDuration(callDuration)}
            </div>
          )}
        </div>

        {/* Video / Call Stage */}
        <div className="relative flex-1 bg-slate-950 flex items-center justify-center overflow-hidden">
          {kind === "video" && (
            <>
              {/* Remote Video Stream (Main) */}
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
                {remoteStream ? (
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-slate-500">
                    <div className="w-20 h-20 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 text-2xl font-bold">
                      {partnerAlias.charAt(0).toUpperCase()}
                    </div>
                    <p className="text-xs font-medium">
                      {callStatus === "calling" ? `Calling ${partnerAlias}…` : `Connecting with ${partnerAlias}…`}
                    </p>
                  </div>
                )}
              </div>

              {/* Local Video Stream (Picture-in-Picture) */}
              {localStream && !isCamOff && (
                <div className="absolute top-4 right-4 w-28 h-40 sm:w-36 sm:h-48 rounded-2xl overflow-hidden border-2 border-emerald-500/40 shadow-xl bg-slate-900 z-10">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover mirror"
                  />
                </div>
              )}
            </>
          )}

          {kind === "audio" && (
            <div className="flex flex-col items-center justify-center gap-4 text-center p-6">
              <div className="relative">
                <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-emerald-500/20 to-teal-500/10 border-2 border-emerald-500/30 flex items-center justify-center text-emerald-400 text-3xl font-extrabold shadow-2xl">
                  {partnerAlias.charAt(0).toUpperCase()}
                </div>
                {callStatus === "connected" && (
                  <span className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-emerald-400 border-4 border-slate-950 animate-pulse" />
                )}
              </div>

              <div>
                <h3 className="text-lg font-bold text-white mb-0.5">{partnerAlias}</h3>
                <p className="text-xs text-slate-400">
                  {callStatus === "calling" && "Calling…"}
                  {callStatus === "ringing" && "Incoming Call…"}
                  {callStatus === "connected" && "Voice Call In Progress"}
                  {callStatus === "ended" && "Call Ended"}
                </p>
              </div>

              {/* Hidden audio element to playback remote stream */}
              <audio ref={remoteVideoRef as any} autoPlay playsInline />
            </div>
          )}
        </div>

        {/* Call Action Controls */}
        <div className="flex items-center justify-center gap-4 px-6 py-5 bg-slate-900/90 border-t border-slate-800/80 z-20">
          {callStatus === "ringing" && !isInitiator ? (
            /* Incoming Call Actions: Accept or Decline */
            <div className="flex items-center gap-6">
              <Button
                onClick={onReject}
                className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-950/40"
                aria-label="Decline Call"
              >
                <PhoneOff size={22} />
              </Button>
              <Button
                onClick={onAccept}
                className="w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/40 animate-bounce"
                aria-label="Accept Call"
              >
                {kind === "video" ? <Video size={22} /> : <Mic size={22} />}
              </Button>
            </div>
          ) : (
            /* Active / Outgoing Call Controls */
            <div className="flex items-center gap-3 sm:gap-5">
              <Button
                onClick={onToggleMic}
                variant="outline"
                className={`w-12 h-12 rounded-2xl border transition-colors ${
                  isMicMuted
                    ? "bg-red-500/20 border-red-500/40 text-red-400"
                    : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-750"
                }`}
                aria-label={isMicMuted ? "Unmute Mic" : "Mute Mic"}
              >
                {isMicMuted ? <MicOff size={19} /> : <Mic size={19} />}
              </Button>

              {kind === "video" && (
                <Button
                  onClick={onToggleCam}
                  variant="outline"
                  className={`w-12 h-12 rounded-2xl border transition-colors ${
                    isCamOff
                      ? "bg-red-500/20 border-red-500/40 text-red-400"
                      : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-750"
                  }`}
                  aria-label={isCamOff ? "Turn on Camera" : "Turn off Camera"}
                >
                  {isCamOff ? <VideoOff size={19} /> : <Video size={19} />}
                </Button>
              )}

              <Button
                onClick={onHangup}
                className="w-14 h-12 sm:w-16 sm:h-12 rounded-2xl bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-950/50 flex items-center justify-center gap-1.5"
                aria-label="End Call"
              >
                <PhoneOff size={20} />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
