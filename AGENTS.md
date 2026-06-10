# Suzume - contexte projet pour futurs agents

Derniere inspection locale: 2026-06-07.

Ce document decrit l'etat observe du depot. Il ne remplace pas une specification produit: si le code et ce document divergent, relire le code. Les zones incertaines sont listees en fin de fichier afin d'eviter d'inventer.

## Vue d'ensemble

Suzume est une application Expo / React Native de lecture d'EPUB. Le cas d'usage principal visible dans le code est la lecture d'EPUB japonais avec:

- une bibliotheque locale de livres embarques et importes;
- un lecteur EPUB pagine base sur `@epubjs-react-native/core` / EPUB.js (moteur historique);
- une detection de direction de lecture LTR/RTL depuis les fichiers OPF;
- une reprise de lecture par CFI EPUB;
- une pagination globale calculee a partir du rendu reel;
- un dictionnaire japonais integre base sur une base SQLite Jitendex embarquee;
- une selection par tap dans le contenu WebView et affichage des resultats dans un bottom sheet.

Une exploration du moteur `foliate-js` est en cours sur la branche `spike/foliate-reader`. Elle ne remplace pas le lecteur historique; voir la section "Spike moteur Foliate" ci-dessous.

Le README racine est encore le README standard du template Expo; ne pas s'en servir comme documentation produit.

## Stack et configuration

- `package.json` declare une app Expo Router (`main: expo-router/entry`), React 19, React Native 0.83, Expo 55 et TypeScript strict.
- Les dependances coeur sont `@epubjs-react-native/core`, `@epubjs-react-native/expo-file-system`, `expo-file-system/legacy`, `expo-sqlite`, `@react-native-async-storage/async-storage`, `expo-document-picker`, `expo-asset`, `@gorhom/bottom-sheet` et `lucide-react-native`.
- `app.json` configure une app portrait, scheme `suzume`, `expo-router`, `expo-splash-screen`, `expo-sqlite`, `typedRoutes` et `reactCompiler`.
- `metro.config.js` ajoute les extensions d'assets `epub`, `zip`, `sqlite`, `db`.
- `tsconfig.json` active `strict` et les alias `@/* -> src/*`, `@/assets/* -> assets/*`.
- Scripts npm observes: `start`, `android`, `ios`, `web`, `lint`, `build:jitendex`. Le script `reset-project` pointe vers `scripts/reset-project.js`, qui n'existe pas dans ce checkout.

## Arborescence utile

- `src/app/_layout.tsx`: layout Expo Router, providers et pile de navigation.
- `src/app/index.tsx`: ecran bibliotheque / accueil.
- `src/app/reader.tsx`: ecran lecteur, orchestration EPUB, progression, dictionnaire.
- `src/books.ts`: livres EPUB embarques.
- `src/theme.ts`: palette et tokens de l'ecran bibliotheque.
- `src/features/library`: import, suppression, stockage et tri des livres.
- `src/features/reader`: hooks, theme lecteur, persistence de progression, scripts injectes et utilitaires EPUB.
- `src/features/dictionary`: base dictionnaire, tap WebView, lookup, ranking, deinflection et bottom sheet.
- `scripts/build-jitendex-sqlite.js`: genere `assets/dictionaries/jitendex.sqlite`.
- `scripts/debug-dictionary-lookup-ranking.js`: debug local du ranking dictionnaire via `sqlite3`.

## Assets et donnees locales

Les assets lourds sont presents localement mais ignores par `.gitignore`:

- `assets/books/shika-no-ou-1.epub` (~1.9 MB)
- `assets/books/le-petit-prince.epub` (~703 KB)
- `assets/dictionaries/jitendex-yomitan.zip` (~37 MB)
- `assets/dictionaries/JPDB_v2.2_Frequency_Kana_2024-10-13.zip` (~5.7 MB)
- `assets/dictionaries/jitendex.sqlite` (~158 MB)

`src/books.ts` expose deux livres embarques:

- `shika-no-ou-1`, titre `鹿の王 1`, auteur/sous-titre `Nahoko Uehashi`;
- `le-petit-prince`, titre `Le Petit Prince`, auteur/sous-titre `Antoine de Saint-Exupéry`.

