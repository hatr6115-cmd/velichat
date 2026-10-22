import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Download, QrCode, Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadQr() {
    if (!dataUrl) return;
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = "veilchat-invite-qr.png";
    anchor.click();
  }

  return (
    <div className={`flex flex-col items-center ${inline ? "" : "p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl shadow-xl"}`}>
      <div className="w-full text-center mb-4">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Invite a Friend</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Scan with camera or share the invite link</p>
      </div>

      {/* QR Code Container */}
      <div className="relative p-3 bg-white rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-sm mb-5 transition-transform hover:scale-[1.02]">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="VeilChat room invite QR"
            className="w-48 h-48 object-contain rounded-xl"
          />
        ) : (
          <div className="w-48 h-48 flex items-center justify-center text-zinc-400">
            <QrCode size={40} className="animate-pulse" />
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2 w-full">
        <Button
          onClick={copyInvite}
          variant="outline"
          className="rounded-full border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/80 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs h-9 gap-1.5 font-medium"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy Link"}
        </Button>
        <Button
          onClick={shareInvite}
          className="rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs h-9 gap-1.5 font-medium shadow-sm"
        >
          <Share2 size={14} /> Share
        </Button>
        <Button
          onClick={downloadQr}
          variant="ghost"
          className="col-span-2 rounded-full text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 text-xs h-8 gap-1.5 font-normal"
        >
          <Download size={13} /> Save QR Image
        </Button>
      </div>
    </div>
  );
}
