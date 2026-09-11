package com.odiac22.pong;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.util.Base64;
import android.view.View;
import android.view.PixelCopy;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
  private WebView web;
  private String observerPair;
  private String deviceId;
  private final Handler observerHandler = new Handler(Looper.getMainLooper());
  private final Runnable captureRunnable = new Runnable() {
    @Override public void run() {
      captureObserverFrame();
      observerHandler.postDelayed(this, 10_000);
    }
  };

  static boolean isPongUrl(Uri url) {
    String host = url.getHost();
    String scheme = url.getScheme();
    String path = url.getPath();
    if (host == null || scheme == null || !("/pong".equals(path) || "/pong/".equals(path) || "/pong/index.html".equals(path))) return false;
    host = host.toLowerCase(Locale.ROOT);
    if (host.equals("odiac22.github.io")) return scheme.equals("https") && (url.getPort() == -1 || url.getPort() == 443);
    if (!scheme.equals("http") && !scheme.equals("https")) return false;
    if (host.equals("localhost") || host.equals("127.0.0.1")) return true;
    String[] parts = host.split("\\.");
    if (parts.length != 4) return false;
    int[] octets = new int[4];
    for (int i = 0; i < 4; i++) {
      if (!parts[i].matches("[0-9]{1,3}")) return false;
      octets[i] = Integer.parseInt(parts[i]);
      if (octets[i] > 255) return false;
    }
    return octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) ||
      (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
  }

  // Preserve encoded values verbatim. Decoding a whole fragment corrupts embedded URLs.
  static String replaceParameter(String encoded, String name, String value) {
    StringBuilder result = new StringBuilder();
    if (encoded != null && !encoded.isEmpty()) {
      for (String part : encoded.split("&")) {
        String key = part.split("=", 2)[0];
        if (Uri.decode(key).equals(name)) continue;
        if (result.length() > 0) result.append('&');
        result.append(part);
      }
    }
    if (result.length() > 0) result.append('&');
    return result.append(name).append('=').append(Uri.encode(value)).toString();
  }

  private String decoratePongUrl(String rawUrl) {
    try {
      Uri source = Uri.parse(rawUrl);
      if (!isPongUrl(source)) return rawUrl;
      Uri.Builder builder = source.buildUpon().encodedQuery(replaceParameter(source.getEncodedQuery(), "pongInstance", BuildConfig.INSTANCE));
      if (observerPair != null && !observerPair.isEmpty()) {
        builder.encodedFragment(replaceParameter(source.getEncodedFragment(), "pongObserve", observerPair));
      }
      return builder.build().toString();
    } catch (Exception ignored) { return rawUrl; }
  }

  private void connectObserver() {
    if (web == null || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) return;
    try {
      JSONObject client = new JSONObject();
      client.put("instance", BuildConfig.INSTANCE);
      client.put("deviceId", deviceId);
      client.put("version", BuildConfig.VERSION_NAME);
      // No JavaScript interface is exposed to third-party pages. Repair pairing after
      // history restoration and origin handoffs even when a fragment was consumed.
      web.evaluateJavascript("window.PongLiveObserver && window.PongLiveObserver.configure(" + JSONObject.quote(observerPair) + "," + client + ")", null);
      observerHandler.removeCallbacks(captureRunnable);
      observerHandler.postDelayed(captureRunnable, 1_500);
    } catch (Exception ignored) {}
  }

  private void deliverObserverFrame(Bitmap full) {
    Bitmap scaled = null;
    try {
      int width = Math.min(360, full.getWidth());
      int height = Math.max(1, Math.round(full.getHeight() * (width / (float) full.getWidth())));
      scaled = Bitmap.createScaledBitmap(full, width, height, true);
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      scaled.compress(Bitmap.CompressFormat.JPEG, 42, output);
      String encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
      web.evaluateJavascript("window.PongLiveObserver && window.PongLiveObserver.frame(" + JSONObject.quote(encoded) + "," + width + "," + height + ")", null);
    } catch (Exception ignored) {
    } finally {
      if (scaled != null && scaled != full) scaled.recycle();
      full.recycle();
    }
  }

  private void captureObserverFrame() {
    if (web == null || web.getWidth() < 1 || web.getHeight() < 1 || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) return;
    Bitmap full = Bitmap.createBitmap(web.getWidth(), web.getHeight(), Bitmap.Config.RGB_565);
    if (Build.VERSION.SDK_INT >= 26) {
      PixelCopy.request(getWindow(), full, result -> {
        if (result == PixelCopy.SUCCESS) deliverObserverFrame(full); else full.recycle();
      }, observerHandler);
      return;
    }
    web.draw(new Canvas(full));
    deliverObserverFrame(full);
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    observerPair = getString(R.string.observer_pair);
    deviceId = getPreferences(MODE_PRIVATE).getString("observer-device", "");
    if (deviceId.isEmpty()) {
      deviceId = UUID.randomUUID().toString();
      getPreferences(MODE_PRIVATE).edit().putString("observer-device", deviceId).apply();
    }
    web = new WebView(this); setContentView(web);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(true); s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true);
    CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String original = request.getUrl().toString();
        String decorated = decoratePongUrl(original);
        if (decorated.equals(original)) return false;
        view.post(() -> view.loadUrl(decorated));
        return true;
      }
      @Override public void onPageFinished(WebView view, String url) { connectObserver(); }
    });
    web.setWebChromeClient(new WebChromeClient());
    if (state == null || web.restoreState(state) == null) {
      web.loadUrl(decoratePongUrl("https://odiac22.github.io/pong/"));
    }
  }
  @Override protected void onResume() { super.onResume(); if (web != null) { web.onResume(); connectObserver(); } }
  @Override protected void onPause() {
    observerHandler.removeCallbacks(captureRunnable);
    if (web != null) {
      web.evaluateJavascript("document.querySelectorAll('video,audio').forEach(v=>v.pause());window.PongLiveObserver && window.PongLiveObserver.send()", null);
      web.onPause();
    }
    super.onPause();
  }
  @Override protected void onSaveInstanceState(Bundle out) { web.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
