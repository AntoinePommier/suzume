# Foliate reader spike — notes d'architecture et de diagnostic

Document de référence pour les agents qui reprennent ce spike.
Ne décrit pas la feature dans son intégralité ; couvre les décisions d'architecture,
les risques, le bug en cours, et les corrections à évaluer.

Branche : `spike/foliate-reader`
Fichiers principaux : `src/app/foliate-reader.tsx`, `src/features/reader-foliate/`

---

## 1. Objectif du spike

Valider si **foliate-js** peut remplacer EPUB.js (actuellement en production via
`@epubjs-react-native/core`) comme moteur final de lecture de Suzume.

La barre de validation est haute. Le moteur doit supporter :

- EPUBs japonais avec `writing-mode: vertical-rl` et `direction: rtl`
- Navigation inter-spines fluide dans les deux sens
- Pagination globale mesurée, mise en cache et affichée dans le footer
- Reprise de position via CFI précis entre sessions
- Futur tap dictionnaire : tap sur un caractère du texte → lookup
  (architecture doit y être compatible dès maintenant)
- Chrome RN minimal (bouton retour, overlay de chargement) sans couche
  RN full-screen qui bloquerait les gestes vers la WebView

Si l'une de ces contraintes ne peut pas être satisfaite proprement, le spike
recommandera de rester sur EPUB.js.

---

## 2. Architecture validée

Les points suivants ont été validés ou sont considérés comme corrects :

**Séparation des responsabilités WebView / RN**

- Tout ce qui touche le contenu du livre (swipe, tap sur le fond, futur tap
  sur le texte) est géré **dans la WebView**, dans le bridge
  (`foliateReaderHtml.ts`), via `ReactNativeWebView.postMessage` vers RN.
- RN est réservé au chrome : bouton retour, overlay de chargement, future
  bottom sheet dictionnaire.
- Il n'y a pas de `GestureDetector`, `Pressable absoluteFill`, ni
  `PanResponder` au-dessus de la WebView côté RN.

**Accès aux contentDocuments des iframes Foliate**

Foliate rend chaque section EPUB dans une `<iframe>` à l'intérieur d'un
`attachShadow({ mode: "closed" })`. Les touch events ne traversent pas la
frontière iframe. La seule voie d'accès correcte aux documents internes est :

```js
view.renderer.getContents()
// retourne [{ doc: iframe.contentDocument }, ...]
```

C'est l'équivalent exact de `rendition.getContents()` dans EPUB.js, utilisé
dans `dictionaryTapScript.ts` et `rtlSwipeScript.ts` de l'ancien reader.

Les listeners touch sont attachés directement sur chaque `contentDocument`
retourné par `getContents()`, pas sur le document parent de la WebView.

**Re-attachement des listeners**

Chaque nouveau spine = nouvel iframe = nouveau `contentDocument`. Les
listeners précédents disparaissent avec l'ancien document. Le re-attachement
se fait dans le handler `view.addEventListener("load", ...)` qui fire à
chaque changement de section.

Un flag `doc.__suzumeTouchAttached` empêche le double-attachement sur un
même document. Un nouveau `contentDocument` n'a pas ce flag → listeners
attachés. Un même document déjà vu → no-op.

**Mapping swipe / direction (RTL)**

Pour un livre japonais RTL :

| Geste (dx) | Appel | Effet Foliate RTL |
|---|---|---|
| dx > 0 (droite) | `view.goLeft()` | `next()` → avance dans la lecture |
| dx < 0 (gauche) | `view.goRight()` | `prev()` → recule dans la lecture |

Ce mapping a été confirmé par les logs : `raw` augmente avec swipe droite
(goLeft) et diminue avec swipe gauche (goRight) dans les sections où la
navigation fonctionne.

---

## 3. Risques identifiés

### Shadow DOM closed + iframes

Foliate utilise `attachShadow({ mode: "closed" })` pour son renderer. Il est
impossible d'accéder à `view.renderer.shadowRoot` depuis l'extérieur. Toute
tentative de traverser le shadow DOM directement cassera. Seules les APIs
exposées par Foliate (`getContents()`, `renderer.page`, `renderer.pages`,
etc.) sont accessibles.

### `getContents()` : API non versionnée

`getContents()` est présent dans notre bundle bundlé (`foliateBundle.ts`,
~300 KB). foliate-js ne publie pas de package npm versionné. Si le bundle est
mis à jour, la présence et le comportement de `getContents()` doivent être
re-vérifiés manuellement.

### Timing de re-attachement

