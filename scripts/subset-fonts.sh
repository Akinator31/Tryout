#!/usr/bin/env bash
# Rebuilds the IBM Plex subsets in packages/tokens/fonts from IBM's npm packages.
#
# The UI bundles only what it uses: Plex Sans 400/500/600 and Plex Mono 400 cut to Latin
# (English and French), and Plex Sans Condensed 500 cut to digits and ":" for the queue
# number and countdowns. Run it again when the Plex version or a character range changes.
#
# Needs npm and pyftsubset (fonttools, with brotli for woff2).
#
# Usage: scripts/subset-fonts.sh
set -euo pipefail

PLEX_SANS=1.1.0
PLEX_SANS_CONDENSED=2.0.0
PLEX_MONO=2.5.0

# Basic Latin, Latin-1, œ/Œ, thin and narrow no-break spaces, dashes, curly quotes, ellipsis, arrow.
LATIN="U+0020-007E,U+00A0-00FF,U+0152-0153,U+2009,U+2013-2014,U+2018-2019,U+201C-201D,U+2026,U+202F,U+2192"
DIGITS="U+0020,U+0030-003A"

out="$(cd "$(dirname "$0")/.." && pwd)/packages/tokens/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# fetch <package> <version>: unpacks an @ibm font package into $work/<package>.
fetch() {
  (cd "$work" && npm pack --silent "@ibm/$1@$2" >/dev/null)
  mkdir -p "$work/$1"
  tar xzf "$work"/ibm-"$1"-"$2".tgz -C "$work/$1"
}

# subset <source woff2> <unicodes> <features> <output name>
subset() {
  pyftsubset "$1" --unicodes="$2" --layout-features="$3" --flavor=woff2 --output-file="$out/$4"
}

fetch plex-sans "$PLEX_SANS"
fetch plex-sans-condensed "$PLEX_SANS_CONDENSED"
fetch plex-mono "$PLEX_MONO"

sans="$work/plex-sans/package/fonts/complete/woff2"
subset "$sans/IBMPlexSans-Regular.woff2" "$LATIN" kern,liga,tnum plex-sans-400.woff2
subset "$sans/IBMPlexSans-Medium.woff2" "$LATIN" kern,liga,tnum plex-sans-500.woff2
subset "$sans/IBMPlexSans-SemiBold.woff2" "$LATIN" kern,liga,tnum plex-sans-600.woff2

condensed="$work/plex-sans-condensed/package/fonts/complete/woff2"
subset "$condensed/IBMPlexSansCondensed-Medium.woff2" "$DIGITS" kern,tnum plex-sans-condensed-500-digits.woff2

mono="$work/plex-mono/package/fonts/complete/woff2"
subset "$mono/IBMPlexMono-Regular.woff2" "$LATIN" kern plex-mono-400.woff2

cp "$work/plex-sans/package/LICENSE.txt" "$out/OFL.txt"
chmod 644 "$out/OFL.txt"
ls -l "$out"
