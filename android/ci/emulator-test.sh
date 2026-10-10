#!/usr/bin/env bash
# Runs inside the Android emulator on GitHub Actions (.github/workflows/android.yml).
#
#  1. The release build installs and opens the live website.
#  2. The debug build (same code, plus a test page) is handed a booking that starts in 100 s, with
#     "Check me in when I arrive" on. Then the app is closed (its process killed) and the screen
#     turned off. The heads-up must
#     arrive, then the alarm must ring full-screen over the lock screen, and "Stop alarm" must
#     silence it. Then the phone is moved to the test shop, and the app (still closed) must notice.
#  3. The app updates itself from a local server standing in for the website. First with
#     "Install unknown apps" off: the app must say so and "Open settings" must open that setting.
#     Once it's on, the update carries on by itself, and Android's installer replaces the app.
#  4. Sounds: the test page chooses the bell for "your turn" and the marimba for heads-ups (their
#     channels must carry the app's tones, and the alarm must ring on the new channel). At the end
#     the phone's sound list is opened from the app and a sound picked in it (OK), and the phone's
#     file picker is opened from the app and an audio file picked in it: each must become that
#     alert's sound.
#
# Screenshots, logs and results.txt go to ci-results/.
set -u
APKS="${1:-apks}"
OUT=ci-results
PKG=com.alphicuts.app
DBG=com.alphicuts.app.debug
mkdir -p "$OUT"
: > "$OUT/results.txt"
FAILED=0

# Every adb call has a time limit and is written to ci-results/adb-log.txt. If the emulator stops
# answering, the run stops within minutes and says which command hung, instead of sitting until the
# job's 35-minute limit cancels it with no results (two runs on 2026-10-07 hung after the install).
MAIN=$$
LIVE_SITE=0   # 1 during the last section (the live website in the app)
finish() {
  [ -n "${LOGCAT_PID:-}" ] && kill "$LOGCAT_PID" 2>/dev/null
  [ -f "$OUT/logcat-stream.txt" ] && tail -n 3000 "$OUT/logcat-stream.txt" > "$OUT/logcat-last.txt" && rm -f "$OUT/logcat-stream.txt"
  echo
  cat "$OUT/results.txt"
}
trap 'finish; exit 1' TERM
trap 'finish; exit $FAILED' USR1
adb() {
  local limit=150
  [ "${1:-}" = install ] && limit=300
  echo "$(date -u +%H:%M:%S) adb $*" >> "$OUT/adb-log.txt"
  timeout "$limit" adb "$@"   # `timeout` runs the real adb, not this function
  local rc=$?
  if [ "$rc" -eq 124 ] && [ "$LIVE_SITE" = 1 ]; then
    echo "NOTE: the emulator froze while the app showed the live website (adb $* took over $limit s). It draws the screen in software; phones don't. Every check above ran first. See logcat-last.txt." | tee -a "$OUT/results.txt"
    echo "::warning::The emulator froze on the live website: adb $*"
    kill -USR1 "$MAIN"
  elif [ "$rc" -eq 124 ]; then
    echo "FAIL: the emulator stopped answering (adb $* took over $limit s)" | tee -a "$OUT/results.txt"
    echo "::error::The emulator stopped answering: adb $*"
    kill -TERM "$MAIN"
  fi
  return "$rc"
}