Le handler `load` fire quand Foliate a chargé la section. À ce moment,
`frame.contentDocument` devrait être le document final. Mais si le renderer
Foliate effectue un second cycle de layout après le `load` event (par ex.
lors de la columnisation), il est théoriquement possible que le document
retourné par `getContents()` au moment du `load` soit intermédiaire.

Ce risque n'a pas été observé en pratique (les logs montrent les touches bien
reçues après chaque crossing), mais il reste un point de vigilance.

### Navigation fragile aux frontières de spine

Voir section 4 (bug actuel). Le premier `prev()` ou `next()` après un
crossing de spine est instable dans la version actuelle.

### `goLeft`/`goRight` vs `next`/`prev`

`goLeft()`/`goRight()` sont direction-aware : Foliate adapte la direction en
fonction de `view.book.dir`. `next()`/`prev()` sont toujours dans l'ordre du
spine, indépendamment de la direction. Il n'a pas encore été testé si `next()`
/ `prev()` se comportent différemment de `goLeft()`/`goRight()` aux
frontières de spine. Ce point est à explorer lors du diagnostic du bug
actuel.

### Pages sentinelles / `renderer.page` / `renderer.pages`

**RÉSOLU — voir section 8.**

Foliate's paginator inclut deux pages sentinelles structurelles dans
`renderer.pages`. Les pages de contenu réelles sont `1` à `renderer.pages -
2`. `renderer.page` vaut `0` ou `renderer.pages - 1` pendant les crossings
de spine. Le bridge filtre maintenant ces états avant de libérer `isPaging`.

### Dedup `relocate` potentiellement trop agressif

Non reproduit après la correction de `isPaging` (section 8). À surveiller.

### Double navigation Foliate + bridge sur le même swipe

**RÉSOLU — voir section 8.**

Foliate enregistre ses propres listeners `touchstart/touchmove/touchend` sur
le même `contentDocument` que le bridge. Sans précaution, Foliate déclenchait
un `snap()` concurrent avec `#goTo` sans vérifier `#locked`, pouvant détruire
l'iframe en cours de chargement et geler `#locked` définitivement.

### Futur dictionnaire : adaptation de `dictionaryTapScript.ts`

`dictionaryTapScript.ts` a été écrit pour l'ancien reader EPUB.js. La
majeure partie est portable telle quelle dans le bridge Foliate. Points de
différence à gérer lors de l'implémentation :

- Remplacer `rendition.getContents()` par `view.renderer.getContents()`
- La variable `doc` est celle passée à `attachTouchListeners`, pas à
  re-chercher via `rendition`
- Les highlight spans (`suzume-dictionary-highlight`) s'insèrent dans le
  `contentDocument` de l'iframe, pas dans le document parent

---

## 4. Bug résolu : navigation bloquée après crossing de spine

### Symptômes observés

Dans une session avec cache HIT (pagination connue, section 24 restaurée) :

```
cache HIT totalPages=591
[FOLIATE-SPIKE] last position sec=24 cfi=epubcfi(...)
[FOLIATE-TOUCH] attached contents=1
[FOLIATE-SPIKE] LOADED spine=24
RELOCATED sec=24/...
```

Navigation en sec=24 : **fonctionne correctement**

```
[FOLIATE-TOUCH] swipe right -> goLeft   → RELOCATED sec=24 raw=2/25
[FOLIATE-TOUCH] swipe right -> goLeft   → RELOCATED sec=24 raw=3/25
[FOLIATE-TOUCH] swipe left -> goRight   → RELOCATED sec=24 raw=2/25
[FOLIATE-TOUCH] swipe left -> goRight   → RELOCATED sec=24 raw=1/25
```

Crossing vers sec=23 :

```
[FOLIATE-TOUCH] swipe left -> goRight
[FOLIATE-SPIKE] LOADED spine=23
[FOLIATE-TOUCH] attached contents=1
RELOCATED sec=23 raw=29/31 global=396/591
```

Navigation après le crossing : **bloquée**

```
[FOLIATE-TOUCH] swipe left -> goRight
[FOLIATE-SPIKE] relocate #N ignored (dup sid=...)
[FOLIATE-TOUCH] swipe right -> goLeft
[FOLIATE-SPIKE] relocate #N ignored (dup sid=...)
```

Le footer reste figé sur `sec=23 raw=29/31 global=396/591`. Les logs
`[FOLIATE-TOUCH]` continuent d'apparaître → les touch listeners sont actifs
et les gestes sont détectés. La navigation semble appelée mais rien ne change
de manière visible.

### Hypothèse principale : dedup sans fenêtre temporelle

La clé de dedup est :

