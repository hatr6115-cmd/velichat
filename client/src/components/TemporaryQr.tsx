import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Download, QrCode, Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type TemporaryQrProps = {
  inviteUrl: string;
  onScan?: () => void;
  onClose?: () => void;
  inline?: boolean;
};

export default function TemporaryQr({ inviteUrl, onScan, onClose, inline = false }: TemporaryQrProps) {
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    if (!inviteUrl) {
      setDataUrl("");
      return () => { active = false; };
    }
    QRCode.toDataURL(inviteUrl, {
      width: 480,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
      errorCorrectionLevel: "H",
    }).then((url) => {
      if (active) setDataUrl(url);
    });
    return () => { active = false; };
  }, [inviteUrl]);

  async function shareInvite() {
    if (!inviteUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "VeilChat Temporary Room",
          text: "Join my temporary private chat on VeilChat (auto-expires in 30m)",
          url: inviteUrl,
        });
      } catch {
        /* user cancelled */
      }
    } else {
      copyInvite();
    }
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    toast.success("Invite link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadQr() {
    if (!dataUrl) return;
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = "veilchat-invite-qr.png";
    anchor.click();
    toast.success("QR code downloaded");
  }

  return (
    <div className={`flex flex-col items-center ${inline ? "" : "p-6 bg-slate-900/90 border border-slate-800 rounded-3xl shadow-xl backdrop-blur-md"}`}>
      <div className="w-full text-center mb-5">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 mb-2 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold">
          <QrCode size={14} /> Temporary Room Invite
        </div>
        <h3 className="text-lg font-bold text-white">Share to Connect</h3>
        <p className="text-xs text-slate-400 mt-1">One guest can scan or open this link to enter.</p>
      </div>

      {/* QR Code Container */}
      <div className="relative p-3 bg-white rounded-2xl shadow-inner mb-6 group transition-transform hover:scale-[1.02]">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Scannable temporary VeilChat room invitation"
            className="w-52 h-52 object-contain rounded-xl"
          />
        ) : (
          <div className="w-52 h-52 flex items-center justify-center text-slate-400">
            <QrCode size={48} className="animate-pulse" />
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2.5 w-full">
        <Button
          onClick={copyInvite}
          variant="outline"
          className="rounded-xl border-slate-700 bg-slate-800/60 hover:bg-slate-800 text-slate-200 text-xs h-10 gap-1.5"
        >
          {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
          {copied ? "Copied!" : "Copy Link"}
        </Button>
        <Button
          onClick={shareInvite}
          className="rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-10 gap-1.5 shadow-lg shadow-emerald-900/20"
        >
          <Share2 size={15} /> Share Link
        </Button>
        <Button
          onClick={downloadQr}
          variant="outline"
          className="col-span-2 rounded-xl border-slate-800 bg-slate-900/40 hover:bg-slate-800/80 text-slate-300 text-xs h-9 gap-1.5"
        >
          <Download size={14} /> Save QR Image
        </Button>
        {onClose && (
          <Button
            type="button"
            onClick={onClose}
            className="col-span-2 mt-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs h-10 font-semibold gap-1.5 border border-slate-700/80"
          >
            ← Back to Chat
          </Button>
        )}
      </div>
    </div>
  );
}