La base `jitendex.sqlite` contient les tables `dictionary_metadata`, `dictionary_terms`, `dictionary_glosses`, `dictionary_tags`, `dictionary_term_meta`. Les metadonnees observees indiquent `Jitendex.org [2026-05-05]`, revision `2026.05.05.0`, `term_count=430822`, `gloss_count=623397`, `tag_count=8`, `term_meta_count=338814`, avec donnees source `ja` vers `en`.

## Navigation et shell app

`src/app/_layout.tsx` enveloppe l'app dans:

- `GestureHandlerRootView`;
- `ReaderProvider` de `@epubjs-react-native/core`;
- une `Stack` Expo Router sans headers.

Deux routes sont declarees sur `main`:

- `index`;
- `reader`, avec `gestureEnabled: false`.

Sur la branche `spike/foliate-reader`, une troisieme route experimentale `foliate-reader` est egalement declaree, avec `gestureEnabled: false`. Elle ne remplace pas le lecteur historique et n'est accessible que via un bouton `[DEV]` conditionnel (`__DEV__`) dans l'ecran bibliotheque.

## Bibliotheque

L'ecran `src/app/index.tsx` affiche:

- un header `Suzume` / `Japanese EPUB reader`;
- un bouton `Import` fonctionnel;
- un bouton `Settings` present visuellement mais branche sur `handlePlaceholderAction`, qui ne fait rien. Le proprietaire du projet a confirme que c'est bien un placeholder;
- une carte `ContinueCard` basee sur `lastOpenedBookId`;
- une grille `Library` limitee a 6 emplacements visibles.

Les couvertures utilisent `useBookCovers`. Si une couverture EPUB est introuvable ou si l'image echoue, l'UI retombe sur une couverture placeholder.

Le texte `Last read today` dans `ContinueCard` est statique dans le code. Il n'est pas calcule depuis `updatedAt`. Le proprietaire du projet a confirme que c'est egalement un placeholder.

Les livres importes peuvent etre supprimes par long press sur leur carte. Les livres embarques ne sont pas supprimables par cette voie.

### Stockage bibliotheque

`src/features/library/libraryStorage.ts` persiste les imports dans `AsyncStorage` sous la cle `suzume:library`.

La forme stockee est:

- `importedBooks: ImportedBook[]`;
- chaque `ImportedBook` contient notamment `id`, `fileUri`, `fingerprint`, `title`, `subtitle`, `importedAt`, `updatedAt`.

La lecture du stockage est defensive: JSON invalide ou donnees non conformes retournent une bibliotheque vide.

### Tri des livres

`src/features/library/libraryBooks.ts` combine `bundledBooks` et imports. `orderLibraryBooks` trie par:

- date de progression de lecture si disponible;
- sinon date d'import/update pour les imports;
- en cas d'egalite, les imports passent avant les livres embarques;
- les livres embarques gardent l'ordre de `src/books.ts`.

### Import EPUB

`src/features/library/importEpub.ts`:

- ouvre `expo-document-picker` avec types EPUB;
- accepte aussi certains MIME types ZIP/octet-stream si l'extension ou le type semble EPUB;
- copie le fichier choisi dans `${documentDirectory}suzume-library/books/{bookId}.epub`;
- calcule un fingerprint avec MD5 si disponible, sinon nom sanitise + taille;
- dedoublonne par `id` ou `fingerprint`;
- extrait les metadonnees EPUB via `extractEpubMetadata`;
- stocke titre, auteur fallback et dates dans `AsyncStorage`;
- lance l'extraction/cache de couverture en arriere-plan.

Si le fichier selectionne n'est pas un EPUB valide, l'import retourne un statut `error`.

### Suppression d'un import

`src/features/library/deleteImportedBook.ts`:

- retire l'entree `AsyncStorage`;
- supprime le fichier EPUB local;
- supprime la couverture cachee;
- supprime la progression associee et recalcule `lastOpenedBookId` parmi les livres restants.

## Utilitaires EPUB et couvertures

`src/features/reader/utils/epubZip.ts` initialise JSZip en evaluant le source embarque dans `@epubjs-react-native/core/lib/module/jszip`. Il n'y a pas de dependance `jszip` directe dans `package.json`.

