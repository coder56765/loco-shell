// SPDX-License-Identifier: GPL-2.0-or-later

// The Loco launcher: a Poco-style app launcher with an app grid, a bar of
// color dots that filter apps by icon color, an emoji button that switches
// to the emoji picker (emoji.js), and a search bar at the bottom, within
// thumb reach.
//
// Also home to the small widgets shared with quickTools.js.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {SwipeTracker} from 'resource:///org/gnome/shell/ui/swipeTracker.js';

import {EmojiPicker} from './emoji.js';

// ---- Shared widgets ------------------------------------------------------

/**
 * Calls onClick when a press or touch lands directly on `backdrop`, not on
 * one of its children. Events on children are left untouched: stopping them
 * (even from a parent) breaks St.Button's click handling in GNOME 50.
 *
 * @param {Clutter.Actor} backdrop - a reactive full-screen layer
 * @param {Function} onClick - called for presses outside its children
 */
export function connectClickOutside(backdrop, onClick) {
    const handler = (actor, event) => {
        const isPress = event.type() === Clutter.EventType.BUTTON_PRESS ||
            event.type() === Clutter.EventType.TOUCH_BEGIN;
        if (!isPress || global.stage.get_event_actor(event) !== backdrop)
            return Clutter.EVENT_PROPAGATE;

        onClick();
        return Clutter.EVENT_STOP;
    };
    backdrop.connect('button-press-event', handler);
    backdrop.connect('touch-event', handler);
}

// Wraps equally sized tiles into centered rows. St.Viewport sizes its
// scrollable area from the layout's *minimum* height, so unlike FlowLayout
// (minimum = one row) this reports the full wrapped height as the minimum.
export const TileGridLayout = GObject.registerClass(
class TileGridLayout extends Clutter.LayoutManager {
    _cellSize(container) {
        const child = container.get_first_child();
        if (!child)
            return [0, 0];

        const [, width] = child.get_preferred_width(-1);
        const [, height] = child.get_preferred_height(width);
        return [width, height];
    }

    _columns(cellWidth, availWidth) {
        return cellWidth > 0 ? Math.max(1, Math.floor(availWidth / cellWidth)) : 1;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const [cellWidth] = this._cellSize(container);
        return [cellWidth, cellWidth];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [cellWidth, cellHeight] = this._cellSize(container);
        const count = container.get_children().filter(c => c.visible).length;
        const columns = forWidth >= 0 ? this._columns(cellWidth, forWidth) : 1;
        const height = Math.ceil(count / columns) * cellHeight;
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const [cellWidth, cellHeight] = this._cellSize(container);
        const availWidth = box.get_width();
        const columns = this._columns(cellWidth, availWidth);
        const xOffset = Math.floor((availWidth - columns * cellWidth) / 2);

        let i = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;

            const x = box.x1 + xOffset + (i % columns) * cellWidth;
            const y = box.y1 + Math.floor(i / columns) * cellHeight;
            child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + cellWidth, y2: y + cellHeight}));
            i++;
        }
    }
});

// ---- Icon colors -----------------------------------------------------------

// Classifies every installed app by the dominant color of its icon: each
// opaque pixel of a small rendering votes for a color, and the most common
// one wins.

const CATEGORIES = ['All', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'White', 'Black'];

const CATEGORY_COLORS = {
    All: '#808080',
    Red: '#E53935',
    Orange: '#FB8C00',
    Yellow: '#FDD835',
    Green: '#4CAF50',
    Blue: '#1E88E5',
    Purple: '#8E24AA',
    White: '#E0E0E0',
    Black: '#303030',
};

const DEFAULT_CATEGORY = 'White';
const SAMPLE_ICON_SIZE = 48;
const MIN_ALPHA = 30;
const LOOKUPS_PER_TICK = 8;
const MAX_IN_FLIGHT = 4;
const CHANGED_DELAY_MS = 250;
const SAVE_DELAY_MS = 2000;

/**
 * Buckets a color by HSV: near-white and near-black first, then by hue.
 *
 * @param {number} r - red, 0-255
 * @param {number} g - green, 0-255
 * @param {number} b - blue, 0-255
 * @returns {string} the color category
 */
