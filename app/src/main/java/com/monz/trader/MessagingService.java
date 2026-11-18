package com.monz.trader;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives Firebase Cloud Messaging pushes (sent by the daily GitHub job) and shows them on the
 * strong-signal channel. Messages with a "notification" part are shown by Android itself when
 * the app is in the background; data-only messages and foreground messages arrive here.
 */
public class MessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        String title = d.get("title"), body = d.get("body"), key = d.get("key");
        if (msg.getNotification() != null) {
            if (title == null) title = msg.getNotification().getTitle();
            if (body == null) body = msg.getNotification().getBody();
        }
        if (title != null && body != null) Alerts.show(this, title, body, key);
    }

    @Override
    public void onNewToken(String token) {
        FirebaseFeatures.subscribe();   // topics survive token changes, but re-subscribe to be safe
    }
}