`extractEpubMetadata.ts` ouvre `META-INF/container.xml`, lit le chemin OPF puis extrait par regex:

- `dc:title`;
- `dc:creator`;
- `dc:identifier`.

`detectReadingDirection.ts` lit le meme OPF et retourne:

- `rtl` si `page-progression-direction="rtl"`;
- `ltr` si `page-progression-direction="ltr"`;
- sinon `rtl` si `primary-writing-mode` vaut `vertical-rl`;
- sinon `ltr`.

`extractEpubCover.ts` cherche une couverture dans le manifest OPF par ordre:

- meta `name="cover"` pointant vers un item;
- item avec propriete `cover-image`;
- item image dont `id` ou `href` contient `cover`.

`epubCoverCache.ts` ecrit les couvertures dans `${cacheDirectory}book-covers/` avec un fichier metadata JSON par livre. Le cache est invalide par fingerprint d'asset/import.

`useBookCovers.ts` ajoute un cache memoire de promesses par livre pour eviter de reparser les EPUB trop souvent.

## Lecteur

`src/app/reader.tsx` est le centre de l'ecran de lecture.

Flux principal:

1. Lit `bookId` depuis les params Expo Router.
2. Charge le livre avec `getLibraryBookById`.
3. `useBookAsset` lit l'EPUB en base64, que le code nomme `bookUri`.
4. Detecte la direction de lecture.
5. Charge la progression stockee pour determiner `initialReaderLocation`.
6. Rend le composant `Reader` de `@epubjs-react-native/core`.
7. Injecte les scripts WebView pour fond, taps dictionnaire, pagination et swipes RTL.
8. Sauvegarde la progression apres changements de location.

Le `Reader` est configure avec:

- `flow="paginated"`;
- `spread="none"`;
- `enableSwipe={readingDirection === "ltr"}`;
- `initialLocation` si un CFI est stocke;
- `defaultTheme={readerTheme}`;
- `fileSystem={useLegacyFileSystem}`.

Pour les livres RTL, le swipe natif est desactive et remplace par `rtlSwipeScript`.

### Theme lecteur

`src/features/reader/readerTheme.ts` definit:

- fond `#F1E2C9`;
- texte `#111111`;
- padding haut `100`;
- padding bas `48`;
- CSS EPUB.js: font-size `20px`, line-height `1.75`, padding body `16px 22px`.

`readerBackgroundScript.ts` force la couleur de fond sur le document principal, le viewer et chaque contenu rendu par EPUB.js.

### Controles lecteur

`useReaderControls.ts` gere:

- visibilite du bouton retour;
- fade du bouton retour;
- indicateur de page en mode compact/etendu;
- fade de l'indicateur pendant le changement de mode.

Dans `reader.tsx`, un tap sur le fond alterne les controles. Si le dictionnaire est ouvert, le meme tap ferme d'abord le dictionnaire.

### Progression de lecture

`src/features/reader/readingProgressStorage.ts` utilise `AsyncStorage` sous `suzume:reading-progress`.

La forme stockee est:

- `byBookId[bookId]` avec `location` CFI, `progress` numerique ou `null`, `updatedAt`;
- `lastOpenedBookId`.

`normalizeReadingProgress` accepte les progressions historiques en `0..1` et les convertit en `0..100`; les valeurs hors bornes sont ignorees.

Dans `reader.tsx`, les sauvegardes sont debouncées avec `progressSaveDelayMs = 900`. Le code force aussi un flush lors de certains changements et au demontage.

La reprise de lecture masque temporairement le contenu si un CFI initial existe. Le contenu devient visible si:

- le lecteur arrive sur le CFI initial;
- ou un fallback de `resumeVisibilityFallbackDelayMs = 1400` ms expire.

### Pagination globale

`renderedPaginationScript.ts` calcule une pagination basee sur le rendu reel:

- attend que `book.ready` soit resolu;
- cree un conteneur invisible hors ecran avec les dimensions du viewer;
- cree une rendition EPUB.js de mesure;
- affiche chaque item linear du spine;
- lit `currentLocation().start.displayed.total` ou fallback `end.displayed.total`;
- poste les messages `rendered-pagination-loading`, `rendered-pagination-ready` ou `rendered-pagination-error`.

