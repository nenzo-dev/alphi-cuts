package com.alphicuts.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.util.Arrays;

/** Every notification the app shows, and the channels (sound settings) they use. */
final class Notifier {
    static final String CH_ALARM = "booking_alarm";
    static final String CH_UPDATES = "booking_updates";
    static final String CH_MESSAGES = "messages";
    static final String CH_WATCH = "watching";
    static final String CH_APP_UPDATES = "app_updates";
    static final int WATCH_ID = 1;
    private static final int UPDATE_ID = 4;
    private static final int GOLD = 0xFFD4AF37;
    private static final long[] ALARM_VIBRATION = {0, 800, 400, 800, 400, 1200};

    private Notifier() {}

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);

        // The three alerts with a sound the client can choose live on channels named by Sounds.
        NotificationChannel alarm = new NotificationChannel(Sounds.channel(c, "alarm"), "Your turn", NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription("Rings when your slot starts or the barber calls you");
        alarm.setSound(Sounds.uri(c, "alarm"), Sounds.attributes("alarm"));
        alarm.enableVibration(true);
        alarm.setVibrationPattern(ALARM_VIBRATION);
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alarm.setBypassDnd(true);

        NotificationChannel updates = new NotificationChannel(Sounds.channel(c, "updates"), "Booking updates", NotificationManager.IMPORTANCE_HIGH);
        updates.setDescription("Heads-up before your slot and when you're nearly up");
        updates.enableVibration(true);
        Uri updatesSound = Sounds.uri(c, "updates");
        if (updatesSound != null) updates.setSound(updatesSound, Sounds.attributes("updates"));

        NotificationChannel messages = new NotificationChannel(Sounds.channel(c, "messages"), "Messages", NotificationManager.IMPORTANCE_DEFAULT);
        messages.setDescription("Replies from the barber");
        Uri messagesSound = Sounds.uri(c, "messages");
        if (messagesSound != null) messages.setSound(messagesSound, Sounds.attributes("messages"));

        NotificationChannel watching = new NotificationChannel(CH_WATCH, "Booking watch", NotificationManager.IMPORTANCE_LOW);
        watching.setDescription("Shown while the app keeps an eye on your booking");
        watching.setShowBadge(false);

        NotificationChannel appUpdates = new NotificationChannel(CH_APP_UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT);
        appUpdates.setDescription("When a new version of the app is ready to install");

        nm.createNotificationChannels(Arrays.asList(alarm, updates, messages, watching, appUpdates));
    }

    static Uri alarmSound() {
        Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return u;
    }

    static int ringId(String token) {
        return 1000 + (token.hashCode() & 0xffff);
    }

    private static int infoId(String token) {
        return 100000 + (token.hashCode() & 0xffff);
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder builder(Context c, String channel) {
        String kind = Sounds.kindOf(channel);
        String live = kind == null ? channel : Sounds.channel(c, kind); // the channel with the client's sound
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, live) : new Notification.Builder(c);
        return b.setSmallIcon(R.drawable.ic_stat_bell).setColor(GOLD).setShowWhen(true);
    }

    private static PendingIntent openApp(Context c, int code) {
        Intent i = new Intent(c, MainActivity.class)
                .putExtra(MainActivity.EXTRA_OPEN, "book")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent receiverIntent(Context c, String action, String token) {
        return Scheduler.broadcast(c, action, token, PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String text(Context c, String key, String fallback) {
        JSONObject sync = Store.sync(c);
        JSONObject texts = sync == null ? null : sync.optJSONObject("texts");
        String t = texts == null ? null : texts.optString(key, null);
        return t == null || t.trim().isEmpty() ? fallback : t;
    }

    /** The full alarm: loud, repeating, over the lock screen, until the client acts or 5 minutes pass. */
    @SuppressWarnings("deprecation")
    static void ring(Context c, JSONObject booking, String phase) {
        channels(c);
        String token = booking.optString("token");
        boolean due = "due".equals(phase);
        String title = due ? "It's your turn" : "You're next";
        String body = text(c, due ? "now" : "called", title);
        String time = booking.optString("label");

        Intent full = new Intent(c, AlarmActivity.class)
                .putExtra(AlarmReceiver.EXTRA_TOKEN, token)
                .putExtra(AlarmActivity.EXTRA_TITLE, title)
                .putExtra(AlarmActivity.EXTRA_TEXT, body)
                .putExtra(AlarmActivity.EXTRA_TIME, time)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(c, ringId(token), full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = builder(c, CH_ALARM)
                .setContentTitle(time.isEmpty() ? title : title + " · " + time)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(fullPi)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat_bell),
                        "I'm here", receiverIntent(c, AlarmReceiver.ACTION_CHECK_IN, token)).build())
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat_bell),
                        "Stop alarm", receiverIntent(c, AlarmReceiver.ACTION_STOP, token)).build());
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_MAX)
                    .setSound(Sounds.uri(c, "alarm"), Sounds.attributes("alarm"))
                    .setVibrate(ALARM_VIBRATION);
        }
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // repeat the sound until handled
        c.getSystemService(NotificationManager.class).notify(ringId(token), n);
        Store.markFired(c, token + ":" + phase);
        Scheduler.scheduleSilence(c, token);
    }

    /** After 5 minutes of ringing: keep the notification, stop the sound. */
    static void silence(Context c, String token) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() != ringId(token)) continue;
            Notification quiet = Notification.Builder.recoverBuilder(c, s.getNotification())
                    .setOnlyAlertOnce(true)
                    .build();
            quiet.flags &= ~Notification.FLAG_INSISTENT;
            nm.notify(ringId(token), quiet);
        }
    }

    static void cancelRing(Context c, String token) {
        c.getSystemService(NotificationManager.class).cancel(ringId(token));
        Scheduler.cancelSilence(c, token);
        AlarmActivity.closeFor(token);
    }

    static void reminder(Context c, JSONObject booking) {
        String token = booking.optString("token");
        long mins = Math.max(1, Math.round((booking.optLong("startMs") - System.currentTimeMillis()) / 60000.0));
        String body = text(c, "reminder", "Your cut starts in {mins} minutes.")
                .replace("{mins} minutes", mins == 1 ? "1 minute" : mins + " minutes")
                .replace("{mins}", String.valueOf(mins));
        post(c, CH_UPDATES, infoId(token), "Your cut is coming up", body);
        Store.markFired(c, token + ":reminder");
    }

    static void onDeck(Context c, JSONObject booking) {
        String token = booking.optString("token");
        post(c, CH_UPDATES, infoId(token), "Almost your turn", text(c, "onDeck", "You're 2 away. Start heading over."));
        Store.markFired(c, token + ":on_deck");
    }

    static void info(Context c, String token, String title, String body) {
        post(c, CH_UPDATES, infoId(token), title, body);
    }

    /** Checked in by arriving at the shop ("Check me in when I arrive"). */
    static void arrived(Context c, JSONObject booking) {
        String token = booking.optString("token");
        post(c, CH_UPDATES, infoId(token), "You're checked in", text(c, "arrived", "You're checked in. The barber can see you're here."));
    }

    /** Checked in and next in line: please stay. */
    static void nextHere(Context c, JSONObject booking) {
        String token = booking.optString("token");
        post(c, CH_UPDATES, infoId(token), "You're next", text(c, "nextHere", "You're next. Please don't leave the shop."));
    }

    static void message(Context c, String ownerFirst) {
        String who = ownerFirst == null || ownerFirst.isEmpty() ? "the barber" : ownerFirst;
        post(c, CH_MESSAGES, 2, "New message from " + who, "Open the app to read it.");
    }

    @SuppressWarnings("deprecation")
    private static void post(Context c, String channel, int id, String title, String body) {
        channels(c);
        Notification.Builder b = builder(c, channel)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(openApp(c, id))
                .setAutoCancel(true);
        if (Build.VERSION.SDK_INT < 26) {
            // No channels before Android 8: each notification carries its sound.
            String kind = Sounds.kindOf(channel);
            Uri sound = kind == null ? null : Sounds.uri(c, kind);
            if (sound != null) b.setSound(sound, Sounds.attributes(kind));
            else b.setDefaults(Notification.DEFAULT_SOUND);
        }
        c.getSystemService(NotificationManager.class).notify(id, b.build());
    }

    /** A newer version is out: tapping it, or its Update button, opens the app and starts the update. */
    static void update(Context c, String version) {
        channels(c);
        Intent i = new Intent(c, MainActivity.class)
                .putExtra(MainActivity.EXTRA_UPDATE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 30, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String body = "This version of the app will no longer be supported. Tap Update to install the new one.";
        Notification n = builder(c, CH_APP_UPDATES)
                .setContentTitle("AlPhi Cuts " + version + " is ready")
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat_bell), "Update", pi).build())
                .build();
        c.getSystemService(NotificationManager.class).notify(UPDATE_ID, n);
    }

    /** The download finished while the person was elsewhere: one tap shows Android's "Update?" screen. */
    static void updateReady(Context c, Intent confirm) {
        channels(c);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(c, 31, confirm, flags);
        Notification n = builder(c, CH_APP_UPDATES)
                .setContentTitle("Finish updating AlPhi Cuts")
                .setContentText("The new version is downloaded. Tap to install it.")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        c.getSystemService(NotificationManager.class).notify(UPDATE_ID, n);
    }

    static void cancelUpdate(Context c) {
        c.getSystemService(NotificationManager.class).cancel(UPDATE_ID);
    }

    static Notification watching(Context c, String body) {
        channels(c);
        return builder(c, CH_WATCH)
                .setContentTitle("Keeping an eye on your booking")
                .setContentText(body)
                .setContentIntent(openApp(c, 3))
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }
}