function classifyColor(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max / 255;
    const s = max === 0 ? 0 : (max - min) / max;

    if (s < 0.15) {
        if (v > 0.8)
            return 'White';
        if (v < 0.25)
            return 'Black';
        return 'White'; // grey is grouped with White
    }

    if (v < 0.15)
        return 'Black';

    let h;
    const delta = max - min;
    if (max === r)
        h = ((g - b) / delta) % 6;
    else if (max === g)
        h = (b - r) / delta + 2;
    else
        h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0)
        h += 360;

    if (h >= 345 || h < 15)
        return 'Red';
    if (h < 45)
        return 'Orange';
    if (h < 70)
        return 'Yellow';
    if (h < 165)
        return 'Green';
    if (h < 255)
        return 'Blue';
    return 'Purple';
}

/**
 * Every opaque pixel votes for its color category; the category with the
 * most pixels wins. This plays the role of `magick -colors 8` followed by
 * picking the most frequent color.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - the icon
 * @returns {string|null} the dominant category, or null if fully transparent
 */
function dominantCategory(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const hasAlpha = pixbuf.get_has_alpha();
    const pixels = pixbuf.read_pixel_bytes().toArray();

    const votes = {};
    let best = null;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * rowstride + x * channels;
            if (hasAlpha && pixels[offset + 3] < MIN_ALPHA)
                continue;

            const category = classifyColor(
                pixels[offset], pixels[offset + 1], pixels[offset + 2]);
            votes[category] = (votes[category] ?? 0) + 1;
            if (!best || votes[category] > votes[best])
                best = category;
        }
    }
    return best;
}

export const ColorIndex = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class ColorIndex extends GObject.Object {
    constructor() {
        super();

        // appId -> {icon: filename, category}
        this._cache = new Map();
        this._queue = [];
        this._queued = new Set();
        this._inFlight = 0;
        this._idleId = 0;
        this._changedId = 0;
        this._saveId = 0;
        this._ready = false;
        this._cancellable = new Gio.Cancellable();

        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'loco-shell']);
        this._cacheFile = Gio.File.new_for_path(GLib.build_filenamev([dir, 'colors.json']));

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('installed-changed',
            () => this._enqueueInstalled(), this);

        // A theme switch changes icon filenames, which invalidates those entries.
        this._iconTheme = new St.IconTheme();
        this._iconTheme.connectObject('changed', () => this._enqueueInstalled(), this);

        this._loadCache();
    }

    /**
     * @param {string} appId - desktop file id
     * @returns {string|null} the category, or null while not yet indexed
     */
    getCategory(appId) {
        return this._cache.get(appId)?.category ?? null;
    }

    /** Drops every cached result and classifies all apps again. */
    reindex() {
        this._cache.clear();
        this._scheduleSave();
        this._scheduleChanged();
        this._enqueueInstalled();
    }

    _loadCache() {
        this._cacheFile.load_contents_async(this._cancellable, (file, res) => {
            try {
                const [, contents] = file.load_contents_finish(res);
                const data = JSON.parse(new TextDecoder().decode(contents));
                for (const [appId, entry] of Object.entries(data)) {
                    if (typeof entry?.category === 'string')
                        this._cache.set(appId, {icon: entry.icon ?? '', category: entry.category});
                }
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                // Missing or corrupt cache: start from scratch.
            }

            this._ready = true;
            this._scheduleChanged();
            this._enqueueInstalled();
        });
    }

    _enqueueInstalled() {
        if (!this._ready)
            return;

        const installed = new Set();
        for (const info of this._appSystem.get_installed()) {
            if (!info.should_show())
                continue;

            const appId = info.get_id();
            installed.add(appId);
            if (!this._queued.has(appId)) {
                this._queued.add(appId);
                this._queue.push(appId);
            }
        }

        for (const appId of this._cache.keys()) {
            if (!installed.has(appId)) {
                this._cache.delete(appId);
                this._scheduleSave();
            }
        }

        this._pump();
    }

    _pump() {
        if (this._idleId || this._cancellable.is_cancelled())
            return;

        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            let budget = LOOKUPS_PER_TICK;
            while (budget-- > 0 && this._inFlight < MAX_IN_FLIGHT && this._queue.length > 0) {
                const appId = this._queue.shift();
                this._queued.delete(appId);
                this._processApp(appId);
            }

            if (this._queue.length > 0 && this._inFlight < MAX_IN_FLIGHT)
                return GLib.SOURCE_CONTINUE;

            // Either done, or waiting for in-flight loads to call _pump() again.
            this._idleId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _processApp(appId) {
        const app = this._appSystem.lookup_app(appId);
        if (!app)
            return;

        const gicon = app.get_icon();
        const info = gicon
            ? this._iconTheme.lookup_by_gicon(gicon, SAMPLE_ICON_SIZE, St.IconLookupFlags.FORCE_SIZE)
            : null;
        const icon = info?.get_filename() ?? '';

        const cached = this._cache.get(appId);
        if (cached && cached.icon === icon)
            return;

        if (!info) {
            this._store(appId, icon, DEFAULT_CATEGORY);
            return;
        }

        this._inFlight++;
        info.load_icon_async(this._cancellable, (obj, res) => {
            this._inFlight--;

            let category = DEFAULT_CATEGORY;
            try {
                category = dominantCategory(obj.load_icon_finish(res)) ?? DEFAULT_CATEGORY;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }

            this._store(appId, icon, category);
            this._pump();
        });
    }

    _store(appId, icon, category) {
        this._cache.set(appId, {icon, category});
        this._scheduleChanged();
        this._scheduleSave();
    }

    _scheduleChanged() {
        if (this._changedId)
            return;

        this._changedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHANGED_DELAY_MS, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleSave() {
        if (this._saveId)
            return;

        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        const data = Object.fromEntries(this._cache);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data, null, 2)));

        try {
            this._cacheFile.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                logError(e, 'loco-shell: cannot create cache directory');
        }

        this._cacheFile.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    logError(e, 'loco-shell: cannot write color cache');
                }
            });
    }

    destroy() {
        this._cancellable.cancel();

        if (this._idleId)
            GLib.source_remove(this._idleId);
        if (this._changedId)
            GLib.source_remove(this._changedId);
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._save();
        }
        this._idleId = this._changedId = this._saveId = 0;

        this._appSystem.disconnectObject(this);
        this._iconTheme.disconnectObject(this);
        this._queue = [];
        this._queued.clear();
    }
});