`useRenderedPagination.ts` transforme les page counts par spine en offsets globaux puis expose:

- page courante globale;
- total pages global.

`reader.tsx` utilise cette pagination pour afficher l'indicateur de page et pour stocker une progression en pourcentage:

`currentPage / totalPages * 100`.

## Spike moteur Foliate

La branche `spike/foliate-reader` explore `foliate-js` comme moteur de rendu EPUB alternatif au moteur historique `@epubjs-react-native/core` / EPUB.js.

### Motivation

Des tests sur des EPUB japonais vertical-rl ont revele des limites structurelles dans EPUB.js:

- a la frontiere entre deux spines, `rendition.prev()` revient trop haut dans le spine precedent;
- le CFI stocke pointe sur le debut du paragraphe et non sur la position visuelle reelle;
- les scripts injectes necessaires (swipe RTL, fond, tap, pagination) s'accumulent et interagissent;
- les rustines tentees (next() x missingPages, scrollBy correctif, recalcul post-relocated) ont ete jugees insatisfaisantes.

L'objectif du spike est de valider si `foliate-js` resout ces problemes sans quitter l'ecosysteme Expo/React Native, et en conservant le produit existant aussi integralement que possible.

### Fichiers du spike

- `scripts/build-foliate-bundle.js`: bundler esbuild, genere l'IIFE depuis `node_modules/foliate-js/view.js`;
- `assets/foliate/foliate-bundle.js`: bundle IIFE genere (~317 KB); ignore par git, regenerer avec `npm run build:foliate`;
- `src/features/reader-foliate/foliateBundle.ts`: export TypeScript de la string du bundle; genere automatiquement par le script precedent;
- `src/features/reader-foliate/foliateReaderHtml.ts`: template HTML + script bridge WebView; contient l'open, la navigation, les events, la mesure de pagination globale, le footer natif, et la logique de tap dictionnaire (hit-testing caret-only, `classifyTap`, comportement modal `isDictionaryOpen`);
- `src/features/reader-foliate/FoliateReaderView.tsx`: composant React Native (WebView + forwardRef + postMessage); expose `next`, `prev`, `goTo`, `setPagination`, `startMeasurement`, `clearDictionaryHighlight`, `highlightDictionaryMatch`, `setDictionaryOpen`;
- `src/features/reader-foliate/pagination/foliatePaginationTypes.ts`: types `ReaderLayoutProfile`, `FoliateRenderedPagination`, `BookRuntimeState`, constante `FOLIATE_ENGINE_BUILD_ID`;
- `src/features/reader-foliate/pagination/createFoliateLayoutKey.ts`: cle stable depuis le profil de layout (JSON trie, champs non-null);
- `src/features/reader-foliate/pagination/foliateBookRuntimeStorage.ts`: lecture/ecriture AsyncStorage pour le cache de pagination (`suzume:book-runtime-state:v1:{bookId}`);
- `src/app/foliate-reader.tsx`: ecran spike, orchestration de la mesure, overlay de preparation, log panel, boutons nav;
- `src/app/index.tsx`: bouton `[DEV]` conditionnel (`__DEV__`) pour acceder au spike depuis la bibliotheque.

### Architecture pagination globale

La pagination globale mesure le nombre reel de pages rendues par Foliate pour chaque section du livre, puis calcule des offsets cumulatifs pour afficher un numero de page global continu.

**Flux au premier chargement (cache absent) :**

1. `foliate-reader.tsx` verifie le cache AsyncStorage (`getFoliatePagination`).
2. Cache absent → `measurementState = "measuring"` → overlay "Preparation du livre…" visible.
3. La WebView principale charge et ouvre le livre normalement.
4. Quand `goToFraction(0)` est resolu, le bridge poste `"ready"`.
5. RN recoit `"ready"` et appelle `window.__startMeasurement(null)` via `injectJavaScript`.
6. Le bridge navigue sequentiellement chaque section avec `view.goTo(i)`, attend l'event `relocate` avec `section.current === i`, lit `view.renderer.pages - 2` (contenu hors sentinelles).
7. Pendant la mesure, les events `relocated` et `loaded` vers RN sont supprimes (`isMeasuring = true`); l'utilisateur ne voit que l'overlay.
8. Quand toutes les sections sont mesurees, le bridge poste `"pagination-ready"` avec `sectionPageCounts`, `sectionOffsets`, `totalPages`, puis navigue vers `initialCfi` (ou `goToFraction(0)`).
9. RN stocke en AsyncStorage, injecte via `window.__setGlobalPagination(...)`, passe `measurementState = "ready"` → overlay disparait.

