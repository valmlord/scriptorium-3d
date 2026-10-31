# SPEC — Scriptorium.3d

Source of truth. Code that diverges from this document is either a bug or a reason to change the document
deliberately, in the same pull request. Silent divergence is not allowed.

---

## 1. What this is

A Cyrillic Library of Babel. Every page of 3200 characters over a 36-symbol alphabet exists at exactly one
address; every address holds exactly one page. Nothing is stored — the library is a **bijection** computed
on demand, so it works in both directions:

- `address → page` (browsing)
- `page → address` (search)

The library is walked through in a 3D scene: hexagonal rooms, four walls of shelves, books that open into a
readable spread.

---

## 2. Alphabet

36 symbols. **The order is part of the format** — a symbol's index is its digit value, so reordering the
table replaces every book in the library.

| Index | Symbols |
|---|---|
| 0 | `` ` `` (space, U+0020) |
| 1–33 | `а б в г д е ё ж з и й к л м н о п р с т у ф х ц ч ш щ ъ ы ь э ю я` |
| 34 | `,` |
| 35 | `.` |

All 33 Russian letters are present, `ё` and `ъ` included. Lower case only.

**Input normalization** (search only, never applied to generated text):

1. `NFC` normalize, then lower case.
2. `ё` is kept as itself — it is symbol 7, not a variant of `е`.
3. Latin homoglyphs that a Russian keyboard produces by accident (`a c e o p x` and friends) are **not**
   silently converted; unknown characters are reported to the caller, which decides whether to reject the
   query or strip them. Silent substitution changes which book the user is sent to, so it never happens
   without telling them.
4. Any whitespace run collapses to one space; `;` `:` `!` `?` `—` `-` and quotation marks are not in the
   alphabet and count as unknown.

---

## 3. Address model

```
room      arbitrary precision, 0 … ROOM_COUNT-1
wall      0…3     four of the six walls carry shelves; two are doorways
shelf     0…4
volume    0…31
page      0…409
```

Fixed constants:

```
PAGE_LENGTH      = 3200
RADIX            = 36
PAGES_PER_BOOK   = 410
BOOKS_PER_SHELF  = 32
SHELVES_PER_WALL = 5
WALLS_PER_ROOM   = 4
PAGES_PER_ROOM   = 4 * 5 * 32 * 410 = 262_400
N                = 36 ** 3200            // size of the library, ~4981 decimal digits
ROOM_COUNT       = ceil(N / PAGES_PER_ROOM)
```

Linearisation — the one canonical ordering:

```
linear = room * PAGES_PER_ROOM
       + ((wall * SHELVES_PER_WALL + shelf) * BOOKS_PER_SHELF + volume) * PAGES_PER_BOOK
       + page
```

`linear` is a `bigint` in `[0, N)`. Addresses with `linear >= N` are invalid: the **last room is partially
filled**, holding `N mod PAGES_PER_ROOM = 261_376` pages instead of 262_400. This is a real edge of the
domain, not an approximation to hide — `Address` validation rejects it and tests cover it.

**Room names** are the room number in base-36 using `0-9a-z` — a different alphabet from page text, so the
two can never be confused. A full room name runs to 3197 characters, which is authentic and inconvenient in
equal measure; see the URL scheme in §7.

The **canonical** name of a room carries no leading zeros: room 1 is `1`, never `0001`; room 0 is `0`.
Parsing stays lenient — `0001` resolves to room 1 rather than being refused, because a hand-edited URL
should land somewhere sensible — but the canonical form is the only one the application produces, and the
router rewrites a non-canonical name to it on load (§7). Without that rewrite the same room would be
reachable through unboundedly many URLs, and "this link is the page" stops being true.

Core therefore exposes both the canonical encoder and a predicate for recognising a canonical name; it does
not silently accept a non-canonical name as though it were one.

---

## 4. The bijection

### 4.1 Why a Feistel network

The obvious construction — `page = (linear * K) mod N` — is a bijection but a **linear** one: adjacent
addresses produce correlated pages, and the structure is visible to anyone who looks. A balanced Feistel
network is equally reversible and cryptographically diffusing. See `DECISIONS.md` ADR-0002.

Because `PAGE_LENGTH` is even, `N = H²` where `H = 36^1600`. The balanced Feistel is therefore a permutation
of **exactly** `[0, N)` — no cycle-walking, no unreachable pages, no special cases.

### 4.2 Parameters

```
ROUNDS      = 10
H           = 36 ** 1600
DOMAIN_TAG  = "scriptorium.3d/v1"        // UTF-8; this string IS the library's identity
PRF_BYTES   = 1051                       // ceil(1600 * log2(36) / 8) = 1035, plus 16 bytes
                                         // of slack so the modulo bias is below 2^-128
