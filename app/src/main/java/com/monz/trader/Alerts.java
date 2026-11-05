package com.monz.trader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** Notification channel, notifications and the background check schedule. */
final class Alerts {
    static final String CHANNEL = "strong_signals";
    static final int JOB_PERIODIC = 1001, JOB_NOW = 1002;
    private Alerts() { }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Strong buy / sell signals", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("STRONG BUY or STRONG SELL on one of your holdings");
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    static boolean allowed(Context c) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm == null || nm.areNotificationsEnabled();
    }

    static void show(Context c, String title, String body, String key) {
        ensureChannel(c);
        if (!allowed(c)) return;
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (key != null) open.putExtra("openSignal", key);
        int id = key == null ? 1 : Math.abs(key.hashCode());
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(pi);
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    static void schedule(Context c, boolean on, int minutes) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (!on) { js.cancel(JOB_PERIODIC); return; }
        long ms = Math.max(15, minutes) * 60_000L;
        JobInfo job = new JobInfo.Builder(JOB_PERIODIC, new ComponentName(c, AlertJobService.class))
                .setPeriodic(ms).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).build();
        js.schedule(job);
    }

    static void runNow(Context c) {
        JobInfo job = new JobInfo.Builder(JOB_NOW, new ComponentName(c, AlertJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setOverrideDeadline(5_000).build();
        c.getSystemService(JobScheduler.class).schedule(job);
    }
}