**Flux au rechargement (cache present) :**

1. Cache present → `paginationRef.current` est positionne immediatement.
2. Quand `"ready"` arrive, `injectPagination()` injecte directement; l'overlay n'est jamais affiche.

**Affichage du compteur :**

- Le compteur est ecrit dans `view.renderer.feet[0].textContent` (footer natif Foliate, shadow DOM du paginator).
- `updateFeet()` est appele par le listener `relocate` du paginator (niveau paginator, pas niveau view).
- Formule: `globalPage = sectionOffsets[currentSectionIndex] + rawPage` (rawPage 1-base, hors sentinelles).
- `lastDisplayedGlobalPage` est conserve en memoire; si `rawPage` est temporairement hors range pendant une transition de spine, le footer garde la derniere valeur valide plutot que de se vider.
- Tant que `globalPagination` est `null`, le footer reste vide.
- Seule la page courante est affichee dans l'UI; le total est dans les logs `[FOLIATE-PAGE]`.

**Cache et invalidation :**

- Cle de cache: `bookId + bookFingerprint + layoutKey`.
- `layoutKey` est un JSON trie des champs non-null du `ReaderLayoutProfile` (engine, engineBuildId, viewport, pixelRatio, orientation, maxColumnCount, flow, direction, writingMode, fontFamily, fontSize, lineHeight, margin, gap, maxInlineSize, maxBlockSize).
- `FOLIATE_ENGINE_BUILD_ID` dans `foliatePaginationTypes.ts` doit etre incremente si le bundle Foliate est regenere, si la logique de mesure change, ou si des parametres de layout qui influencent les pages changent.
- Format AsyncStorage: `BookRuntimeState` (version 1) keye sous `suzume:book-runtime-state:v1:{bookId}`.

**Piste abandonnee — deuxieme WebView cachee :**

Une approche avec une deuxieme WebView Foliate en `opacity:0` pour mesurer la pagination sans toucher au reader principal a ete tentee et abandonnee. Raisons: deux instances WKWebView avec HTML Foliate lourd (~340 KB) et un livre de 3 MB ne peuvent pas charger simultanement sur iOS/RN sans defaillance silencieuse; les tentatives de sequencement n'ont pas suffi. Ne pas reintroduire cette approche sans raison forte et sans solution au probleme de chargement WKWebView.

### Etat valide au 2026-06-09

- EPUB envoye en base64 depuis React Native vers la WebView: fonctionne.
- `foliate-js` ouvre le livre et detecte `dir=rtl`.
- `view.open(file)` parse le livre mais ne declenche pas de rendu seul; `view.goToFraction(0)` est necessaire.
- Les events `load` et `relocate` sont bien recus.
- Le texte japonais vertical-rl est visible.
- L'affichage deux colonnes corrige via `view.renderer.setAttribute('max-column-count', '1')`.
- Doublons de `relocate` au meme CFI/section observes; ils semblent internes a la stabilisation du paginator; dedupliques cote RN.
- Navigation cross-spine visuellement correcte.
- Pagination globale mesuree et affichee dans le footer natif Foliate: fonctionne.
- Overlay "Preparation du livre…" pendant la mesure: fonctionne.
- Cache persistant AsyncStorage par `bookId + fingerprint + layoutKey`: fonctionne.
- Footer stable au passage de spine (pas de clignotement grace a `lastDisplayedGlobalPage`): fonctionne.
- Logs `[FOLIATE-PAGE] sec=N raw=p/P local=p offset=O global=G/T` visibles dans Metro.
- Tap dictionnaire caret-only (`classifyTap`): fonctionne, y compris sur glyphes creux (ロ 口 田).
- Comportement modal dictionnaire ouvert (`isDictionaryOpen`): fonctionne; swipes bloques, tap ferme le dict.
- Connexion lookup SQLite depuis le spike: fonctionnel (meme pipeline que le lecteur historique).
- Chrome masque automatiquement sur `dictionary-tap`: fonctionne.

