# Third-party notices

Protect Archive UI 1.0.0 is licensed under **AGPL-3.0-only**; see the full root `LICENSE`
(also served at `/notices/LICENSE.txt`).
Independently licensed dependencies/assets retain their own copyrights and terms. Do not remove
their required notices or treat the project license as ownership of third-party work.

| Component | License / evidence | Notice delivery |
|---|---|---|
| Original favicon `src/app/icon.svg` | Original artwork; owner confirmed publication permission on 2026-10-12 | Covered by the project license; no invented author |
| Lucide icons including Cctv / Feather-derived icons | Installed lucide-react 1.52.0: ISC / included MIT notice | Exact `public/notices/Lucide-LICENSE.txt` |
| Inter, Inter Tight, Geist Mono | Google Fonts families, each SIL OFL 1.1 | Exact texts in `public/notices/Fonts-OFL.txt` |
| shadcn/ui-derived components and shadcn CLI | Installed shadcn 4.21.2: MIT, copyright notice retained | Exact `public/notices/shadcn-LICENSE.txt` and installed notice bundle |
| Next, React, React DOM, Radix, cn, pg, ws, server-only, tw-animate-css | Installed locked packages: MIT | Available package LICENSE/NOTICE files in `dist/notices/npm` |
| Drizzle ORM and Class Variance Authority | Installed locked packages: Apache-2.0 | Full installed licenses and available notices in the bundle |
| Development/build tools | Locked packages including Apache-2.0 and MIT terms | Collected as a conservative superset; not all execute at runtime |
| Sharp 0.35.5 / @img/sharp-linux-x64 0.35.5 | Apache-2.0; build dependency only | Unused addon is removed before runtime COPY; installed build notices retained |
| @img/sharp-libvips-linux-x64 1.3.4 | LGPL-3.0-or-later; build dependency only | Its unused binary is absent from every application-image layer; original build notices retained |
| Node runtime | Exact upstream multi-component LICENSE | Official Node binary and `/usr/local/LICENSE` are copied into a pinned Debian runtime; npm is not distributed |
| Debian ffmpeg/codecs/native libraries | Actual build is GPL-enabled; ffmpeg identifies GPL-2.0-or-later; other libraries retain package-specific terms | Copyright records under `/usr/share/doc`, common texts under `/usr/share/common-licenses` |

`npm run build:cli` copies available installed LICENSE/NOTICE/COPYING files plus public asset
texts and records package versions/licenses in `dist/notices`. Docker includes this at
`/app/notices` and the full root LICENSE/this document. The web footer serves exact static
copies of the root project license and this notice document; parity is tested. No external
license-scanning service is used. Missing or ambiguous metadata must be reviewed, not inferred.

Font notice provenance: the `ofl/<family>/OFL.txt` files of the
[Google Fonts repository](https://github.com/google/fonts), retrieved 2026-10-16; exact texts
retained. Lucide and shadcn notices come from the
installed versions. Build-time font binaries are supplied by Next's Google Fonts integration;
recheck metadata/provenance if that supply changes. No official Ubiquiti logo is used as product
identity. Synthetic test videos are generated locally, never included as footage assets.

The prebuilt GHCR image also conveys Node, Debian, ffmpeg and native libraries, each under its
own terms. Preserve all notices and exact corresponding source where required. The release build
records the actual package/source versions, and the matching source bundles are attached to the
GitHub release of each version; an inventory or upstream homepage alone would not be sufficient.
See the source guide `docs/licensing.md`.

## Versioned native sources

Each GitHub release attaches `native-source.tar.gz` with exact Debian source packages, packaging,
license texts, runtime inventory and SHA256SUMS alongside the matching application source.
See `docs/native-sources.md` for
verification and replacement/build instructions. Each component keeps its own license; the
application AGPL identifier does not relicense Node, npm, Debian packages or fonts.

Inline pgpass/pg-types MIT notices and exact sigstore/SPDX build notices are retained under
`public/notices/runtime`. npm and its dependencies, including `@npmcli/agent`, are build tools
only. They are not copied into the runtime, and every saved image layer is checked for excluded
npm/Corepack/Sharp/libvips payloads. Original third-party attribution is not fabricated.