```js
var key = (cfi || "") + "|" + (section.current != null ? section.current : "");
```

Après le landing sur sec=23 raw=29, `lastRelocateKey` vaut
`"epubcfi(...):X|23"` (la position d'ancrage de fin de section).

Hypothèse : lorsque `view.goRight()` (prev) est appelé depuis cette position
de crossing, Foliate résout la navigation vers la même ancre de fin de section
et fire un `relocate` avec le même `(cfi, section)`. Ce relocate est filtré
par le dedup → `lastRelocateKey` ne change pas → toutes les navigations
suivantes sont bloquées en cascade.

Cette hypothèse est **sérieuse mais non prouvée**. Elle explique bien les
logs observés, mais la cause interne (pourquoi Foliate résout vers le même
ancre) n'a pas encore été confirmée par inspection directe de
`renderer.page`.

### Hypothèse alternative : Foliate ne change pas renderer.page

Il est également possible que `view.goRight()` soit bien appelé mais que
Foliate ne change pas réellement `renderer.page` après un crossing. Dans ce
cas, aucun `relocate` ne serait fire du tout — ou un relocate "identique"
serait fire sans que la page ait bougé, pour une raison interne au paginator
(sentinel, état transitoire, bug Foliate).

### Point à trancher avant toute correction

```
Cas A : renderer.page change après le swipe bloqué
         → problème dans le bridge / dedup
         → correction : fenêtre temporelle sur le dedup

Cas B : renderer.page ne change pas après le swipe bloqué
         → problème de navigation Foliate / mapping / sentinel / frontière
         → correction différente, potentiellement tester next/prev à la place
```

La prochaine étape de diagnostic est d'**ajouter des logs
`before`/`after` autour de chaque appel de navigation** (voir section 5)
pour observer directement si `renderer.page` change ou non.

---

## 5. Corrections potentielles à évaluer

### Très probablement utile (appliquer en premier)

**Enrichir les logs de navigation**

Avant tout autre changement, ajouter dans `attachTouchListeners` (dans le
bridge) un log before/after pour chaque navigation :

```js
rnPost("log",
  "[FOLIATE-NAV] BEFORE action=" + action +
  " sec=" + currentSectionIndex +
  " page=" + view.renderer.page +
  "/" + view.renderer.pages
);
view.goLeft(); // ou goRight(), next(), prev()
```

Et dans le handler `relocate`, logguer `renderer.page` au moment du fire.
Cela permettra de trancher entre Cas A et Cas B sans ambiguïté.

**Ajouter un guard `isPaging`**

Empêcher plusieurs navigations simultanées, comme l'ancien reader :

```js
var isPaging = false;
// dans touchend, branche swipe :
if (!isPaging) {
  isPaging = true;
  view.goLeft(); // ou goRight()
  setTimeout(function() { isPaging = false; }, 300);
}
```

Ce guard est indépendant du bug de dedup. Il est utile même si le bug est
du Cas B.

### À confirmer avant application (attendre le diagnostic)

**Ajouter une fenêtre temporelle sur le dedup**

Si le diagnostic confirme le Cas A, modifier le dedup :

```js
var lastRelocateTs = 0;
var DEDUP_WINDOW_MS = 200;

// dans le handler relocate :
var now = Date.now();
if (key && key === lastRelocateKey && (now - lastRelocateTs) < DEDUP_WINDOW_MS) {
  // ignorer
  return;
}
lastRelocateKey = key;
lastRelocateTs = now;
```

Les rafales de stabilisation du paginator arrivent en <50ms. Un swipe
utilisateur est toujours >300ms après le dernier relocate accepté. 200ms est
une fenêtre raisonnable, à ajuster si des faux positifs ou faux négatifs
apparaissent.

**Tester `next()`/`prev()` à la place de `goLeft()`/`goRight()` aux frontières**

Si le diagnostic confirme le Cas B, essayer de remplacer les appels de
navigation par `view.next()` / `view.prev()`. Ces méthodes ne sont pas
direction-aware ; elles naviguent toujours dans l'ordre du spine. Il faudrait
alors adapter le mapping dans le touch handler pour tenir compte de
`bookDir`. À n'essayer qu'après avoir observé le comportement de
`renderer.page` en Cas B.

**Re-attacher les listeners sur `relocate` en plus de `load`**

Ajouter `attachToAllContents()` au début du handler `view.relocate`. Cette
opération est idempotente (flag `__suzumeTouchAttached`). Elle couvre le cas
hypothétique où le `load` tirerait sur un document transitoire. Peu de
risque, mais faible priorité.

### À éviter

- Revenir à une couche RN full-screen (`GestureDetector`, `Pressable
  absoluteFill`, `PanResponder`) : bloque le futur tap dictionnaire.
- Masquer le bug avec une boucle `setInterval` ou un `setTimeout` de retry
  côté RN : créerait de la dette difficile à retirer sans casser l'UX.
- Double-posting du message `relocated` pour contourner le dedup sans le
  corriger : désynchroniserait la sauvegarde de position et la pagination.

---

## 6. Tests manuels recommandés

Checklist à dérouler dans l'ordre après chaque correction.

- [ ] **Navigation dans une même section** : 5 swipes avant, 5 swipes arrière
  en sec=24. Vérifier que `raw` monte et descend sans `dup` dans les logs.

- [ ] **Crossing sec=24 → sec=23** : swipe gauche depuis sec=24 raw=1.
  Vérifier landing sur sec=23 raw=29/31.

- [ ] **Navigation après landing en sec=23** : au moins 3 swipes gauche
  (reculer) depuis raw=29. Vérifier que `raw` descend : 29 → 28 → 27.

- [ ] **Crossing vers section suivante** : depuis une dernière page, swipe
  droite. Vérifier landing en section+1 raw=1, puis navigation raw 1→2→3.

- [ ] **Plusieurs crossings consécutifs** : 5 passages de frontière d'affilée.
  Vérifier que la navigation post-landing fonctionne à chaque fois.

- [ ] **Swipes rapides** : 3 swipes en <200ms. Vérifier qu'un seul est traité
  (guard `isPaging`), pas de saut de plusieurs pages.

- [ ] **Tap fond → chrome toggle** : tap court → back button apparaît, tap
  à nouveau → disparaît. Vérifier `reader-background-tap` dans les logs.

- [ ] **Reprise CFI** : lire jusqu'en sec=23 raw=15, fermer, rouvrir. Vérifier
  `cache HIT`, `last position sec=23`, et `RELOCATED` avec CFI précis (contient
  `:`).

- [ ] **Compatibilité tap futur dictionnaire** : vérifier qu'un tap court sur
  du texte ne déclenche que `reader-background-tap` (comportement actuel
  attendu), et qu'aucune couche ne bloque les coordonnées du touch event.

---

## 7. Recommandation pour l'agent d'implémentation

**Ne pas modifier le dedup en premier.**

Le bug est ambigu : les logs montrent que les swipes sont détectés et que les
appels de navigation sont bien émis, mais on ne sait pas encore si
`renderer.page` change côté Foliate.

**Étape 1 — Diagnostic**

Ajouter les logs `before`/`after` autour de chaque appel de navigation dans
`foliateReaderHtml.ts` :

- `currentSectionIndex` au moment du swipe
- `view.renderer.page` et `view.renderer.pages` avant l'appel
- l'action appelée (`goLeft`, `goRight`, `next`, `prev`)
- un log dans le handler `view.relocate` qui print `renderer.page` au moment
  du fire, avant le test de dedup

Reproduire le bug (crossing sec=24→23, puis swipe bloqué) et observer :

> **Cas A** : `renderer.page` change après le swipe → le problème est dans
> le bridge (dedup). Appliquer la fenêtre temporelle de 200ms.

> **Cas B** : `renderer.page` ne change pas → le problème est dans la
> navigation Foliate. Tester `next()`/`prev()` à la place de
> `goLeft()`/`goRight()`, et/ou ajouter un délai après le `load` avant
> d'accepter des navigations.

**Étape 2 — Guard `isPaging`**

Ajouter le guard de 300ms indépendamment du résultat du Cas A/B. C'est une
amélioration de robustesse sans risque.

**Étape 3 — Correction ciblée selon le cas**

Appliquer la correction identifiée à l'étape 1. Re-dérouler la checklist
complète de tests manuels.

**Ce qu'il ne faut pas toucher**

- `src/app/reader.tsx` et tout `src/features/reader/` : reader EPUB.js de
  production, hors scope.
- `src/features/reader-foliate/pagination/` : le système de pagination et
  cache fonctionne correctement, ne pas modifier sans raison précise.

---

## 8. Diagnostic et correction du bug de crossing (résolu)

### Cause racine confirmée par inspection du code source Foliate

**`paginator.js` — pages sentinelles structurelles**

Le paginator Foliate ajoute systématiquement deux colonnes vides (sentinelles)
à chaque section, indépendamment du contenu EPUB :

```js
// expand() — paginator.js
this.#element.style[side] = `${expandedSize + this.#size * 2}px`
// pages = pageCount + 2
```

Pages de contenu : `1..renderer.pages - 2`.
Sentinelles : `0` (avant) et `renderer.pages - 1` (après).

Confirmé par `#scrollToAnchor` (ne scroll jamais vers page < 1) et par la
formule `fraction = (page - 1) / (pages - 2)` dans `#afterScroll`.

**Séquence d'un crossing backward (depuis page=1 de sec=N) :**

1. `#scrollPrev` scroll vers page=0 (sentinelle) → `#afterScroll` →
   **relocate(sec=N, page=0)** — sentinelle, `#locked=true`
2. `#goTo(N-1)` → iframe load → **load(N-1)**
3. `scrollToAnchor(1)` → scroll vers page=pages-2 → **relocate(sec=N-1, page=pages-2)**
4. `wait(100)` → `#locked=false`

Le relocate intermédiaire (étape 1) est une étape **structurelle invariante**
de tout crossing, pas un artefact de l'EPUB.

**Double navigation : Foliate attache ses propres listeners touch**

`paginator.js` enregistre `touchstart/touchmove/touchend` en bubble phase sur
le même `contentDocument` que le bridge (via son propre événement `load`) :

```js
// paginator.js
this.addEventListener('load', ({ detail: { doc } }) => {
    doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
})
```

`#onTouchEnd` → `requestAnimationFrame(() => snap())`. Dans `snap()`, `#goTo`
est appelé **sans vérifier `#locked`**. Au moment du rAF, l'iframe de la
nouvelle section n'est pas encore chargée (`pages=0`), ce qui produisait
`page >= pages-1 = -1` toujours vrai → `#goTo` concurrent → `#createView()`
détruisait l'iframe en cours → `#turnPage` ne résolvait jamais → `#locked`
restait `true` indéfiniment.

### Corrections appliquées

**1. Capture phase + `stopImmediatePropagation` dans `attachTouchListeners`**

Les listeners du bridge sont maintenant en `{ capture: true }`. La capture
précède le bubble dans le modèle DOM → nos handlers tirent en premier.
`e.stopImmediatePropagation()` bloque ensuite `#onTouchStart`, `#onTouchMove`
et `#onTouchEnd` de Foliate. `snap()` n'est donc jamais planifié.

```js
doc.addEventListener("touchstart", function (e) {
  e.stopImmediatePropagation(); // bloque #onTouchStart Foliate
  ...
}, { capture: true, passive: true });
doc.addEventListener("touchmove", function (e) {
  e.stopImmediatePropagation(); // bloque #onTouchMove (scrollBy)
}, { capture: true, passive: true });
doc.addEventListener("touchend", function (e) {
  e.stopImmediatePropagation(); // bloque #onTouchEnd (snap)
  ...
}, { capture: true, passive: true });
```

**2. Filtre sentinel dans le handler `relocate`**

`isPaging` n'est libéré que sur un relocate de page de contenu :

```js
var isSentinel = rendPages <= 2 || rendPage < 1 || rendPage > rendPages - 2;
if (isSentinel) return; // guard maintenu, relocated non posté
releasePaging("relocate");
```

Pendant un crossing, le relocate sentinel ne libère plus le guard. La
libération arrive uniquement après le chargement complet de la nouvelle spine
et le scroll vers l'ancre cible.

### Architecture de navigation validée

```
touch (iframe contentDocument)
  → capture listener Suzume (touchend)
    → stopImmediatePropagation (Foliate #onTouchEnd bloqué)
    → isPaging guard
    → view.goLeft() / view.goRight()
      → Foliate #turnPage → #locked=true
        → #scrollPrev/#scrollNext → sentinel → relocate [ignoré]
        → #goTo(adjacent) → iframe load → load event
        → scrollToAnchor → relocate [page de contenu]
          → releasePaging("relocate")
          → #locked=false (100ms plus tard)
```

Testé sur plusieurs allers-retours inter-spines, y compris des frontières
autres que sec23/sec24, sans gel observé.

### Logs en mode DEBUG_NAV=true

```
// backward crossing sec=24 page=1/25 → sec=23 page=29/31
[FOLIATE-NAV] paging locked action=goRight sec=24 page=1/25
[FOLIATE-NAV] RELOCATE-FIRE #N sec=24 page=0/25 [SENTINEL — guard held]
[FOLIATE-SPIKE] LOADED spine=23
[FOLIATE-NAV] RELOCATE-FIRE #N+1 sec=23 page=29/31
[FOLIATE-NAV] paging released by relocate action=goRight sec=23 page=29/31
```
