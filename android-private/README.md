# Pong Private Android

Pong Private keeps the normal Pong player in its main WebView and opens
SimpCity in a separate disposable WebView.

- SimpCity cookies, cache, form data, storage, and navigation history are
  cleared when **Close & Wipe** is pressed or the activity is destroyed.
- Android screenshots and task-switcher previews are blocked with
  `FLAG_SECURE`.
- Downloads, file access, content access, and automatic media playback are
  disabled in the private view.
- The private page injects a **Scrape** action that reads authenticated thread
  pages and returns creator names to Pong's existing BAlbums/Bunkr workflow.

Build:

```powershell
cd android-private
gradle assembleDebug
```
