package com.alphicuts.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
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
    private static final String TAG = "AlPhiCuts";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final String TEST_PREFIX = "file:///android_asset/test/";
    private static final int REQ_FILE = 10;
    private static final int REQ_NOTIFICATIONS = 11;

    private static volatile boolean visible;
    private volatile boolean trusted;
    private boolean debuggable;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    static boolean isVisible() {
        return visible;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
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
    }

    private static String hashFor(Intent i) {
        return i != null && "book".equals(i.getStringExtra(EXTRA_OPEN)) ? "#book" : "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if ("book".equals(intent.getStringExtra(EXTRA_OPEN)) && trusted) {
            web.evaluateJavascript("location.hash='#book'", null);
        }
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
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

    private void tellPage() {
        if (trusted) web.evaluateJavascript("window.dispatchEvent(new Event('alphiapp'))", null);
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
    }

    @Override
    protected void onPause() {
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
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
