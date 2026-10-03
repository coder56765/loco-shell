// SPDX-License-Identifier: GPL-2.0-or-later

// The launcher's emoji mode: GNOME's emoji list, Emoji Kitchen stickers,
// and typing or pasting the result into the app you were using.
//
// The emoji list is GNOME's own (the on-screen keyboard's emoji.json). Emoji
// Kitchen stickers come from kitchen.txt.gz, a compact index of
// xsalazar/emoji-kitchen-backend (rebuilt by `install.sh --update-kitchen`);
// their images are fetched from Google's servers on demand and cached in
// ~/.cache/loco-shell/kitchen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const MAX_FAVORITE_EMOJIS = 7;
const MAX_RECENT_EMOJIS = 14;
// Recents are stored with room for the favorites, which the recent row skips,
// so that row stays full and an unpinned favorite returns to its old place.
const STORED_RECENT_EMOJIS = MAX_RECENT_EMOJIS + MAX_FAVORITE_EMOJIS;
const KITCHEN_IMAGE_URL = 'https://www.gstatic.com/android/keyboard/emojikitchen';
const MAX_STICKER_DOWNLOADS = 6;
// The emoji list is loaded this long after startup, so emoji mode opens at once.
const EMOJI_PREFETCH_SECONDS = 5;
const STICKER_SIZE = 64;
// How long to wait for the app's text field to take input again after Loco closes.
const INPUT_FOCUS_WAIT_MS = 400;
// How long a pasted emoji stays on the clipboard before the old text comes back.
const CLIPBOARD_RESTORE_MS = 500;

