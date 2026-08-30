# Scriptorium.3d

A Cyrillic Library of Babel you can walk through.

Every text of 3200 characters that can be written in the 36-symbol Russian alphabet already exists here,
each on its own page, on its own shelf, in its own hexagonal room. Nothing is stored: the library is a
**bijection** between an address and a page, so a book can be located by its address — or an address can
be located by its text.

Rendered in Three.js, choreographed with GSAP.

## How it works

The address of a page — room, wall, shelf, volume, page number — is linearised into a single integer, and
that integer is put through a 10-round balanced Feistel network over `Z_(36^3200)`. The result, read in
base 36, is the page. Because the network is a permutation of exactly that domain, running it backwards
turns any text into the one address where it lives. That is the entire search feature: not an index, an
inverse.

## Status

Work in progress.

## License

[MIT](LICENSE)
