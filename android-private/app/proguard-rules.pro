# The JavaScript bridges are referenced from WebView JavaScript.
-keepclassmembers class com.odiac22.pongprivate.MainActivity$*Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
