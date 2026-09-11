package com.odiac22.pong;

import android.app.Activity;
import android.os.Bundle;
import android.net.Uri;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;

public class MainActivity extends Activity {
  private WebView web;
  private String observerPair;

  private boolean isPongHost(String host) {
    if (host == null) return false;
    String value = host.toLowerCase();
    return value.equals("odiac22.github.io") || value.equals("localhost") ||
      value.equals("127.0.0.1") || value.startsWith("192.168.") || value.startsWith("10.");
  }

  private String decoratePongUrl(String rawUrl) {
    try {
      Uri source = Uri.parse(rawUrl);
      if (!isPongHost(source.getHost())) return rawUrl;
      Uri.Builder builder = source.buildUpon();
      if (source.getQueryParameter("pongInstance") == null) {
        builder.appendQueryParameter("pongInstance", BuildConfig.INSTANCE);
      }
      String fragment = source.getFragment();
      if (observerPair != null && !observerPair.isEmpty() && (fragment == null || !fragment.contains("pongObserve="))) {
        builder.fragment((fragment == null || fragment.isEmpty() ? "" : fragment + "&") + "pongObserve=" + observerPair);
      }
      return builder.build().toString();
    } catch (Exception ignored) {
      return rawUrl;
    }
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    web = new WebView(this); setContentView(web);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(true); s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true);
    CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    observerPair = getString(R.string.observer_pair);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String original = request.getUrl().toString();
        String decorated = decoratePongUrl(original);
        if (!decorated.equals(original)) {
          view.loadUrl(decorated);
          return true;
        }
        return false;
      }

      @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        String decorated = decoratePongUrl(url);
        if (!decorated.equals(url)) {
          view.loadUrl(decorated);
          return true;
        }
        return false;
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    if (state == null) {
      web.loadUrl("https://odiac22.github.io/pong/?pongInstance=" + BuildConfig.INSTANCE + "#pongObserve=" + observerPair);
    } else web.restoreState(state);
  }
  @Override protected void onSaveInstanceState(Bundle out) { web.saveState(out); super.onSaveInstanceState(out); }
  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
