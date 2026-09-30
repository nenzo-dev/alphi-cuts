package com.alphicuts.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Calls the same public database functions the website uses, for when the app is closed. */
final class Api {
    private Api() {}

    /** Only the shop's own Supabase project, over HTTPS. */
    static boolean isAllowedBase(String url) {
        return url != null && url.matches("https://[a-z0-9-]+\\.supabase\\.co");
    }

    private static String call(JSONObject sync, String fn, JSONObject body) throws Exception {
        JSONObject api = sync.getJSONObject("api");
        String base = api.getString("url");
        String key = api.getString("key");
        if (!isAllowedBase(base)) throw new IOException("unexpected server");
        HttpURLConnection con = (HttpURLConnection) new URL(base + "/rest/v1/rpc/" + fn).openConnection();
        try {
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("apikey", key);
            con.setRequestProperty("Authorization", "Bearer " + key);
            con.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = con.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            InputStream in = code >= 400 ? con.getErrorStream() : con.getInputStream();
            String text = read(in);
            if (code >= 400) throw new IOException("HTTP " + code);
            return text;
        } finally {
            con.disconnect();
        }
    }

    static JSONArray array(JSONObject sync, String fn, JSONObject body) throws Exception {
        String text = call(sync, fn, body).trim();
        return text.isEmpty() ? new JSONArray() : new JSONArray(text);
    }

    static void checkIn(Context c, String token) throws Exception {
        JSONObject sync = Store.sync(c);
        if (sync == null) throw new IOException("no booking data");
        call(sync, "check_in", new JSONObject().put("p_token", token));
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream s = in; ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            int n;
            while ((n = s.read(chunk)) != -1) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }
}