### Points a valider

- Coherence des offsets au passage de spine (ex: sec=25 → sec=26 doit faire G → G+1, pas G → G+23).
- Reprise de lecture via CFI ou locator Foliate.
- Tests sur plusieurs EPUB japonais differents.
- Decision formelle: remplacement du moteur historique, fallback, ou abandon du spike.

Points desormais valides (ne pas reintroduire) :

- ~~Tap sur caractere japonais et extraction du texte~~ — valide, voir section 9 de `docs/foliate-spike-notes.md`.
- ~~Connexion au dictionnaire SQLite depuis le spike~~ — valide, meme pipeline que le lecteur historique.

### Consignes pour ce spike

- Ne pas toucher au lecteur historique EPUB.js (`reader.tsx`, `features/reader`, `features/dictionary`).
- Ne pas reintroduire la deuxieme WebView de mesure (voir "Piste abandonnee" ci-dessus).
- Ne pas reintroduire un compteur React Native overlay; le compteur doit rester dans `view.renderer.feet`.
- Le footer doit afficher la page globale, pas `location.current`; rester vide si la pagination n'est pas prete.
- Incrementer `FOLIATE_ENGINE_BUILD_ID` si le bundle ou la logique de mesure change, pour invalider les caches.
- Ne pas considerer Foliate comme moteur definitif tant que tap, reprise et progression ne sont pas valides.
- Garder le spike isole du lecteur historique pendant toute la phase d'exploration.
- Ne pas reintroduire de fallback TreeWalker / `getTextNodesUnderPoint` / Range-par-caractere dans le bridge Foliate; utiliser la strategie caret-only (`classifyTap`).
- Ne pas ajouter d'overlay RN full-screen (`GestureDetector absoluteFill`, `PanResponder`, `Pressable absoluteFill`) pour gerer les taps sur le texte; les interactions texte restent dans la WebView / iframe Foliate.
- Garder le court-circuit `isDictionaryOpen` cote bridge (pas seulement cote RN) avant la navigation et avant le hit-testing.
- Ne pas confondre les touch events WebView (derriere le dictionnaire) et les interactions internes au bottom sheet.
- Si la migration est decidee, introduire une frontiere claire (ex: `ReaderEngine`) pour ne pas melanger les deux stacks.

## Support RTL

`detectReadingDirection.ts` detecte RTL depuis les metadonnees EPUB. Si un livre est RTL:

- `Reader.enableSwipe` est false;
- `rtlSwipeScript` est injecte;
- le script attache des listeners touch au document principal et aux contenus rendus;
- un swipe horizontal suffisant appelle `rendition.next()` si `deltaX > 0`, sinon `rendition.prev()`.

Le script se reattache sur `rendered`, `relocated`, `resized` et par intervalle.

Des tests ont montre que dans certains cas RTL/vertical, `rendition.prev()` a une frontiere de spine revient trop haut dans le spine precedent. Des rustines du type `next() x missingPages`, `scrollBy` correctif ou correction post-`relocated` ont ete tentees et jugees insatisfaisantes. Le spike Foliate vise notamment a ne pas accumuler ce type de contournements.

## Dictionnaire

Le dictionnaire runtime utilise la base embarquee `assets/dictionaries/jitendex.sqlite`.

### Ouverture de la base

`dictionaryDatabase.ts` expose deux familles:

- `getBundledJitendexDatabase()`: copie l'asset `jitendex.sqlite` vers `documentDirectory` si necessaire puis ouvre cette base avec `expo-sqlite`;
- `getDictionaryDatabase()`: ouvre/initialise `suzume-dictionaries.db`, une base pour imports Yomitan generiques.

Le lookup actuel de `reader.tsx` appelle `lookupJapaneseTermFromSqlite`, qui utilise uniquement `getBundledJitendexDatabase()`.

La base importable `suzume-dictionaries.db` et `importYomitanDictionary.ts` existent et sont exportees, mais aucune reference applicative actuelle ne les appelle hors du module d'import lui-meme.

### Tap dans le contenu EPUB

