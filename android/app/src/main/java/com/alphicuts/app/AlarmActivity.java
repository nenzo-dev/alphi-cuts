package com.alphicuts.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/** The "It's your turn" screen. Shows over the lock screen and turns the screen on. */
public class AlarmActivity extends Activity {
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_TIME = "time";

    private static WeakReference<AlarmActivity> current = new WeakReference<>(null);
    private String token;
    private TextView titleView;
    private TextView timeView;
    private TextView textView;

    /** Closes the screen if it's showing this booking (called when the alarm is handled elsewhere). */
    static void closeFor(String token) {
        AlarmActivity a = current.get();
        if (a != null && token != null && token.equals(a.token)) a.runOnUiThread(a::finish);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildView());
        bind(getIntent());
        current = new WeakReference<>(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    private void bind(Intent i) {
        token = i.getStringExtra(AlarmReceiver.EXTRA_TOKEN);
        String title = i.getStringExtra(EXTRA_TITLE);
        titleView.setText(title == null ? "It's your turn" : title);
        timeView.setText(i.getStringExtra(EXTRA_TIME));
        textView.setText(i.getStringExtra(EXTRA_TEXT));
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(primary ? 0xFF171512 : 0xFFF3EFE6);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        if (primary) bg.setColor(0xFFD4AF37);
        else {
            bg.setColor(0x00000000);
            bg.setStroke(dp(1), 0xFF6B6255);
        }
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private View buildView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF171512);
        root.setPadding(dp(28), dp(28), dp(28), dp(28));

        titleView = new TextView(this);
        titleView.setTextColor(0xFFE8C866);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setGravity(Gravity.CENTER);

        timeView = new TextView(this);
        timeView.setTextColor(0xFFF3EFE6);
        timeView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 52);
        timeView.setTypeface(Typeface.DEFAULT_BOLD);
        timeView.setGravity(Gravity.CENTER);
        timeView.setPadding(0, dp(8), 0, dp(8));

        textView = new TextView(this);
        textView.setTextColor(0xFFB8AD9A);
        textView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        textView.setGravity(Gravity.CENTER);
        textView.setPadding(0, 0, 0, dp(24));

        Button here = button("I'm here", true);
        here.setOnClickListener(v -> send(AlarmReceiver.ACTION_CHECK_IN));
        Button stop = button("Stop alarm", false);
        stop.setOnClickListener(v -> send(AlarmReceiver.ACTION_STOP));
        Button open = button("Open the app", false);
        open.setOnClickListener(v -> {
            send(AlarmReceiver.ACTION_STOP);
            startActivity(new Intent(this, MainActivity.class)
                    .putExtra(MainActivity.EXTRA_OPEN, "book")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        });

        root.addView(titleView);
        root.addView(timeView);
        root.addView(textView);
        root.addView(here);
        root.addView(stop);
        root.addView(open);
        return root;
    }

    private void send(String action) {
        if (token != null) {
            sendBroadcast(new Intent(this, AlarmReceiver.class)
                    .setAction(action)
                    .putExtra(AlarmReceiver.EXTRA_TOKEN, token));
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        super.onDestroy();
    }
}
