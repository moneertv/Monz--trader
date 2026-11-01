package com.monz.trader;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.util.Xml;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Hosts the app (assets/www) in a WebView and gives it a small native bridge:
 *  - httpGet: network requests from Java, so third-party sites need no CORS support
 *  - xlsx:    download an Excel file and return its cell values (for ASE files)
 *  - share:   hand a text backup to Android's share sheet
 * All results come back asynchronously through window.__nativeResolve(id, ok, payload).
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
        web.addJavascriptInterface(new Bridge(), "NativeBridge");
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

    private void resolve(String id, boolean ok, String payload) {
        final String js = "window.__nativeResolve(" + JSONObject.quote(id) + "," + ok + ","
                + JSONObject.quote(payload == null ? "" : payload) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private static byte[] download(String url, JSONObject headers) throws Exception {
        if (!url.startsWith("https://")) throw new IllegalArgumentException("Only https URLs are allowed");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "MonzTrader/0.1 (Android; personal portfolio)");
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                c.setRequestProperty(k, headers.getString(k));
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
        }
        c.disconnect();
        if (code >= 400) throw new Exception("HTTP " + code + " for " + url);
        return out.toByteArray();
    }

    // ---------------------------------------------------------------- xlsx reader
    private static String readXlsx(byte[] data) throws Exception {
        Map<String, byte[]> parts = new HashMap<>();
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(data))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (name.equals("xl/sharedStrings.xml") || name.equals("xl/workbook.xml")
                        || (name.startsWith("xl/worksheets/sheet") && name.endsWith(".xml"))) {
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = zin.read(buf)) > 0) b.write(buf, 0, n);
                    parts.put(name, b.toByteArray());
                }
            }
        }
        if (parts.isEmpty()) throw new Exception("Not an .xlsx workbook (legacy .xls is not supported)");
        List<String> shared = new ArrayList<>();
        if (parts.containsKey("xl/sharedStrings.xml")) {
            XmlPullParser p = Xml.newPullParser();
            p.setInput(new ByteArrayInputStream(parts.get("xl/sharedStrings.xml")), "UTF-8");
            StringBuilder cur = null;
            boolean inT = false;
            for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
                if (ev == XmlPullParser.START_TAG) {
                    if (p.getName().equals("si")) cur = new StringBuilder();
                    else if (p.getName().equals("t")) inT = true;
                } else if (ev == XmlPullParser.TEXT && inT && cur != null) {
                    cur.append(p.getText());
                } else if (ev == XmlPullParser.END_TAG) {
                    if (p.getName().equals("t")) inT = false;
                    else if (p.getName().equals("si") && cur != null) { shared.add(cur.toString()); cur = null; }
                }
            }
        }
        List<String> sheetNames = new ArrayList<>();
        if (parts.containsKey("xl/workbook.xml")) {
            XmlPullParser p = Xml.newPullParser();
            p.setInput(new ByteArrayInputStream(parts.get("xl/workbook.xml")), "UTF-8");
            for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
                if (ev == XmlPullParser.START_TAG && p.getName().equals("sheet")) {
                    sheetNames.add(p.getAttributeValue(null, "name"));
                }
            }
        }
        JSONArray sheets = new JSONArray();
        for (int i = 1; i <= 200; i++) {
            byte[] xml = parts.get("xl/worksheets/sheet" + i + ".xml");
            if (xml == null) continue;
            JSONObject sheet = new JSONObject();
            sheet.put("name", i - 1 < sheetNames.size() ? sheetNames.get(i - 1) : ("Sheet" + i));
            sheet.put("rows", readSheet(xml, shared));
            sheets.put(sheet);
        }
        return new JSONObject().put("sheets", sheets).toString();
    }

    private static int colIndex(String ref) {
        int col = 0;
        for (int i = 0; i < ref.length(); i++) {
            char ch = ref.charAt(i);
            if (ch < 'A' || ch > 'Z') break;
            col = col * 26 + (ch - 'A' + 1);
        }
        return col - 1;
    }

    private static final int MAX_ROWS = 1500;

    private static JSONArray readSheet(byte[] xml, List<String> shared) throws Exception {
        JSONArray rows = new JSONArray();
        XmlPullParser p = Xml.newPullParser();
        p.setInput(new ByteArrayInputStream(xml), "UTF-8");
        List<String> row = null;
        String type = null, ref = null;
        StringBuilder val = null;
        boolean capture = false;
        for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
            if (ev == XmlPullParser.START_TAG) {
                String n = p.getName();
                if (n.equals("row")) row = new ArrayList<>();
                else if (n.equals("c")) { type = p.getAttributeValue(null, "t"); ref = p.getAttributeValue(null, "r"); val = new StringBuilder(); }
                else if ((n.equals("v") || n.equals("t")) && val != null) capture = true;
            } else if (ev == XmlPullParser.TEXT && capture && val != null) {
                val.append(p.getText());
            } else if (ev == XmlPullParser.END_TAG) {
                String n = p.getName();
                if (n.equals("v") || n.equals("t")) capture = false;
                else if (n.equals("c") && row != null && val != null) {
                    String v = val.toString();
                    if ("s".equals(type) && !v.isEmpty()) {
                        int k = Integer.parseInt(v.trim());
                        v = k < shared.size() ? shared.get(k) : "";
                    }
                    int idx = ref != null ? colIndex(ref) : row.size();
                    while (row.size() < idx) row.add("");
                    if (row.size() == idx) row.add(v); else row.set(idx, v);
                    val = null;
                } else if (n.equals("row") && row != null) {
                    rows.put(new JSONArray(row));
                    row = null;
                    if (rows.length() >= MAX_ROWS) break;   // daily file has ~6,600 history rows; newest come first
                }
            }
        }
        return rows;
    }

    // ---------------------------------------------------------------- bridge
    private class Bridge {
        @JavascriptInterface
        public void httpGet(final String id, final String url, final String headersJson) {
            pool.submit(() -> {
                try {
                    JSONObject h = headersJson == null || headersJson.isEmpty() ? null : new JSONObject(headersJson);
                    resolve(id, true, new String(download(url, h), StandardCharsets.UTF_8));
                } catch (Throwable t) {
                    resolve(id, false, String.valueOf(t.getMessage()));
                }
            });
        }

        @JavascriptInterface
        public void xlsx(final String id, final String url) {
            pool.submit(() -> {
                try {
                    resolve(id, true, readXlsx(download(url, null)));
                } catch (Throwable t) {
                    resolve(id, false, String.valueOf(t.getMessage()));
                }
            });
        }

        @JavascriptInterface
        public void share(final String title, final String text) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, title);
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, title));
            });
        }
    }
}
