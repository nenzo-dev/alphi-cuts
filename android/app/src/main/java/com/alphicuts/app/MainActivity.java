package com.alphicuts.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

/** The app's only normal screen: the shop's website, with a bridge to the phone's alarms. */
public class MainActivity extends Activity {
    static final String SITE_URL = "https://alphi-cuts.pages.dev/";
    static final String SITE_HOST = "alphi-cuts.pages.dev";
    static final String EXTRA_OPEN = "open";
    static final String EXTRA_UPDATE = "update";
    private static final String TAG = "AlPhiCuts";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final String TEST_PREFIX = "file:///android_asset/test/";
    private static final int REQ_FILE = 10;
    private static final int REQ_NOTIFICATIONS = 11;
    private static final int REQ_LOCATION = 13;
    private static final int REQ_BACKGROUND_LOCATION = 14;
    private static final int REQ_PHONE_SOUND = 15;
    private static final int REQ_SOUND_FILE = 16;

    private static volatile boolean visible;
    private static volatile MainActivity current;
    private volatile boolean trusted;
    private boolean debuggable;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private boolean startUpdateOnResume;
    private AlertDialog blockDialog;
    private String pendingBlock;

    static boolean isVisible() {
        return visible;
    }

    static MainActivity current() {
        return current;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        Notifier.channels(this);
        debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(0xFF171512);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " AlphiCutsAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(this), "AlphiAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> openExternal(url));

        String start = SITE_URL + hashFor(getIntent());
        String test = getIntent().getStringExtra("testUrl");
        if (debuggable && test != null && test.startsWith(TEST_PREFIX)) start = test;
        // Decide trust before loading: a fast page can call the bridge before onPageStarted arrives.
        trusted = trustedUrl(start);
        web.loadUrl(start);

        askForNotificationsOnce();
        Scheduler.scheduleAll(this); // re-arm alarms whenever the app is opened

        // Act on "Update" (from the update notification) only on a fresh start. When Android rebuilds
        // this screen later, getIntent() is still that first intent; anything new comes to onNewIntent.
        boolean fresh = state == null && (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0;
        Intent opened = fresh ? getIntent() : new Intent();
        startUpdateOnResume = opened.getBooleanExtra(EXTRA_UPDATE, false);
        Updater.schedule(this);
        if (!testUpdate(opened)) Updater.checkInBackground(this, false);
    }

    /** Debug builds under test can fetch updates from a local server (see ci/emulator-test.sh). */
    private boolean testUpdate(Intent i) {
        String base = i.getStringExtra("updateBase");
        if (!debuggable || base == null || !base.startsWith("http")) return false;
        Updater.setTestBase(this, base);
        final boolean auto = i.getBooleanExtra("autoUpdate", false);
        final Context app = getApplicationContext();
        new Thread(() -> {
            Updater.check(app, false, true);
            tellPage();
            if (auto) runOnUiThread(() -> Updater.start(this));
        }).start();
        return true;
    }

