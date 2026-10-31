package com.veilchat.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.webkit.JavascriptInterface;

public final class ClipboardBridge {
    private final Context context;

    public ClipboardBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public void copyText(String text) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("VeilChat message", text));
        }
    }
}
