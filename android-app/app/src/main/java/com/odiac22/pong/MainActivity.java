package com.odiac22.pong;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.RenderProcessGoneDetail;
import android.content.SharedPreferences;
import android.content.Intent;
import android.widget.FrameLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {
  // Both locally validated and release APKs use the live LAN Pong endpoint.
  // A deliberate deep link can still override it for isolated emulator tests.
  private static final String DEFAULT_PONG_URL = "http://192.168.1.124:8787/pong";
  private static final String TIKTOK_HOME_URL = "https://www.tiktok.com/foryou";
  private FrameLayout root;
  private WebView web;
  private WebView tiktokWeb;
  private String currentTikTokUrl = "";
  private final List<String> nearbyTikTokUrls = new ArrayList<>();
  private final Map<String, String> integratedSwapStreams = new ConcurrentHashMap<>();
  private boolean tiktokVisible = false;
  private boolean tiktokSwapEnabled = false;
  private int tiktokSwapGeneration = 0;
  private String tiktokObservedFaceKey = "";
  private final Handler tiktokSwapHandler = new Handler(Looper.getMainLooper());
  private final Handler tiktokLayoutHandler = new Handler(Looper.getMainLooper());
  private final Handler tiktokFaceHandler = new Handler(Looper.getMainLooper());
  private final Runnable tiktokSwapPoller = new Runnable() {
    @Override public void run() {
      pollTikTokIntegratedSwap();
    }
  };
  private final Runnable tiktokLayoutPoller = new Runnable() {
    @Override public void run() {
      syncTikTokPlayerBounds();
    }
  };
  private final Runnable tiktokFacePoller = new Runnable() {
    @Override public void run() {
      pollPongFaceSelectionForTikTok();
    }
  };
  private String observerPair;
  private String deviceId;
  private String activityInstanceId;
  private SharedPreferences appState;
  private int webGeneration = 0;
  private int lifecycleSequence = 0;
  private boolean recoveringRenderer = false;
  private boolean nativeForeground = false;

  private void ensureRoot() {
    if (root != null) return;
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    setContentView(root);
  }

  private void configureAndLoadWebView(String initialUrl) {
    webGeneration += 1;
    web = new WebView(this);
    ensureRoot();
    // Pong is the normal full-screen surface. TikTok mode temporarily brings
    // only its bounded player viewport in front of this WebView.
    root.addView(web, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    if (Build.VERSION.SDK_INT >= 26) {
      web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    // Wireless/USB debugging is the operator's private diagnostic channel for
    // the release APKs as well. It exposes no in-page bridge and is reachable
    // only through an already-authorized Android debugging connection.
    WebView.setWebContentsDebuggingEnabled(true);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    // Pong owns audible playback through its persisted speaker control and
    // active/visible-frame gate. Swap audio is a synchronized companion stream
    // started after asynchronous GPU preparation, so WebView's per-start
    // gesture requirement would permanently reject it even after the user had
    // explicitly enabled audio. Let the page enforce the stricter ownership
    // policy instead of Android blocking valid ordinary/resumed/swap playback.
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setJavaScriptCanOpenWindowsAutomatically(false);
    s.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String original = request.getUrl().toString();
        if ("pong-native".equalsIgnoreCase(request.getUrl().getScheme())) {
          if ("tiktok".equalsIgnoreCase(request.getUrl().getHost())) openTikTokMode();
          return true;
        }
        String decorated = decoratePongUrl(original);
        if (decorated.equals(original)) return false;
        view.post(() -> view.loadUrl(decorated));
        return true;
      }
      @Override public void onPageFinished(WebView view, String url) {
        String decorated = decoratePongUrl(url);
        if (!decorated.equals(url)) {
          view.loadUrl(decorated);
          return;
        }
        rememberPongUrl(url);
        connectObserver();
        emitNativeLifecycle(recoveringRenderer ? "renderer-recovered" : "webview-ready");
        recoveringRenderer = false;
      }
      @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        final String recoveryUrl = resumablePongUrl(view.getUrl());
        rememberPongUrl(recoveryUrl);
        recoveringRenderer = true;
        lifecycleSequence += 1;
        view.post(() -> {
          if (web != view || isFinishing() || isDestroyed()) return;
          try {
            if (root != null) root.removeView(view);
            view.destroy();
          } catch (Exception ignored) {}
          configureAndLoadWebView(recoveryUrl);
        });
        // The page session is authoritative in localStorage. Recover the
        // renderer instead of allowing Android to terminate the whole APK.
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    web.loadUrl(resumablePongUrl(initialUrl));
  }

  private static boolean isTikTokPageUrl(String rawUrl) {
    try {
      Uri url = Uri.parse(rawUrl);
      String host = url.getHost();
      String path = url.getPath();
      return "https".equalsIgnoreCase(url.getScheme()) && host != null && path != null &&
        (host.equalsIgnoreCase("tiktok.com") || host.toLowerCase(Locale.ROOT).endsWith(".tiktok.com")) &&
        path.matches("/@[^/]+/video/[0-9]+/?");
    } catch (Exception ignored) {
      return false;
    }
  }

  private void updateTikTokStatus(String message) {
    // TikTok has no separate native control/status panel. Its own website UI
    // and Pong's existing controls are the only visible interfaces.
  }

  private void syncTikTokPlayerBounds() {
    if (!tiktokVisible || web == null || tiktokWeb == null || root == null) return;
    web.evaluateJavascript(
      "(()=>{try{const e=document.getElementById('video-container');if(!e)return '';const r=e.getBoundingClientRect(),w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);return JSON.stringify({x:r.left/w,y:r.top/h,w:r.width/w,h:r.height/h})}catch(e){return ''}})()",
      raw -> {
        if (!tiktokVisible || tiktokWeb == null || root == null) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject bounds = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          int rootWidth = Math.max(1, root.getWidth());
          int rootHeight = Math.max(1, root.getHeight());
          int left = Math.min(rootWidth - 1,
            Math.max(0, (int) Math.round(bounds.optDouble("x", 0) * rootWidth)));
          int top = Math.min(rootHeight - 1,
            Math.max(0, (int) Math.round(bounds.optDouble("y", 0) * rootHeight)));
          int width = Math.max(1, Math.min(rootWidth - left,
            Math.max(1, (int) Math.round(bounds.optDouble("w", 1) * rootWidth))));
          int height = Math.max(1, Math.min(rootHeight - top,
            Math.max(1, (int) Math.round(bounds.optDouble("h", 1) * rootHeight))));
          FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(width, height);
          params.leftMargin = left;
          params.topMargin = top;
          tiktokWeb.setLayoutParams(params);
          tiktokWeb.setAlpha(1f);
          tiktokWeb.setVisibility(View.VISIBLE);
          tiktokWeb.bringToFront();
        } catch (Exception ignored) {}
        if (tiktokVisible) tiktokLayoutHandler.postDelayed(tiktokLayoutPoller, 750);
      }
    );
  }

  private String tiktokObserverScript() {
    return "javascript:(()=>{try{" +
      "if(window.__pongTikTokObserverInstalled){window.__pongTikTokScan&&window.__pongTikTokScan();return;}" +
      "window.__pongTikTokObserverInstalled=true;let last='';" +
      "const canonical=u=>{try{const x=new URL(u,location.href);return /(^|\\.)tiktok\\.com$/i.test(x.hostname)&&/^\\/@[^/]+\\/video\\/\\d+\\/?$/i.test(x.pathname)?x.origin+x.pathname:''}catch(e){return''}};" +
      "const score=a=>{const r=a.getBoundingClientRect(),h=Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)),w=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left));return h*w};" +
      "const reactId=el=>{try{const roots=Object.getOwnPropertyNames(el).filter(k=>k.startsWith('__react')).map(k=>el[k]),seen=new WeakSet(),q=roots.map(x=>[x,0]);while(q.length){const [x,d]=q.shift();if(!x||typeof x!=='object'||seen.has(x)||d>7)continue;seen.add(x);for(const k of Object.keys(x).slice(0,100)){let v;try{v=x[k]}catch(e){continue}if((k==='id'||k==='itemId'||k==='group_id')&&/^\\d{15,22}$/.test(String(v)))return String(v);if(v&&typeof v==='object')q.push([v,d+1])}}}catch(e){}return''};" +
      "const visibleVideo=()=>Array.from(document.querySelectorAll('video')).filter(v=>v.id!=='pong-integrated-swap').sort((a,b)=>score(b)-score(a))[0]||null;" +
      "window.__pongClearIntegratedSwap=()=>{const o=document.getElementById('pong-integrated-swap'),v=window.__pongIntegratedOriginal;if(o){try{o.pause();o.__pongAbort&&o.__pongAbort.abort();o.__pongBlob&&URL.revokeObjectURL(o.__pongBlob)}catch(e){}o.remove()}if(v){v.style.opacity=v.dataset.pongOriginalOpacity||'';delete v.dataset.pongOriginalOpacity}window.__pongIntegratedOriginal=null};" +
      "window.__pongApplyIntegratedSwap=s=>{try{if(!s||!s.streamUrl){window.__pongClearIntegratedSwap();return false}const original=visibleVideo();if(!original)return false;let overlay=document.getElementById('pong-integrated-swap');if(!overlay){overlay=document.createElement('video');overlay.id='pong-integrated-swap';overlay.playsInline=true;overlay.muted=true;overlay.defaultMuted=true;overlay.setAttribute('playsinline','');overlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:#000;z-index:1;object-fit:contain;margin:0'}const parent=original.parentElement||document.body;if(getComputedStyle(parent).position==='static')parent.style.position='relative';if(overlay.parentElement!==parent)parent.appendChild(overlay);if(window.__pongIntegratedOriginal&&window.__pongIntegratedOriginal!==original){window.__pongIntegratedOriginal.style.opacity=window.__pongIntegratedOriginal.dataset.pongOriginalOpacity||''}window.__pongIntegratedOriginal=original;if(!Object.prototype.hasOwnProperty.call(original.dataset,'pongOriginalOpacity'))original.dataset.pongOriginalOpacity=original.style.opacity||'';overlay.style.objectFit=getComputedStyle(original).objectFit||'contain';const session=String(s.sessionId||'');const mediaUrl='https://v16-webapp-prime.us.tiktok.com'+String(s.streamUrl);const reveal=()=>{if(overlay.readyState>=2&&window.__pongIntegratedOriginal===original){const t=Number(s.currentTime);try{if(Number.isFinite(t)&&Math.abs(overlay.currentTime-t)>.75)overlay.currentTime=t}catch(e){}try{if(Number.isFinite(t)&&Math.abs(original.currentTime-t)>.75)original.currentTime=t}catch(e){}original.style.opacity='0';overlay.style.visibility='visible';if(s.paused===true||original.paused)overlay.pause();else overlay.play().catch(()=>{})}};if(overlay.dataset.session!==session){if(overlay.__pongAbort)overlay.__pongAbort.abort();if(overlay.__pongBlob)URL.revokeObjectURL(overlay.__pongBlob);overlay.dataset.session=session;overlay.style.visibility='hidden';const controller=new AbortController(),ms=new MediaSource(),blob=URL.createObjectURL(ms);overlay.__pongAbort=controller;overlay.__pongBlob=blob;overlay.src=blob;overlay.load();ms.addEventListener('sourceopen',async()=>{try{const sb=ms.addSourceBuffer('video/mp4; codecs=\"avc1.64001f\"'),queue=[];let ended=false;const pump=()=>{if(sb.updating||!queue.length){if(ended&&!sb.updating&&!queue.length&&ms.readyState==='open'){try{ms.endOfStream()}catch(e){}}return}try{sb.appendBuffer(queue.shift())}catch(e){controller.abort()}};sb.addEventListener('updateend',()=>{reveal();pump()});const response=await fetch(mediaUrl,{cache:'no-store',signal:controller.signal});if(!response.ok||!response.body)throw new Error('swap stream '+response.status);const reader=response.body.getReader();while(true){const part=await reader.read();if(part.done)break;if(part.value?.byteLength){queue.push(part.value);pump()}}ended=true;pump()}catch(e){if(e?.name!=='AbortError'){original.style.opacity=original.dataset.pongOriginalOpacity||'';overlay.style.visibility='hidden'}}},{once:true})}overlay.onloadeddata=reveal;overlay.onplaying=reveal;overlay.onerror=()=>{original.style.opacity=original.dataset.pongOriginalOpacity||'';overlay.style.visibility='hidden'};if(overlay.readyState>=2)reveal();return true}catch(e){return false}};" +
      "window.__pongTikTokScan=()=>{" +
      "const found=[];document.querySelectorAll('.swiper-slide').forEach(slide=>{const id=reactId(slide),author=(slide.querySelector('a[href^=\"/@\"]')?.getAttribute('href')||'').slice(2),u=id?'https://www.tiktok.com/@'+encodeURIComponent(author||'_')+'/video/'+id:'';if(u&&!found.some(x=>x.u===u))found.push({u,s:slide.classList.contains('swiper-slide-active')?1:0,t:slide.getBoundingClientRect().top})});" +
      "document.querySelectorAll('a[href*=\"/video/\"]').forEach(a=>{const u=canonical(a.href);if(u&&!found.some(x=>x.u===u))found.push({u,s:score(a),t:a.getBoundingClientRect().top})});" +
      "found.sort((a,b)=>b.s-a.s||Math.abs(a.t)-Math.abs(b.t));let current=found[0]?.u||canonical(location.href);" +
      "const urls=[];if(current)urls.push(current);found.sort((a,b)=>a.t-b.t).forEach(x=>{if(!urls.includes(x.u)&&urls.length<8)urls.push(x.u)});" +
      "const payload=JSON.stringify({current,urls});if(payload!==last){last=payload;PongTikTokFeed.report(payload)}};" +
      "new MutationObserver(()=>window.__pongTikTokScan()).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});" +
      "addEventListener('scroll',window.__pongTikTokScan,{passive:true});setInterval(window.__pongTikTokScan,800);window.__pongTikTokScan();" +
      "}catch(e){}})()";
  }

  private void ensureTikTokWebView() {
    if (tiktokWeb != null) return;
    ensureRoot();
    tiktokWeb = new WebView(this);
    if (Build.VERSION.SDK_INT >= 26) {
      tiktokWeb.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    }
    WebSettings settings = tiktokWeb.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(true);
    // The transformed stream is served by the trusted Pong host on the local
    // network and is composited over the HTTPS TikTok page. No other mixed
    // content is injected by the app.
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    settings.setLoadWithOverviewMode(false);
    settings.setUseWideViewPort(true);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    settings.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(tiktokWeb, true);
    tiktokWeb.addJavascriptInterface(new TikTokFeedBridge(), "PongTikTokFeed");
    tiktokWeb.setWebChromeClient(new WebChromeClient());
    tiktokWeb.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri requested = request.getUrl();
        String path = requested == null ? "" : String.valueOf(requested.getPath());
        if ("https".equalsIgnoreCase(requested == null ? "" : requested.getScheme()) &&
            path.startsWith("/__pong_swap/")) {
          String sessionId = path.substring("/__pong_swap/".length()).replaceAll("[^A-Za-z0-9_-]", "");
          String upstream = integratedSwapStreams.get(sessionId);
          if (upstream == null || upstream.isEmpty()) return null;
          try {
            HttpURLConnection connection = (HttpURLConnection) new URL(upstream).openConnection();
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(0);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "video/mp4,video/*;q=0.9,*/*;q=0.1");
            connection.setRequestProperty("Origin", "http://192.168.1.124:8787");
            connection.setRequestProperty("Referer", "http://192.168.1.124:8787/pong");
            connection.connect();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
              connection.disconnect();
              return null;
            }
            InputStream body = new FilterInputStream(connection.getInputStream()) {
              @Override public void close() throws IOException {
                try { super.close(); } finally { connection.disconnect(); }
              }
            };
            HashMap<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Content-Type", "video/mp4");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Access-Control-Allow-Origin", "https://www.tiktok.com");
            return new WebResourceResponse("video/mp4", null, status, "OK", headers, body);
          } catch (Exception ignored) {
            return null;
          }
        }
        return super.shouldInterceptRequest(view, request);
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String scheme = request.getUrl().getScheme();
        // TikTok periodically tries to wake its native app. Keep this workflow
        // inside the logged-in website instead of replacing it with an Android
        // unknown-scheme error page.
        return !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
      }
      @Override public void onPageFinished(WebView view, String url) {
        if (url != null && url.toLowerCase(Locale.ROOT).contains("tiktok.com")) {
          view.evaluateJavascript(tiktokObserverScript(), null);
          updateTikTokStatus(currentTikTokUrl.isEmpty()
            ? "TikTok ready"
            : "Ready · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
        }
      }
    });
    tiktokWeb.setVisibility(View.GONE);
    tiktokWeb.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    root.addView(tiktokWeb, new FrameLayout.LayoutParams(1, 1));
    tiktokWeb.loadUrl(TIKTOK_HOME_URL);
  }

  private void openTikTokMode() {
    runOnUiThread(() -> {
      if (tiktokVisible) {
        hideTikTokMode();
        return;
      }
      ensureTikTokWebView();
      if (web != null) {
        web.evaluateJavascript(
          "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true})}catch(e){}",
          null
        );
      }
      tiktokVisible = true;
      tiktokWeb.onResume();
      tiktokWeb.resumeTimers();
      String currentUrl = tiktokWeb.getUrl();
      if (currentUrl == null || (!currentUrl.startsWith("https://") && !currentUrl.startsWith("http://"))) {
        tiktokWeb.loadUrl(TIKTOK_HOME_URL);
      }
      tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
      syncTikTokPlayerBounds();
      tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
      tiktokFaceHandler.post(tiktokFacePoller);
      tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
    });
  }

  private void hideTikTokMode() {
    if (tiktokWeb == null) return;
    tiktokVisible = false;
    tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
    tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
    tiktokObservedFaceKey = "";
    tiktokSwapEnabled = false;
    clearTikTokIntegratedSwap();
    tiktokWeb.evaluateJavascript(
      "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
      null
    );
    tiktokWeb.setVisibility(View.GONE);
    if (web != null) web.bringToFront();
  }

  /** Use Pong's existing face picker; TikTok mode adds no duplicate buttons. */
  private void pollPongFaceSelectionForTikTok() {
    if (!tiktokVisible || web == null) return;
    web.evaluateJavascript(
      "(()=>{try{const s=pongFaceSwapState||{},a=Array.isArray(s.selectedFaceIds)&&s.selectedFaceIds.length?s.selectedFaceIds:[s.selectedFaceId];return JSON.stringify({enabled:!!s.enabled,key:a.filter(Boolean).map(String).join('|')})}catch(e){return ''}})()",
      raw -> {
        if (!tiktokVisible) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject state = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          boolean enabled = state.optBoolean("enabled", false);
          String faceKey = state.optString("key", "");
          if (enabled && !faceKey.isEmpty()) {
            if (!tiktokSwapEnabled || !faceKey.equals(tiktokObservedFaceKey)) {
              clearTikTokIntegratedSwap();
              tiktokObservedFaceKey = faceKey;
              tiktokSwapEnabled = true;
              requestTikTokIntegratedSwap();
            }
          } else if (tiktokSwapEnabled) {
            tiktokSwapEnabled = false;
            tiktokObservedFaceKey = "";
            clearTikTokIntegratedSwap();
          }
        } catch (Exception ignored) {}
        if (tiktokVisible) tiktokFaceHandler.postDelayed(tiktokFacePoller, 500);
      }
    );
  }

  private void forwardTikTokFeedToPong(JSONObject payload) {
    if (web == null || payload == null) return;
    web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveFeed&&window.PongTikTokLiveFeed(" + payload + ")}catch(e){}",
      null
    ));
  }

  private void requestTikTokIntegratedSwap() {
    if (!isTikTokPageUrl(currentTikTokUrl)) {
      updateTikTokStatus("Open a TikTok video first");
      if (tiktokWeb != null) tiktokWeb.evaluateJavascript(tiktokObserverScript(), null);
      return;
    }
    final String target = currentTikTokUrl;
    final int generation = ++tiktokSwapGeneration;
    updateTikTokStatus("Preparing swap…");
    if (web != null) web.post(() -> web.evaluateJavascript(
      "try{window.PongTikTokLiveSwapCurrent&&window.PongTikTokLiveSwapCurrent(" + JSONObject.quote(target) + ")}catch(e){}",
      ignored -> {
        if (generation != tiktokSwapGeneration || !tiktokSwapEnabled) return;
        tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
        tiktokSwapHandler.post(tiktokSwapPoller);
      }
    ));
  }

  private static String unwrapJavascriptResult(String raw) {
    if (raw == null || "null".equals(raw) || "undefined".equals(raw)) return "";
    try {
      if (raw.startsWith("\"") && raw.endsWith("\"")) return new JSONArray("[" + raw + "]").getString(0);
    } catch (Exception ignored) {}
    return raw;
  }

  private void pollTikTokIntegratedSwap() {
    if (!tiktokVisible || !tiktokSwapEnabled || web == null || tiktokWeb == null) return;
    final int generation = tiktokSwapGeneration;
    web.evaluateJavascript(
      "(()=>{try{return window.PongTikTokLiveIntegratedState?window.PongTikTokLiveIntegratedState():''}catch(e){return''}})()",
      raw -> {
        if (generation != tiktokSwapGeneration || !tiktokVisible || !tiktokSwapEnabled) return;
        try {
          String decoded = unwrapJavascriptResult(raw);
          JSONObject state = decoded.isEmpty() ? new JSONObject() : new JSONObject(decoded);
          String requestedUrl = state.optString("requestedUrl", "");
          String streamUrl = state.optString("streamUrl", "");
          boolean ready = state.optBoolean("ready", false);
          if (requestedUrl.equals(currentTikTokUrl) && ready && !streamUrl.isEmpty()) {
            String sessionId = state.optString("sessionId", "").replaceAll("[^A-Za-z0-9_-]", "");
            if (sessionId.isEmpty()) throw new IllegalStateException("Missing swap session");
            integratedSwapStreams.put(sessionId, streamUrl);
            state.put("streamUrl", "/__pong_swap/" + sessionId + "?g=" + generation);
            tiktokWeb.evaluateJavascript(
              "try{window.__pongApplyIntegratedSwap&&window.__pongApplyIntegratedSwap(" + state + ")}catch(e){}",
              null
            );
            updateTikTokStatus("Swap live · " + Math.max(1, nearbyTikTokUrls.size()) + " queued");
          } else {
            updateTikTokStatus("Preparing swap…");
          }
        } catch (Exception ignored) {
          updateTikTokStatus("Preparing swap…");
        }
        tiktokSwapHandler.postDelayed(tiktokSwapPoller, readyPollDelayMs());
      }
    );
  }

  private int readyPollDelayMs() {
    return 240;
  }

  private void clearTikTokIntegratedSwap() {
    tiktokSwapGeneration += 1;
    tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
    integratedSwapStreams.clear();
    if (tiktokWeb != null) tiktokWeb.evaluateJavascript(
      "try{window.__pongClearIntegratedSwap&&window.__pongClearIntegratedSwap()}catch(e){}",
      null
    );
    if (tiktokVisible) updateTikTokStatus(currentTikTokUrl.isEmpty() ? "Choose a video" : "TikTok ready");
  }

  private final class TikTokFeedBridge {
    @JavascriptInterface public void report(String rawPayload) {
      try {
        JSONObject supplied = new JSONObject(rawPayload == null ? "{}" : rawPayload);
        LinkedHashSet<String> validated = new LinkedHashSet<>();
        String suppliedCurrent = supplied.optString("current", "");
        if (isTikTokPageUrl(suppliedCurrent)) validated.add(suppliedCurrent);
        JSONArray urls = supplied.optJSONArray("urls");
        if (urls != null) {
          for (int index = 0; index < urls.length() && validated.size() < 8; index++) {
            String candidate = urls.optString(index, "");
            if (isTikTokPageUrl(candidate)) validated.add(candidate);
          }
        }
        if (validated.isEmpty()) return;
        String nextCurrent = isTikTokPageUrl(suppliedCurrent) ? suppliedCurrent : validated.iterator().next();
        JSONObject safe = new JSONObject();
        safe.put("current", nextCurrent);
        JSONArray safeUrls = new JSONArray();
        for (String value : validated) safeUrls.put(value);
        safe.put("urls", safeUrls);
        safe.put("source", "android-tiktok-web");
        runOnUiThread(() -> {
          currentTikTokUrl = nextCurrent;
          nearbyTikTokUrls.clear();
          nearbyTikTokUrls.addAll(validated);
          updateTikTokStatus("Ready · " + validated.size() + " queued");
          forwardTikTokFeedToPong(safe);
          if (tiktokSwapEnabled) {
            clearTikTokIntegratedSwap();
            tiktokSwapEnabled = true;
            requestTikTokIntegratedSwap();
          }
        });
      } catch (Exception ignored) {}
    }
  }

  private boolean hasObserverPairing() {
    String value = observerPair == null ? "" : observerPair.trim();
    return !value.isEmpty() && !"OBSERVER_PAIR_PLACEHOLDER".equals(value);
  }

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
      String query = replaceParameter(source.getEncodedQuery(), "pongInstance", BuildConfig.INSTANCE);
      query = replaceParameter(query, "pongNative", "1");
      Uri.Builder builder = source.buildUpon().encodedQuery(query);
      if (observerPair != null && !observerPair.isEmpty()) {
        builder.encodedFragment(replaceParameter(source.getEncodedFragment(), "pongObserve", observerPair));
      }
      return builder.build().toString();
    } catch (Exception ignored) { return rawUrl; }
  }

  private String resumablePongUrl(String rawUrl) {
    try {
      Uri source = Uri.parse(rawUrl);
      if (!isPongUrl(source)) return DEFAULT_PONG_URL;
      // Auto-start parameters are one-shot commands. Reopening them would start
      // a new run instead of restoring the deck saved on this same origin.
      Uri.Builder builder = source.buildUpon().clearQuery().fragment(null);
      return decoratePongUrl(builder.build().toString());
    } catch (Exception ignored) {
      return DEFAULT_PONG_URL;
    }
  }

  private void rememberPongUrl(String rawUrl) {
    if (appState == null || rawUrl == null) return;
    try {
      if (isPongUrl(Uri.parse(rawUrl))) {
        appState.edit().putString("last-pong-url", resumablePongUrl(rawUrl)).apply();
      }
    } catch (Exception ignored) {}
  }

  private String requestedPongUrl(Intent intent) {
    try {
      String requested = intent == null ? null : intent.getDataString();
      if (requested != null && isPongUrl(Uri.parse(requested))) return requested;
    } catch (Exception ignored) {}
    return null;
  }

  private void connectObserver() {
    if (!hasObserverPairing() || web == null || web.getUrl() == null || !isPongUrl(Uri.parse(web.getUrl()))) {
      return;
    }
    try {
      JSONObject client = new JSONObject();
      client.put("instance", BuildConfig.INSTANCE);
      client.put("deviceId", deviceId);
      client.put("activityInstanceId", activityInstanceId);
      client.put("version", BuildConfig.VERSION_NAME);
      client.put("webGeneration", webGeneration);
      client.put("lifecycleSequence", lifecycleSequence);
      client.put("foreground", nativeForeground);
      // No JavaScript interface is exposed to third-party pages. Repair pairing after
      // history restoration and origin handoffs even when a fragment was consumed.
      web.evaluateJavascript("window.PongLiveObserver && window.PongLiveObserver.configure(" + JSONObject.quote(observerPair) + "," + client + ")", null);
    } catch (Exception ignored) {}
  }

  private void emitNativeLifecycle(String phase) {
    if (web == null || web.getUrl() == null) return;
    try {
      if (!isPongUrl(Uri.parse(web.getUrl()))) return;
      lifecycleSequence += 1;
      JSONObject detail = new JSONObject();
      detail.put("phase", phase);
      detail.put("activityInstanceId", activityInstanceId);
      detail.put("foreground", nativeForeground);
      detail.put("webGeneration", webGeneration);
      detail.put("sequence", lifecycleSequence);
      web.evaluateJavascript(
        "window.PongLiveObserver&&window.PongLiveObserver.event('native-lifecycle'," + detail + ")",
        null
      );
    } catch (Exception ignored) {}
  }

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    // The release build injects the private observer pairing through BuildConfig.
    // Keeping it out of source/resources prevents accidental plaintext commits,
    // while the release guard refuses APKs that would silently ship disconnected.
    observerPair = BuildConfig.OBSERVER_PAIR;
    activityInstanceId = UUID.randomUUID().toString();
    appState = getSharedPreferences("pong-app-state", MODE_PRIVATE);
    deviceId = appState.getString("observer-device", "");
    if (deviceId.isEmpty()) {
      deviceId = UUID.randomUUID().toString();
      appState.edit().putString("observer-device", deviceId).apply();
    }
    String requestedUrl = requestedPongUrl(getIntent());
    String lastUrl = requestedUrl != null
      ? requestedUrl
      : appState.getString("last-pong-url", DEFAULT_PONG_URL);
    // Do not marshal the complete WebView history into Android's Activity
    // state Bundle. Large Pong decks made that Bundle expensive and could
    // crash during background/restore. The web app's compact localStorage
    // session is the single restoration authority.
    ensureRoot();
    configureAndLoadWebView(lastUrl);
  }
  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    String requestedUrl = requestedPongUrl(intent);
    if (requestedUrl != null && web != null) web.loadUrl(resumablePongUrl(requestedUrl));
  }
  @Override protected void onResume() {
    super.onResume();
    nativeForeground = true;
    if (web != null) {
      web.onResume();
      web.resumeTimers();
      web.evaluateJavascript("try{window.PongResumeFromAppBackground&&window.PongResumeFromAppBackground()}catch(e){}", null);
      connectObserver();
      emitNativeLifecycle("resume");
    }
  }
  @Override protected void onPause() {
    nativeForeground = false;
    if (web != null) {
      rememberPongUrl(web.getUrl());
      lifecycleSequence += 1;
      web.evaluateJavascript("try{if(window.PongPrepareForAppBackground){window.PongPrepareForAppBackground()}else{document.querySelectorAll('video,audio').forEach(v=>v.pause())}window.PongLiveObserver&&window.PongLiveObserver.event('native-lifecycle',{phase:'pause',activityInstanceId:" + JSONObject.quote(activityInstanceId) + ",foreground:false,webGeneration:" + webGeneration + ",sequence:" + lifecycleSequence + "});window.PongLiveObserver&&window.PongLiveObserver.send()}catch(e){}", null);
      // Keep JavaScript, queue polling, and media preloading alive while another
      // Android app is in front. Media itself is paused above, so no audio leaks.
    }
    if (tiktokWeb != null) {
      tiktokWeb.evaluateJavascript(
        "try{document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.muted=true;v.volume=0})}catch(e){}",
        null
      );
    }
    super.onPause();
  }
  @Override protected void onStop() { nativeForeground = false; if (web != null) rememberPongUrl(web.getUrl()); super.onStop(); }
  @Override protected void onDestroy() {
    tiktokSwapHandler.removeCallbacks(tiktokSwapPoller);
    tiktokLayoutHandler.removeCallbacks(tiktokLayoutPoller);
    tiktokFaceHandler.removeCallbacks(tiktokFacePoller);
    WebView oldWeb = web;
    WebView oldTikTokWeb = tiktokWeb;
    web = null;
    tiktokWeb = null;
    if (oldWeb != null) {
      try {
        oldWeb.stopLoading();
        oldWeb.setWebChromeClient(null);
        oldWeb.setWebViewClient(null);
        oldWeb.removeAllViews();
        oldWeb.destroy();
      } catch (Exception ignored) {}
    }
    if (oldTikTokWeb != null) {
      try {
        oldTikTokWeb.stopLoading();
        oldTikTokWeb.removeJavascriptInterface("PongTikTokFeed");
        oldTikTokWeb.setWebChromeClient(null);
        oldTikTokWeb.setWebViewClient(null);
        oldTikTokWeb.removeAllViews();
        oldTikTokWeb.destroy();
      } catch (Exception ignored) {}
    }
    super.onDestroy();
  }
  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); }
  @Override public void onBackPressed() {
    if (tiktokVisible) {
      hideTikTokMode();
      return;
    }
    if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
  }
}
