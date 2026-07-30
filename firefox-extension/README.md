# Pong SimpCity Scraper for Firefox Android

The extension injects the bundled Pong scraper directly into authenticated
SimpCity thread pages. It requests access only to `simpcity.cr`, stores no
credentials or history, and returns creator names to the live Pong page through
the URL fragment.

Firefox release builds require the packaged XPI to be signed by Mozilla before
installation. Submit it as an unlisted add-on in the Mozilla Add-on Developer
Hub, then host the returned signed XPI.
