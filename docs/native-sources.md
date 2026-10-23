# Native source distribution

The application is AGPL-3.0-only. Node, Debian packages, fonts and other dependencies keep
their own terms. Each release attaches the matching `source.tar.gz` (application) and
`native-source.tar.gz` (third-party material) to its GitHub release, for example
`https://github.com/dree007/unifi-protect-archive-ui/releases/tag/v2.1.0`. A registry image ID, registry digest and source checksum are
different identities; the release manifest records them separately.

The native bundle contains exact Debian descriptors, original/patch archives, build files,
complete runtime notices, an image-derived inventory, a component matrix and SHA256SUMS.
Source packages are deduplicated by source name/version, including epochs and binary-rebuild
suffix distinctions. Supplemental permissive-license sources do not imply that every MIT,
BSD, ISC or Apache component has a corresponding-source duty.

## Verify a download

Use a disposable directory, retain the matching application source, and install its locked
maintainer dependencies with Node24. Debian source validation needs tar/gzip/dpkg-source.

```sh
sha256sum native-source.tar.gz
# Compare with the release's recorded SHA-256 before extraction.
mkdir native-sources
tar -xzf native-source.tar.gz --no-same-owner -C native-sources
(cd native-sources && sha256sum -c SHA256SUMS)
NATIVE_BUNDLE_DIRECTORY="$PWD/native-sources" npm run release:native:check
```

The checker verifies every listed file, descriptor/version, archive, extracted Debian build
material and runtime assignment. It rejects missing files, changed bytes, unsupported links,
unlisted/private material and unresolved compliance findings. With `RELEASE_OUTPUT` set to
the matching local release artifacts it also compares a fresh inventory of the actual image.
Successful checksum validation alone is not a legal opinion.

## Rebuild or replace libraries

The application starts ffmpeg as a separate process. Extract the appropriate Debian descriptor
with `dpkg-source -x` in an isolated workspace; `debian/control`, `debian/rules`, changelog and
patches identify the package's build requirements. The bundle records actual ffmpeg flags and
linked libraries. Use the application Dockerfile/lockfile from the matching source release.
Node's full multi-component license and preferred source accompany the native material.

Operators may rebuild an image and replace compatible libraries under their respective terms,
including permitted reverse engineering for debugging modifications to LGPL components.
Read-only container filesystems are runtime safeguards, not contractual restrictions on
replacement. Modified builds need their own testing and applicable source offers.

Sharp/libvips are used only as build dependencies. Their unused native runtime files are
removed in the builder before the runtime COPY; the app's image optimizer is disabled and
private thumbnails use ffmpeg. This does not affect server-side thumbnail caching.

## Availability and retention

Sources are distributed as versioned GitHub release assets, linked beside the image download
and in its package documentation. A release asset must be below 2 GiB; split material if a later
version exceeds that limit. Keep matching source and notices freely downloadable while the
corresponding image is distributed, preserve historical artifacts and maintain backups. This
is a direct-source delivery plan, not a written-offer shortcut or a blanket three-year promise.

Before publication the release pipeline checks integrity and compliance; after publication the
maintainer separately verifies that both archives download anonymously.
npm is needed during compilation, not by the standalone server, worker, migration or bundled
maintenance CLIs. Only the official Node binary and its complete license are copied into the
Debian runtime. npm/Corepack and Sharp/libvips are checked against every saved image layer,
including older layers hidden by whiteouts. The native bundle excludes the npm preferred-source
archive because those components are not distributed; Debian and Node sources remain intact.
Identical notice files share one manifest material without losing component attribution.
