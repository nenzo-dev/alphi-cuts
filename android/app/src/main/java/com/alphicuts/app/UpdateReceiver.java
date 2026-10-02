package com.alphicuts.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/**
 * What Android's installer says about an update: show its "Update this app?" screen, explain a block
 * that a setting can lift (InstallBlock), or report that it didn't work.
 */
public class UpdateReceiver extends BroadcastReceiver {
    private static final String TAG = "AlPhiCuts";

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        MainActivity m = MainActivity.current();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (MainActivity.isVisible()) {
                c.startActivity(confirm);
                if (m != null) m.updateProgress("confirm", 100);
            } else {
                Notifier.updateReady(c, confirm); // the person left the app while it downloaded
                if (m != null) m.updateProgress("idle", 0);
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            Log.i(TAG, "Update installed");
            return;
        }
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.w(TAG, "Update not installed: " + status + " " + message);
        String reason = InstallBlock.fromStatus(status);
        if (reason.isEmpty() && message != null && message.contains("INSUFFICIENT_STORAGE")) reason = InstallBlock.STORAGE;
        if (!reason.isEmpty()) {
            final String r = reason;
            if (m != null) m.runOnUiThread(() -> m.showInstallBlock(r));
            else Store.putString(c, "installBlocked", r); // shown when the app is next opened
        } else if (m != null) {
            m.updateProgress(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "idle" : "error", 0);
        }
    }
}
