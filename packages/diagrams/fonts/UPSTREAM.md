# Excalifont

The hand that writes on every drawing. Vendored, not fetched: the engine renders in Node, in
a browser and in a capture, and a face that only one of the three can reach would make the
three disagree about how wide a name is — which in this renderer means disagreeing about how
big its box is.

| | |
|---|---|
| Family | Excalifont Regular, version 1.000 |
| Copyright | Copyright (c) 2024 by Excalidraw. All rights reserved. |
| Licence | **SIL Open Font License 1.1** — see `LICENSE`, and the statement inside the font's own metadata |
| Designed by | Your Own Font Foundry (Virgil); Ján Filípek / DizajnDesign (Excalifont, modifications) |
| Trademark | Excalifont is a trademark of Excalidraw |
| From | `excalidraw/excalidraw`, `packages/excalidraw/fonts/Excalifont/`, `master`, fetched 2026-09-16 |

## The two files, and why only two

Upstream publishes seven subsets by unicode range. Two of them cover what this catalogue is
written in, and the other five are Cyrillic, Greek and combining marks that would be four
hundred kilobytes nobody reads.

| Here | Upstream | Bytes | Covers |
|---|---|---|---|
| `Excalifont-Regular-latin.woff2` | `Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2` | 24 956 | `U+20-7E`, `U+A0-FF` and punctuation — Latin, and every accent Spanish uses: á é í ó ú ñ ü ¿ ¡ |
| `Excalifont-Regular-latin-ext.woff2` | `Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2` | 12 220 | `U+100-17E` and friends — Latin Extended-A, for a name that is not in either language |

**The files are byte-for-byte upstream's.** Nothing is re-subset, re-hinted or renamed, which
is deliberate: the OFL's reserved-name clause binds a *modified* version, and an unmodified
redistribution under the original name is the one case it never touches. Renaming the files
is not a modification of the font software — the bytes are the bytes.

## What the licence requires of us, and where each is met

- **The copyright notice and the licence travel with it** → `LICENSE`, in this folder, beside
  the binaries.
- **It is not sold on its own** → it is not sold at all; it is bundled with software, which
  the OFL names explicitly as permitted.
- **A modified version may not use a reserved name** → nothing is modified.
- **The whole thing stays under this licence** → it does; the rest of this package is not
  affected, because the OFL binds the font software and not the documents set in it.
