# Loco Shell

A GNOME Shell 50 extension with two parts:

- **Loco launcher**, inspired by Xiaomi's POCO Launcher. It replaces GNOME's Show Apps grid with a launcher that can:
  - filter apps by icon color;
  - search from a bar at the bottom;
  - pick emoji, including [Emoji Kitchen](https://emojikitchen.dev) stickers.
- **Quick tools**, inspired by Samsung's One Hand Operation+. Swipe inward from a screen edge to open a panel with brightness, volume, media controls and a grid of quick tools you choose. Keep swiping to the middle of the screen to open the launcher instead.

## Install from source

```sh
git clone https://github.com/coder56765/loco-shell
cd loco-shell
./install.sh
```

Then log out and back in (GNOME on Wayland only picks up new extensions at login) and run:

```sh
gnome-extensions enable loco-shell@ali
```

`install.sh` compiles the settings schema and links the folder into `~/.local/share/gnome-shell/extensions/`.

## Using it

**Opening the launcher**

- Super+A, the dash's Show Apps button, double-tapping Super, or a long edge swipe.
- From the overview, a three-finger touchpad swipe up that goes past the window overview reveals the launcher, following your fingers.
- A three-finger swipe down closes it.

**Launcher**

- The color dots filter apps by the dominant color of their icon. The launcher always opens on *All*.
- Type to search. Up moves from the search bar into the results, and Enter launches the first one.

**Emoji** (the 😀 button after the color dots)

- The grid shows your favorites (up to 7), your 14 most recently used emoji, then every emoji.
- Click an emoji to see its Emoji Kitchen stickers. The emoji itself stays first in that list; click it again to type it into the app you were using.
- Double-click a sticker to paste it.
- The star at the right of the color bar pins the selected emoji to your favorites. Pinning an 8th drops the oldest.
- Right-click, Escape, or picking a color clears the selection.

**Quick tools**

- Swipe in from the left or right edge, with a mouse or a finger.
- The panel's tools come from a catalog of about 50: connectivity, display, Wellbeing, accessibility, privacy, window and workspace actions, session actions, and more. You can also add your own tools that open an app or run a command.

**Settings:** use the gear tile in the quick tools panel, or the Extensions app. You can choose and order the tools, create custom tools, and turn the edges and the long swipe on or off.

## Privacy

- **Clipboard:**
  - A sticker is pasted through the clipboard.
  - So is an emoji when the target app has no input method (for example X11 apps). Your previous clipboard text is put back half a second later.
  - With nothing to type into (e.g. the launcher was opened over the overview), the emoji is copied and a notification says so.
- **Network:** Emoji Kitchen sticker images are downloaded from Google's servers (`www.gstatic.com`), only when you open an emoji's stickers. Nothing else is sent anywhere.
- **Local files:**
  - `~/.cache/loco-shell/colors.json` caches the app icon colors.
  - `~/.cache/loco-shell/kitchen/` caches the downloaded stickers.

## Emoji Kitchen data

`kitchen.txt.gz` is a compact index of which stickers exist: 619 emoji and 147,000 pairs, in about 395 KB. It's built from [xsalazar/emoji-kitchen-backend](https://github.com/xsalazar/emoji-kitchen-backend)'s `metadata.json`, which is about 100 MB. To rebuild it with the latest stickers:

```sh
./install.sh --update-kitchen
```

## Files

| File | What it holds |
|---|---|
| `extension.js` | Starts and stops everything, and takes over Show Apps |
| `launcher.js` | The launcher, its color filter, and widgets shared with the quick tools |
| `emoji.js` | The emoji picker, Emoji Kitchen, and typing/pasting into apps |
| `quickTools.js` | The quick tools, their panel, and the edge swipes |
| `toolCatalog.js` | The list of built-in tools (shared with the settings window) |
| `prefs.js` | The settings window |

## Credits

- The emoji names come from GNOME Shell's on-screen keyboard.
- The Emoji Kitchen approach follows [Mingle](https://github.com/halfmexican/mingle), and the sticker data comes from [emoji-kitchen-backend](https://github.com/xsalazar/emoji-kitchen-backend).
- Emoji Kitchen stickers are made by Google.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
