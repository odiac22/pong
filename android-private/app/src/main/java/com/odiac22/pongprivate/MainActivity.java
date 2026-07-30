package com.odiac22.pongprivate;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String PONG_URL = "https://odiac22.github.io/pong/";
    private FrameLayout root;
    private WebView pongView;
    private WebView privateView;
    private LinearLayout privatePanel;
    private TextView privateStatus;
    private String privateThreadUrl = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        root = new FrameLayout(this);
        setContentView(root);
        pongView = createWebView(false);
        pongView.addJavascriptInterface(new PongBridge(), "PongPrivateAndroid");
        root.addView(pongView, match());
        pongView.loadUrl(PONG_URL);
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView(boolean disposable) {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(!disposable);
        settings.setCacheMode(disposable ? WebSettings.LOAD_NO_CACHE : WebSettings.LOAD_DEFAULT);
        settings.setSaveFormData(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient());
        view.setDownloadListener((url, agent, disposition, type, length) ->
            Toast.makeText(this, "Downloads are disabled in private mode", Toast.LENGTH_SHORT).show()
        );
        return view;
    }

    private Button button(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(16);
        button.setAllCaps(false);
        return button;
    }

    private void openPrivateSimpCity(String rawUrl) {
        if (privatePanel != null) return;
        privateThreadUrl = rawUrl == null ? "" : rawUrl;
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        WebStorage.getInstance().deleteOrigin("https://simpcity.cr");
        WebStorage.getInstance().deleteOrigin("https://www.simpcity.cr");

        privatePanel = new LinearLayout(this);
        privatePanel.setOrientation(LinearLayout.VERTICAL);
        privatePanel.setBackgroundColor(Color.rgb(10, 12, 17));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        privateStatus = new TextView(this);
        privateStatus.setText("Private SimpCity");
        privateStatus.setTextColor(Color.WHITE);
        privateStatus.setTextSize(16);
        privateStatus.setPadding(18, 0, 12, 0);
        bar.addView(privateStatus, new LinearLayout.LayoutParams(0, 58, 1));

        Button scrape = button("Scrape");
        scrape.setOnClickListener(view -> scrapePrivateThread());
        bar.addView(scrape, new LinearLayout.LayoutParams(-2, 58));
        Button close = button("Close & Wipe");
        close.setOnClickListener(view -> closeAndWipePrivate());
        bar.addView(close, new LinearLayout.LayoutParams(-2, 58));
        privatePanel.addView(bar);

        privateView = createWebView(true);
        privateView.addJavascriptInterface(new ScrapeBridge(), "PongPrivateScrape");
        privateView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                privateStatus.setText("Private SimpCity — Scrape when ready");
            }
        });
        privatePanel.addView(privateView, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(privatePanel, match());
        cookies.removeAllCookies(removed -> runOnUiThread(() -> {
            cookies.flush();
            if (privateView != null) privateView.loadUrl(privateThreadUrl);
        }));
    }

    private void scrapePrivateThread() {
        if (privateView == null) return;
        privateStatus.setText("Scraping all thread pages…");
        privateView.evaluateJavascript(SCRAPE_SCRIPT, null);
    }

    private void closeAndWipePrivate() {
        if (privateView != null) {
            privateView.stopLoading();
            privateView.loadUrl("about:blank");
            privateView.clearHistory();
            privateView.clearCache(true);
            privateView.clearFormData();
            privateView.removeJavascriptInterface("PongPrivateScrape");
            privateView.destroy();
            privateView = null;
        }
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        WebStorage.getInstance().deleteOrigin("https://simpcity.cr");
        WebStorage.getInstance().deleteOrigin("https://www.simpcity.cr");
        if (privatePanel != null) root.removeView(privatePanel);
        privatePanel = null;
        privateStatus = null;
        privateThreadUrl = "";
    }

    private final class PongBridge {
        @JavascriptInterface public void openSimpCity(String url) {
            runOnUiThread(() -> openPrivateSimpCity(url));
        }
    }

    private final class ScrapeBridge {
        @JavascriptInterface public void progress(String message) {
            runOnUiThread(() -> {
                if (privateStatus != null) privateStatus.setText(message);
            });
        }

        @JavascriptInterface public void finish(String payload) {
            runOnUiThread(() -> {
                try {
                    JSONObject parsed = new JSONObject(payload);
                    JSONArray names = parsed.optJSONArray("names");
                    String threadUrl = parsed.optString("threadUrl", privateThreadUrl);
                    if (names == null || names.length() == 0) {
                        privateStatus.setText("No creator names found");
                        return;
                    }
                    String namesJson = names.toString();
                    closeAndWipePrivate();
                    String script = "window.PongReceiveSimpCityNames(" + namesJson + "," +
                        JSONObject.quote(threadUrl) + ")";
                    pongView.evaluateJavascript(script, null);
                } catch (Exception error) {
                    if (privateStatus != null) privateStatus.setText("Scrape failed");
                }
            });
        }
    }

    @Override public void onBackPressed() {
        if (privatePanel != null) {
            closeAndWipePrivate();
        } else if (pongView.canGoBack()) {
            pongView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override protected void onDestroy() {
        closeAndWipePrivate();
        if (pongView != null) {
            pongView.stopLoading();
            pongView.destroy();
        }
        super.onDestroy();
    }

    private static final String SCRAPE_SCRIPT =
        "(async()=>{try{" +
        "const bridge=window.PongPrivateScrape;" +
        "const first=new URL(location.href);first.searchParams.delete('page');" +
        "first.pathname=first.pathname.replace(/page-\\\\d+\\\\/?$/i,'');" +
        "const firstHtml=document.documentElement.outerHTML;" +
        "const pageNums=[...document.querySelectorAll('a[href*=\"/page-\"]')].map(a=>{const m=a.href.match(/page-(\\\\d+)/);return m?+m[1]:1});" +
        "const total=Math.max(1,...pageNums);const htmls=[firstHtml];" +
        "for(let p=2;p<=total;p+=3){const nums=[p,p+1,p+2].filter(n=>n<=total);" +
        "bridge.progress(`Scraping pages ${p}-${nums[nums.length-1]} of ${total}`);" +
        "const batch=await Promise.all(nums.map(async n=>{const u=new URL(first);u.pathname=u.pathname.replace(/\\\\/$/,'')+`/page-${n}`;return await(await fetch(u,{credentials:'include',cache:'no-store'})).text()}));htmls.push(...batch)}" +
        "const names=new Map();const add=v=>{v=String(v||'').replace(/<[^>]+>/g,' ').replace(/\\\\s+/g,' ').trim().replace(/^(?:by|from|credit|credits?)\\\\s*[:\\\\-]\\\\s*/i,'');" +
        "if(v.length<2||v.length>100||/^(?:reply|report|quote|simpcity|forums?|members?|login|register)$/i.test(v))return;" +
        "const key=v.toLowerCase().replace(/[^a-z0-9]+/g,'');if(key.length>1&&!names.has(key))names.set(key,v)};" +
        "for(const html of htmls){const doc=new DOMParser().parseFromString(html,'text/html');" +
        "doc.querySelectorAll('blockquote,.bbCodeBlock--quote').forEach(n=>n.remove());" +
        "doc.querySelectorAll('a[href*=\"/threads/\"]').forEach(a=>{if(!/page-\\\\d+|#post-/i.test(a.href))add(a.getAttribute('data-preview-url')?a.textContent:(a.title||a.textContent))});" +
        "doc.querySelectorAll('.message-body,.bbWrapper').forEach(el=>{const text=el.innerText||'';" +
        "for(const m of text.matchAll(/(?:aka|also known as|model|creator)\\\\s*[:\\\\-]?\\\\s*([@A-Za-z0-9_. -]{2,60})/gi))add(m[1]);" +
        "el.querySelectorAll('a[href*=\"instagram.com/\"],a[href*=\"twitter.com/\"],a[href*=\"x.com/\"],a[href*=\"onlyfans.com/\"]').forEach(a=>{try{add(new URL(a.href).pathname.split('/').filter(Boolean)[0])}catch(e){}})});" +
        "}bridge.finish(JSON.stringify({threadUrl:first.href,names:[...names.values()]}));" +
        "}catch(e){window.PongPrivateScrape.progress('Scrape failed: '+e.message)}})()";
}
