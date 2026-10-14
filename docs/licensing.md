# Licensing and source availability

Unifi Protect Archive UI is licensed under **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`). [LICENSE](../LICENSE) contains the complete license text. This does not change
third-party copyrights/licenses. No warranty is provided; redistribution is permitted under the
applicable license terms. Existing source and dependency notices must be preserved.

## Source and network use

The license distinguishes conveying source, conveying binaries, and running modified versions
that interact with users over a network. AGPL section 13 requires such modified versions to offer
those users the corresponding source. Section 6 defines delivery options for non-source forms;
source must correspond to the version actually provided. A generic project homepage or an
unavailable/incorrect revision is not a source-delivery solution.

The application's footer links to the full project license and third-party notices. Configure
`APP_SOURCE_URL` with a credential-free HTTPS URL for the complete corresponding source of the
running revision. Only HTTPS URLs without userinfo, query parameters or fragments are accepted.
Official release images already link the matching `source.tar.gz` of their GitHub release, so an
unmodified installation needs no setting. If you modify or rebuild the application, set
`APP_SOURCE_URL` to the source of your version: a link to the unmodified release does not cover your
changes. Without any source URL (for example in a local build), the footer shows “Source publication
pending” instead of a link.

Keep build/install scripts, package metadata/lockfile, migrations and deployment configuration
with the source, as specified by the publication manifest. Preserve changes/attribution notices
when redistributing modified work. Review the exact license text rather than assuming that a UI
link alone fulfills all duties.

## Source release versus locally built image

The v1.0 distribution consists of the public source and a prebuilt Linux amd64 GHCR image.
End users do not build locally. Maintainer local builds
and candidate tests are different from conveying a binary image to the public. The latter requires
complete corresponding-source and notice fulfillment before release.

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `public/notices/` preserve the font/icon/UI
licenses that accompany the source. `npm run build:cli` preserves available installed npm notices
and a package ledger in `dist/notices`, copied to `/app/notices` in the image. The Debian/Node
copyright records are retained; their presence does not by itself complete binary source duties.

## Before redistributing binaries or Docker images

An image contains the app/server/browser bundles, Node/npm, Debian packages and ffmpeg/native
libraries. Record the actual image digest, package/source versions, build configuration and all
applicable license texts. Provide complete matching source through an appropriate mechanism;
retain any relevant patches/build scripts and LGPL relinking/reverse-engineering rights.
A link to a moving upstream branch or an unverified generic download is insufficient evidence.

The inspected Debian ffmpeg build enables GPL components, including x264/x265, and identifies
itself as GPL-2.0-or-later. It is invoked as a separate executable for thumbnails; this does not
mean its binaries are relicensed as AGPL. Review obligations for every distributed native
component and required corresponding source before any image/GHCR publication. Copyleft, patent
and trademark questions are not replaced by retaining notice files. For the official image, the native source bundle (`native-source.tar.gz`) is attached to the same
GitHub release; its inventory is generated from, and checked against, the actual image. The release
publisher rejects incomplete evidence.

## License-text provenance

The full AGPL text was copied unchanged from the official
[SPDX license-list data](https://github.com/spdx/license-list-data/blob/main/text/AGPL-3.0-only.txt)
on 2026-10-12 because the canonical GNU text server was unreachable during preparation. It is the
complete license, not a rewritten summary. SPDX identifies the explicit
[AGPL-3.0-only choice](https://spdx.org/licenses/AGPL-3.0-only.html); the illustrative “or later”
application example inside the official license text does not override this project's explicit
SPDX declaration.

Primary references: [GNU AGPL](https://www.gnu.org/licenses/agpl-3.0.html),
[FFmpeg legal information](https://ffmpeg.org/legal.html),
[Debian copyright policy](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information).
This document describes how the project meets these duties; it is not blanket legal clearance.
