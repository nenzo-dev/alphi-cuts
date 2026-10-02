package com.alphicuts.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The phone forgets every alarm when it restarts (and when the clock changes): set them again, and
 * keep the background update check going. After the app itself was updated, an "update ready"
 * notice or an old install block no longer applies.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        Scheduler.scheduleAll(c);
        Updater.schedule(c);
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            Notifier.cancelUpdate(c);
            Store.remove(c, "installBlocked");
            Store.putInt(c, "resumeUpdate", 0);
        }
    }
}