`dictionaryTapScript.ts` est injecte dans la WebView EPUB.js.

Il:

- attache `touchstart` / `touchend`;
- ignore les mouvements superieurs a `maxTapMovement = 10`;
- exclut whitespace, ponctuation et certains blocs (`rt`, `rp`, `script`, `style`);
- trouve le caractere touche via `caretRangeFromPoint`, `caretPositionFromPoint` ou mesure de ranges;
- construit un payload avec `character`, `before`, `after`, `context`;
- garde environ `contextRadius = 20` caracteres avant/apres, sans whitespace;
- poste `dictionary-tap`, `dictionary-close` ou `reader-background-tap`;
- stocke une ancre de highlight dans le document;
- expose `window.__suzumeClearDictionaryHighlight`;
- expose `window.__suzumeHighlightDictionaryMatch(surfaceText)`.

Le highlight peut traverser plusieurs text nodes visibles et ignore les espaces pour compter la longueur de surface.

### Lookup japonais

`lookupJapaneseTerm.ts`:

- normalise le texte apres le tap en supprimant les espaces;
- limite la recherche a `maxLookupLength = 20`;
- genere des prefixes du plus long au plus court;
- passe chaque prefixe dans `deinflectJapaneseTerm`;
- limite a `maxLookupCandidates = 400`;
- interroge la base avec `expression IN (...) OR reading IN (...)`;
- limite les lignes brutes a `maxBulkRows = 1000`;
- groupe et ranke les resultats;
- renvoie au plus `maxEntries = 30`;
- charge les gloses dans `dictionary_glosses` seulement pour les meilleurs groupes.

Si aucun resultat n'est trouve par la pipeline complete, `queryExactPrefixFallback` essaie des matchs exacts d'expression sur les prefixes.

Le `matchedText` renvoye sert a surligner la surface effectivement reconnue.

### Desinflexion

`japaneseDeinflectionRules.ts` contient une table de 516 regles portee de `wtetsu/deinja`, commit `3f160eabbab21e1eda0396493c3c95afa515474c`, licence Apache-2.0.

`japaneseDeinflector.ts` applique:

- formes adjectives;
- ichidan;
- godan;
- suffixes `suru`;
- regle classique `し -> る`;
- irregularites `kuru`, `special`, `iku`;
- filtre des terminaisons `bogus`.

Chaque candidat contient:

- `surfaceForm`;
- `dictionaryForm`;
- `reasons`;
- `rules`;
- `candidateOrder`;
- `inflectionChainLength`.

### Ranking

Les fichiers `src/features/dictionary/lookup/*` separent la generation, classification, groupement et comparaison.

Le groupement se fait par:

- `sequence:{sequence}` si une sequence Jitendex/JMdict est disponible;
- sinon `term:{expression}\0{reading}`.

Le ranking favorise notamment:

- match exact expression sur toute la source;
- match exact reading sur toute la source;
- desinflexions fortes compatibles avec les tags de regles JMDict;
- prefixes plus longs;
- score dictionnaire;
- tags de priorite (`priority form`, etoile, rare/obsolete/irregular);
- frequence JPDB, ou score plus faible est meilleur;
- nombre de gloses;
- ordre dans les term banks;
- ordre initial des candidats.

`classifyDictionaryMatch.ts` contient aussi une compatibilite entre regles de desinflexion et tags JMDict (`v1`, `v5*`, `vs`, `vk`, `adj-i`, etc.).

### Bottom sheet

`DictionaryBottomSheet.tsx` utilise `@gorhom/bottom-sheet`.

Comportement observe:

- hauteur ouverte: 60% de l'ecran, limitee par le safe area top;
- backdrop invisible mais fermable;
- fermeture par pan down ou pull depuis le haut du contenu;
- affichage des statuts `loading`, `notInstalled`, `error`, `noResults`;
- affichage des entrees avec lecture, expression et gloses.

`getDisplayReading` retire le suffixe kana commun entre expression et lecture pour eviter d'afficher une lecture redondante.

## Scripts dictionnaire

`scripts/build-jitendex-sqlite.js` genere `assets/dictionaries/jitendex.sqlite` depuis:

- `assets/dictionaries/jitendex-yomitan.zip`;
- optionnellement `assets/dictionaries/JPDB_v2.2_Frequency_Kana_2024-10-13.zip`.

