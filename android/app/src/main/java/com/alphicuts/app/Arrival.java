package com.alphicuts.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * "Check me in when I arrive" (2.5.0), only if the client turns it on. On the day of a booking, from
 * two hours before the slot until it ends, the booking watcher (WatchService) asks where the phone is.
 * Within the shop's arrival distance, the booking is checked in with arrive_at_shop(), which checks the
 * distance again; the position isn't kept anywhere. Once checked in, the watcher says when they're next.
 */
final class Arrival {
    private static final String TAG = "AlPhiCuts";
    private static final long BEFORE_MS = 2 * 60 * 60 * 1000L;
    private static final long RETRY_MS = 30_000L;
    private static volatile long lastTry;

    private Arrival() {}

    static boolean enabled(Context c) {
        return Store.getInt(c, "arrivalOn", 0) == 1;
    }

    static void setEnabled(Context c, boolean on) {
        Store.putInt(c, "arrivalOn", on ? 1 : 0);
    }

    static boolean hasLocation(Context c) {
        return granted(c, Manifest.permission.ACCESS_FINE_LOCATION) || granted(c, Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    /** "Allow all the time": needed from Android 10 for the check to work with the app closed. */
    static boolean hasBackground(Context c) {
        return Build.VERSION.SDK_INT < 29 || granted(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private static boolean granted(Context c, String permission) {
        return c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** From the watcher, about once a minute: check the booking in if the phone is at the shop. Network: off the main thread. */
    static void maybeCheckIn(Context c, JSONObject sync, JSONObject b) {
        if (sync == null || b == null || !enabled(c)) return;
        String status = b.optString("status");
        if (!"booked".equals(status) && !"on_deck".equals(status) && !"called".equals(status)) return;
        JSONObject shop = sync.optJSONObject("arrival");
        if (shop == null) return;
        double lat = shop.optDouble("lat", Double.NaN), lng = shop.optDouble("lng", Double.NaN);
        double radius = shop.optDouble("radius", 150);
        if (Double.isNaN(lat) || Double.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || radius < 30 || radius > 1000) return;
        long now = System.currentTimeMillis();
        if (now < b.optLong("startMs") - BEFORE_MS || now > b.optLong("endMs")) return;
        if (now - lastTry < RETRY_MS) return;
        // Without "all the time", location is only allowed while the app is on screen.
        if (!hasLocation(c) || (!hasBackground(c) && !MainActivity.isVisible())) return;

        Location here = locate(c);
        if (here == null) return;
        float[] meters = new float[1];
        Location.distanceBetween(lat, lng, here.getLatitude(), here.getLongitude(), meters);
        double slack = here.hasAccuracy() ? Math.min(Math.max(here.getAccuracy(), 0), 100) : 0;
        if (meters[0] > radius + slack) return;

        lastTry = now;
        String token = b.optString("token");
        Log.i(TAG, "Arrived at the shop (" + Math.round(meters[0]) + " m)");
        try {
            JSONObject res = Api.object(sync, "arrive_at_shop", new JSONObject()
                    .put("p_token", token).put("p_lat", here.getLatitude()).put("p_lng", here.getLongitude())
                    .put("p_accuracy", here.hasAccuracy() ? (double) here.getAccuracy() : JSONObject.NULL));
            if (!"checked_in".equals(res.optString("result"))) {
                Log.i(TAG, "Not checked in on arrival: " + res.optString("result"));
                return;
            }
            Store.setStatus(c, token, "checked_in");
            Notifier.cancelRing(c, token);
            Notifier.arrived(c, b);
            Scheduler.scheduleAll(c);
            Log.i(TAG, "Checked in on arrival");
        } catch (Exception e) {
            Log.w(TAG, "Arrival check-in failed: " + e.getMessage());
        }
    }

    /**
     * Once checked in: are they next? Nobody still waiting has an earlier slot today (the public queue,
     * which has times and statuses only). Says so once. Network: off the main thread.
     */
    static void maybeTellNext(Context c, JSONObject sync, JSONObject b) throws Exception {
        if (sync == null || b == null || !"checked_in".equals(b.optString("status"))) return;
        String token = b.optString("token");
        int mine = minutes(b.optString("slot"));
        if (mine < 0 || Store.fired(c, token + ":next")) return;
        JSONArray queue = Api.array(sync, "public_queue_today", new JSONObject());
        boolean present = false, ahead = false;
        for (int i = 0; i < queue.length(); i++) {
            JSONObject r = queue.optJSONObject(i);
            if (r == null) continue;
            String st = r.optString("status");
            int t = minutes(r.optString("slot_time"));
            if ("checked_in".equals(st) && t == mine) present = true;
            if (Store.isWatched(st) && t >= 0 && t < mine) ahead = true;
        }
        if (present && !ahead) {
            Notifier.nextHere(c, b);
            Store.markFired(c, token + ":next");
            Log.i(TAG, "Told the client they're next");
        }
    }

    /** "HH:MM" or "HH:MM:SS" as minutes since midnight; -1 if it isn't a time. */
    static int minutes(String hhmm) {
        if (hhmm == null || !hhmm.matches("\\d{1,2}:\\d{2}(:\\d{2})?")) return -1;
        String[] p = hhmm.split(":");
        return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
    }

    /** A current position (or one under a minute old), waiting at most 25 seconds. Off the main thread. */
    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private static Location locate(Context c) {
        LocationManager lm = c.getSystemService(LocationManager.class);
        if (lm == null) return null;
        boolean fine = granted(c, Manifest.permission.ACCESS_FINE_LOCATION);
        String provider = null;
        try {
            if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)
                    && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) {
                provider = LocationManager.FUSED_PROVIDER;
            } else if (fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                provider = LocationManager.GPS_PROVIDER;
            } else if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                provider = LocationManager.NETWORK_PROVIDER;
            }
            if (provider == null) return null; // location is switched off on the phone

            Location last = lm.getLastKnownLocation(provider);
            if (last != null && System.currentTimeMillis() - last.getTime() < 60_000L) return last;

            final Location[] found = {null};
            final CountDownLatch done = new CountDownLatch(1);
            if (Build.VERSION.SDK_INT >= 30) {
                CancellationSignal cancel = new CancellationSignal();
                lm.getCurrentLocation(provider, cancel, c.getMainExecutor(), loc -> {
                    found[0] = loc;
                    done.countDown();
                });
                if (!done.await(25, TimeUnit.SECONDS)) cancel.cancel();
            } else {
                // Every method spelled out: older Android has no defaults for the optional ones.
                LocationListener once = new LocationListener() {
                    @Override public void onLocationChanged(Location loc) { found[0] = loc; done.countDown(); }
                    @Override public void onStatusChanged(String p, int s, Bundle extras) {}
                    @Override public void onProviderEnabled(String p) {}
                    @Override public void onProviderDisabled(String p) {}
                };
                lm.requestSingleUpdate(provider, once, Looper.getMainLooper());
                if (!done.await(25, TimeUnit.SECONDS)) lm.removeUpdates(once);
            }
            return found[0] != null ? found[0] : last;
        } catch (SecurityException | IllegalArgumentException | InterruptedException e) {
            Log.w(TAG, "No location: " + e.getMessage());
            return null;
        }
    }
}