```

### 4.3 Round function

For round index `i ∈ [0, 10)` and half `x ∈ [0, H)`:

```
xb     = minimal big-endian byte encoding of x   (zero-length when x = 0)
seed   = SHA-256( DOMAIN_TAG ‖ u8(i) ‖ u32be(xb.length) ‖ xb )
stream = SHA-256(seed ‖ u32be(0)) ‖ SHA-256(seed ‖ u32be(1)) ‖ …
F(i,x) = int_be( stream[0 … PRF_BYTES) ) mod H
```

The length prefix is mandatory: without it `u8(i)` and the leading bytes of `xb` can be reordered into the
same seed for different inputs, and a collision there is a collision between two books.

### 4.4 Encryption and decryption

```
encrypt(v):                        decrypt(v):
  a = v / H,  b = v mod H            a = v / H,  b = v mod H
  for i = 0 … 9:                     for i = 9 … 0:
    a, b = b, (a + F(i,b)) mod H       a, b = (b - F(i,a)) mod H, a
  return a*H + b                     return a*H + b
```

`getPage(address) = digitsToText(encrypt(linear(address)))`
`locate(page)     = fromLinear(decrypt(textToInt(page)))`

Measured on the reference machine: encrypt 1.34 ms, decrypt 0.98 ms, all 36 symbols uniformly distributed.

### 4.5 Frozen format

`DOMAIN_TAG`, the alphabet order, `ROUNDS`, `PRF_BYTES` and the linearisation together define which text
lives at which address. **Changing any of them silently rewrites the entire library and invalidates every
link ever shared.** Consequences, all mandatory:

- `FORMAT_VERSION = 1` is exported and embedded in shareable URLs.
- Golden vectors are committed as test fixtures and are a compatibility contract, not a snapshot to
  regenerate when a test goes red. A red golden test means the format changed — that is the alarm working.

---

## 5. Public API of `core`

```ts
export const FORMAT_VERSION = 1;

export interface Address { room: bigint; wall: number; shelf: number; volume: number; page: number }
export type BookAddress = Omit<Address, 'page'>;

export function getPage(address: Address): string;             // exactly 3200 chars
export function locate(page: string): Address;                 // input must be exactly 3200 chars
export function getTitle(book: BookAddress): string;           // first 25 chars of page 0
export function randomAddress(): Address;

export type PadMode = 'spaces' | 'random';
export interface SearchHit { address: Address; offset: number } // offset = where the query starts

export function search(query: string, mode: PadMode, offset?: number): SearchHit;
```

`search` builds a full 3200-character page containing `query` at `offset` (random when omitted), pads the
remainder according to `mode`, and returns `locate` of it plus the offset, so the reader can highlight the
phrase. A book **title** is defined as the first 25 characters of its page 0 — which makes title search a
special case of `search`, not a second mechanism.

Errors are dedicated types, never bare `Error`: `InvalidAddressError`, `InvalidPageLengthError`,
`UnknownSymbolError` (carrying the offending characters and their positions).

---

## 6. Runtime architecture

```
src/
  core/     pure TypeScript. No DOM, no three, no gsap. The whole bijection lives here.
  worker/   the core behind a Web Worker: typed protocol, request ids, cancellation, LRU cache
  engine/   three.js: renderer, hexagonal room, instanced spines, lighting, fog, LOD
  motion/   gsap: CameraRig, master timeline with labels, easing tokens
  state/    navigation FSM: LIBRARY → ROOM → WALL → SHELF → BOOK → PAGE
  ui/       DOM overlays: reader, search, address bar, i18n
  app/      router (URL ↔ address) and composition of the layers
```

Invariants enforced by lint, not by good intentions — see `docs/architecture.md`.

**Animation model.** Every transition between navigation levels is one GSAP timeline carrying a label.
Going back is `.reverse()` of that same timeline, never a second hand-written animation. GSAP animates a
plain `CameraRig` object of numeric fields; the rig is applied to the three.js camera once per frame. GSAP
never touches three.js objects directly.

**Generation off the main thread.** 1.3 ms per page is fine once and ruinous 32 times in a frame while
generating shelf titles. All generation goes through the worker client, which caches and can cancel.

---

## 7. URL scheme

```
#/v1/r/<room-base36>/w/<0-3>/s/<0-4>/b/<0-31>/p/<0-409>[?q=<query>&lang=ru|en]
```

- `v1` is `FORMAT_VERSION`. A URL carrying an unknown version is refused with an explanation, never
  silently opened at the wrong book.
- Room names reach ~3197 characters. That is within every browser's fragment limit, but the UI must offer
  copy-to-clipboard rather than expecting anyone to read the address bar.
- Browser back and forward drive the navigation FSM; they never desynchronise from the camera.

---

## 8. Interface

Bilingual, RU and EN, switchable at runtime and remembered. The **library text itself is always Cyrillic** —
translation applies to interface chrome only. Language lives in the URL so a shared link opens in the
language it was shared in.

Accessibility is a requirement, not a milestone that can be dropped: `prefers-reduced-motion` collapses
camera flights to instant cuts, the whole hierarchy is reachable from the keyboard, and the reader is real
selectable text.

---

## 9. Stack

`three 0.185` · `gsap 3.15` (core only, no Club plugins) · `vite 8` · `typescript 5.9` ·
`vitest 4` + `fast-check 4` · `@noble/hashes 2`.

TypeScript is pinned to **5.9.x, not 7.x**: `typescript-eslint@8` requires `typescript <6.1.0`.
