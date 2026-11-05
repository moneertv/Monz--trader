package com.monz.trader;

import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Network download and .xlsx reading, shared by the app screen and the background alert check. */
final class NativeIO {
    private NativeIO() { }

    static byte[] download(String url, JSONObject headers) throws Exception {
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
    static String readXlsx(byte[] data) throws Exception {
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

}
