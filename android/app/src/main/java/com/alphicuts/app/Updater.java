package com.alphicuts.app;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * App updates. The website publishes the latest version as app/android.json and app/alphi-cuts.apk
 * (see .github/workflows/android.yml). The app checks when it opens (at most hourly) and every few
 * hours in the background, tells the person when a newer version is out, and "Update" downloads it,
 * checks it's exactly the published file (SHA-256) and hands it to Android's own installer, which
 * asks "Update this app?" and only accepts a file signed with the same key as the installed app.
 * If the phone blocks the install, InstallBlock explains why and opens the setting that lifts it.
 */
final class Updater {
    private static final String TAG = "AlPhiCuts";
    private static final long CHECK_EVERY_MS = 60 * 60 * 1000L;
    private static final int JOB_ID = 4343;
    private static volatile boolean busy;

    private Updater() {}

    // ---------------------------------------------------------------- what's available
    /** Where updates come from: the website, or (debug builds under test only) a local server. */
    static String base(Context c) {
        String b = Store.getString(c, "updateBase");
        return b == null || b.isEmpty() ? MainActivity.SITE_URL : b;
    }

    static void setTestBase(Context c, String url) {
        Store.putString(c, "updateBase", url);
        Store.putLong(c, "updateCheckedAt", 0);
    }

    /** The newer version that's ready (from app/android.json), or null. */
    static JSONObject available(Context c) {
        String s = Store.getString(c, "update");
        if (s == null) return null;
        try {
            JSONObject j = new JSONObject(s);
            return j.optInt("versionCode") > BuildConfig.VERSION_CODE ? j : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Fetches app/android.json. Network: call off the main thread. */
    private static JSONObject latest(Context c) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(base(c) + "app/android.json?t=" + System.currentTimeMillis()).openConnection();
        try {
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setUseCaches(false);
            if (con.getResponseCode() != 200) throw new IOException("HTTP " + con.getResponseCode());
            try (InputStream in = con.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                int n;
                while ((n = in.read(chunk)) != -1 && buf.size() < 20000) buf.write(chunk, 0, n);
                return new JSONObject(buf.toString("UTF-8"));
            }
        } finally {
            con.disconnect();
        }
    }

    /**
     * Looks for a newer version (at most hourly unless forced). Remembers it for the website, and with
     * notify=true shows a notification once per version. Network: call off the main thread.
     */
    static void check(Context c, boolean notify, boolean force) {
        if (force || System.currentTimeMillis() - Store.getLong(c, "updateCheckedAt", 0) >= CHECK_EVERY_MS) {
            try {
                JSONObject j = latest(c);
                Store.putLong(c, "updateCheckedAt", System.currentTimeMillis());
                if (j.optInt("versionCode", 0) > BuildConfig.VERSION_CODE && j.optString("sha256", "").matches("[0-9a-f]{64}")) {
                    Store.putString(c, "update", j.toString());
                    Log.i(TAG, "Update available: " + j.optString("versionName"));
                } else {
                    Store.remove(c, "update");
                }
            } catch (Exception e) {
                Log.w(TAG, "Update check failed: " + e.getMessage());
            }
        }
        JSONObject u = available(c);
        if (!notify || u == null || MainActivity.isVisible()) return;
        int code = u.optInt("versionCode");
        if (Store.getInt(c, "updateNotified", 0) == code) return;
        Store.putInt(c, "updateNotified", code);
        Notifier.update(c, u.optString("versionName", "new"));
    }

    static void checkInBackground(MainActivity a, boolean force) {
        final Context c = a.getApplicationContext();
        new Thread(() -> {
            check(c, false, force);
            a.tellPage();
        }).start();
    }

    /** The background check every few hours (UpdateJob), kept across restarts. */
    static void schedule(Context c) {
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            if (js == null || js.getPendingJob(JOB_ID) != null) return;
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, UpdateJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(6 * 60 * 60 * 1000L)
                    .setPersisted(true)
                    .build();
            js.schedule(job);
        } catch (Exception e) {
            Log.w(TAG, "Update checks not scheduled: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- installing
    /** "Update" pressed: anything blocking installs first, then download, verify and install. */
    static void start(MainActivity a) {
        JSONObject u = available(a);
        if (u == null) {
            a.updateProgress("none", 0);
            return;
        }
        if (busy) return;
        String blocked = InstallBlock.before(a);
        if (!blocked.isEmpty()) {
            Log.i(TAG, "Update blocked before download: " + blocked);
            a.showInstallBlock(blocked);
            return;
        }
        busy = true;
        Store.remove(a, "installBlocked");
        Notifier.cancelUpdate(a);
        final Context c = a.getApplicationContext();
        a.updateProgress("downloading", 0);
        new Thread(() -> {
            File apk = new File(c.getCacheDir(), "update.apk");
            try {
                download(a, base(c) + "app/alphi-cuts.apk?v=" + u.optInt("versionCode"), apk);
                a.updateProgress("checking", 100);
                if (!u.optString("sha256").equalsIgnoreCase(sha256(apk))) throw new IOException("download didn't match the published file");
                a.updateProgress("installing", 100);
                install(c, apk);
            } catch (Exception e) {
                Log.w(TAG, "Update failed: " + e.getMessage());
                String msg = String.valueOf(e.getMessage());
                if (msg.contains("ENOSPC") || msg.toLowerCase().contains("no space")) a.runOnUiThread(() -> a.showInstallBlock(InstallBlock.STORAGE));
                else a.updateProgress("error", 0);
            } finally {
                busy = false;
            }
        }).start();
    }

    private static void download(MainActivity a, String url, File to) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        try {
            con.setConnectTimeout(20000);
            con.setReadTimeout(30000);
            con.setUseCaches(false);
            if (con.getResponseCode() != 200) throw new IOException("HTTP " + con.getResponseCode());
            long total = con.getContentLength();
            try (InputStream in = con.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] chunk = new byte[16384];
                long done = 0;
                int n, last = -1;
                while ((n = in.read(chunk)) != -1) {
                    out.write(chunk, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != last) {
                        last = pct;
                        a.updateProgress("downloading", pct);
                    }
                }
            }
        } finally {
            con.disconnect();
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] chunk = new byte[16384];
            int n;
            while ((n = in.read(chunk)) != -1) md.update(chunk, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** Hands the file to Android's installer; UpdateReceiver hears back (and shows its "Update?" screen). */
    private static void install(Context c, File apk) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (OutputStream out = s.openWrite("alphi-cuts.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) != -1) out.write(chunk, 0, n);
                s.fsync(out);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent status = PendingIntent.getBroadcast(c, id, new Intent(c, UpdateReceiver.class), flags);
            s.commit(status.getIntentSender());
            Log.i(TAG, "Update handed to the installer");
        }
    }
}
