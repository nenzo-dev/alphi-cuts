package com.alphicuts.app;

import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs on the day of a booking, from two hours before the slot until it ends, even with the app
 * closed. It checks the booking with the database and alerts the client when the barber moves
 * them up the queue (two away, called next), and when the barber replies in the chat. Android
 * requires a visible notification while this runs.
 */
public class WatchService extends Service {
    private static final long MAX_RUN_MS = 4 * 60 * 60 * 1000L;
    private static final long FAST_POLL_MS = 20_000L;
    private static final long SLOW_POLL_MS = 60_000L;
    private static final long MESSAGE_POLL_MS = 60_000L;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock lock;
    private long startedAt;
    private long lastMessagePoll;

    static void start(Context c) {
        Intent i = new Intent(c, WatchService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception e) {
            // Android didn't allow a background start right now. The alarms still ring on time.
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(Notifier.WATCH_ID, Notifier.watching(this, describe()), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(Notifier.WATCH_ID, Notifier.watching(this, describe()));
            }
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (thread == null) {
            startedAt = System.currentTimeMillis();
            PowerManager pm = getSystemService(PowerManager.class);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "alphicuts:watch");
            lock.setReferenceCounted(false);
            lock.acquire(MAX_RUN_MS);
            thread = new HandlerThread("booking-watch");
            thread.start();
            handler = new Handler(thread.getLooper());
            handler.post(this::tick);
        }
        return START_STICKY;
    }

    /**
     * The booking this service is here for, or null when there's nothing left to watch: one still
     * waiting, or one checked in at the shop (watched a while past its slot, in case the barber is late).
     */
    private JSONObject nextActive(JSONObject sync, long now) {
        JSONArray list = sync == null ? null : sync.optJSONArray("bookings");
        JSONObject best = null;
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject b = list.optJSONObject(i);
            if (b == null || !Store.isWatched(b.optString("status"))) continue;
            long start = b.optLong("startMs");
            long until = b.optLong("endMs") + ("checked_in".equals(b.optString("status")) ? Scheduler.LATE_MS : 0);
            if (until <= now || start - Scheduler.WATCH_LEAD_MS > now) continue;
            if (best == null || start < best.optLong("startMs")) best = b;
        }
        return best;
    }

    private String describe() {
        JSONObject b = nextActive(Store.sync(this), System.currentTimeMillis());
        if (b != null && "checked_in".equals(b.optString("status"))) return "You're checked in. We'll tell you when you're next.";
        String label = b == null ? "" : b.optString("label");
        return label.isEmpty() ? "We'll let you know when it's your turn." : "Your " + label + " slot. We'll alert you when it's your turn.";
    }

    private void tick() {
        long now = System.currentTimeMillis();
        JSONObject sync = Store.sync(this);
        JSONObject active = nextActive(sync, now);
        if (active == null || now - startedAt > MAX_RUN_MS) {
            stopSelf();
            return;
        }
        try {
            pollBookings(sync);
        } catch (Exception ignored) {
            // offline or the server is busy: try again next time
        }
        if (now - lastMessagePoll >= MESSAGE_POLL_MS) {
            lastMessagePoll = now;
            try {
                pollMessages(sync);
            } catch (Exception ignored) {
                // same as above
            }
        }
        // "Check me in when I arrive", then "you're next" once checked in (Arrival.java).
        JSONObject latest = Store.booking(this, active.optString("token"));
        Arrival.maybeCheckIn(this, Store.sync(this), latest);
        try {
            Arrival.maybeTellNext(this, Store.sync(this), Store.booking(this, active.optString("token")));
        } catch (Exception ignored) {
            // offline or the server is busy: try again next time
        }
        getSystemService(NotificationManager.class).notify(Notifier.WATCH_ID, Notifier.watching(this, describe()));
        long untilStart = active.optLong("startMs") - now;
        handler.postDelayed(this::tick, untilStart < 45 * 60_000L ? FAST_POLL_MS : SLOW_POLL_MS);
    }

    private void pollBookings(JSONObject sync) throws Exception {
        JSONArray tokens = sync.optJSONArray("tokens");
        if (tokens == null || tokens.length() == 0) return;
        JSONArray rows = Api.array(sync, "get_my_bookings", new JSONObject().put("p_tokens", tokens));
        boolean changed = false;

        // A cancelled booking is deleted, so it simply stops coming back. (This only runs after a
        // successful reply; a network error throws before getting here.)
        java.util.Set<String> present = new java.util.HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null) present.add(row.optString("client_token"));
        }
        JSONArray known = sync.optJSONArray("bookings");
        for (int i = 0; known != null && i < known.length(); i++) {
            JSONObject b = known.optJSONObject(i);
            if (b == null || !Store.isWaiting(b.optString("status"))) continue;
            String token = b.optString("token");
            if (present.contains(token)) continue;
            Store.setStatus(this, token, "cancelled");
            Notifier.cancelRing(this, token);
            changed = true;
        }

        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String token = row.optString("client_token");
            String status = row.optString("status");
            JSONObject b = Store.booking(this, token);
            if (b == null || status.isEmpty() || status.equals(b.optString("status"))) continue;
            Store.setStatus(this, token, status);
            b.put("status", status);
            changed = true;
            if ("on_deck".equals(status)) {
                if (!Store.fired(this, token + ":on_deck")) Notifier.onDeck(this, b);
            } else if ("called".equals(status)) {
                if (!Store.fired(this, token + ":called") && !Store.fired(this, token + ":due")) Notifier.ring(this, b, "called");
            } else if (!Store.isWaiting(status)) {
                Notifier.cancelRing(this, token); // checked in, in the chair, done or cancelled
            }
        }
        if (changed) Scheduler.scheduleAll(this);
    }

    private void pollMessages(JSONObject sync) throws Exception {
        String device = sync.optString("device");
        if (!device.matches("[0-9a-f]{32,64}")) return;
        JSONArray rows = Api.array(sync, "get_my_messages", new JSONObject().put("p_token", device));
        int owner = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject m = rows.optJSONObject(i);
            if (m != null && "owner".equals(m.optString("sender"))) owner++;
        }
        String key = "ownerMessages:" + device;
        int seen = Store.getInt(this, key, -1);
        if (seen >= 0 && owner > seen && !MainActivity.isVisible()) Notifier.message(this, sync.optString("ownerFirst"));
        Store.putInt(this, key, owner);
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (lock != null && lock.isHeld()) lock.release();
        thread = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
