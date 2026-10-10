package com.alphicuts.app;

import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * The client's own sound for each kind of alert (app 1.4.0): one of the website's tones (bundled in
 * res/raw by tools/make_tones.py), one of the phone's sounds (Android's sound picker), a sound file of
 * their own, or the phone's usual sound.
 *
 * Android keeps a notification's sound in its channel, and an app can only set it when the channel
 * is made. So a new choice makes a fresh channel ("booking_alarm_2") and removes the old one.
 * A file of their own is copied into the phone's sounds (Alarms or Notifications, in "AlPhi Cuts"),
 * because Android itself plays notification sounds and can't open a file only this app may read.
 */
final class Sounds {
    static final String[] KINDS = {"alarm", "updates", "messages"};
    static final String[][] TONES = {
            {"phone", "Phone ring"}, {"chime", "Two-note chime"}, {"bell", "Bell"},
            {"clock", "Alarm clock"}, {"marimba", "Marimba"}, {"soft", "Soft rise"}};
    static final long MAX_FILE_BYTES = 10L * 1024 * 1024;

    private static Ringtone playing;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private Sounds() {}

    static boolean isKind(String kind) {
        for (String k : KINDS) if (k.equals(kind)) return true;
        return false;
    }

    static String base(String kind) {
        return "updates".equals(kind) ? Notifier.CH_UPDATES : "messages".equals(kind) ? Notifier.CH_MESSAGES : Notifier.CH_ALARM;
    }

    /** The kind of alert a channel id belongs to, or null for the channels without a chosen sound. */
    static String kindOf(String channel) {
        for (String k : KINDS) if (channel.equals(base(k))) return k;
        return null;
    }

    /** The channel in use for this kind: the original id until the first change, then id_1, id_2... */
    static String channel(Context c, String kind) {
        int v = Store.getInt(c, "soundVersion_" + kind, 0);
        return v == 0 ? base(kind) : base(kind) + "_" + v;
    }

    /** "default", a tone id ("bell"), "phone:<uri>" or "file:<uri>". */
    static String choice(Context c, String kind) {
        String s = Store.getString(c, "sound_" + kind);
        return s == null || s.isEmpty() ? "default" : s;
    }

    static boolean isTone(String id) {
        for (String[] t : TONES) if (t[0].equals(id)) return true;
        return false;
    }

    private static String toneName(String id) {
        for (String[] t : TONES) if (t[0].equals(id)) return t[1];
        return id;
    }

    /** The bundled file for a tone: the looping ring for "your turn", the short sound for the rest. */
    private static int raw(String tone, boolean ring) {
        switch (tone) {
            case "phone": return ring ? R.raw.tone_phone_ring : R.raw.tone_phone_short;
            case "chime": return ring ? R.raw.tone_chime_ring : R.raw.tone_chime_short;
            case "bell": return ring ? R.raw.tone_bell_ring : R.raw.tone_bell_short;
            case "clock": return ring ? R.raw.tone_clock_ring : R.raw.tone_clock_short;
            case "marimba": return ring ? R.raw.tone_marimba_ring : R.raw.tone_marimba_short;
            case "soft": return ring ? R.raw.tone_soft_ring : R.raw.tone_soft_short;
            default: return 0;
        }
    }

    private static Uri systemDefault(String kind) {
        return "alarm".equals(kind) ? Notifier.alarmSound() : Settings.System.DEFAULT_NOTIFICATION_URI;
    }

