package com.monz.trader;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Background check: loads assets/www/alerts.html in an invisible WebView. That page refreshes the
 * prices of your holdings, recomputes signals with the same engine as the app, posts a notification
 * for any new STRONG BUY / STRONG SELL, then calls NativeBridge.done().
 */
public class AlertJobService extends JobService {
    private WebView web;
    private ExecutorService pool;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public boolean onStartJob(final JobParameters params) {
        pool = Executors.newFixedThreadPool(2);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        final Runnable finish = () -> {
            cleanup();
            jobFinished(params, false);
        };
        web.addJavascriptInterface(new JsBridge(this, web, pool, finish), "NativeBridge");
        main.postDelayed(finish, 4 * 60_000L);   // never run longer than 4 minutes
        web.loadUrl("file:///android_asset/www/alerts.html");
        return true;
    }

    private void cleanup() {
        main.removeCallbacksAndMessages(null);
        if (web != null) { web.destroy(); web = null; }
        if (pool != null) { pool.shutdownNow(); pool = null; }
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        cleanup();
        return true;
    }
}
