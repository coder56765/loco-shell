#!/usr/bin/env bash
# Compile the settings schema and link this folder into the user's GNOME Shell
# extensions directory. GNOME on Wayland only picks up a new extension, or new
# code, after logging out and back in.
#
#   ./install.sh                   compile + link
#   ./install.sh --update-kitchen  also rebuild kitchen.txt.gz from the latest
#                                  Emoji Kitchen data (downloads ~100 MB once)
set -euo pipefail

uuid="loco-shell@ali"
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
kitchen_url="https://raw.githubusercontent.com/xsalazar/emoji-kitchen-backend/main/app/metadata.json"

# glib-compile-schemas lives in glib's dev output on NixOS, which is usually
# not on PATH.
compile_schemas() {
    if command -v glib-compile-schemas >/dev/null; then
        glib-compile-schemas "$src/schemas"
    elif command -v nix-shell >/dev/null; then
        nix-shell -p glib --run "glib-compile-schemas '$src/schemas'"
    else
        echo "glib-compile-schemas not found; install glib's dev tools" >&2
        exit 1
    fi
}

# Shrinks the ~100 MB metadata.json into the compact index the extension reads:
#   v1 / known emoji codepoints / dates / one "left right date" index line per
#   latest sticker. Image URLs are rebuilt from those three fields.
update_kitchen() {
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    echo "Downloading Emoji Kitchen data…"
    curl -fsSL -o "$tmp/metadata.json" "$kitchen_url"
    python3 - "$tmp/metadata.json" "$src/kitchen.txt.gz" <<'PY'
import gzip, json, sys

URL = 'https://www.gstatic.com/android/keyboard/emojikitchen/{date}/{l}/{l}_{r}.png'
def upath(cp):
    return '-'.join('u' + p for p in cp.split('-'))

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as f:
    data = json.load(f)

known = list(data['knownSupportedEmoji'])
index = {cp: i for i, cp in enumerate(known)}
dates, date_index = [], {}
pairs, seen, mismatches = [], set(), 0

for entry in data['data'].values():
    for combos in entry.get('combinations', {}).values():
        for c in combos:
            if not c.get('isLatest'):
                continue
            left, right, date = c['leftEmojiCodepoint'], c['rightEmojiCodepoint'], c['date']
            if (left, right) in seen:
                continue
            seen.add((left, right))
            # The extension rebuilds URLs; skip anything that doesn't follow the pattern.
            if URL.format(date=date, l=upath(left), r=upath(right)) != c['gStaticUrl']:
                mismatches += 1
                continue
            for cp in (left, right):
                if cp not in index:
                    index[cp] = len(known)
                    known.append(cp)
            if date not in date_index:
                date_index[date] = len(dates)
                dates.append(date)
            pairs.append((index[left], index[right], date_index[date]))

lines = ['v1', ' '.join(known), ' '.join(dates)] + [f'{a} {b} {d}' for a, b, d in pairs]
with gzip.open(dst, 'wt', encoding='utf-8', compresslevel=9) as out:
    out.write('\n'.join(lines) + '\n')
print(f'kitchen.txt.gz: {len(known)} emoji, {len(pairs)} stickers ({mismatches} skipped)')
PY
}

if [[ "${1:-}" == "--update-kitchen" ]]; then
    update_kitchen
fi

compile_schemas
echo "Compiled $src/schemas"

mkdir -p "$(dirname "$dest")"
ln -sfn "$src" "$dest"
echo "Linked $dest -> $src"
