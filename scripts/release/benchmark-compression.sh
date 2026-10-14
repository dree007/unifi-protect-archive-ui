#!/bin/sh
# Offline benchmark only; does not download or publish any artifact.
set -eu
bundle=${1:?Usage: benchmark-compression.sh BUNDLE OUTPUT}
output=${2:?Usage: benchmark-compression.sh BUNDLE OUTPUT}
mkdir -p "$output"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$output/payload.tar" -C "$bundle" .
for format in gzip xz zstd; do
  case "$format" in
    gzip) extension=gz; set -- gzip -n -6 -c ;;
    xz) extension=xz; set -- xz -1 -T1 -c ;;
    zstd) extension=zst; set -- zstd -3 -T1 -q -c ;;
  esac
  /usr/bin/time -f 'elapsed=%e user=%U system=%S peak_rss_kib=%M' -o "$output/$format-compress.txt" "$@" "$output/payload.tar" > "$output/native-source.tar.$extension"
  /usr/bin/time -f 'elapsed=%e user=%U system=%S peak_rss_kib=%M' -o "$output/$format-decompress.txt" "$format" -dc "$output/native-source.tar.$extension" > /dev/null
  wc -c < "$output/native-source.tar.$extension" > "$output/$format-size.txt"
  sha256sum "$output/native-source.tar.$extension" > "$output/$format-sha256.txt"
done