function promiseCallback(start) {
    return new Promise((resolve, reject) => {
        start((source, res, finish) => {
            try {
                resolve(finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * @param {Gio.File} file - file to read
 * @param {Gio.Cancellable} [cancellable] - cancels the read
 * @returns {Promise<Uint8Array>} its contents
 */
function loadFileContents(file, cancellable = null) {
    return promiseCallback(done => file.load_contents_async(cancellable,
        (f, res) => done(f, res, r => f.load_contents_finish(r)[1])));
}

/**
 * @param {Gio.File} file - a gzip-compressed text file
 * @returns {Promise<string>} the decompressed text
 */
async function loadGzipText(file) {
    const compressed = await loadFileContents(file);
    const stream = new Gio.ConverterInputStream({
        base_stream: Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(compressed)),
        converter: new Gio.ZlibDecompressor({format: Gio.ZlibCompressorFormat.GZIP}),
    });
    const output = Gio.MemoryOutputStream.new_resizable();
    await promiseCallback(done => output.splice_async(stream,
        Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
        GLib.PRIORITY_DEFAULT, null, (o, res) => done(o, res, r => o.splice_finish(r))));
    return new TextDecoder().decode(output.steal_as_bytes().toArray());
}

function isSkinToneVariant(char) {
    for (const c of char) {
        const cp = c.codePointAt(0);
        if (cp >= 0x1F3FB && cp <= 0x1F3FF)
            return true;
    }
    return false;
}

/**
 * Lowercase hex codepoints joined by '-', without the FE0F emoji
 * presentation selector, which the two data sources use inconsistently.
 *
 * @param {string} char - an emoji
 * @returns {string} its matching key
 */
function emojiKey(char) {
    return [...char]
        .map(c => c.codePointAt(0))
        .filter(cp => cp !== 0xFE0F)
        .map(cp => cp.toString(16))
        .join('-');
}

function charFromCodepoints(codepoints) {
    return String.fromCodePoint(...codepoints.split('-').map(hex => parseInt(hex, 16)));
}

// Older single symbols like ☺ or ❤ default to text style; FE0F makes them
// render (and paste) as color emoji. Newer emoji (U+1F000 and up) don't need it.
function emojiText(char) {
    const codepoints = [...char];
    return codepoints.length === 1 && codepoints[0].codePointAt(0) < 0x1F000 ? `${char}\uFE0F` : char;
}

/** GNOME's emoji list, without skin-tone variants (about 1,560 emoji). */
class EmojiCatalog {
    constructor() {
        this._loading = null;
        this._byKey = new Map();
        this.items = [];
    }

    /** @returns {Promise<object[]>} items as {char, name, key} */
    load() {
        this._loading ??= (async () => {
            const file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/emoji.json');
            const list = JSON.parse(new TextDecoder().decode(await loadFileContents(file)));
            this.items = list
                .filter(e => !isSkinToneVariant(e.char))
                .map(e => ({char: e.char, name: e.name, key: emojiKey(e.char)}));
            this._byKey = new Map(this.items.map(item => [item.key, item]));
            return this.items;
        })();
        return this._loading;
    }

    nameFor(char) {
        return this._byKey.get(emojiKey(char))?.name ?? '';
    }
}

/** Which Emoji Kitchen stickers exist, read from kitchen.txt.gz. */
class KitchenIndex {
    constructor(file) {
        this._file = file;
        this._loading = null;
        this._byKey = null;
    }

    get loaded() {
        return this._byKey !== null;
    }

    load() {
        this._loading ??= (async () => {
            const lines = (await loadGzipText(this._file)).split('\n');
            if (lines[0] !== 'v1')
                throw new Error(`Unknown kitchen index format "${lines[0]}"`);

            this._known = lines[1].split(' ');
            this._dates = lines[2].split(' ');
            const keys = this._known.map(cp => cp.split('-').filter(p => p !== 'fe0f').join('-'));

            // Pairs as flat (left, right, date) indices; each emoji maps to
            // the pairs it appears in, on either side.
            const count = lines.length - 3;
            this._pairs = new Uint16Array(count * 3);
            this._byKey = new Map();
            let n = 0;
            for (let i = 3; i < lines.length; i++) {
                if (!lines[i])
                    continue;
                const [a, b, d] = lines[i].split(' ');
                this._pairs.set([+a, +b, +d], n * 3);
                for (const key of a === b ? [keys[a]] : [keys[a], keys[b]]) {
                    let list = this._byKey.get(key);
                    if (!list)
                        this._byKey.set(key, list = []);
                    list.push(n);
                }
                n++;
            }
        })();
        return this._loading;
    }

    /**
     * @param {string} char - an emoji
     * @returns {object[]} its stickers as {left, right, date, partner}; call load() first
     */
    combosFor(char) {
        const key = emojiKey(char);
        return (this._byKey.get(key) ?? []).map(n => {
            const [a, b, d] = this._pairs.subarray(n * 3, n * 3 + 3);
            const left = this._known[a];
            const right = this._known[b];
            const leftKey = left.split('-').filter(p => p !== 'fe0f').join('-');
            return {left, right, date: this._dates[d], partner: leftKey === key ? right : left};
        });
    }
}

function cancelledError() {
    return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled');
}

function kitchenPath(codepoints) {
    return codepoints.split('-').map(p => `u${p}`).join('-');
}

/** Downloads sticker images on demand into ~/.cache/loco-shell/kitchen. */
class StickerStore {
    constructor() {
        this._session = new Soup.Session({user_agent: 'loco-shell'});
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'loco-shell', 'kitchen']));
        this._cancellable = new Gio.Cancellable();
        this._queue = [];
        this._active = 0;
        this._pending = new Map();
        // Names known to be on disk, so scrolling doesn't stat files over and over.
        this._onDisk = new Set();
    }

    fileFor(combo) {
        return this._dir.get_child(`${combo.left}_${combo.right}.png`);
    }

    /** @returns {Gio.File|null} the image, if it is already in the cache */
    cachedFile(combo) {
        const file = this.fileFor(combo);
        const name = file.get_basename();
        if (this._onDisk.has(name))
            return file;
        if (!file.query_exists(null))
            return null;
        this._onDisk.add(name);
        return file;
    }

    /**
     * @param {object} combo - from KitchenIndex.combosFor()
     * @returns {Promise<Gio.File>} the cached image, downloaded if needed
     */
    ensure(combo) {
        const cached = this.cachedFile(combo);
        if (cached)
            return Promise.resolve(cached);
        const file = this.fileFor(combo);

        // One download per sticker, however many tiles ask for it.
        const name = file.get_basename();
        let entry = this._pending.get(name);
        if (!entry) {
            entry = {};
            const cancellable = this._cancellable;
            entry.promise = new Promise((resolve, reject) => {
                this._queue.push({combo, file, cancellable, resolve, reject});
                this._pump();
            }).finally(() => {
                if (this._pending.get(name) === entry)
                    this._pending.delete(name);
            });
            this._pending.set(name, entry);
        }
        return entry.promise;
    }

    _pump() {
        while (this._active < MAX_STICKER_DOWNLOADS && this._queue.length > 0) {
            const job = this._queue.shift();
            if (job.cancellable.is_cancelled()) {
                job.reject(cancelledError());
                continue;
            }
            this._active++;
            this._download(job).then(job.resolve, job.reject).finally(() => {
                this._active--;
                this._pump();
            });
        }
    }

    async _download({combo, file, cancellable}) {
        const path = kitchenPath(combo.left);
        const url = `${KITCHEN_IMAGE_URL}/${combo.date}/${path}/${path}_${kitchenPath(combo.right)}.png`;
        const message = Soup.Message.new('GET', url);
        const bytes = await promiseCallback(done => this._session.send_and_read_async(message,
            GLib.PRIORITY_DEFAULT, cancellable,
            (s, res) => done(s, res, r => s.send_and_read_finish(r))));
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()} for ${url}`);

        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        await promiseCallback(done => file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
            (f, res) => done(f, res, r => f.replace_contents_finish(r))));
        this._onDisk.add(file.get_basename());
        return file;
    }

    /** Drops queued downloads and aborts running ones (e.g. a new emoji was picked). */
    cancelAll() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._pending.clear();
        const queued = this._queue;
        this._queue = [];
        for (const job of queued)
            job.reject(cancelledError());
    }

    destroy() {
        this.cancelAll();
        this._session.abort();
    }
}

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Types and pastes into the app that had focus before Loco opened, the same
 * way GNOME's on-screen keyboard does.
 */
class TextDelivery {
    constructor() {
        this._timeouts = new Set();
        this._destroyed = false;
    }

    // A wait that destroy() cancels; after that, the caller never resumes.
    _delay(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeouts.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
    }

    /** @returns {Promise<boolean>} whether predicate() came true within timeoutMs */
    async _waitFor(predicate, timeoutMs) {
        for (let waited = 0; waited <= timeoutMs; waited += 50) {
            if (predicate())
                return true;
            // eslint-disable-next-line no-await-in-loop
            await this._delay(50);
        }
        return false;
    }

    _keyboard() {
        this._device ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        return this._device;
    }

    _tap(keyvals) {
        const keyboard = this._keyboard();
        const time = GLib.get_monotonic_time();
        for (const keyval of keyvals)
            keyboard.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        for (const keyval of [...keyvals].reverse())
            keyboard.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
    }

    /**
     * @param {string} text - what to type
     * @param {boolean} hasTarget - whether an app window will get focus back
     */
    async type(text, hasTarget) {
        if (!hasTarget) {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            Main.notify(`Copied ${text}`, 'Paste it with Ctrl+V.');
            return;
        }

        // Prefer the input method, once the app's text field has it back.
        if (await this._waitFor(() => Main.inputMethod.currentFocus !== null, INPUT_FOCUS_WAIT_MS)) {
            Main.inputMethod.commit(text);
            return;
        }

        // No input method (e.g. X11 apps): emoji have no key on the keyboard
        // layout, so paste it instead, then put the old clipboard text back.
        const clipboard = St.Clipboard.get_default();
        const previous = await new Promise(resolve =>
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (c, old) => resolve(old)));
        if (this._destroyed)
            return;
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._tap([Clutter.KEY_Control_L, Clutter.KEY_v]);
        if (previous !== null) {
            await this._delay(CLIPBOARD_RESTORE_MS);
            clipboard.set_text(St.ClipboardType.CLIPBOARD, previous);
        }
    }

    /**
     * @param {Gio.File} file - a PNG image
     * @param {boolean} hasTarget - whether an app window will get focus back
     */
    async pasteImage(file, hasTarget) {
        const bytes = await loadFileContents(file);
        if (this._destroyed)
            return;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
        if (!hasTarget) {
            Main.notify('Sticker copied', 'Paste it with Ctrl+V.');
            return;
        }
        // Give the app its keyboard focus back before pasting.
        await this._delay(150);
        this._tap([Clutter.KEY_Control_L, Clutter.KEY_v]);
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._device = null;
    }
}

// Shows a long list of equally sized tiles inside a scroll view, creating
// only the tiles on screen (plus a row above and below) and re-binding them
// as the view scrolls. Creating thousands of St widgets at once would stall
// the shell, which draws on the same thread.
const VirtualTileGrid = GObject.registerClass(
class VirtualTileGrid extends St.Widget {
    /**
     * @param {object} params - grid setup
     * @param {Function} params.createTile - () => tile object with a .button actor
     * @param {Function} params.bindTile - (tile, item) => void, fills a tile in
     * @param {St.Adjustment} params.adjustment - the scroll view's vertical
     *   adjustment; its owner calls queueUpdate() when it changes
     */
    constructor({createTile, bindTile, adjustment}) {
        super({style_class: 'loco-grid', x_expand: true});
        this._createTile = createTile;
        this._bindTile = bindTile;
        this._adjustment = adjustment;
        this._items = [];
        this._free = [];
        this._bound = new Map();
        this._cell = null;
        this._columns = 1;
        this._gridY = 0;
        this._laterId = 0;

        // One tile up front, to measure the cell size from.
        this._release(this._take());

        this.connect('notify::visible', () => this.queueUpdate());
        this.connect('destroy', () => {
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        });
    }

    get items() {
        return this._items;
    }

    setItems(items) {
        this._items = items;
        for (const tile of this._bound.values())
            this._release(tile);
        this._bound.clear();
        this.queue_relayout();
        this.queueUpdate();
    }

    /** Fills the tiles on screen in again, e.g. after the selection changed. */
    rebind() {
        for (const [i, tile] of this._bound)
            this._bindTile(tile, this._items[i]);
    }

    /** @returns {St.Button[]} the tiles currently on screen, in item order */
    realizedButtons() {
        return [...this._bound.entries()].sort((a, b) => a[0] - b[0]).map(([, tile]) => tile.button);
    }

    _cellSize() {
        if (!this._cell) {
            const probe = this._free[0] ?? this._bound.values().next().value;
            const [, width] = probe.button.get_preferred_width(-1);
            const [, height] = probe.button.get_preferred_height(width);
            if (width <= 0 || height <= 0)
                return [0, 0];
            this._cell = [width, height];
        }
        return this._cell;
    }

    vfunc_get_preferred_width(_forHeight) {
        const [width] = this._cellSize();
        return [width, width];
    }

    // The full height of every row, as the minimum too: St.Viewport sizes
    // its scrollable area from the minimum height.
    vfunc_get_preferred_height(forWidth) {
        const [width, height] = this._cellSize();
        const columns = forWidth > 0 && width > 0 ? Math.max(1, Math.floor(forWidth / width)) : 1;
        const total = Math.ceil(this._items.length / columns) * height;
        return [total, total];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = this._cellSize();
        const availWidth = box.get_width();
        const columns = width > 0 ? Math.max(1, Math.floor(availWidth / width)) : 1;
        const xOffset = Math.floor((availWidth - columns * width) / 2);

        // Moved or reflowed: the set of rows on screen may have changed.
        if (columns !== this._columns || box.y1 !== this._gridY) {
            this._columns = columns;
            this._gridY = box.y1;
            this.queueUpdate();
        }

        for (const [i, tile] of this._bound) {
            const x = xOffset + (i % columns) * width;
            const y = Math.floor(i / columns) * height;
            tile.button.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + height}));
        }
    }

    // Binding changes widgets, so it runs just before the next frame rather
    // than in the middle of a layout pass.
    queueUpdate() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        if (!this.visible)
            return;
        const height = this._cell?.[1];
        if (!height) {
            this.queue_relayout();
            return;
        }

        const columns = this._columns;
        const top = this._adjustment.value - this._gridY;
        const bottom = top + this._adjustment.page_size;
        const first = Math.max(0, Math.floor(top / height) - 1) * columns;
        const last = Math.min(this._items.length - 1, (Math.floor(bottom / height) + 2) * columns - 1);

        for (const [i, tile] of this._bound) {
            if (i < first || i > last) {
                this._release(tile);
                this._bound.delete(i);
            }
        }
        for (let i = first; i <= last; i++) {
            if (this._bound.has(i))
                continue;
            const tile = this._take();
            this._bindTile(tile, this._items[i]);
            tile.button.show();
            this._bound.set(i, tile);
        }
        this.queue_relayout();
    }

    _take() {
        let tile = this._free.pop();
        if (!tile) {
            tile = this._createTile();
            this.add_child(tile.button);
        }
        return tile;
    }

    _release(tile) {
        tile.button.hide();
        this._free.push(tile);
    }
});

function tileLabel(text) {
    const label = new St.Label({
        style_class: 'loco-tile-label',
        text,
        x_align: Clutter.ActorAlign.CENTER,
        y_expand: true,
    });
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.END,
        line_alignment: Pango.Alignment.CENTER,
    });
    return label;
}

/**
 * Favorites and recent rows, then all emoji, or the selected emoji followed
 * by its Kitchen stickers. The launcher puts `actors` into its scrollable
 * column and `pinButton` into its color bar, and forwards search, scrolling
 * and keys here.
 */
export class EmojiPicker {
    /**
     * @param {object} params - setup
     * @param {Gio.Settings} params.settings - the extension's settings
     * @param {Gio.File} params.dir - the extension's folder (holds kitchen.txt.gz)
     * @param {St.ScrollView} params.scrollView - the launcher's scroll view
     * @param {object} params.launcher - {isOpen(), closeForInsert()}; the
     *   latter puts the launcher away so typed text reaches the app
     * @param {Function} params.onSelectionChanged - the selected emoji changed
     */
    constructor({settings, dir, scrollView, launcher, onSelectionChanged}) {
        this._settings = settings;
        this._scrollView = scrollView;
        this._launcher = launcher;
        this._onSelectionChanged = onSelectionChanged;

        this._catalog = new EmojiCatalog();
        this._kitchen = new KitchenIndex(dir.get_child('kitchen.txt.gz'));
        this._stickers = new StickerStore();
        this._delivery = new TextDelivery();
        this._items = null;
        this._kitchenItems = [];
        this._selected = null;
        this._pendingClick = null;
        this._active = false;
        this._query = '';
        this._destroyed = false;

        this._buildUi();

        this._settings.connectObject(
            'changed::favorite-emojis', () => this._syncPinnedRows(),
            'changed::recent-emojis', () => this._syncPinnedRows(), this);

        this._prefetchId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EMOJI_PREFETCH_SECONDS, () => {
            this._prefetchId = 0;
            this._catalog.load().catch(e => logError(e, 'loco-shell: cannot load the emoji list'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildUi() {
        // Every emoji section only creates the tiles on screen.
        const grid = () => new VirtualTileGrid({
            createTile: () => this._createTile(),
            bindTile: (tile, item) => this._bindTile(tile, item),
            adjustment: this._scrollView.vadjustment,
        });
        this._favGrid = grid();
        this._recentGrid = grid();
        this._separator = new St.Widget({style_class: 'loco-emoji-separator', x_expand: true});
        this._emojiGrid = grid();
        this._kitchenGrid = grid();
        this._status = new St.Label({
            style_class: 'loco-emoji-status',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._grids = [this._favGrid, this._recentGrid, this._emojiGrid, this._kitchenGrid];
        this.actors = [this._favGrid, this._recentGrid, this._separator,
            this._emojiGrid, this._kitchenGrid, this._status];

        // The shell also destroys these at logout without calling destroy().
        this._favGrid.connect('destroy', () => this._settings.disconnectObject(this));

        // For the launcher's color bar: pin the selected emoji to favorites.
        this._pinIcon = new St.Icon({icon_name: 'non-starred-symbolic'});
        this.pinButton = new St.Button({
            style_class: 'loco-pin-button',
            child: this._pinIcon,
            can_focus: true,
            track_hover: true,
            accessible_name: 'Pin to favorites',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.pinButton.connect('clicked', () => this._toggleFavorite());

        this._syncSections();
        this._syncPinButton();
    }

    /** @returns {string|null} the selected emoji, as typed */
    get selected() {
        return this._selected ? emojiText(this._selected) : null;
    }

    /** Shows or hides emoji mode; showing loads the data if needed. */
    setActive(active) {
        this._active = active;
        if (active)
            this._load();
        else
            this.clearSelection();
        this._syncSections();
    }

    /** The launcher's scroll position changed: emoji tiles may come and go. */
    scrolled() {
        for (const grid of this._grids)
            grid.queueUpdate();
    }

    filter(query) {
        this._query = query;
        const matches = item => !query || item.search.includes(query);
        this._emojiGrid.setItems((this._items ?? []).filter(matches));
        // The selected emoji always comes first in its sticker list.
        this._kitchenGrid.setItems(this._selected
            ? [this._item(this._selected), ...this._kitchenItems.filter(matches)]
            : []);
        this._syncSections();
    }

    /** @returns {St.Button[]} the tiles on screen, top to bottom */
    visibleTiles() {
        const grids = [this._favGrid, this._recentGrid, this._selected ? this._kitchenGrid : this._emojiGrid];
        return grids.filter(grid => grid.visible).flatMap(grid => grid.realizedButtons());
    }

    /** Enter in the search field: the first match (in Kitchen view, the selected emoji). */
    activateFirst() {
        const grid = this._selected ? this._kitchenGrid : this._emojiGrid;
        this._activate(grid.items[0]);
    }

    clearSelection() {
        this._cancelPendingClick();
        if (!this._selected)
            return;

        this._selected = null;
        this._kitchenItems = [];
        this._stickers.cancelAll();
        this._kitchenGrid.setItems([]);
        this._status.text = '';
        this._syncSelection();
    }

    /** The launcher closed: nothing should be pending any more. */
    onLauncherClosed() {
        this._cancelPendingClick();
        this._stickers.cancelAll();
    }

    _syncSections() {
        const active = this._active;
        const searching = this._query !== '';
        // Favorites only once something is pinned; both rows step aside while searching.
        this._favGrid.visible = active && !searching && this._favGrid.items.length > 0;
        this._recentGrid.visible = active && !searching && this._recentGrid.items.length > 0;
        this._separator.visible = this._favGrid.visible || this._recentGrid.visible;
        this._emojiGrid.visible = active && !this._selected;
        this._kitchenGrid.visible = active && !!this._selected;
        this._status.visible = active && this._status.text !== '';
        this.pinButton.visible = active;
    }

    async _load() {
        // Parse the sticker index now, so it's ready by the first click.
        this._kitchen.load().catch(e => logError(e, 'loco-shell: cannot read kitchen.txt.gz'));
        if (this._items)
            return;

        let items;
        try {
            items = await this._catalog.load();
        } catch (e) {
            logError(e, 'loco-shell: cannot load the emoji list');
            this._setStatus('The emoji list could not be loaded.');
            return;
        }
        if (this._destroyed || this._items)
            return;

        this._items = items.map(item => ({kind: 'emoji', ...item, search: item.name.toLowerCase()}));
        this._syncPinnedRows();
        this.filter(this._query);
    }

    _item(char) {
        const name = this._catalog.nameFor(char);
        return {kind: 'emoji', char, key: emojiKey(char), name, search: name.toLowerCase()};
    }

    _syncPinnedRows() {
        if (!this._items)
            return;
        const favorites = this._settings.get_strv('favorite-emojis');
        const favoriteKeys = new Set(favorites.map(emojiKey));
        const recents = this._settings.get_strv('recent-emojis')
            .filter(c => !favoriteKeys.has(emojiKey(c)))
            .slice(0, MAX_RECENT_EMOJIS);
        this._favGrid.setItems(favorites.map(c => this._item(c)));
        this._recentGrid.setItems(recents.map(c => this._item(c)));
        this._syncSections();
        this._syncPinButton();
    }

    _setStatus(text) {
        this._status.text = text;
        this._syncSections();
    }

    /** One tile type for emoji and stickers, reused as the grids scroll. */
    _createTile() {
        const glyph = new St.Label({
            style_class: 'loco-emoji-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            style_class: 'loco-sticker',
            icon_size: STICKER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const art = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        art.add_child(glyph);
        art.add_child(icon);

        const label = tileLabel('');
        const box = new St.BoxLayout({
            style_class: 'loco-tile-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(art);
        box.add_child(label);

        const button = new St.Button({
            style_class: 'loco-tile loco-emoji-tile',
            child: box,
            can_focus: true,
            track_hover: true,
        });
        const tile = {button, glyph, icon, label, item: null, token: 0};
        button.connect('clicked', () => this._onTileClicked(tile));
        button.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol !== Clutter.KEY_Return && symbol !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            this._activate(tile.item);
            return Clutter.EVENT_STOP;
        });
        button.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._scrollView, button));
        return tile;
    }

    _bindTile(tile, item) {
        tile.item = item;
        const token = ++tile.token;

        if (item.kind === 'emoji') {
            tile.glyph.text = emojiText(item.char);
            tile.glyph.show();
            tile.icon.hide();
            tile.label.text = item.name;
            tile.button.accessible_name = item.name || item.char;
            if (this._selected && emojiKey(this._selected) === item.key)
                tile.button.add_style_class_name('selected');
            else
                tile.button.remove_style_class_name('selected');
            return;
        }

        // A sticker: the partner emoji stands in until the image is there.
        tile.button.remove_style_class_name('selected');
        tile.glyph.text = emojiText(item.partner);
        tile.label.text = `+ ${item.name || item.partner}`;
        tile.button.accessible_name = `${this.selected ?? ''} + ${item.name || item.partner}`;

        const cached = this._stickers.cachedFile(item.combo);
        if (cached) {
            this._showStickerImage(tile, cached);
            return;
        }
        tile.icon.hide();
        tile.glyph.show();
        this._stickers.ensure(item.combo).then(file => {
            // Still showing the same sticker (tiles are reused while scrolling)?
            if (tile.token === token)
                this._showStickerImage(tile, file);
        }).catch(e => {
            if (!isCancelled(e) && !this._warnedDownload) {
                this._warnedDownload = true;
                console.warn(`loco-shell: sticker download failed: ${e.message}`);
            }
        });
    }

    _showStickerImage(tile, file) {
        tile.icon.gicon = new Gio.FileIcon({file});
        tile.icon.show();
        tile.glyph.hide();
    }

    _onTileClicked(tile) {
        const item = tile.item;
        if (!item)
            return;

        if (item.kind === 'sticker') {
            this._onDoubleClick(item, () => this._pasteSticker(item.combo));
            return;
        }
        // Clicking the selected emoji again (first in its sticker list, or in
        // the favorite/recent rows) types it; any other emoji gets selected.
        if (this._selected && emojiKey(this._selected) === item.key)
            this._insertEmoji(item.char);
        else
            this._selectEmoji(item.char);
    }

    _activate(item) {
        if (item?.kind === 'sticker')
            this._pasteSticker(item.combo);
        else if (item)
            this._insertEmoji(item.char);
    }

    /** Stickers paste on a double click; key is the item clicked. */
    _onDoubleClick(key, onDouble) {
        if (this._pendingClick?.key === key) {
            this._cancelPendingClick();
            onDouble();
            return;
        }

        this._cancelPendingClick();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Clutter.Settings.get_default().double_click_time, () => {
                this._pendingClick = null;
                return GLib.SOURCE_REMOVE;
            });
        this._pendingClick = {key, id};
    }

    _cancelPendingClick() {
        if (this._pendingClick)
            GLib.source_remove(this._pendingClick.id);
        this._pendingClick = null;
    }

    async _selectEmoji(char) {
        this.clearSelection();
        this._selected = char;
        this._kitchenItems = [];
        this._scrollView.vadjustment.value = 0;
        // Shown right away: the emoji itself first, its stickers once known.
        this._syncSelection();
        this.filter(this._query);
        if (!this._kitchen.loaded)
            this._setStatus('Loading Emoji Kitchen…');

        let combos = [];
        try {
            await this._kitchen.load();
            combos = this._kitchen.combosFor(char);
        } catch (e) {
            logError(e, 'loco-shell: cannot read kitchen.txt.gz');
        }
        // Destroyed (extension disabled) or another emoji picked meanwhile.
        if (this._destroyed || this._selected !== char)
            return;

        this._kitchenItems = combos.map(combo => {
            const partner = charFromCodepoints(combo.partner);
            const name = this._catalog.nameFor(partner);
            return {kind: 'sticker', combo, partner, name, search: name.toLowerCase()};
        });
        this._setStatus(combos.length > 0 ? '' : `No Kitchen stickers for ${emojiText(char)}`);
        this.filter(this._query);
    }

    _syncSelection() {
        for (const grid of this._grids)
            grid.rebind();
        this._syncSections();
        this._syncPinButton();
        this._onSelectionChanged();
    }

    _syncPinButton() {
        const selected = this._selected;
        const pinned = selected && this._settings.get_strv('favorite-emojis')
            .some(c => emojiKey(c) === emojiKey(selected));
        this.pinButton.reactive = !!selected;
        this._pinIcon.icon_name = pinned ? 'starred-symbolic' : 'non-starred-symbolic';
        this.pinButton.accessible_name = pinned ? 'Unpin from favorites' : 'Pin to favorites';
        if (pinned)
            this.pinButton.add_style_class_name('pinned');
        else
            this.pinButton.remove_style_class_name('pinned');
    }

    _toggleFavorite() {
        if (!this._selected)
            return;

        const key = emojiKey(this._selected);
        const favorites = this._settings.get_strv('favorite-emojis');
        let next = favorites.filter(c => emojiKey(c) !== key);
        if (next.length === favorites.length) {
            // Pinning an 8th drops the oldest.
            next = [...favorites, emojiText(this._selected)].slice(-MAX_FAVORITE_EMOJIS);
        }
        this._settings.set_strv('favorite-emojis', next);
    }

    // Whether an app window gets keyboard focus back once Loco closes.
    _hasInsertTarget() {
        return !Main.overview.visible && global.display.focus_window !== null;
    }

    _insertEmoji(char) {
        const text = emojiText(char);
        const key = emojiKey(char);
        const recents = this._settings.get_strv('recent-emojis').filter(c => emojiKey(c) !== key);
        this._settings.set_strv('recent-emojis', [text, ...recents].slice(0, STORED_RECENT_EMOJIS));

        const hasTarget = this._hasInsertTarget();
        this._launcher.closeForInsert();
        this._delivery.type(text, hasTarget).catch(e => logError(e, 'loco-shell: cannot insert emoji'));
    }

    async _pasteSticker(combo) {
        const hasTarget = this._hasInsertTarget();
        let file;
        try {
            file = await this._stickers.ensure(combo);
        } catch (e) {
            if (!isCancelled(e))
                Main.notify('Sticker unavailable', 'It could not be downloaded.');
            return;
        }
        if (this._destroyed || !this._launcher.isOpen())
            return;
        this._launcher.closeForInsert();
        await this._delivery.pasteImage(file, hasTarget).catch(e => logError(e, 'loco-shell: cannot paste sticker'));
    }

    destroy() {
        this._destroyed = true;
        this._cancelPendingClick();
        if (this._prefetchId)
            GLib.source_remove(this._prefetchId);
        this._prefetchId = 0;
        this._stickers.destroy();
        this._delivery.destroy();
        this._settings.disconnectObject(this);
        // The grids and the pin button are destroyed with the launcher's widgets.
    }
}
