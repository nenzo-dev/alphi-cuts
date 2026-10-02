package com.alphicuts.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Turns the bookings the website sent into system alarms. System alarms fire even when the app is
 * closed or the phone is asleep, which is what lets the app ring on time:
 *   REMINDER  a few minutes before the slot (heads-up notification)
 *   DUE       when the slot starts (the ringing alarm; set as an alarm clock so it fires exactly)
 *   WATCH     two hours before, to start watching for the barber calling early
 */
final class Scheduler {
    static final String ACTION_REMINDER = "com.alphicuts.app.REMINDER";
    static final String ACTION_DUE = "com.alphicuts.app.DUE";
    static final String ACTION_WATCH = "com.alphicuts.app.WATCH";
    static final String ACTION_SILENCE = "com.alphicuts.app.SILENCE";
    static final long WATCH_LEAD_MS = 2 * 60 * 60 * 1000L;
    /** A checked-in client may wait past their slot if the barber is running late: keep watching. */
    static final long LATE_MS = 2 * 60 * 60 * 1000L;
    private static final long RING_MS = 5 * 60 * 1000L;
    private static final String SCHEDULED = "scheduled";

    private Scheduler() {}

    static PendingIntent broadcast(Context c, String action, String token, int flags) {
        Intent i = new Intent(c, AlarmReceiver.class)
                .setAction(action)
                .setData(Uri.parse("alphi://booking/" + token))
                .putExtra(AlarmReceiver.EXTRA_TOKEN, token);
        return PendingIntent.getBroadcast(c, 0, i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        return c.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    /** Clears every alarm set earlier and sets them again from the saved bookings. */
    static synchronized void scheduleAll(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        cancelRecorded(c, am);
        JSONObject sync = Store.sync(c);
        if (sync == null) return;

        long now = System.currentTimeMillis();
        int reminderMin = Math.max(0, sync.optInt("reminderMinutes", 10));
        JSONArray bookings = sync.optJSONArray("bookings");
        JSONArray recorded = new JSONArray();
        boolean watchNow = false;

        for (int i = 0; bookings != null && i < bookings.length(); i++) {
            JSONObject b = bookings.optJSONObject(i);
            if (b == null) continue;
            if ("checked_in".equals(b.optString("status"))) {
                // At the shop: no alarms, but keep watching so they hear when they're next.
                if (now >= b.optLong("startMs") - WATCH_LEAD_MS && now < b.optLong("endMs") + LATE_MS) watchNow = true;
                continue;
            }
            if (!Store.isWaiting(b.optString("status"))) continue;
            String token = b.optString("token");
            long start = b.optLong("startMs");
            long end = b.optLong("endMs");
            if (token.isEmpty() || end <= now) continue;

            if (start > now) {
                set(c, am, ACTION_DUE, token, start, true, recorded);
                long reminder = start - reminderMin * 60000L;
                if (reminderMin > 0 && reminder > now) set(c, am, ACTION_REMINDER, token, reminder, false, recorded);
                long watch = start - WATCH_LEAD_MS;
                if (watch > now) set(c, am, ACTION_WATCH, token, watch, false, recorded);
                else watchNow = true;
            } else {
                // The slot has already started: ring now unless it already rang.
                if (!Store.fired(c, token + ":due") && !Store.fired(c, token + ":called")) Notifier.ring(c, b, "due");
                watchNow = true;
            }
        }
        Store.putString(c, SCHEDULED, recorded.toString());
        if (watchNow) WatchService.start(c);
    }

    private static void set(Context c, AlarmManager am, String action, String token, long at, boolean alarmClock, JSONArray recorded) {
        PendingIntent pi = broadcast(c, action, token, PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            if (canExact(c) && alarmClock) {
                PendingIntent show = PendingIntent.getActivity(c, 1, new Intent(c, MainActivity.class),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
            } else if (canExact(c)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            // Exact alarms were switched off in settings: fall back to an inexact one.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
        recorded.put(action + "|" + token);
    }

    private static void cancelRecorded(Context c, AlarmManager am) {
        String raw = Store.getString(c, SCHEDULED);
        if (raw == null) return;
        try {
            JSONArray list = new JSONArray(raw);
            for (int i = 0; i < list.length(); i++) {
                String[] parts = list.getString(i).split("\\|", 2);
                if (parts.length != 2) continue;
                PendingIntent pi = broadcast(c, parts[0], parts[1], PendingIntent.FLAG_NO_CREATE);
                if (pi != null) {
                    am.cancel(pi);
                    pi.cancel();
                }
            }
        } catch (Exception ignored) {
            // nothing usable recorded
        }
        Store.putString(c, SCHEDULED, "[]");
    }

    static void scheduleSilence(Context c, String token) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = broadcast(c, ACTION_SILENCE, token, PendingIntent.FLAG_UPDATE_CURRENT);
        long at = System.currentTimeMillis() + RING_MS;
        try {
            if (canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    static void cancelSilence(Context c, String token) {
        PendingIntent pi = broadcast(c, ACTION_SILENCE, token, PendingIntent.FLAG_NO_CREATE);
        if (pi != null) {
            c.getSystemService(AlarmManager.class).cancel(pi);
            pi.cancel();
        }
    }
}
