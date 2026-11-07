package com.veilchat.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;

    // Configurable default URL (falls back to veilchat web service)
    private static final String DEFAULT_URL = "https://veilchat.onrender.com";

    private final ActivityResultLauncher<String[]> requestPermissionsLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                PermissionRequest request = pendingWebPermission;
                pendingWebPermission = null;
                if (request == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;

                List<String> grantedResources = new ArrayList<>();
                for (String resource : request.getResources()) {
                    String permission = androidPermissionForResource(resource);
                    boolean granted = permission != null &&
                            (Boolean.TRUE.equals(result.get(permission)) ||
                                    ContextCompat.checkSelfPermission(MainActivity.this, permission)
                                            == PackageManager.PERMISSION_GRANTED);
                    if (granted) grantedResources.add(resource);
                }

                if (grantedResources.isEmpty()) {
                    request.deny();
                } else {
                    // Grant only what Android actually approved. In particular,
                    // denying camera access must not also break a voice-only call.
                    request.grant(grantedResources.toArray(new String[0]));
                }
            });

    private final ActivityResultLauncher<String> filePickerLauncher =
            registerForActivityResult(new ActivityResultContracts.GetMultipleContents(), uris -> {
                if (filePathCallback != null) {
                    Uri[] results = null;
                    if (uris != null && !uris.isEmpty()) {
                        results = uris.toArray(new Uri[0]);
                    }
                    filePathCallback.onReceiveValue(results);
                    filePathCallback = null;
                }
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android's secure-window flag blocks system screenshots, screen recording,
        // and sensitive recent-app thumbnails for the entire WebView session.
        applySecureWindowFlag();
        setContentView(R.layout.activity_main);

        // Dark status bar and navigation bar to match VeilChat theme
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(ContextCompat.getColor(this, R.color.background_dark));
            getWindow().setNavigationBarColor(ContextCompat.getColor(this, R.color.background_dark));
        }

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        setupWebView();

        // Handle Back button navigation
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });

        // Camera/microphone access is requested only when a call or scanner
        // actually needs it, and only for the resources requested by the page.

        // Load the chat room URL (supports deep links / invites passed via Intent)
        String targetUrl = DEFAULT_URL;
        if (getIntent() != null && getIntent().getData() != null) {
            targetUrl = getIntent().getData().toString();
        }
        // Always fetch the latest hosted UI after an app update instead of showing stale WebView HTML.
        webView.clearCache(false);
        webView.loadUrl(targetUrl);
    }

    private String androidPermissionForResource(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
            return Manifest.permission.RECORD_AUDIO;
        }
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
            return Manifest.permission.CAMERA;
        }
        return null;
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " VeilChatApp/1.0 (SecureMobile)");
        webView.addJavascriptInterface(new ClipboardBridge(this), "VeilChatClipboard");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                progressBar.setVisibility(View.GONE);
                Toast.makeText(MainActivity.this, "Network error: " + description, Toast.LENGTH_SHORT).show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                }
            }

            // Bridge WebRTC/QR permissions to the matching Android runtime
            // permissions. A voice call asks for the microphone only; a video
            // call asks for camera and microphone.
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                    request.deny();
                    return;
                }

                List<String> grantableResources = new ArrayList<>();
                List<String> missingPermissions = new ArrayList<>();
                for (String resource : request.getResources()) {
                    String permission = androidPermissionForResource(resource);
                    if (permission == null) continue;
                    grantableResources.add(resource);
                    if (ContextCompat.checkSelfPermission(MainActivity.this, permission)
                            != PackageManager.PERMISSION_GRANTED && !missingPermissions.contains(permission)) {
                        missingPermissions.add(permission);
                    }
                }

                if (grantableResources.isEmpty()) {
                    request.deny();
                    return;
                }
                if (missingPermissions.isEmpty()) {
                    request.grant(grantableResources.toArray(new String[0]));
                    return;
                }

                if (pendingWebPermission != null) pendingWebPermission.deny();
                pendingWebPermission = request;
                requestPermissionsLauncher.launch(missingPermissions.toArray(new String[0]));
            }

            @Override
            public void onPermissionRequestDenied(PermissionRequest request) {
                if (pendingWebPermission == request) pendingWebPermission = null;
            }

            // File selection for view-once photos and videos
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                filePickerLauncher.launch("*/*");
                return true;
            }
        });
    }

    private void applySecureWindowFlag() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Re-enforce capture protection whenever the app returns to the foreground.
        applySecureWindowFlag();
    }

    @Override
    protected void onDestroy() {
        if (pendingWebPermission != null) {
            pendingWebPermission.deny();
            pendingWebPermission = null;
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