Il utilise le binaire `sqlite3` local, cree les tables runtime, extrait des gloses simplifiees, importe tags et term meta, cree les indexes, puis lance `VACUUM`.

`scripts/debug-dictionary-lookup-ranking.js` charge les modules TypeScript de ranking via `typescript.transpileModule`, interroge `jitendex.sqlite` via `sqlite3 -json`, puis imprime prefixes, candidats, matchs bruts et ranking. C'est le meilleur outil local avant de modifier le ranking.

## Tests et verification

Aucun fichier de test ou configuration Jest/Vitest n'a ete trouve dans le depot inspecte.

La commande disponible pour verification generale est `npm run lint`. Je n'ai pas observe de script `typecheck` dedie. La commande `./node_modules/.bin/tsc --noEmit` a ete utilisee ponctuellement pour verifier les types TypeScript sans compilation.

Pour les changements dictionnaire, utiliser aussi:

`node scripts/debug-dictionary-lookup-ranking.js <terme japonais>`

Pour regenerer la base Jitendex:

`npm run build:jitendex`

Cette regeneration depend des zips locaux ignores par git et du binaire `sqlite3`.

## Points a clarifier / ne pas inventer

- Les fichiers mentionnes dans certains contextes IDE `src/features/reader/scripts/readingPositionAnchorScript.ts` et `src/features/reader/position/readingPositionModel.ts` ne sont pas presents dans ce checkout apres restore git. La reprise actuelle observee passe par CFI EPUB + pagination rendue, pas par ces fichiers.
- Le bouton `Settings` est un placeholder confirme.
- `Last read today` est statique et placeholder confirme.
- `useLibraryBooks` expose `isLoading` et `error`, mais `index.tsx` ne les affiche pas actuellement. Le comportement souhaite n'est pas encore clarifie par le proprietaire du projet.
- L'import Yomitan generique existe dans le code mais n'est pas branche a l'UI ni au lookup utilise par le lecteur. Le proprietaire pense qu'il faudrait probablement le supprimer, mais confirmer avant de retirer du code.
- La base `suzume-dictionaries.db` creee par `getDictionaryDatabase()` n'a pas le meme schema que `jitendex.sqlite`. L'intention produit n'est pas claire; verifier avant de la brancher a `lookupJapaneseTermFromSqlite` ou de supprimer le code associe.
- Les assets EPUB/ZIP/SQLite sont ignores par git. Un autre clone peut ne pas les avoir.
- `src/global.css` definit seulement des variables de police web; aucune integration directe n'a ete observee dans les fichiers React Native lus.

## Conseils pour futurs agents

- Avant de modifier le lecteur, relire `reader.tsx`, `useBookAsset.ts`, `readingProgressStorage.ts`, `useRenderedPagination.ts` et les scripts injectes: beaucoup de comportement depend de l'ordre des effets et des messages WebView.
- Avant de modifier le dictionnaire, lancer le script de debug sur plusieurs formes flechies japonaises et comparer les classes de ranking.
- Eviter de remplacer les regex OPF/XML par des manipulations plus fragiles; si un vrai parseur XML est ajoute, verifier Expo/React Native.
- Avant de supprimer ou de brancher l'import Yomitan generique, decider explicitement si le projet doit rester sur `jitendex.sqlite` embarque uniquement ou supporter des dictionnaires utilisateur.
- Si vous touchez aux assets ignores, documenter comment les recreer ou les obtenir.
- Si vous travaillez sur `spike/foliate-reader`, relire aussi `src/features/reader-foliate/foliateReaderHtml.ts`, `FoliateReaderView.tsx` et `scripts/build-foliate-bundle.js` avant toute modification du spike.
- Le spike Foliate doit rester separe du lecteur historique tant que la migration n'est pas decidee; ne pas importer de code du spike dans `reader.tsx` ni inversement.
- Pour le tap dictionnaire Foliate, ne pas introduire un nouveau systeme de hit-testing sans lire la section 9 de `docs/foliate-spike-notes.md`; la strategie caret-only a ete choisie deliberement apres mesure du cout du bruteforce sur le DOM multi-colonnes de Foliate.
