package com.monz.trader;

import android.content.Context;
import android.os.Bundle;

import com.google.firebase.analytics.FirebaseAnalytics;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.crashlytics.FirebaseCrashlytics;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Firebase features used by the app. Results of async calls go back to JavaScript through the
 * Callback, which JsBridge turns into window.__nativeResolve(id, ok, payload).
 */
final class FirebaseFeatures {
    static final String TOPIC = "monz-alerts";
    private FirebaseFeatures() { }

    interface Callback { void done(boolean ok, String payload); }

    // ---------------------------------------------------------------- push
    static void subscribe() {
        try { FirebaseMessaging.getInstance().subscribeToTopic(TOPIC); } catch (Throwable ignored) { }
    }

    static void setPush(boolean on, Callback cb) {
        try {
            (on ? FirebaseMessaging.getInstance().subscribeToTopic(TOPIC) : FirebaseMessaging.getInstance().unsubscribeFromTopic(TOPIC))
                .addOnCompleteListener(t -> cb.done(t.isSuccessful(), t.isSuccessful() ? "" : String.valueOf(t.getException())));
        } catch (Throwable t) { cb.done(false, t.getMessage()); }
    }

    // ---------------------------------------------------------------- crash reports + analytics
    static void recordJsError(String message) {
        try {
            FirebaseCrashlytics.getInstance().log("JS: " + message);
            FirebaseCrashlytics.getInstance().recordException(new JsException(message));
        } catch (Throwable ignored) { }
    }

    static final class JsException extends Exception {
        JsException(String m) { super(m); }
    }

    static void logEvent(Context c, String name, String paramsJson) {
        try {
            Bundle b = new Bundle();
            if (paramsJson != null && !paramsJson.isEmpty()) {
                JSONObject o = new JSONObject(paramsJson);
                Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = o.get(k);
                    if (v instanceof Number) b.putDouble(k, ((Number) v).doubleValue()); else b.putString(k, String.valueOf(v));
                }
            }
            FirebaseAnalytics.getInstance(c).logEvent(name, b);
        } catch (Throwable ignored) { }
    }

    static void setCollection(Context c, boolean analytics, boolean crashes) {
        try { FirebaseAnalytics.getInstance(c).setAnalyticsCollectionEnabled(analytics); } catch (Throwable ignored) { }
        try { FirebaseCrashlytics.getInstance().setCrashlyticsCollectionEnabled(crashes); } catch (Throwable ignored) { }
    }

    // ---------------------------------------------------------------- account + cloud backup
    static String authStatus() {
        try {
            FirebaseUser u = FirebaseAuth.getInstance().getCurrentUser();
            return u == null ? "" : String.valueOf(u.getEmail());
        } catch (Throwable t) { return ""; }
    }

    static void signIn(String email, String password, boolean create, Callback cb) {
        try {
            FirebaseAuth a = FirebaseAuth.getInstance();
            (create ? a.createUserWithEmailAndPassword(email, password) : a.signInWithEmailAndPassword(email, password))
                .addOnCompleteListener(t -> cb.done(t.isSuccessful(), t.isSuccessful() ? authStatus() : readable(t.getException())));
        } catch (Throwable t) { cb.done(false, t.getMessage()); }
    }

    static void signOut() { try { FirebaseAuth.getInstance().signOut(); } catch (Throwable ignored) { } }

    /** Saves the backup JSON to users/{uid}/backups/latest. Only that user can read it (see firestore.rules). */
    static void cloudSave(String json, Callback cb) {
        FirebaseUser u = FirebaseAuth.getInstance().getCurrentUser();
        if (u == null) { cb.done(false, "Sign in first"); return; }
        Map<String, Object> doc = new HashMap<>();
        doc.put("data", json);
        doc.put("savedAt", FieldValue.serverTimestamp());
        doc.put("bytes", json.length());
        FirebaseFirestore.getInstance().collection("users").document(u.getUid()).collection("backups").document("latest")
            .set(doc).addOnCompleteListener(t -> cb.done(t.isSuccessful(), t.isSuccessful() ? "" : readable(t.getException())));
    }

    static void cloudLoad(Callback cb) {
        FirebaseUser u = FirebaseAuth.getInstance().getCurrentUser();
        if (u == null) { cb.done(false, "Sign in first"); return; }
        FirebaseFirestore.getInstance().collection("users").document(u.getUid()).collection("backups").document("latest").get()
            .addOnCompleteListener(t -> {
                if (!t.isSuccessful()) { cb.done(false, readable(t.getException())); return; }
                if (t.getResult() == null || !t.getResult().exists()) { cb.done(false, "No cloud backup yet"); return; }
                cb.done(true, String.valueOf(t.getResult().getString("data")));
            });
    }

    private static String readable(Exception e) {
        if (e == null) return "Unknown error";
        String m = String.valueOf(e.getMessage());
        if (m.contains("PERMISSION_DENIED")) return "Permission denied: publish firestore.rules in the Firebase console";
        if (m.contains("CONFIGURATION_NOT_FOUND") || m.contains("OPERATION_NOT_ALLOWED")) return "Enable Email/Password sign-in in the Firebase console";
        return m;
    }
}
