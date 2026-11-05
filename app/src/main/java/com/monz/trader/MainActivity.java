package com.monz.trader;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;


import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the app (assets/www) in a WebView with the JsBridge ("NativeBridge"): network requests,
 * .xlsx reading, sharing, and the strong-signal alert controls.
 */
public class MainActivity extends Activity {

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B1220"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest req) {
                String u = req.getUrl().toString();
                if (u.startsWith("http://") || u.startsWith("https://")) {   // source links open in the browser
                    try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u))); } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new JsBridge(this, web, pool, null), "NativeBridge");
        Alerts.ensureChannel(this);
        // Android 15 draws apps edge-to-edge: pad the content so the status bar, navigation bar
        // and keyboard never cover it.
        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B1220"));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top; left = bars.left; right = bars.right; bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(Color.parseColor("#0B1220"));
            getWindow().setNavigationBarColor(Color.parseColor("#121B2E"));
        }
        setContentView(root);
        root.requestApplyInsets();
        web.loadUrl("file:///android_asset/www/index.html");
        openFromIntent(getIntent());
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.appBack ? window.appBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        super.onDestroy();
    }

    /** Opens a signal when the app is launched from an alert notification. */
    private void openFromIntent(Intent i) {
        if (i == null) return;
        String key = i.getStringExtra("openSignal");
        if (key == null) return;
        i.removeExtra("openSignal");
        final String js = "window.openSignalFromAlert && window.openSignalFromAlert(" + org.json.JSONObject.quote(key) + ")";
        web.postDelayed(() -> web.evaluateJavascript(js, null), 600);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromIntent(intent);
    }

    void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 7);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        web.evaluateJavascript("window.onNotificationPermission && window.onNotificationPermission(" + Alerts.allowed(this) + ")", null);
    }
}