    private static String hashFor(Intent i) {
        return i != null && "book".equals(i.getStringExtra(EXTRA_OPEN)) ? "#book" : "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if ("book".equals(intent.getStringExtra(EXTRA_OPEN)) && trusted) {
            web.evaluateJavascript("location.hash='#book'", null);
        }
        if (intent.getBooleanExtra(EXTRA_UPDATE, false)) startUpdateOnResume = true;
        testUpdate(intent);
    }

    // ---------------------------------------------------------------- which pages may use the bridge
    boolean isTrustedPage() {
        return trusted;
    }

    private boolean isSite(Uri u) {
        return u != null && "https".equals(u.getScheme()) && SITE_HOST.equals(u.getHost());
    }

    private boolean trustedUrl(String url) {
        if (url == null) return false;
        if (debuggable && url.startsWith(TEST_PREFIX)) return true;
        return isSite(Uri.parse(url));
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String path = u.getPath() == null ? "" : u.getPath();
            boolean stay = (isSite(u) && !path.endsWith(".apk")) || (debuggable && u.toString().startsWith(TEST_PREFIX));
            if (stay) {
                if (request.isForMainFrame()) trusted = trustedUrl(u.toString());
                return false;
            }
            openExternal(u.toString()); // phone numbers, WhatsApp, maps, app updates
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            trusted = trustedUrl(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (trusted) Log.i(TAG, "Loaded " + url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            trusted = trustedUrl(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showOffline();
        }
    }

    private void showOffline() {
        Log.w(TAG, "Couldn't load the site; showing the offline page");
        trusted = false;
        web.loadUrl(OFFLINE_URL);
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("OK", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("Yes", (d, w) -> result.confirm())
                    .setNegativeButton("No", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
        if (requestCode == REQ_PHONE_SOUND || requestCode == REQ_SOUND_FILE) {
            String kind = Store.getString(this, "soundPicking");
            Store.remove(this, "soundPicking");
            if (resultCode != RESULT_OK || data == null || kind == null || !Sounds.isKind(kind)) return;
            if (requestCode == REQ_PHONE_SOUND) {
                Sounds.applyPicked(this, kind, data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI));
                soundsChanged(null);
                Sounds.preview(this, kind);
            } else if (data.getData() != null) {
                Uri source = data.getData();
                Toast.makeText(this, "Saving your sound…", Toast.LENGTH_SHORT).show();
                new Thread(() -> {
                    String problem = Sounds.applyFile(getApplicationContext(), kind, source);
                    runOnUiThread(() -> {
                        soundsChanged(problem);
                        if (problem == null) Sounds.preview(this, kind);
                    });
                }).start();
            }
        }
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone can open that link.", Toast.LENGTH_SHORT).show();
        }
    }

    // ---------------------------------------------------------------- alert permissions
    /** What's still needed for alarms to work with the app closed. Read by the website. */
    JSONObject alertStatus() {
        JSONObject o = new JSONObject();
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            PowerManager pm = getSystemService(PowerManager.class);
            boolean notifications = nm.areNotificationsEnabled()
                    && (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
            boolean exact = Scheduler.canExact(this);
            boolean fullScreen = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent();
            boolean background = pm.isIgnoringBatteryOptimizations(getPackageName());
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("code", BuildConfig.VERSION_CODE);
            o.put("notifications", notifications);
            o.put("exactAlarms", exact);
            o.put("fullScreen", fullScreen);
            o.put("background", background);
            o.put("ready", notifications && exact && fullScreen && background);
            // App updates: the newer version that's ready, and anything on the phone blocking installs.
            JSONObject u = Updater.available(this);
            if (u != null) {
                o.put("update", new JSONObject().put("versionName", u.optString("versionName"))
                        .put("versionCode", u.optInt("versionCode")).put("size", u.optLong("size")));
            }
            o.put("installBlocked", installBlocked());
            // "Check me in when I arrive": turned on, and what Android allows (Arrival.java).
            o.put("arrival", new JSONObject().put("on", Arrival.enabled(this))
                    .put("location", Arrival.hasLocation(this)).put("background", Arrival.hasBackground(this)));
            // Each kind of alert has its own sound, chosen in the phone's settings (openSoundSettings).
            o.put("sounds", Build.VERSION.SDK_INT >= 26);
            o.put("soundChoice", true); // the Sounds panel can choose sounds in the app (setSound)
        } catch (Exception ignored) {
            // leave whatever was filled in
        }
        return o;
    }

    private void askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        if (Store.getInt(this, "askedNotifications", 0) == 1) return;
        Store.putInt(this, "askedNotifications", 1);
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    /** Walks the client through whichever permission is still missing, one at a time. */
    void requestAlerts() {
        String pkg = "package:" + getPackageName();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && shouldAskAgain()) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
            return;
        }
        if (!nm.areNotificationsEnabled()) {
            explain("Turn on notifications", "Notifications are off for this app, so it can't alert you. Turn them on in the next screen.",
                    new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            return;
        }
        if (!Scheduler.canExact(this) && Build.VERSION.SDK_INT >= 31) {
            explain("Allow alarms", "So the app can ring at the exact time of your slot, allow \"Alarms & reminders\" in the next screen.",
                    new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse(pkg)));
            return;
        }
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) {
            explain("Allow full-screen alerts", "So your turn shows on the screen even when the phone is locked, allow full-screen notifications in the next screen.",
                    new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse(pkg)));
            return;
        }
        PowerManager pm = getSystemService(PowerManager.class);
        if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
            explain("Let the app run in the background", "So the app can tell you when the barber calls you, even when it's closed, allow it to run in the background in the next screen.",
                    new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse(pkg)));
            return;
        }
        Toast.makeText(this, "Alerts are on.", Toast.LENGTH_SHORT).show();
        tellPage();
    }

    private boolean shouldAskAgain() {
        // Android stops showing the permission prompt after two refusals; then send people to settings.
        return Store.getInt(this, "askedNotifications", 0) < 2 || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS);
    }

    private void explain(String title, String message, Intent settings) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton("Continue", (d, w) -> {
                    try {
                        startActivity(settings);
                    } catch (ActivityNotFoundException e) {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                    }
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    // ---------------------------------------------------------------- checking in on arrival
    /** "Check me in when I arrive": location first, then (Android 10 and later) location all the time. */
    void startArrivalFlow() {
        Arrival.setEnabled(this, true);
        if (!Arrival.hasLocation(this)) {
            if (Store.getInt(this, "askedLocation", 0) >= 2 && !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)) {
                // Android stops asking after two refusals: the switch is in the app's settings now.
                explain("Allow location", "So the app can check you in when you arrive, allow location for AlPhi Cuts in the next screen (Permissions, then Location).",
                        new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                return;
            }
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            return;
        }
        if (!Arrival.hasBackground(this)) {
            askForBackgroundLocation();
            return;
        }
        Toast.makeText(this, "You'll be checked in when you arrive.", Toast.LENGTH_SHORT).show();
        Scheduler.scheduleAll(this); // starts the watcher if a booking is in its arrival window
        tellPage();
    }

    private void askForBackgroundLocation() {
        new AlertDialog.Builder(this)
                .setTitle("Allow location all the time")
                .setMessage("So the app can check you in when you arrive, even when it's closed, choose \"Allow all the time\" "
                        + "in the next screen. It's only used on the day of your booking, from two hours before your slot.")
                .setPositiveButton("Continue", (d, w) -> requestPermissions(
                        new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_BACKGROUND_LOCATION))
                .setNegativeButton("Not now", (d, w) -> tellPage())
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOCATION) {
            Store.putInt(this, "askedLocation", Store.getInt(this, "askedLocation", 0) + 1);
            if (Arrival.hasLocation(this) && !Arrival.hasBackground(this)) askForBackgroundLocation();
            Scheduler.scheduleAll(this);
            tellPage();
            return;
        }
        if (requestCode == REQ_BACKGROUND_LOCATION) {
            Scheduler.scheduleAll(this);
            tellPage();
            return;
        }
        if (requestCode != REQ_NOTIFICATIONS) return;
        Store.putInt(this, "askedNotifications", Store.getInt(this, "askedNotifications", 0) + 1);
        tellPage();
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && Store.getInt(this, "alertsFlow", 0) == 1) {
            requestAlerts(); // carry on with the next step
        }
    }

    void startAlertsFlow() {
        Store.putInt(this, "alertsFlow", 1);
        requestAlerts();
    }

    void tellPage() {
        runJs("window.dispatchEvent(new Event('alphiapp'))");
    }

    private void runJs(String js) {
        runOnUiThread(() -> {
            if (web != null && trusted) web.evaluateJavascript(js, null);
        });
    }

    // ---------------------------------------------------------------- app updates
    /** Tells the website how an update is going: downloading (with %), checking, installing, confirm, blocked, error. */
    void updateProgress(String state, int pct) {
        runJs("window.__alphiUpdate&&window.__alphiUpdate(" + JSONObject.quote(state) + "," + pct + ")");
    }

    /** What's blocking installs, if the last attempt was blocked; "" otherwise. */
    String installBlocked() {
        String reason = Store.getString(this, "installBlocked");
        if (reason == null || !InstallBlock.known(reason)) return "";
        // A block that a setting lifts is checked again, in case it was changed outside the app.
        if (InstallBlock.resumesAfterSettings(reason) && InstallBlock.before(this).isEmpty()) {
            Store.remove(this, "installBlocked");
            return "";
        }
        return reason;
    }

    /** The phone blocks the update: say why, with a button to the setting that lifts it. */
    void showInstallBlock(String reason) {
        Store.putString(this, "installBlocked", reason);
        updateProgress("blocked", 0);
        if (isFinishing()) return;
        if (!visible) {
            pendingBlock = reason; // shown as soon as the screen is back
            return;
        }
        if (blockDialog != null && blockDialog.isShowing()) blockDialog.dismiss();
        blockDialog = new AlertDialog.Builder(this)
                .setTitle(InstallBlock.title(reason))
                .setMessage(InstallBlock.message(reason))
                .setPositiveButton("Open settings", (d, w) -> openInstallSettings(reason))
                .setNegativeButton("Not now", null)
                .show();
    }

    /** "Open settings" (here or on the website): the screen that lifts the block. */
    void openInstallSettings(String reason) {
        String r = reason == null || reason.isEmpty() ? installBlocked() : reason;
        if (r.isEmpty()) r = InstallBlock.before(this);
        if (r.isEmpty()) {
            Updater.start(this); // nothing is blocking any more
            return;
        }
        // Back from the settings screen, the update carries on by itself once the block is lifted.
        Store.putInt(this, "resumeUpdate", InstallBlock.resumesAfterSettings(r) ? 1 : 0);
        Log.i(TAG, "Opening settings for: " + r);
        InstallBlock.open(this, r);
    }

    /**
     * Opens the phone's settings for one kind of alert ("alarm", "updates" or "messages"), where the
     * client picks its sound. Android keeps a notification's sound in its channel, so this is the
     * one place it can be changed.
     */
    void openSoundSettings(String which) {
        Notifier.channels(this);
        String channel = Sounds.channel(this, Sounds.isKind(which) ? which : "alarm");
        Intent[] tries = Build.VERSION.SDK_INT >= 26
                ? new Intent[]{
                        new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                                .putExtra(Settings.EXTRA_CHANNEL_ID, channel),
                        new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()),
                        new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))}
                : new Intent[]{new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))};
        for (Intent i : tries) {
            try {
                startActivity(i);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // try the next, more general screen
            }
        }
        Toast.makeText(this, "Open Settings, then Apps, AlPhi Cuts, Notifications.", Toast.LENGTH_LONG).show();
    }

    // ---------------------------------------------------------------- the client's own sounds (Sounds.java)
    /**
     * From the website's Sounds panel: "default" or one of the website's tones is used straight away;
     * "phone" opens Android's sound picker and "file" lets the client choose a sound file.
     */
    void setSound(String kind, String choice) {
        if (!Sounds.isKind(kind) || choice == null) return;
        if ("phone".equals(choice)) {
            Uri current = Sounds.uri(this, kind);
            Intent i = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
                    .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, "alarm".equals(kind) ? RingtoneManager.TYPE_ALARM : RingtoneManager.TYPE_NOTIFICATION)
                    .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "alarm".equals(kind) ? "Sound for Your turn" : "updates".equals(kind) ? "Sound for booking updates" : "Sound for messages")
                    .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
                    .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
                    .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, current);
            startPicker(i, REQ_PHONE_SOUND, kind);
        } else if ("file".equals(choice)) {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*");
            startPicker(i, REQ_SOUND_FILE, kind);
        } else if ("default".equals(choice) || Sounds.isTone(choice)) {
            Sounds.apply(this, kind, choice, "");
            soundsChanged(null);
            Sounds.preview(this, kind);
        }
    }

    private void startPicker(Intent i, int request, String kind) {
        Store.putString(this, "soundPicking", kind);
        try {
            startActivityForResult(i, request);
        } catch (ActivityNotFoundException e) {
            Store.remove(this, "soundPicking");
            openSoundSettings(kind); // no picker on this phone: its own settings for that alert
        }
    }

    /** Tells the website the sounds changed (it redraws the panel), with a message if something failed. */
    void soundsChanged(String problem) {
        runJs("window.dispatchEvent(new CustomEvent('alphisounds',{detail:" + JSONObject.quote(problem == null ? "" : problem) + "}))");
    }

    void printPage() {
        printing = true; // the print screen needs the page to keep rendering behind it
        PrintManager pm = getSystemService(PrintManager.class);
        pm.print("AlPhi Cuts receipt", web.createPrintDocumentAdapter("AlPhi Cuts receipt"), new PrintAttributes.Builder().build());
    }

    // ---------------------------------------------------------------- lifecycle
    private boolean printing;

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        printing = false;
        web.onResume();
        web.resumeTimers();
        tellPage();
        if (pendingBlock != null) {
            String r = pendingBlock;
            pendingBlock = null;
            showInstallBlock(r);
        } else if (Store.getInt(this, "resumeUpdate", 0) == 1) {
            // Back from the settings screen that blocked the update: carry on once it's lifted.
            Store.putInt(this, "resumeUpdate", 0);
            if (InstallBlock.before(this).isEmpty()) {
                Store.remove(this, "installBlocked");
                Updater.start(this);
            }
        } else if (startUpdateOnResume) {
            startUpdateOnResume = false;
            Updater.start(this); // "Update" on the update notification
        }
    }

    @Override
    protected void onPause() {
        Sounds.stopPreview();
        visible = false;
        if (!printing) {
            web.onPause();
            web.pauseTimers(); // the phone's own alarms and the watcher take over in the background
        }
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (blockDialog != null && blockDialog.isShowing()) blockDialog.dismiss();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
