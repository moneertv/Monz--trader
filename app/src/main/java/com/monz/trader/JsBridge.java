package com.monz.trader;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;

/**
 * The JavaScript bridge ("NativeBridge"), used by both the app screen and the headless background
 * alert check. Results of async calls come back through window.__nativeResolve(id, ok, payload).
 */
class JsBridge {
    private final Context ctx;
    private final WebView web;
    private final ExecutorService pool;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable onDone;      // headless check only

    JsBridge(Context ctx, WebView web, ExecutorService pool, Runnable onDone) {
        this.ctx = ctx; this.web = web; this.pool = pool; this.onDone = onDone;
    }

    private void resolve(String id, boolean ok, String payload) {
        final String js = "window.__nativeResolve(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload == null ? "" : payload) + ")";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    @JavascriptInterface
    public void httpGet(final String id, final String url, final String headersJson) {
        pool.submit(() -> {
            try {
                JSONObject h = headersJson == null || headersJson.isEmpty() ? null : new JSONObject(headersJson);
                resolve(id, true, new String(NativeIO.download(url, h), StandardCharsets.UTF_8));
            } catch (Throwable t) { resolve(id, false, String.valueOf(t.getMessage())); }
        });
    }

    @JavascriptInterface
    public void xlsx(final String id, final String url) {
        pool.submit(() -> {
            try { resolve(id, true, NativeIO.readXlsx(NativeIO.download(url, null))); }
            catch (Throwable t) { resolve(id, false, String.valueOf(t.getMessage())); }
        });
    }

    @JavascriptInterface
    public void share(final String title, final String text) {
        if (!(ctx instanceof Activity)) return;
        main.post(() -> {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_SUBJECT, title);
            i.putExtra(Intent.EXTRA_TEXT, text);
            ctx.startActivity(Intent.createChooser(i, title));
        });
    }

    // ---------------------------------------------------------------- alerts
    @JavascriptInterface
    public void notify(String title, String body, String key) { Alerts.show(ctx, title, body, key); }

    @JavascriptInterface
    public void setAlerts(boolean on, int minutes) { Alerts.schedule(ctx, on, minutes); }

    @JavascriptInterface
    public void checkAlertsNow() { Alerts.runNow(ctx); }

    @JavascriptInterface
    public boolean notificationsAllowed() { return Alerts.allowed(ctx); }

    @JavascriptInterface
    public void requestNotificationPermission() {
        if (ctx instanceof MainActivity) main.post(() -> ((MainActivity) ctx).askNotificationPermission());
    }

    @JavascriptInterface
    public void done() { if (onDone != null) main.post(onDone); }
}