// ---- The launcher ----------------------------------------------------------

const CARD_WIDTH = 920;
const CARD_HEIGHT = 760;
const TILE_ICON_SIZE = 64;

const OPEN_TIME = 320;
const CLOSE_TIME = 200;
// How far below its resting place the grid starts, as a share of the card height.
const GRID_RISE = 0.45;
// Extra lag per row, so the grid settles like a sheet instead of a block.
const ROW_STAGGER = 22;
const MAX_STAGGER_ROWS = 8;

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

export class LocoLauncher {
    /**
     * @param {ColorIndex} colorIndex - app icon colors
     * @param {Gio.Settings} settings - the extension's settings
     * @param {Gio.File} dir - the extension's folder (holds kitchen.txt.gz)
     */
    constructor(colorIndex, settings, dir) {
        this._colorIndex = colorIndex;
        this._settings = settings;
        this._dir = dir;
        this._selectedCategory = 'All';
        this._mode = 'apps';
        this._tiles = [];
        this._tilesDirty = true;
        this._grab = null;
        this._gesture = false;

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('installed-changed', () => {
            this._tilesDirty = true;
            if (this._backdrop.visible)
                this._rebuildTiles();
        }, this);
        this._colorIndex.connectObject('changed', () => this._applyFilter(), this);

        this._buildUi();
    }

    get isOpen() {
        return this._grab !== null;
    }

