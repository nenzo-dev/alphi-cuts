package com.alphicuts.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Handles the system alarms set by Scheduler and the buttons on the alarm notification. */
public class AlarmReceiver extends BroadcastReceiver {
    static final String EXTRA_TOKEN = "token";
    static final String ACTION_CHECK_IN = "com.alphicuts.app.CHECK_IN";
    static final String ACTION_STOP = "com.alphicuts.app.STOP";

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context c = context.getApplicationContext();
        final String action = intent.getAction();
        final String token = intent.getStringExtra(EXTRA_TOKEN);
        if (action == null || token == null) return;
        JSONObject b = Store.booking(c, token);
        boolean waiting = b != null && Store.isWaiting(b.optString("status"));

        switch (action) {
            case Scheduler.ACTION_REMINDER:
                if (waiting && !Store.fired(c, token + ":reminder")) Notifier.reminder(c, b);
                break;
            case Scheduler.ACTION_DUE:
                if (waiting && !Store.fired(c, token + ":due") && !Store.fired(c, token + ":called")) {
                    Notifier.ring(c, b, "due");
                }
                WatchService.start(c);
                break;
            case Scheduler.ACTION_WATCH:
                WatchService.start(c);
                break;
            case Scheduler.ACTION_SILENCE:
                Notifier.silence(c, token);
                break;
            case ACTION_STOP:
                Notifier.cancelRing(c, token);
                break;
            case ACTION_CHECK_IN:
                Notifier.cancelRing(c, token);
                final PendingResult pending = goAsync();
                new Thread(() -> {
                    try {
                        Api.checkIn(c, token);
                        Store.setStatus(c, token, "checked_in");
                        Notifier.info(c, token, "You're checked in", "The barber knows you're here.");
                    } catch (Exception e) {
                        Notifier.info(c, token, "Couldn't check you in",
                                "Sorry, we ran into an error. It's not you, it's us. Please tell the barber you're here.");
                    } finally {
                        pending.finish();
                    }
                }).start();
                break;
            default:
                break;
        }
    }
}
