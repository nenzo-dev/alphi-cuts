package com.alphicuts.app;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * window.AlphiAndroid on the website. Only the shop's own site can use it: every call is ignored
 * unless the page showing is https://alphi-cuts.pages.dev (links to anywhere else open outside
 * the app, so no other site ever loads here).
 */
final class Bridge {
    private final MainActivity activity;

    Bridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String info() {
        if (!activity.isTrustedPage()) return "{}";
        return activity.alertStatus().toString();
    }

    /** The website sends the bookings held on this phone; the app sets alarms for them. */
    @JavascriptInterface
    public void syncBookings(String json) {
        if (!activity.isTrustedPage() || json == null || json.length() > 50_000) return;
        try {
            JSONObject sync = new JSONObject(json);
            JSONObject api = sync.getJSONObject("api");
            if (!Api.isAllowedBase(api.optString("url")) || api.optString("key").isEmpty()) return;
            JSONArray bookings = sync.optJSONArray("bookings");
            JSONArray tokens = sync.optJSONArray("tokens");
            if (bookings == null || tokens == null || bookings.length() > 10 || tokens.length() > 10) return;
            for (int i = 0; i < bookings.length(); i++) {
                JSONObject b = bookings.getJSONObject(i);
                if (!b.optString("token").matches("[0-9a-f]{32,64}")) return;
                if (b.optLong("startMs") <= 0 || b.optLong("endMs") <= b.optLong("startMs")) return;
            }
            Store.saveSync(activity, sync);
            Scheduler.scheduleAll(activity);
        } catch (Exception ignored) {
            // malformed data: keep the alarms that are already set
        }
    }

    @JavascriptInterface
    public void requestAlerts() {
        if (activity.isTrustedPage()) activity.runOnUiThread(activity::startAlertsFlow);
    }

    @JavascriptInterface
    public void print() {
        if (activity.isTrustedPage()) activity.runOnUiThread(activity::printPage);
    }

    /** "Check me in when I arrive" on today's booking: asks for location, then watches for arrival. */
    @JavascriptInterface
    public void enableArrival() {
        if (activity.isTrustedPage()) activity.runOnUiThread(activity::startArrivalFlow);
    }

    @JavascriptInterface
    public void disableArrival() {
        if (!activity.isTrustedPage()) return;
        Arrival.setEnabled(activity, false);
        activity.tellPage();
    }

    /** "Update" on the website: download, check and install the newer version. */
    @JavascriptInterface
    public void startUpdate() {
        if (activity.isTrustedPage()) activity.runOnUiThread(() -> Updater.start(activity));
    }

    /** Look for a newer version now; the website hears back through its 'alphiapp' event. */
    @JavascriptInterface
    public void checkUpdate() {
        if (activity.isTrustedPage()) Updater.checkInBackground(activity, true);
    }

    /** "Open settings" when the phone blocks the update: the screen that lifts the block. */
    @JavascriptInterface
    public void openInstallSettings() {
        if (activity.isTrustedPage()) activity.runOnUiThread(() -> activity.openInstallSettings(""));
    }
}