pass() { echo "PASS: $1" | tee -a "$OUT/results.txt"; }
fail() { echo "FAIL: $1" | tee -a "$OUT/results.txt"; echo "::error::$1"; FAILED=1; }
# A screenshot that takes too long is only noted: it shouldn't stop the run. (`timeout` runs the real adb.)
shot() { timeout 60 adb exec-out screencap -p > "$OUT/$1.png" || echo "NOTE: screenshot $1 took too long" | tee -a "$OUT/results.txt"; }
notifications() { adb shell dumpsys notification --noredact; }
# wait_for SECONDS COMMAND...: retry every 2 s until COMMAND succeeds
wait_for() {
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
# seconds left until SECONDS reaches $1 (at least 5, so a slow step never skips a check)
left() { local n=$(($1 - SECONDS)); [ "$n" -lt 5 ] && n=5; echo "$n"; }
has_notification() { notifications | grep -qF "$1"; }
alarm_screen_up() { adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | grep -q "AlarmActivity"; }
ui_dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml; }
tap_text() {
  local bounds
  # Any capitalisation: some Android builds show buttons in capitals ("UPDATE").
  bounds=$(ui_dump | tr '>' '\n' | grep -iF "text=\"$1\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
  [ -n "$bounds" ] || return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | grep -oE '[0-9]+' | tr '\n' ' ')"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}
tap_desc() {
  local bounds
  bounds=$(ui_dump | tr '>' '\n' | grep -iF "content-desc=\"$1\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
  [ -n "$bounds" ] || return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | grep -oE '[0-9]+' | tr '\n' ' ')"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}
screen_has() { ui_dump | grep -qiF "$1"; }
# channel_sound CHANNEL TEXT: the live channel (not a deleted one) has a sound containing TEXT
channel_sound() { adb shell dumpsys notification --noredact | grep -E "mId='$1(_[0-9]+)?'" | grep -v "mDeleted=true" | grep -qF "mSound=$2"; }
focus_is() { adb shell dumpsys window | grep -E "mCurrentFocus" | grep -q "$1"; }

adb wait-for-device
adb root >/dev/null 2>&1
sleep 3
adb wait-for-device
adb shell settings put system screen_off_timeout 1800000
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
# A fresh emulator can take a while to get online; the site can't load before that.
dns_ok() { adb shell "ping -c 1 -W 2 alphi-cuts.pages.dev" 2>&1 | grep -q "^PING"; }
wait_for 180 dns_ok || echo "NOTE: the emulator still can't look up alphi-cuts.pages.dev" | tee -a "$OUT/results.txt"
adb logcat -c
timeout 2400 adb logcat -v threadtime > "$OUT/logcat-stream.txt" 2>&1 &
LOGCAT_PID=$!
# Which emulator this was: its Android build and its built-in browser (the app's web view).
{ adb shell getprop ro.build.fingerprint; adb shell getprop ro.product.model; adb shell dumpsys package com.google.android.webview | grep -m1 versionName; adb shell dumpsys package com.android.webview | grep -m1 versionName; } > "$OUT/device.txt" 2>&1

# ---------------------------------------------------------------- 0. the app's web view, on a plain page
# If the emulator stalls here too, the emulator itself is the problem, not the live site (a run on
# 2026-10-10 stalled two seconds after the release build opened the live site).
DEBUG=$(ls "$APKS"/debug/*.apk 2>/dev/null | head -1)
if [ -n "$DEBUG" ] && adb install -r "$DEBUG"; then
  adb shell am start -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/plain.html
  sleep 8
  if [ "$(adb shell echo alive | tr -d '\r')" = alive ]; then pass "the app's web view opens a plain page and the emulator keeps answering"; fi
  adb shell am force-stop "$DBG"
fi

# ---------------------------------------------------------------- 1. the release build installs
RELEASE=$(ls "$APKS"/release/*.apk 2>/dev/null | head -1)
if [ -n "$RELEASE" ] && adb install -r "$RELEASE"; then pass "release APK installs"; else fail "release APK did not install"; fi

# ---------------------------------------------------------------- 2. alarm rings with the app closed
DEBUG=$(ls "$APKS"/debug/*.apk 2>/dev/null | head -1)
if [ -n "$DEBUG" ] && adb install -r "$DEBUG"; then pass "debug APK installs"; else fail "debug APK did not install"; fi
adb shell pm grant "$DBG" android.permission.POST_NOTIFICATIONS
adb shell appops set "$DBG" USE_FULL_SCREEN_INTENT allow
adb shell dumpsys deviceidle whitelist +"$DBG" >/dev/null   # same as "allow background use"
# "Check me in when I arrive": location allowed all the time, and the phone starts 2 km from the test shop.
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION ACCESS_BACKGROUND_LOCATION; do adb shell pm grant "$DBG" android.permission.$p; done
adb shell cmd location set-location-enabled true >/dev/null 2>&1
adb emu geo fix 28.70 -15.33 >/dev/null 2>&1

adb shell am start -W -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/bridge-test.html
T0=$SECONDS
sleep 6
shot 02-bridge-test

adb shell dumpsys alarm > "$OUT/alarms.txt"
grep -qF "com.alphicuts.app.DUE" "$OUT/alarms.txt" && pass "slot alarm is set" || fail "slot alarm was not set"
grep -qF "com.alphicuts.app.REMINDER" "$OUT/alarms.txt" && pass "heads-up alarm is set" || fail "heads-up alarm was not set"
adb shell dumpsys activity services "$DBG" > "$OUT/services.txt"
grep -qF "WatchService" "$OUT/services.txt" && pass "booking watcher is running" || fail "booking watcher is not running"

# Sounds chosen in the app (the test page picked the bell and the marimba): each alert moves to a
# fresh channel that carries the app's own tone.
adb shell dumpsys notification --noredact > "$OUT/channels.txt"
if grep -E "mId='booking_alarm_1'" "$OUT/channels.txt" | grep -qF "mSound=android.resource://$DBG/"; then
  pass "the alarm's sound can be chosen in the app"
else
  fail "choosing the alarm's sound in the app did not change it"
fi
if grep -E "mId='booking_updates_1'" "$OUT/channels.txt" | grep -qF "mSound=android.resource://$DBG/"; then
  pass "the heads-up's sound can be chosen in the app"
else
  fail "choosing the heads-up's sound in the app did not change it"
fi


# Close the app completely: leave it, then kill its process. Alarms live in the system, not the app.
adb shell input keyevent KEYCODE_HOME
sleep 2
PID=$(adb shell pidof "$DBG" | tr -d '\r' | awk '{print $1}')
if [ -n "$PID" ]; then
  # The debug build can kill its own process (run-as needs no root); root is the fallback.
  adb shell run-as "$DBG" kill -9 "$PID" 2>/dev/null || adb shell kill -9 "$PID" 2>/dev/null
fi
sleep 1
NEWPID=$(adb shell pidof "$DBG" | tr -d '\r' | awk '{print $1}')
echo "app process before: ${PID:-none}, after: ${NEWPID:-none}" | tee -a "$OUT/results.txt"
if [ -n "$PID" ] && [ "$NEWPID" != "$PID" ]; then pass "app process was killed"; else fail "could not kill the app process"; fi
adb shell input keyevent KEYCODE_SLEEP

# Heads-up about 40 s after the booking was made (1 minute before the slot).
if wait_for "$(left $((T0 + 80)))" has_notification "Your cut at Test Cuts starts in 1 minute"; then
  pass "heads-up notification arrived with the app closed"
else
  fail "heads-up notification did not arrive"
fi
notifications > "$OUT/notifications-reminder.txt"

# The slot starts 100 s after the booking was made.
if wait_for "$(left $((T0 + 150)))" has_notification "It's your turn at Test Cuts"; then
  pass "slot alarm fired with the app closed"
else
  fail "slot alarm did not fire"
fi
sleep 4
notifications > "$OUT/notifications-alarm.txt"
shot 03-alarm-lock-screen
if grep -qE "fullscreenIntent=PendingIntent" "$OUT/notifications-alarm.txt"; then pass "alarm uses a full-screen alert"; else fail "alarm has no full-screen alert"; fi
if grep -qF "booking_alarm_1" "$OUT/notifications-alarm.txt"; then pass "the alarm rings with the sound chosen in the app"; else fail "the alarm did not use the chosen sound"; fi
if wait_for 20 alarm_screen_up; then pass "alarm screen shows over the lock screen"; else fail "alarm screen did not show"; fi

if tap_text "Stop alarm"; then
  sleep 3
  if has_notification "It's your turn at Test Cuts"; then fail "Stop alarm did not silence the alarm"; else pass "Stop alarm silences the alarm"; fi
else
  fail "could not find the Stop alarm button"
fi
shot 04-after-stop

# The client walks into the shop with the app closed (the alarm started the booking watcher again in
# a new process): the watcher must notice from the phone's location. The test database address
# doesn't exist, so the check-in itself then fails quietly.
adb shell input keyevent KEYCODE_HOME
arrived() { adb emu geo fix 28.68 -15.33 >/dev/null 2>&1; adb logcat -d -s AlPhiCuts:V | grep -qF "Arrived at the shop"; }
if wait_for 90 arrived; then pass "arriving at the shop is noticed with the app closed"; else fail "arriving at the shop was not noticed"; fi
adb logcat -d -s AlPhiCuts:V | grep -E "Arrived|Arrival|location" | tail -6 >> "$OUT/results.txt"

# ---------------------------------------------------------------- 3. the app updates itself
# A local server stands in for the website: it offers "version 9.9.9" (really this same debug build).
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb logcat -d -s AlPhiCuts:V > "$OUT/alarm-log.txt"
UPD=$(mktemp -d)
mkdir -p "$UPD/app"
cp "$DEBUG" "$UPD/app/alphi-cuts.apk"
printf '{"versionName":"9.9.9","versionCode":99,"size":%s,"sha256":"%s"}\n' \
  "$(stat -c %s "$UPD/app/alphi-cuts.apk")" "$(sha256sum "$UPD/app/alphi-cuts.apk" | cut -d' ' -f1)" > "$UPD/app/android.json"
python3 -m http.server 8000 --directory "$UPD" >/dev/null 2>&1 &
SERVER=$!
sleep 2
# Like a phone where "Install unknown apps" is still off for the app.
adb shell am force-stop "$DBG"
adb shell appops set "$DBG" REQUEST_INSTALL_PACKAGES deny
before_update=$(adb shell dumpsys package "$DBG" | grep -m1 lastUpdateTime | tr -d '\r')
adb logcat -c
adb shell am start -W -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/update-test.html \
  --es updateBase http://10.0.2.2:8000/ --ez autoUpdate true >/dev/null
if wait_for 40 screen_has "Allow updates from AlPhi Cuts"; then pass "a blocked install says why"; else fail "no explanation when installs are blocked"; fi
shot 05-update-blocked
if tap_text "Open settings"; then
  if wait_for 15 focus_is "com.android.settings"; then pass "Open settings opens the setting that allows installs"; else fail "Open settings did not open Settings"; fi
  sleep 2
  shot 06-install-setting
else
  fail "could not find the Open settings button"
fi
# Turn the setting on, as the person would, and come back: the update carries on by itself.
adb shell appops set "$DBG" REQUEST_INSTALL_PACKAGES allow
adb shell input keyevent KEYCODE_BACK
handed() { adb logcat -d -s AlPhiCuts:V | grep -qF "Update handed to the installer"; }
if wait_for 60 handed; then
  pass "the update carries on once allowed, matches the published file and goes to the installer"
else
  fail "update did not reach the installer"
  adb logcat -d -s AlPhiCuts:V | tail -20 >> "$OUT/results.txt"
fi
sleep 3
shot 07-update-confirm
if wait_for 20 tap_text "Update"; then
  updated() { [ "$(adb shell dumpsys package "$DBG" | grep -m1 lastUpdateTime | tr -d '\r')" != "$before_update" ]; }
  if wait_for 60 updated; then pass "Android's installer updates the app"; else fail "the app was not replaced"; fi
else
  fail "could not find the installer's Update button"
fi
shot 08-after-update
adb logcat -d -s AlPhiCuts:V > "$OUT/update-log.txt"
kill "$SERVER" 2>/dev/null

# ---------------------------------------------------------------- 4. sounds opened from the app itself
# (a) "Phone's sounds": Android's sound list opens in the app; a sound picked there, with OK, becomes
#     the booking updates' sound.
adb shell am start -W -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/sound-test.html >/dev/null
picker_up() { adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | grep -qiE "RingtonePicker|soundpicker"; }
if wait_for 30 picker_up; then
  pass "the phone's sound list opens in the app"
  sleep 2
  shot 09-sound-picker
  # The first sound in the list that isn't "Default ...".
  sound=$(ui_dump | tr '>' '\n' | grep -E 'CheckedTextView|android:id/text1' | grep -oE 'text="[^"]+"' | sed 's/^text="//; s/"$//' | grep -viE '^(default|none|silent)' | head -1)
  echo "sound list pick: ${sound:-none}" >> "$OUT/adb-log.txt"
  if [ -n "$sound" ] && tap_text "$sound" && sleep 1 && tap_text "OK"; then
    if wait_for 20 channel_sound booking_updates "content://media"; then
      pass "a sound picked from the phone's list becomes the booking updates' sound ($sound)"
    else
      fail "the sound picked from the phone's list was not used"
    fi
  else
    fail "couldn't pick a sound in the phone's list"
    adb shell input keyevent KEYCODE_BACK
  fi
else
  fail "the phone's sound list did not open in the app"
fi

# (b) "My own file": the phone's file picker opens in the app; an audio file picked there is saved
#     among the phone's sounds and becomes the messages' sound.
adb push android/app/src/main/res/raw/tone_bell_short.wav /sdcard/Download/ci-own-tone.wav >/dev/null
adb shell am start -W -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/file-test.html >/dev/null
files_up() { adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | grep -qiE "documentsui|DocumentsActivity|PickActivity"; }
pick_file() { tap_text "ci-own-tone.wav"; }
if wait_for 30 files_up; then
  pass "the phone's file picker opens in the app"
  sleep 3
  shot 10-file-picker
  if ! wait_for 8 pick_file; then
    # Not in Recent: open the list of places and go to Downloads.
    tap_desc "Show roots" || tap_desc "Navigate up"
    sleep 2
    tap_text "Downloads" || tap_text "Download"
    sleep 3
    wait_for 15 pick_file
  fi
  if wait_for 30 channel_sound messages "content://media"; then
    pass "an audio file picked in the app becomes the messages' sound"
  else
    fail "the audio file picked in the app was not used"
    shot 11-file-picker-after
  fi
  if adb shell ls "/sdcard/Notifications/AlPhi Cuts/" 2>/dev/null | grep -qF "ci-own-tone"; then
    pass "the file is saved among the phone's sounds (Notifications/AlPhi Cuts)"
  else
    fail "the file was not saved among the phone's sounds"
  fi
else
  fail "the phone's file picker did not open in the app"
fi
adb shell am force-stop "$DBG"

adb logcat -d -b crash > "$OUT/crashes.txt" 2>/dev/null
if grep -qF "alphicuts" "$OUT/crashes.txt"; then fail "the app crashed (see crashes.txt)"; else pass "no crashes"; fi
adb logcat -d | grep -iE "alphicuts|AndroidRuntime" | tail -400 > "$OUT/logcat.txt"

# ---------------------------------------------------------------- 5. the live website in the app (last)
# Last, because the emulator has frozen here since 2026-10-07 (it draws the screen in software) and
# nothing can run after a freeze. A freeze here is noted; a page that does not load still fails.
LIVE_SITE=1
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
# Started without -W: the check below waits for the page itself, not for the first frame.
adb shell am start -n "$PKG/.MainActivity"
# The first load on a fresh emulator can be slow: wait for the site (or the offline page).
release_loaded() { adb logcat -d -s AlPhiCuts:V | grep -qE "Loaded https://alphi-cuts.pages.dev/|offline page"; }
wait_for 90 release_loaded
sleep 3
if adb shell dumpsys window | grep -E "mCurrentFocus" | grep -q "$PKG/"; then pass "app opens and stays open"; else fail "app did not stay open"; fi
adb logcat -d -s AlPhiCuts:V > "$OUT/release-log.txt"
# What the emulator is busy with while the live site is open (two runs hung here on 2026-10-07).
timeout 30 adb shell top -b -n 1 -m 12 > "$OUT/top-release.txt" 2>&1
shot 01-release-home
if grep -qF "Loaded https://alphi-cuts.pages.dev/" "$OUT/release-log.txt" && ! grep -qF "offline page" "$OUT/release-log.txt"; then
  pass "live website shows inside the app"
else
  fail "live website did not show inside the app"
fi
adb shell input keyevent KEYCODE_HOME
adb shell am force-stop "$PKG"   # frees its memory for the rest of the test

LIVE_SITE=0
finish
exit $FAILED
