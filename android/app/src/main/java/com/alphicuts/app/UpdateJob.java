package com.alphicuts.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Every few hours, even with the app closed: is there a newer version? If so, say so once. */
public class UpdateJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            Updater.check(getApplicationContext(), true, false);
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // try again later
    }
}
