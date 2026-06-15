# Suzume 🐦

A mobile reader for Japanese EPUBs, with an integrated offline dictionary and
tap-to-look-up built for vertical Japanese typography.

Suzume lets you import a Japanese EPUB, read it in proper vertical
right-to-left layout, and tap any word to get an instant dictionary definition —
all on-device, no network required.

> **Status: work in progress.** This is a personal project under active
> development. The core reading and lookup loop works on device; some areas
> (page-turn polish, settings, second-pass UI) are still being built. The code
> and architecture are intended to be production-quality even while the feature
> set is incomplete.

## Features

**Working today**

- 📖 Import and read EPUB files from the device
- 🇯🇵 Vertical (vertical-rl) Japanese reading layout
- 👆 Swipe / drag page navigation with custom page-turn animations
- 📚 Local offline dictionary (SQLite), no network needed
- 🔍 Tap a word in the text to look it up, with Japanese deinflection
  (conjugated forms resolved back to dictionary entries)
- 🔖 Reading progress saved and restored across sessions

**In progress**

- Page-turn animation polish (depth/parallax, cross-section flow)
- Reader typography settings (font size, margins)
- UI/UX refinement of the library and lookup surfaces

## Tech stack

- **React Native** (0.83) + **Expo** (55) + **expo-router**
- **TypeScript**
- **react-native-webview** as the rendering host for the reader
- **foliate-js** for EPUB pagination and vertical Japanese layout
- **expo-sqlite** for the local dictionary
- **react-native-reanimated** / **react-native-gesture-handler** for interactions

## Technical highlights

A few parts of the project that went beyond wiring libraries together:

- **Foliate integration inside React Native.** The reader embeds the
  [foliate-js](https://github.com/johnfactotum/foliate-js) pagination engine in a
  WebView and drives it from the native side, to get correct vertical-rl
  Japanese typography that off-the-shelf RN EPUB readers don't handle well.

- **WebView ↔ React Native bridge.** A typed message protocol coordinates
  navigation, reading position, dictionary taps and lifecycle between the native
  app and the in-WebView reader, working around the constraints of foliate-js'
  closed shadow DOM.

- **Custom page-turn animations (ghost / adjacent surfaces).** iBooks-style
  page turns — including cross-section transitions in both directions — are
  rendered by mirroring the current and neighbouring pages onto overlay
  surfaces, so the animation never disturbs the real paginated view. This avoids
  the WebKit compositing artifacts that a naive transform of the reader would
  cause.

- **On-device Japanese dictionary.** A [Yomitan](https://github.com/yomidevs/yomitan)
  dictionary (Jitendex) plus frequency data is compiled into a local SQLite
  database; lookups run a deinflection pass so conjugated/inflected words resolve
  to their base entries.

## Project structure

```
src/
  app/                 Expo Router screens (library, reader)
  features/
    library/           EPUB import & library management
    reader-foliate/    Foliate-based vertical Japanese reader (current focus)
    dictionary/        SQLite dictionary, deinflection, tap lookup
scripts/
  build-foliate-bundle.js    Bundles foliate-js for the WebView
  build-jitendex-sqlite.js   Compiles the Yomitan dictionary into SQLite
```

## Getting started

> Requires a **development build** (the reader relies on native modules not
> available in Expo Go).

```bash
# 1. Install dependencies
npm install

# 2. Build the in-WebView reader bundle
npm run build:foliate

# 3. Build the dictionary database
#    (requires a Yomitan dictionary archive in assets/dictionaries/ —
#     not bundled in the repo)
npm run build:jitendex

# 4. Run on a device / simulator
npm run ios      # or: npm run android
```

## Roadmap

- [ ] Finish page-turn polish (parallax depth, smoother spine transitions)
- [ ] Reader settings (typography, margins, theme)
- [ ] Lookup history and saved words
- [ ] Library improvements (sorting, metadata, covers)

---

*Suzume (雀) means "sparrow" in Japanese. Personal project — feedback welcome.*
