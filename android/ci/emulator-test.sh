#!/usr/bin/env bash
# Runs inside the Android emulator on GitHub Actions (.github/workflows/android.yml).
#
#  1. The release build installs and opens the live website.
#  2. The debug build (same code, plus a test page) is handed a booking that starts in 100 s.
#     Then the app is closed (its process killed) and the screen turned off. The heads-up must
#     arrive, then the alarm must ring full-screen over the lock screen, and "Stop alarm" must
#     silence it.
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

pass() { echo "PASS: $1" | tee -a "$OUT/results.txt"; }
fail() { echo "FAIL: $1" | tee -a "$OUT/results.txt"; echo "::error::$1"; FAILED=1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
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
  bounds=$(ui_dump | tr '>' '\n' | grep -F "text=\"$1\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
  [ -n "$bounds" ] || return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | grep -oE '[0-9]+' | tr '\n' ' ')"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

adb wait-for-device
adb root >/dev/null 2>&1
sleep 3
adb wait-for-device
adb shell settings put system screen_off_timeout 1800000
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard

# ---------------------------------------------------------------- 1. release build opens the site
RELEASE=$(ls "$APKS"/release/*.apk 2>/dev/null | head -1)
if [ -n "$RELEASE" ] && adb install -r "$RELEASE"; then pass "release APK installs"; else fail "release APK did not install"; fi
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
adb shell am start -W -n "$PKG/.MainActivity"
sleep 25
shot 01-release-home
if adb shell dumpsys window | grep -E "mCurrentFocus" | grep -q "$PKG/"; then pass "app opens and stays open"; else fail "app did not stay open"; fi
ui_dump > "$OUT/release-ui.xml"
if grep -qF "Book" "$OUT/release-ui.xml" && ! grep -qF "ran into an error" "$OUT/release-ui.xml"; then
  pass "live website shows inside the app"
else
  fail "live website did not show inside the app"
fi
adb shell input keyevent KEYCODE_HOME

# ---------------------------------------------------------------- 2. alarm rings with the app closed
DEBUG=$(ls "$APKS"/debug/*.apk 2>/dev/null | head -1)
if [ -n "$DEBUG" ] && adb install -r "$DEBUG"; then pass "debug APK installs"; else fail "debug APK did not install"; fi
adb shell pm grant "$DBG" android.permission.POST_NOTIFICATIONS
adb shell appops set "$DBG" USE_FULL_SCREEN_INTENT allow
adb shell dumpsys deviceidle whitelist +"$DBG" >/dev/null   # same as "allow background use"

adb shell am start -W -n "$DBG/com.alphicuts.app.MainActivity" --es testUrl file:///android_asset/test/bridge-test.html
T0=$SECONDS
sleep 6
shot 02-bridge-test

adb shell dumpsys alarm > "$OUT/alarms.txt"
grep -qF "com.alphicuts.app.DUE" "$OUT/alarms.txt" && pass "slot alarm is set" || fail "slot alarm was not set"
grep -qF "com.alphicuts.app.REMINDER" "$OUT/alarms.txt" && pass "heads-up alarm is set" || fail "heads-up alarm was not set"
adb shell dumpsys activity services "$DBG" > "$OUT/services.txt"
grep -qF "WatchService" "$OUT/services.txt" && pass "booking watcher is running" || fail "booking watcher is not running"

# Close the app completely: leave it, then kill its process. Alarms live in the system, not the app.
adb shell input keyevent KEYCODE_HOME
sleep 2
PID=$(adb shell pidof "$DBG" | tr -d '\r')
if [ -n "$PID" ]; then adb shell kill -9 "$PID"; fi
sleep 1
NEWPID=$(adb shell pidof "$DBG" | tr -d '\r')
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
if wait_for 20 alarm_screen_up; then pass "alarm screen shows over the lock screen"; else fail "alarm screen did not show"; fi

if tap_text "Stop alarm"; then
  sleep 3
  if has_notification "It's your turn at Test Cuts"; then fail "Stop alarm did not silence the alarm"; else pass "Stop alarm silences the alarm"; fi
else
  fail "could not find the Stop alarm button"
fi
shot 04-after-stop

adb logcat -d -b crash > "$OUT/crashes.txt" 2>/dev/null
if grep -qF "alphicuts" "$OUT/crashes.txt"; then fail "the app crashed (see crashes.txt)"; else pass "no crashes"; fi
adb logcat -d | grep -iE "alphicuts|AndroidRuntime" | tail -400 > "$OUT/logcat.txt"

echo
cat "$OUT/results.txt"
exit $FAILED
