package com.alphicuts.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * What the app remembers between runs: the booking details the website last sent (see
 * Bridge.syncBookings), which alerts have already gone off, and what the watcher last saw.
 * Kept in private app storage; uninstalling the app deletes it.
 */
final class Store {
    private static final String PREFS = "alphi";
    private static final String SYNC = "sync";
    private static final String FIRED = "fired";

    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isWaiting(String status) {
        return "booked".equals(status) || "on_deck".equals(status) || "called".equals(status);
    }

    /** Waiting, or checked in at the shop and waiting for the chair: the watcher keeps an eye on these. */
    static boolean isWatched(String status) {
        return isWaiting(status) || "checked_in".equals(status);
    }

    static synchronized void saveSync(Context c, JSONObject sync) {
        // Forget "already fired" markers for bookings that are no longer on this phone.
        Set<String> keep = new HashSet<>();
        Set<String> fired = prefs(c).getStringSet(FIRED, new HashSet<>());
        JSONArray tokens = sync.optJSONArray("tokens");
        for (String key : fired) {
            String token = key.contains(":") ? key.substring(0, key.indexOf(':')) : key;
            if (tokens != null && contains(tokens, token)) keep.add(key);
        }
        prefs(c).edit().putString(SYNC, sync.toString()).putStringSet(FIRED, keep).apply();
    }

    static synchronized JSONObject sync(Context c) {
        String s = prefs(c).getString(SYNC, null);
        if (s == null) return null;
        try {
            return new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    static synchronized JSONObject booking(Context c, String token) {
        JSONObject sync = sync(c);
        if (sync == null || token == null) return null;
        JSONArray list = sync.optJSONArray("bookings");
        if (list == null) return null;
        for (int i = 0; i < list.length(); i++) {
            JSONObject b = list.optJSONObject(i);
            if (b != null && token.equals(b.optString("token"))) return b;
        }
        return null;
    }

    static synchronized void setStatus(Context c, String token, String status) {
        JSONObject sync = sync(c);
        if (sync == null) return;
        JSONArray list = sync.optJSONArray("bookings");
        if (list == null) return;
        try {
            for (int i = 0; i < list.length(); i++) {
                JSONObject b = list.optJSONObject(i);
                if (b != null && token.equals(b.optString("token"))) b.put("status", status);
            }
        } catch (Exception ignored) {
            return;
        }
        prefs(c).edit().putString(SYNC, sync.toString()).apply();
    }

    static synchronized boolean fired(Context c, String key) {
        return prefs(c).getStringSet(FIRED, new HashSet<>()).contains(key);
    }

    static synchronized void markFired(Context c, String key) {
        Set<String> set = new HashSet<>(prefs(c).getStringSet(FIRED, new HashSet<>()));
        set.add(key);
        prefs(c).edit().putStringSet(FIRED, set).apply();
    }

    static synchronized String getString(Context c, String key) {
        return prefs(c).getString(key, null);
    }

    static synchronized void putString(Context c, String key, String value) {
        prefs(c).edit().putString(key, value).apply();
    }

    static synchronized int getInt(Context c, String key, int def) {
        return prefs(c).getInt(key, def);
    }

    static synchronized void putInt(Context c, String key, int value) {
        prefs(c).edit().putInt(key, value).apply();
    }

    static synchronized long getLong(Context c, String key, long def) {
        return prefs(c).getLong(key, def);
    }

    static synchronized void putLong(Context c, String key, long value) {
        prefs(c).edit().putLong(key, value).apply();
    }

    static synchronized void remove(Context c, String key) {
        prefs(c).edit().remove(key).apply();
    }

    static boolean contains(JSONArray arr, String value) {
        for (int i = 0; i < arr.length(); i++) {
            if (value.equals(arr.optString(i))) return true;
        }
        return false;
    }
}
