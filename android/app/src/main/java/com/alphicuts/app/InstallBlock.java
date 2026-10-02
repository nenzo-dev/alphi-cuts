package com.alphicuts.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.UserManager;
import android.provider.Settings;

/**
 * What can stop the phone installing an app update, and the settings screen that lifts it:
 *   unknown_sources  "Install unknown apps" is off for this app (Android 7: "Unknown sources" is off)
 *   policy           the phone blocks every app from outside the Play Store (Samsung's Auto Blocker,
 *                    or a phone managed by an employer or school)
 *   security         a security check (Google Play Protect, or the phone maker's own) refused it
 *   storage          not enough free space
 */
final class InstallBlock {
    static final String UNKNOWN_SOURCES = "unknown_sources";
    static final String POLICY = "policy";
    static final String SECURITY = "security";
    static final String STORAGE = "storage";

    private InstallBlock() {}

    /** What would stop an install right now, checked before anything is downloaded; "" if nothing. */
    @SuppressWarnings("deprecation")
    static String before(Context c) {
        try {
            UserManager um = c.getSystemService(UserManager.class);
            if (um != null && (um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES)
                    || (Build.VERSION.SDK_INT >= 29 && um.hasUserRestriction(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY)))) {
                return POLICY;
            }
            if (Build.VERSION.SDK_INT >= 26) {
                if (!c.getPackageManager().canRequestPackageInstalls()) return UNKNOWN_SOURCES;
            } else if (Settings.Secure.getInt(c.getContentResolver(), Settings.Secure.INSTALL_NON_MARKET_APPS, 0) != 1) {
                return UNKNOWN_SOURCES;
            }
        } catch (Exception ignored) {
            // can't tell: try the install, and Android's installer will say if it's blocked
        }
        return "";
    }

    /** Android's installer refused the update: is it something a setting can fix? "" if not. */
    static String fromStatus(int status) {
        if (status == PackageInstaller.STATUS_FAILURE_BLOCKED) return SECURITY;
        if (status == PackageInstaller.STATUS_FAILURE_STORAGE) return STORAGE;
        return "";
    }

    static boolean known(String reason) {
        return UNKNOWN_SOURCES.equals(reason) || POLICY.equals(reason) || SECURITY.equals(reason) || STORAGE.equals(reason);
    }

    /** Lifted by a setting the person changes, so the update can carry on by itself afterwards. */
    static boolean resumesAfterSettings(String reason) {
        return UNKNOWN_SOURCES.equals(reason) || POLICY.equals(reason);
    }

    static String title(String reason) {
        switch (reason) {
            case UNKNOWN_SOURCES: return "Allow updates from AlPhi Cuts";
            case POLICY: return "Your phone is blocking app installs";
            case SECURITY: return "A security check stopped the update";
            case STORAGE: return "Not enough space for the update";
            default: return "The update couldn't install";
        }
    }

    static String message(String reason) {
        switch (reason) {
            case UNKNOWN_SOURCES:
                return "Your phone doesn't let AlPhi Cuts install its own updates yet. Tap Open settings, turn on "
                        + "\"Allow from this source\", then come back and the update will carry on.\n\n"
                        + "If the switch won't turn on, your phone blocks all apps from outside the Play Store. On a "
                        + "Samsung, turn off Auto Blocker under Security and privacy first.";
            case POLICY:
                return "This phone is set to block apps from outside the Play Store, so the update can't install. "
                        + "On a Samsung this is Auto Blocker: tap Open settings, find Auto Blocker (under Security "
                        + "and privacy) and turn it off, then come back and the update will carry on.\n\n"
                        + "If an employer or school manages this phone, ask them to allow it.";
            case SECURITY:
                return "Your phone's security check, such as Google Play Protect, stopped the update. The update "
                        + "comes from the shop's own website and is signed by the shop.\n\n"
                        + "Tap Update again, and if the check asks, choose \"More details\" and then \"Install "
                        + "anyway\". Open settings shows the check's own settings.";
            case STORAGE:
                return "Your phone doesn't have enough free space for the update. Tap Open settings to free up "
                        + "some space, then come back and tap Update again.";
            default:
                return "Something on this phone stopped the update. Tap Open settings to check, then tap Update again.";
        }
    }

    /** The settings screens that lift the block, best first. */
    static Intent[] settings(Context c, String reason) {
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        switch (reason) {
            case UNKNOWN_SOURCES:
                return Build.VERSION.SDK_INT >= 26
                        ? new Intent[]{new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkg), new Intent(Settings.ACTION_SECURITY_SETTINGS)}
                        : new Intent[]{new Intent(Settings.ACTION_SECURITY_SETTINGS)};
            case POLICY:
                return new Intent[]{new Intent(Settings.ACTION_SECURITY_SETTINGS)};
            case SECURITY:
                return new Intent[]{
                        new Intent().setClassName("com.google.android.gms", "com.google.android.gms.security.settings.VerifyAppsSettingsActivity"),
                        new Intent(Settings.ACTION_SECURITY_SETTINGS)};
            case STORAGE:
                return new Intent[]{new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS)};
            default:
                return new Intent[]{new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)};
        }
    }

    /** Opens the first of those screens this phone has, or the main Settings app. */
    static void open(Activity a, String reason) {
        for (Intent i : settings(a, reason)) {
            try {
                a.startActivity(i);
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // this phone doesn't have that screen: try the next one
            }
        }
        try {
            a.startActivity(new Intent(Settings.ACTION_SETTINGS));
        } catch (ActivityNotFoundException ignored) {
            // no Settings app at all: nothing more to offer
        }
    }
}