    /** The sound to play for this kind, or null to leave the phone's usual sound. */
    static Uri uri(Context c, String kind) {
        String ch = choice(c, kind);
        int id = isTone(ch) ? raw(ch, "alarm".equals(kind)) : 0;
        if (id != 0) {
            return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + c.getPackageName() + "/" + id);
        } else if (ch.startsWith("phone:") || ch.startsWith("file:")) {
            return Uri.parse(ch.substring(ch.indexOf(':') + 1));
        }
        return "alarm".equals(kind) ? Notifier.alarmSound() : null;
    }

    static AudioAttributes attributes(String kind) {
        return new AudioAttributes.Builder()
                .setUsage("alarm".equals(kind) ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    /** What the website shows for each kind: the choice and its name. */
    static JSONObject describe(Context c) {
        JSONObject o = new JSONObject();
        try {
            for (String k : KINDS) {
                String ch = choice(c, k);
                String label;
                if (isTone(ch)) label = toneName(ch);
                else if (ch.startsWith("phone:") || ch.startsWith("file:")) label = Store.getString(c, "soundName_" + k);
                else label = "The phone's usual sound";
                String type = isTone(ch) ? ch : ch.startsWith("phone:") ? "phone" : ch.startsWith("file:") ? "file" : "default";
                o.put(k, new JSONObject().put("choice", type).put("label", label == null ? "" : label));
            }
            o.put("ownFile", true); // Android 9 and older need the storage permission first (MainActivity)
        } catch (Exception ignored) {
            // whatever was filled in
        }
        return o;
    }

    /** Keeps the choice and moves this kind of alert to a fresh channel with that sound. */
    static void apply(Context c, String kind, String choice, String name) {
        if (!isKind(kind)) return;
        String old = channel(c, kind);
        String oldChoice = choice(c, kind);
        Store.putString(c, "sound_" + kind, choice);
        Store.putString(c, "soundName_" + kind, name == null ? "" : name);
        if (oldChoice.startsWith("file:") && !oldChoice.equals(choice)) removeCopied(c, oldChoice.substring(5));
        if (Build.VERSION.SDK_INT >= 26) {
            Store.putInt(c, "soundVersion_" + kind, Store.getInt(c, "soundVersion_" + kind, 0) + 1);
            c.getSystemService(NotificationManager.class).deleteNotificationChannel(old);
        }
        Notifier.channels(c);
    }

    /** A sound picked in Android's sound picker. The usual sound counts as "default". */
    static void applyPicked(Context c, String kind, Uri picked) {
        if (picked == null || picked.equals(systemDefault(kind)) || picked.equals(Settings.System.DEFAULT_RINGTONE_URI)) {
            apply(c, kind, "default", "");
            return;
        }
        String name = "";
        try {
            Ringtone r = RingtoneManager.getRingtone(c, picked);
            if (r != null) name = r.getTitle(c);
        } catch (Exception ignored) {
            // nameless is fine
        }
        apply(c, kind, "phone:" + picked, name);
    }

    /**
     * Copies a sound file the client chose into the phone's own sounds and uses it. Runs off the main
     * thread. Answers an error for people, or null when it worked. On Android 9 and older the copy
     * needs the storage permission (MainActivity asks for it before the file is chosen).
     */
    static String applyFile(Context c, String kind, Uri source) {
        ContentResolver cr = c.getContentResolver();
        String name = "My sound";
        long size = -1;
        try (Cursor q = cr.query(source, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (q != null && q.moveToFirst()) {
                if (!q.isNull(0)) name = q.getString(0);
                if (!q.isNull(1)) size = q.getLong(1);
            }
        } catch (Exception ignored) {
            // unnamed
        }
        if (size > MAX_FILE_BYTES) return TOO_BIG;
        String mime = cr.getType(source);
        if (mime == null || !mime.startsWith("audio/")) mime = "audio/mpeg";
        boolean alarm = "alarm".equals(kind);
        Uri dest;
        try {
            dest = Build.VERSION.SDK_INT >= 29
                    ? copyIntoSounds(cr, source, name, mime, alarm, kind)
                    : copyIntoSoundsOld(cr, source, name, mime, alarm, kind);
        } catch (Exception e) {
            return "too big".equals(e.getMessage()) ? TOO_BIG : "Couldn't use that file. Try an MP3 or M4A.";
        }
        if (dest == null) return "Couldn't save the sound on this phone.";
        final Uri saved = dest;
        final String shown = name;
        main.post(() -> apply(c, kind, "file:" + saved, shown));
        return null;
    }

    private static final String TOO_BIG = "That file is too big. Choose one under 10 MB.";

    /** Android 10 and later: into Alarms or Notifications through MediaStore, no permission needed. */
    @android.annotation.TargetApi(29)
    private static Uri copyIntoSounds(ContentResolver cr, Uri source, String name, String mime, boolean alarm, String kind) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, "AlPhi Cuts " + kind + " - " + name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, (alarm ? Environment.DIRECTORY_ALARMS : Environment.DIRECTORY_NOTIFICATIONS) + "/AlPhi Cuts");
        v.put(alarm ? MediaStore.Audio.Media.IS_ALARM : MediaStore.Audio.Media.IS_NOTIFICATION, 1);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri dest = cr.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (dest == null) return null;
        try (InputStream in = cr.openInputStream(source); OutputStream out = cr.openOutputStream(dest)) {
            copy(in, out);
        } catch (Exception e) {
            try { cr.delete(dest, null, null); } catch (Exception ignored) { /* already gone */ }
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(dest, v, null, null);
        return dest;
    }

    /** Android 9 and older: a file in the shared Alarms or Notifications folder, added to MediaStore. */
    @SuppressWarnings("deprecation")
    private static Uri copyIntoSoundsOld(ContentResolver cr, Uri source, String name, String mime, boolean alarm, String kind) throws Exception {
        File dir = new File(Environment.getExternalStoragePublicDirectory(alarm ? Environment.DIRECTORY_ALARMS : Environment.DIRECTORY_NOTIFICATIONS), "AlPhi Cuts");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("no folder");
        File file = new File(dir, ("AlPhi Cuts " + kind + " " + System.currentTimeMillis() + " - " + name).replaceAll("[\\\\/:*?\"<>|]", "_"));
        try (InputStream in = cr.openInputStream(source); OutputStream out = new FileOutputStream(file)) {
            copy(in, out);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            throw e;
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DATA, file.getAbsolutePath());
        v.put(MediaStore.MediaColumns.TITLE, name);
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, file.getName());
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.SIZE, file.length());
        v.put(alarm ? MediaStore.Audio.Media.IS_ALARM : MediaStore.Audio.Media.IS_NOTIFICATION, 1);
        Uri row = cr.insert(MediaStore.Audio.Media.getContentUriForPath(file.getAbsolutePath()), v);
        if (row == null) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
        return row;
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        if (in == null || out == null) throw new IllegalStateException("no stream");
        byte[] buf = new byte[64 * 1024];
        long copied = 0;
        for (int n; (n = in.read(buf)) > 0; ) {
            copied += n;
            if (copied > MAX_FILE_BYTES) throw new IllegalStateException("too big");
            out.write(buf, 0, n);
        }
    }

    /**
     * When the phone won't let the client hear this kind of alert (its volume is off, or the phone
     * is on silent), a line saying so; otherwise "".
     */
    static String quietMessage(Context c, String kind) {
        try {
            AudioManager am = c.getSystemService(AudioManager.class);
            if ("alarm".equals(kind)) {
                return am.getStreamVolume(AudioManager.STREAM_ALARM) == 0
                        ? "Your alarm volume is off, so you won't hear it. Turn it up in the phone's sound settings." : "";
            }
            if (am.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return "Your phone is on silent or vibrate, so you won't hear this sound.";
            return am.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0
                    ? "Your notification volume is off, so you won't hear it. Turn it up in the phone's sound settings." : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static void removeCopied(Context c, String uri) {
        try { c.getContentResolver().delete(Uri.parse(uri), null, null); } catch (Exception ignored) { /* not ours any more */ }
    }

    /** Plays this kind's sound for a few seconds, so the client hears what they picked. */
    static void preview(Context c, String kind) {
        stopPreview();
        Uri u = uri(c, kind);
        if (u == null) u = systemDefault(kind);
        try {
            playing = RingtoneManager.getRingtone(c, u);
            if (playing == null) return;
            playing.setAudioAttributes(attributes(kind));
            playing.play();
            final Ringtone mine = playing;
            main.postDelayed(() -> { if (playing == mine) stopPreview(); }, 6000);
        } catch (Exception ignored) {
            playing = null;
        }
    }

    static void stopPreview() {
        if (playing != null) {
            try { playing.stop(); } catch (Exception ignored) { /* already stopped */ }
            playing = null;
        }
    }
}