    _buildUi() {
        // Full-monitor layer: clicking anywhere outside the card closes it.
        this._backdrop = new St.Widget({reactive: true, visible: false});
        // The shell also destroys these widgets at logout without calling
        // destroy() on us; stop reacting to app and color changes then.
        this._backdrop.connect('destroy', () => {
            this._appSystem.disconnectObject(this);
            this._colorIndex.disconnectObject(this);
        });
        // A right click anywhere drops the emoji selection.
        this._backdrop.connect('captured-event', (actor, event) => {
            if (this._emoji.selected && event.type() === Clutter.EventType.BUTTON_PRESS &&
                event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._emoji.clearSelection();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        connectClickOutside(this._backdrop, () => this.close());
        this._backdrop.connect('key-press-event', this._onKeyPress.bind(this));
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        // Reactive so that clicks on its padding count as "inside".
        this._card = new St.BoxLayout({
            style_class: 'popup-menu-content loco-launcher',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._backdrop.add_child(this._card);
        global.focus_manager.add_group(this._card);

        this._buildGrid();

        this._bottomBar = new St.BoxLayout({
            style_class: 'loco-launcher-bottom',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._card.add_child(this._bottomBar);
        this._buildColorBar();
        this._buildSearch();

        // 0 = hidden, 1 = fully shown. Driven by the open/close animations
        // and, live, by the touchpad swipe from the overview.
        this._reveal = new St.Adjustment({actor: this._card, lower: 0, upper: 1, value: 0});
        this._reveal.connect('notify::value', () => this._applyReveal());

        // Three-finger swipe down (touchpad or touchscreen) puts the launcher
        // away, following the fingers. The overview's own tracker is off
        // while Loco holds its POPUP grab, and it sits on the stage, which
        // events no longer reach once the backdrop has the grab; so this one
        // sits on the backdrop, and is enabled only while Loco is open.
        this._swipeTracker = new SwipeTracker(this._backdrop,
            Clutter.Orientation.VERTICAL, Shell.ActionMode.POPUP,
            {allowDrag: false, allowScroll: false, name: 'Loco swipe tracker'});
        this._swipeTracker.enabled = false;
        this._swipeTracker.connect('begin', () => {
            const progress = this._reveal.value;
            this._reveal.remove_transition('value');
            this._swipeTracker.confirmSwipe(this._card.height, [0, 1], progress, 1);
        });
        this._swipeTracker.connect('update', (tracker, progress) => {
            this._reveal.value = progress;
        });
        this._swipeTracker.connect('end', (tracker, duration, endProgress) => {
            if (endProgress < 1)
                this.close(duration);
            else
                this._reveal.ease(1, {duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        });
    }

    _buildSearch() {
        // Not .search-entry: that one is always dark, to suit the overview.
        this._entry = new St.Entry({
            style_class: 'loco-search',
            hint_text: 'Search apps…',
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-find-symbolic',
        }));
        this._clearIcon = new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-clear-symbolic',
        });
        this._entry.connect('secondary-icon-clicked', () => {
            this._entry.text = '';
            this._entry.grab_key_focus();
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._entry.set_secondary_icon(this._entry.text ? this._clearIcon : null);
            this._applyFilter();
            this._scrollView.vadjustment.value = 0;
        });
        this._entry.clutter_text.connect('key-press-event', this._onEntryKeyPress.bind(this));
        this._bottomBar.add_child(this._entry);
    }

    _buildGrid() {
        // One scrollable column: the app grid, or the emoji sections
        // (favorites, recent, then all emoji or the selected emoji's stickers).
        this._content = new St.BoxLayout({
            style_class: 'loco-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._scrollView = new St.ScrollView({
            style_class: 'loco-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            // The grid rises from below; cut it off at the bottom edge.
            clip_to_allocation: true,
        });

        this._grid = new St.Widget({
            style_class: 'loco-grid',
            x_expand: true,
            layout_manager: new TileGridLayout(),
        });
        // Emoji mode lives in emoji.js; its sections share this scrollable column.
        this._emoji = new EmojiPicker({
            settings: this._settings,
            dir: this._dir,
            scrollView: this._scrollView,
            launcher: {
                isOpen: () => this.isOpen,
                // Leave the search field first, so typed text goes to the app.
                closeForInsert: () => {
                    global.stage.set_key_focus(this._backdrop);
                    this.close();
                },
            },
            onSelectionChanged: () => this._syncBarLabel(null),
        });
        // Scrolling decides which emoji tiles exist.
        const scrolled = () => this._emoji.scrolled();
        this._scrollView.vadjustment.connect('notify::value', scrolled);
        this._scrollView.vadjustment.connect('notify::page-size', scrolled);
        for (const actor of [this._grid, ...this._emoji.actors])
            this._content.add_child(actor);
        this._scrollView.child = this._content;

        // One-finger touch scrolling, as in the overview's search results.
        // Three fingers are left to the swipe-down gesture.
        const panGesture = new Clutter.PanGesture({max_n_points: 1});
        panGesture.connect('pan-update', gesture => {
            this._scrollView.vadjustment.value -= gesture.get_delta().get_y();
        });
        this._scrollView.add_action(panGesture);

        this._card.add_child(this._scrollView);
    }

    _buildColorBar() {
        const bar = new St.BoxLayout({style_class: 'loco-color-bar', x_expand: true});

        this._colorLabel = new St.Label({
            style_class: 'loco-color-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(this._colorLabel);

        const dots = new St.BoxLayout({
            style_class: 'loco-color-dots',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(dots);

        this._colorButtons = new Map();
        for (const category of CATEGORIES) {
            const dot = new St.Widget({
                style_class: category === 'All' ? 'loco-color-dot loco-color-dot-all' : 'loco-color-dot',
                style: category === 'All' ? null : `background-color: ${CATEGORY_COLORS[category]};`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const button = new St.Button({
                style_class: 'loco-color-ring',
                child: dot,
                can_focus: true,
                track_hover: true,
                accessible_name: category,
            });
            button.connect('clicked', () => this._selectCategory(category));
            button.connect('notify::hover', () => this._syncBarLabel(button.hover ? category : null));
            dots.add_child(button);
            this._colorButtons.set(category, button);
        }

        // The emoji picker, right after Black.
        this._emojiButton = new St.Button({
            style_class: 'loco-color-ring loco-emoji-ring',
            child: new St.Label({
                style_class: 'loco-emoji-dot',
                text: '😀',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            can_focus: true,
            track_hover: true,
            accessible_name: 'Emoji',
        });
        this._emojiButton.connect('clicked', () => this._setMode('emoji'));
        this._emojiButton.connect('notify::hover', () => this._syncBarLabel(this._emojiButton.hover ? 'Emoji' : null));
        dots.add_child(this._emojiButton);

        // Far right: pin the selected emoji to the favorites row.
        bar.add_child(this._emoji.pinButton);

        this._syncColorButtons();
        this._syncBarLabel(null);
        this._bottomBar.add_child(bar);
    }

    _syncBarLabel(hovered) {
        if (hovered)
            this._colorLabel.text = hovered;
        else if (this._mode === 'emoji' && this._emoji.selected)
            this._colorLabel.text = `${this._emoji.selected} +`;
        else
            this._colorLabel.text = this._mode === 'emoji' ? 'Emoji' : 'Colors';
    }

    _createTile(app) {
        const box = new St.BoxLayout({
            style_class: 'loco-tile-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const icon = app.create_icon_texture(TILE_ICON_SIZE);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        box.add_child(tileLabel(app.get_name()));

        const button = new St.Button({
            style_class: 'loco-tile',
            child: box,
            can_focus: true,
            track_hover: true,
            accessible_name: app.get_name(),
        });
        button.connect('clicked', () => this._launch(app));
        button.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._scrollView, button));
        this._grid.add_child(button);

        return {appId: app.get_id(), name: app.get_name().toLowerCase(), button};
    }

    _rebuildTiles() {
        this._tilesDirty = false;
        this._grid.destroy_all_children();

        const apps = this._appSystem.get_installed()
            .filter(info => info.should_show())
            .map(info => this._appSystem.lookup_app(info.get_id()))
            .filter(app => app !== null);
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

        this._tiles = apps.map(app => this._createTile(app));
        this._applyFilter();
    }

    // ---- Apps or emoji ----------------------------------------------------

    _setMode(mode) {
        if (this._mode !== mode) {
            this._mode = mode;
            this._entry.hint_text = mode === 'emoji' ? 'Search emoji…' : 'Search apps…';
            this._entry.text = '';
            this._scrollView.vadjustment.value = 0;
            this._emoji.setActive(mode === 'emoji');
        }
        this._grid.visible = mode === 'apps';
        this._syncColorButtons();
        this._syncBarLabel(null);
    }

    // ---- Filtering and keyboard ------------------------------------------

    _applyFilter() {
        const query = this._entry.text.trim().toLowerCase();
        if (this._mode === 'emoji') {
            this._emoji.filter(query);
        } else {
            for (const tile of this._tiles) {
                const matchesSearch = tile.name.includes(query);
                const matchesCategory = this._selectedCategory === 'All' ||
                    this._colorIndex.getCategory(tile.appId) === this._selectedCategory;
                tile.button.visible = matchesSearch && matchesCategory;
            }
        }

        // Don't leave keyboard focus on a tile that just got filtered out.
        const focus = global.stage.key_focus;
        if (focus && !focus.mapped && this._content.contains(focus))
            this._entry.grab_key_focus();
    }

    _selectCategory(category) {
        this._selectedCategory = category;
        this._setMode('apps');
        this._applyFilter();
    }

    _syncColorButtons() {
        for (const [category, button] of this._colorButtons) {
            if (this._mode === 'apps' && category === this._selectedCategory) {
                button.add_style_class_name('selected');
                button.style = `border-color: ${CATEGORY_COLORS[category]};`;
            } else {
                button.remove_style_class_name('selected');
                button.style = null;
            }
        }
        if (this._mode === 'emoji')
            this._emojiButton.add_style_class_name('selected');
        else
            this._emojiButton.remove_style_class_name('selected');
    }

    _visibleTiles() {
        if (this._mode === 'apps')
            return this._tiles.map(t => t.button).filter(b => b.visible);

        return this._emoji.visibleTiles();
    }

    _firstVisibleTile() {
        return this._visibleTiles()[0] ?? null;
    }

    _launch(app) {
        this.close();
        app.activate();
        // Opened from the overview: leave it, as GNOME's own app grid does.
        if (Main.overview.visible)
            Main.overview.hide();
    }

    _onEntryKeyPress(actor, event) {
        const symbol = event.get_key_symbol();

        // The search bar sits below the grid: Up moves into the results.
        if (symbol === Clutter.KEY_Up) {
            this._firstVisibleTile()?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (this._mode === 'emoji') {
                this._emoji.activateFirst();
            } else {
                const tile = this._tiles.find(t => t.button.visible);
                if (tile)
                    this._launch(this._appSystem.lookup_app(tile.appId));
            }
            return Clutter.EVENT_STOP;
        }

        // Ctrl+R must not reach the text field.
        return this._handleShortcut(event);
    }

    _handleShortcut(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            // Drop the emoji selection first, then close.
            if (this._emoji.selected)
                this._emoji.clearSelection();
            else
                this.close();
            return Clutter.EVENT_STOP;
        }

        if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) &&
            (symbol === Clutter.KEY_r || symbol === Clutter.KEY_R)) {
            this._colorIndex.reindex();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(actor, event) {
        if (this._handleShortcut(event) === Clutter.EVENT_STOP)
            return Clutter.EVENT_STOP;

        // Arrow keys and Tab move between the tiles, color dots and entry.
        // Inside the entry the arrows belong to the text cursor, so only Tab
        // moves focus from there.
        const symbol = event.get_key_symbol();
        const isTab = symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab;
        const inEntry = global.stage.key_focus === this._entry.clutter_text;
        if ((isTab || !inEntry) && global.focus_manager.navigate_from_event(event))
            return Clutter.EVENT_STOP;

        return Clutter.EVENT_PROPAGATE;
    }

    // ---- Showing, hiding and the reveal animation --------------------------

    _applyReveal() {
        const p = this._reveal.value;
        const lag = 1 - p;

        // The frame appears in place almost at once; the grid then rises
        // into it from its bottom edge, and the bottom bar lifts a little.
        this._card.opacity = Math.round(255 * Math.min(1, p * 3));
        this._bottomBar.opacity = Math.round(255 * Math.min(1, p * 2));
        this._bottomBar.translation_y = lag * 24;

        // From the card's size, which is set explicitly: on the first frame
        // the scroll view isn't allocated yet and reports a bogus height.
        this._content.translation_y = lag * this._card.height * GRID_RISE;
        this._content.opacity = Math.round(255 * Math.min(1, p * 1.5));

        // Lower rows trail behind, so the grid stretches and settles. Only
        // tiles near the viewport matter; the rest are clipped anyway.
        const tiles = this._visibleTiles();
        const rowHeight = tiles[0]?.height || 1;
        const scrollTop = this._scrollView.vadjustment.value;
        const limit = scrollTop + (MAX_STAGGER_ROWS + 1) * rowHeight;
        for (const button of tiles) {
            const y = button.get_parent().y + button.y;
            if (y > limit && lag > 0)
                continue;
            const row = Math.min(MAX_STAGGER_ROWS, Math.max(0, Math.floor((y - scrollTop) / rowHeight)));
            button.translation_y = lag * row * ROW_STAGGER;
        }
    }

    // Puts the launcher on screen, fully hidden (reveal 0), without a grab.
    _show() {
        if (this._tilesDirty)
            this._rebuildTiles();

        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const width = Math.min(CARD_WIDTH * scaleFactor, Math.floor(workArea.width * 0.92));
        const height = Math.min(CARD_HEIGHT * scaleFactor, Math.floor(workArea.height * 0.92));

        this._backdrop.set_position(monitor.x, monitor.y);
        this._backdrop.set_size(monitor.width, monitor.height);
        this._card.set_size(width, height);
        this._card.set_position(
            workArea.x - monitor.x + Math.floor((workArea.width - width) / 2),
            workArea.y - monitor.y + Math.floor((workArea.height - height) / 2));

        // A closing animation may still be running; take over from it.
        this._reveal.remove_transition('value');
        if (!this._backdrop.visible) {
            this._emoji.clearSelection();
            // Always start on all apps, whatever was showing last time.
            this._selectedCategory = 'All';
            this._setMode('apps');
            this._entry.text = '';
            this._applyFilter();
            this._scrollView.vadjustment.value = 0;
            this._reveal.value = 0;
            this._applyReveal();
        }

        Main.layoutManager.uiGroup.set_child_above_sibling(this._backdrop, null);
        this._backdrop.show();
        return true;
    }

    _grabAndFocus() {
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._swipeTracker.enabled = true;
        this._entry.grab_key_focus();
    }

    open() {
        if (this.isOpen || this._gesture || !this._show())
            return;

        this._grabAndFocus();
        this._reveal.ease(1, {duration: OPEN_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    /**
     * @param {number} [swipeDuration] - when closed by a swipe: the time
     *   the swipe tracker wants for the rest of the motion
     */
    close(swipeDuration) {
        if (!this.isOpen)
            return;

        Main.popModal(this._grab);
        this._grab = null;
        this._swipeTracker.enabled = false;
        this._emoji.onLauncherClosed();

        const fromSwipe = swipeDuration !== undefined;
        this._reveal.ease(0, {
            duration: fromSwipe ? swipeDuration : CLOSE_TIME,
            mode: fromSwipe ? Clutter.AnimationMode.EASE_OUT_CUBIC : Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this._backdrop.hide(),
        });
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    /**
     * Starts a gesture-driven reveal (the touchpad swipe past the overview).
     *
     * @returns {boolean} whether the reveal started
     */
    beginReveal() {
        if (this.isOpen || this._gesture || !this._show())
            return false;
        this._gesture = true;
        return true;
    }

    /** @param {number} progress - 0 (hidden) to 1 (shown), follows the fingers */
    updateReveal(progress) {
        if (this._gesture)
            this._reveal.value = Math.max(0, Math.min(1, progress));
    }

    /**
     * @param {boolean} commit - open the launcher, or put it away again
     * @param {number} duration - the swipe tracker's remaining animation time
     */
    endReveal(commit, duration) {
        if (!this._gesture)
            return;
        this._gesture = false;

        if (commit) {
            this._grabAndFocus();
            this._reveal.ease(1, {duration: Math.max(duration, 150), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this._reveal.ease(0, {
                duration: Math.max(duration, 150),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._backdrop.hide(),
            });
        }
    }

    destroy() {
        if (this.isOpen) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._emoji.destroy();
        this._swipeTracker.destroy();
        this._reveal.remove_transition('value');
        // The clear icon is only parented while there is text; free it either way.
        this._entry.set_secondary_icon(null);
        this._clearIcon.destroy();
        this._backdrop.destroy();
        this._backdrop = null;
        this._tiles = [];
    }
}
