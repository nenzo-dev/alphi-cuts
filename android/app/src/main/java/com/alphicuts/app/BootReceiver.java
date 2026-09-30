package com.alphicuts.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The phone forgets every alarm when it restarts (and when the clock changes): set them again. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Scheduler.scheduleAll(context.getApplicationContext());
    }
}
