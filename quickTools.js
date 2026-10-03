// SPDX-License-Identifier: GPL-2.0-or-later

// One Hand Operation+ for GNOME (port of one-hand-op/shell.qml): drag
// inward from a screen edge to open a panel of quick tools, or keep dragging
// to the middle of the screen for the launcher.
//
// Sections: the quick tools themselves (built-in and custom, listed in
// toolCatalog.js), the quick tools panel, and the edge swipes.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {showScreenshotUI, showScreenRecordingUI} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {spawnCommandLine} from 'resource:///org/gnome/shell/misc/util.js';

import {TileGridLayout, connectClickOutside} from './launcher.js';
import {CUSTOM_PREFIX, getBuiltinTool, parseCustomTools} from './toolCatalog.js';

// Shell-side implementations of the quick tools listed in toolCatalog.js.
// Settings-backed toggles talk to GSettings directly; hardware toggles
// (Wi-Fi, Bluetooth, ...) reuse the toggles from GNOME's Quick Settings so
// they behave exactly like the system menu.




class Tool {
    constructor(meta) {
        this.id = meta.id;
        this.name = meta.name;
        this.toggle = !!meta.toggle;
        this._iconName = meta.icon;
        this._onChanged = null;
    }

    get iconName() {
        return this._iconName;
    }

    get gicon() {
        return null;
    }

    get available() {
        return true;
    }

    get active() {
        return false;
    }

    // Toggles act in place; actions run once the panel has slid away, so
    // screenshots, menus and dialogs aren't covered by it.
    get closesPanel() {
        return !this.toggle;
    }

    activate() {}

    /** @param {Function} callback - called whenever the tile must redraw */
    onChanged(callback) {
        this._onChanged = callback;
    }

    _changed() {
        this._onChanged?.();
    }

    destroy() {
        this._onChanged = null;
    }
}

class ActionTool extends Tool {
    constructor(meta, action, isAvailable = () => true) {
        super(meta);
        this._action = action;
        this._isAvailable = isAvailable;
    }

    get available() {
        return this._isAvailable();
    }

    activate() {
        this._action();
    }
}

class SettingsToggle extends Tool {
    /**
     * @param {object} meta - catalog entry
     * @param {string|Gio.Settings} schema - a system schema id, or a settings object
     * @param {string} key - key to watch
     * @param {Function} [read] - settings => on
     * @param {Function} [write] - (settings, on) => void
     */
    constructor(meta, schema, key,
        read = s => s.get_boolean(key),
        write = (s, on) => s.set_boolean(key, on)) {
        super(meta);
        this._read = read;
        this._write = write;

        if (schema instanceof Gio.Settings) {
            this._settings = schema;
        } else {
            // Missing on this system (e.g. no gnome-settings-daemon plugin)
            // means the tool shows as unavailable.
            const source = Gio.SettingsSchemaSource.get_default().lookup(schema, true);
            this._settings = source?.has_key(key) ? new Gio.Settings({schema_id: schema}) : null;
        }
        this._settings?.connectObject(`changed::${key}`, () => this._changed(), this);
    }

    get available() {
        return this._settings !== null;
    }

    get active() {
        return this._settings ? this._read(this._settings) : false;
    }

    activate() {
        this._write(this._settings, !this.active);
    }

    destroy() {
        this._settings?.disconnectObject(this);
        super.destroy();
    }
}

function findQuickSettingsToggle(className) {
    const grid = Main.panel.statusArea.quickSettings?.menu?._grid;
    return grid?.get_children().find(item => item.constructor.name === className) ?? null;
}

class QuickSettingsToggle extends Tool {
    constructor(meta, className) {
        super(meta);
        this._toggle = findQuickSettingsToggle(className);
        this._toggle?.connectObject(
            'notify::checked', () => this._changed(),
            'notify::visible', () => this._changed(),
            'notify::reactive', () => this._changed(),
            'notify::icon-name', () => this._changed(),
            'notify::gicon', () => this._changed(),
            'destroy', () => {
                this._toggle = null;
                this._changed();
            }, this);
    }

    // Follow the system toggle's live icon (signal strength, profile, ...).
    get iconName() {
        return this._toggle?.icon_name || super.iconName;
    }

    get gicon() {
        return this._toggle?.gicon ?? null;
    }

    get available() {
        return !!this._toggle?.visible && this._toggle.reactive;
    }

    get active() {
        return !!this._toggle?.checked;
    }

    activate() {
        // Toggle-mode buttons (bound to a setting) flip on a real click
        // only; the others act in their 'clicked' handler.
        if (this._toggle.toggle_mode)
            this._toggle.checked = !this._toggle.checked;
        else
            this._toggle.emit('clicked', Clutter.BUTTON_PRIMARY);
    }

    destroy() {
        this._toggle?.disconnectObject(this);
        super.destroy();
    }
}

class StreamMuteToggle extends Tool {
    constructor(meta, input) {
        super(meta);
        this._input = input;
        this._mixer = getMixerControl();
        this._stream = null;
        this._mixer.connectObject(
            input ? 'default-source-changed' : 'default-sink-changed', () => this._bindStream(),
            'state-changed', () => this._bindStream(), this);
        this._bindStream();
    }

    _bindStream() {
        this._stream?.disconnectObject(this);
        this._stream = this._input ? this._mixer.get_default_source() : this._mixer.get_default_sink();
        this._stream?.connectObject('notify::is-muted', () => this._changed(), this);
        this._changed();
    }

    get available() {
        return this._stream !== null;
    }

    get active() {
        return !!this._stream?.is_muted;
    }

    activate() {
        this._stream.change_is_muted(!this._stream.is_muted);
    }

    destroy() {
        this._mixer.disconnectObject(this);
        this._stream?.disconnectObject(this);
        super.destroy();
    }
}

class SystemActionTool extends ActionTool {
    constructor(meta, method, property) {
        const actions = SystemActions.getDefault();
        super(meta, () => actions[method](), () => actions[property]);
    }
}

class CustomTool extends Tool {
    constructor(spec) {
        super({id: spec.id, name: spec.name, icon: spec.icon});
        this._spec = spec;
        this._app = spec.type === 'app'
            ? Shell.AppSystem.get_default().lookup_app(spec.target)
            : null;
    }

    get iconName() {
        return this._spec.icon || (this._app ? null : 'system-run-symbolic');
    }

    get gicon() {
        return this._spec.icon ? null : this._app?.get_icon() ?? null;
    }

    get available() {
        return this._spec.type === 'command' || this._app !== null;
    }

    activate() {
        if (this._spec.type === 'app')
            this._app.activate();
        else
            spawnCommandLine(this._spec.target);
    }
}

function focusedWindow() {
    return global.display.focus_window;
}

function withFocusedWindow(action) {
    return () => {
        const window = focusedWindow();
        if (window)
            action(window);
    };
}

function switchWorkspace(direction) {
    const active = global.workspace_manager.get_active_workspace();
    active.get_neighbor(direction).activate(global.get_current_time());
}

function moveWindowToWorkspace(direction) {
    const window = focusedWindow();
    if (!window)
        return;

    const target = global.workspace_manager.get_active_workspace().get_neighbor(direction);
    window.change_workspace_by_index(target.index(), false);
    target.activate_with_focus(window, global.get_current_time());
}

function showDesktop() {
    const workspace = global.workspace_manager.get_active_workspace();
    for (const window of workspace.list_windows()) {
        if (window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.minimized && !window.is_skip_taskbar())
            window.minimize();
    }
}

function launchApp(desktopId) {
    Shell.AppSystem.get_default().lookup_app(desktopId)?.activate();
}

function appExists(desktopId) {
    return () => Shell.AppSystem.get_default().lookup_app(desktopId) !== null;
}

function openMenu(statusAreaKey) {
    Main.panel.statusArea[statusAreaKey]?.menu.open();
}

/**
 * @param {string} id - tool id from the quick-tools setting
 * @param {object} ctx - {settings, launcher, extension, customTools}
 * @returns {Tool|null} the tool, or null for an unknown id
 */
function createTool(id, ctx) {
    if (id.startsWith(CUSTOM_PREFIX)) {
        const spec = ctx.customTools.find(t => t.id === id);
        return spec ? new CustomTool(spec) : null;
    }

    const meta = getBuiltinTool(id);
    if (!meta)
        return null;

    const IFACE = 'org.gnome.desktop.interface';
    const A11Y_APPS = 'org.gnome.desktop.a11y.applications';
    const {LEFT, RIGHT} = Meta.MotionDirection;

    switch (id) {
    // Connectivity: reuse the system toggles.
    case 'wifi': return new QuickSettingsToggle(meta, 'NMWirelessToggle');
    case 'bluetooth': return new QuickSettingsToggle(meta, 'BluetoothToggle');
    case 'airplane': return new QuickSettingsToggle(meta, 'RfkillToggle');
    case 'vpn': return new QuickSettingsToggle(meta, 'NMVpnToggle');

    // Display
    case 'night-light':
        return new SettingsToggle(meta, 'org.gnome.settings-daemon.plugins.color', 'night-light-enabled');
    case 'dark-style':
        return new SettingsToggle(meta, IFACE, 'color-scheme',
            s => s.get_string('color-scheme') === 'prefer-dark',
            (s, on) => s.set_string('color-scheme', on ? 'prefer-dark' : 'default'));
    case 'auto-rotate': return new QuickSettingsToggle(meta, 'RotationToggle');
    case 'power-mode': return new QuickSettingsToggle(meta, 'PowerProfilesToggle');
    case 'keep-awake': return new SettingsToggle(meta, ctx.settings, 'keep-awake');
    case 'animations': return new SettingsToggle(meta, IFACE, 'enable-animations');
    case 'hot-corner': return new SettingsToggle(meta, IFACE, 'enable-hot-corners');
    case 'touchpad':
        return new SettingsToggle(meta, 'org.gnome.desktop.peripherals.touchpad', 'send-events',
            s => s.get_string('send-events') !== 'disabled',
            (s, on) => s.set_string('send-events', on ? 'enabled' : 'disabled'));

    // Sound & notifications
    case 'dnd':
        return new SettingsToggle(meta, 'org.gnome.desktop.notifications', 'show-banners',
            s => !s.get_boolean('show-banners'),
            (s, on) => s.set_boolean('show-banners', !on));
    case 'mute': return new StreamMuteToggle(meta, false);
    case 'mic-mute': return new StreamMuteToggle(meta, true);
    case 'notifications': return new ActionTool(meta, () => openMenu('dateMenu'));

    // Wellbeing
    case 'break-reminders':
        return new SettingsToggle(meta, 'org.gnome.desktop.break-reminders', 'selected-breaks',
            s => s.get_strv('selected-breaks').length > 0,
            (s, on) => {
                if (on) {
                    const saved = ctx.settings.get_strv('saved-break-reminders');
                    s.set_strv('selected-breaks', saved.length > 0 ? saved : ['eyesight', 'movement']);
                } else {
                    ctx.settings.set_strv('saved-break-reminders', s.get_strv('selected-breaks'));
                    s.set_strv('selected-breaks', []);
                }
            });
    case 'screen-time-limit':
        return new SettingsToggle(meta, 'org.gnome.desktop.screen-time-limits', 'daily-limit-enabled');
    case 'wellbeing-settings':
        return new ActionTool(meta, () => spawnCommandLine('gnome-control-center wellbeing'),
            appExists('org.gnome.Settings.desktop'));

    // Privacy
    case 'location': return new SettingsToggle(meta, 'org.gnome.system.location', 'enabled');
    case 'camera':
        return new SettingsToggle(meta, 'org.gnome.desktop.privacy', 'disable-camera',
            s => !s.get_boolean('disable-camera'),
            (s, on) => s.set_boolean('disable-camera', !on));

    // Accessibility
    case 'high-contrast':
        return new SettingsToggle(meta, 'org.gnome.desktop.a11y.interface', 'high-contrast');
    case 'large-text':
        return new SettingsToggle(meta, IFACE, 'text-scaling-factor',
            s => s.get_double('text-scaling-factor') > 1.0,
            (s, on) => s.set_double('text-scaling-factor', on ? 1.25 : 1.0));
    case 'screen-reader': return new SettingsToggle(meta, A11Y_APPS, 'screen-reader-enabled');
    case 'screen-keyboard': return new SettingsToggle(meta, A11Y_APPS, 'screen-keyboard-enabled');
    case 'magnifier': return new SettingsToggle(meta, A11Y_APPS, 'screen-magnifier-enabled');

    // Windows & workspaces (act on the window that had focus)
    case 'show-desktop': return new ActionTool(meta, showDesktop);
    case 'close-window':
        return new ActionTool(meta, withFocusedWindow(w => w.delete(global.get_current_time())));
    case 'minimize-window': return new ActionTool(meta, withFocusedWindow(w => w.minimize()));
    case 'maximize-window':
        return new ActionTool(meta, withFocusedWindow(w => (w.is_maximized() ? w.unmaximize() : w.maximize())));
    case 'fullscreen-window':
        return new ActionTool(meta,
            withFocusedWindow(w => (w.is_fullscreen() ? w.unmake_fullscreen() : w.make_fullscreen())));
    case 'always-on-top':
        return new ActionTool(meta, withFocusedWindow(w => (w.is_above() ? w.unmake_above() : w.make_above())));
    case 'workspace-prev': return new ActionTool(meta, () => switchWorkspace(LEFT));
    case 'workspace-next': return new ActionTool(meta, () => switchWorkspace(RIGHT));
    case 'move-window-prev': return new ActionTool(meta, () => moveWindowToWorkspace(LEFT));
    case 'move-window-next': return new ActionTool(meta, () => moveWindowToWorkspace(RIGHT));

    // Shell
    case 'screenshot': return new ActionTool(meta, showScreenshotUI);
    case 'screen-record': return new ActionTool(meta, showScreenRecordingUI);
    case 'overview': return new ActionTool(meta, () => Main.overview.show());
    case 'launcher': return new ActionTool(meta, () => ctx.launcher.open());
    case 'quick-settings': return new ActionTool(meta, () => openMenu('quickSettings'));
    case 'run-dialog': return new ActionTool(meta, () => Main.openRunDialog());

    // Session
    case 'lock': return new SystemActionTool(meta, 'activateLockScreen', 'canLockScreen');
    case 'suspend': return new SystemActionTool(meta, 'activateSuspend', 'canSuspend');
    case 'log-out': return new SystemActionTool(meta, 'activateLogout', 'canLogout');
    case 'restart': return new SystemActionTool(meta, 'activateRestart', 'canRestart');
    case 'power-off': return new SystemActionTool(meta, 'activatePowerOff', 'canPowerOff');

    // Apps
    case 'settings':
        return new ActionTool(meta, () => launchApp('org.gnome.Settings.desktop'), appExists('org.gnome.Settings.desktop'));
    case 'files':
        return new ActionTool(meta, () => launchApp('org.gnome.Nautilus.desktop'), appExists('org.gnome.Nautilus.desktop'));

    // Loco
    case 'loco-settings': return new ActionTool(meta, () => ctx.extension.openPreferences());
    case 'close-panel': return new ActionTool(meta, () => {});

    default:
        return null;
    }
}

const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;

/**
 * Keeps the session from idling or suspending while the keep-awake setting
 * is on. Lives for as long as the extension is enabled.
 */
export class KeepAwake {
    constructor(settings) {
        this._settings = settings;
        this._cookie = 0;
        this._pending = false;
        this._destroyed = false;
        this._settings.connectObject('changed::keep-awake', () => this._sync(), this);
        this._sync();
    }

    get _wanted() {
        return !this._destroyed && this._settings.get_boolean('keep-awake');
    }

    _sync() {
        if (this._wanted)
            this._inhibit();
        else
            this._uninhibit();
    }

    // No cancellable: an Inhibit that already reached the session manager
    // must always be answered with an Uninhibit, or it leaks until logout.
    _callSessionManager(method, params, replyType, callback) {
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', method, params, replyType,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    callback?.(conn.call_finish(res));
                } catch (e) {
                    logError(e, `loco-shell: SessionManager.${method} failed`);
                    callback?.(null);
                }
            });
    }

    _inhibit() {
        if (this._cookie || this._pending)
            return;

        this._pending = true;
        this._callSessionManager('Inhibit',
            new GLib.Variant('(susu)', ['loco-shell', 0, 'Keep Awake quick tool', INHIBIT_SUSPEND | INHIBIT_IDLE]),
            new GLib.VariantType('(u)'), reply => {
                this._pending = false;
                if (!reply)
                    return;
                [this._cookie] = reply.deepUnpack();
                // Switched off, or the extension disabled, while in flight.
                this._sync();
            });
    }

    _uninhibit() {
        if (!this._cookie)
            return;

        this._callSessionManager('Uninhibit', new GLib.Variant('(u)', [this._cookie]), null);
        this._cookie = 0;
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnectObject(this);
        this._uninhibit();
    }
}

// The One Hand Operation+ quick tools panel: a brightness section, a volume
// and media section, and a grid of configurable quick tools, laid out like
// Samsung's One Hand Operation+ panel. Uses the shell's own MPRIS,
// brightness and volume APIs instead of playerctl, busctl and wpctl.




const PANEL_WIDTH = 300;
const MARGIN = 12;
const SLIDE_IN_TIME = 220;
const SLIDE_OUT_TIME = 250;
const VOLUME_STEP = 0.05;

// MprisSource has no destroy(), so share one for the whole session instead of
// leaking a D-Bus watcher on every enable.
let mprisSource = null;

function getMprisSource() {
    mprisSource ??= new MprisSource();
    return mprisSource;
}

function flatIconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'loco-flat-button',
        child: new St.Icon({icon_name: iconName}),
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
    });
}

function rowIcon(iconName) {
    return new St.Icon({
        style_class: 'loco-row-icon',
        icon_name: iconName,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function valueLabel() {
    return new St.Label({
        style_class: 'loco-value-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function section(vertical = false) {
    return new St.BoxLayout({
        style_class: 'loco-quick-section',
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        x_expand: true,
    });
}

export class QuickPanel {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     * @param {object} ctx - {launcher, extension}, passed on to the tools
     */
    constructor(settings, ctx) {
        this._settings = settings;
        this._ctx = ctx;
        this._grab = null;
        this._player = null;
        this._players = new Set();
        this._brightnessScale = null;
        this._stream = null;
        this._syncingSlider = false;
        this._tools = [];

        this._buildUi();

        this._settings.connectObject(
            'changed::quick-tools', () => this._toolsChanged(),
            'changed::custom-tools', () => this._toolsChanged(), this);

        this._mpris = getMprisSource();
        this._mpris.connectObject(
            'player-added', () => this._syncMedia(),
            'player-removed', (source, player) => {
                player.disconnectObject(this);
                this._players.delete(player);
                this._syncMedia();
            }, this);
        this._syncMedia();

        Main.brightnessManager.connectObject('changed', () => this._bindBrightness(), this);
        this._bindBrightness();

        this._mixer = getMixerControl();
        this._mixer.connectObject(
            'default-sink-changed', () => this._bindSink(),
            'state-changed', () => this._bindSink(), this);
        this._bindSink();
    }

    get isOpen() {
        return this._grab !== null;
    }

    _buildUi() {
        // Full-monitor layer: clicking outside the card closes it.
        this._backdrop = new St.Widget({reactive: true, visible: false});
        // The shared MPRIS source and mixer outlive these widgets; the shell
        // also destroys them at logout without calling destroy() on us.
        this._backdrop.connect('destroy', () => this._disconnectSignals());
        connectClickOutside(this._backdrop, () => this.close());
        this._backdrop.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            if (global.focus_manager.navigate_from_event(event))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        // Reactive so that clicks on its padding count as "inside".
        this._card = new St.BoxLayout({
            style_class: 'popup-menu-content loco-quick-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._backdrop.add_child(this._card);
        global.focus_manager.add_group(this._card);

        this._buildBrightnessSection();
        this._buildMediaSection();
        this._buildToolsSection();
    }

    _buildBrightnessSection() {
        this._brightnessSection = section();

        this._brightnessSlider = new Slider(0);
        this._brightnessSlider.set({x_expand: true, accessible_name: 'Brightness'});
        this._brightnessSlider.connect('notify::value', () => {
            if (!this._syncingSlider && this._brightnessScale)
                this._brightnessScale.value = this._brightnessSlider.value;
        });
        this._brightnessSection.add_child(this._brightnessSlider);

        this._brightnessLabel = valueLabel();
        this._brightnessSection.add_child(this._brightnessLabel);
        this._brightnessSection.add_child(rowIcon('display-brightness-symbolic'));

        this._card.add_child(this._brightnessSection);
    }

    _buildMediaSection() {
        const media = section(true);

        this._volumeRow = new St.BoxLayout({style_class: 'loco-quick-row'});
        this._volumeSlider = new Slider(0);
        this._volumeSlider.set({x_expand: true, accessible_name: 'Volume'});
        this._volumeSlider.connect('notify::value', () => {
            if (this._syncingSlider || !this._stream)
                return;
            this._stream.volume = this._volumeSlider.value * this._mixer.get_vol_max_norm();
            this._stream.push_volume();
        });
        this._volumeRow.add_child(this._volumeSlider);

        this._volumeLabel = valueLabel();
        this._volumeRow.add_child(this._volumeLabel);

        this._muteIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic'});
        this._muteButton = new St.Button({
            style_class: 'loco-flat-button',
            child: this._muteIcon,
            can_focus: true,
            track_hover: true,
            accessible_name: 'Mute',
        });
        this._muteButton.connect('clicked', () => {
            this._stream?.change_is_muted(!this._stream.is_muted);
        });
        this._volumeRow.add_child(this._muteButton);
        media.add_child(this._volumeRow);

        this._mediaTitle = new St.Label({
            style_class: 'loco-media-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        media.add_child(this._mediaTitle);

        // Same row as Samsung's: previous, play, next, volume down, volume up.
        const controls = new St.BoxLayout({style_class: 'loco-media-controls', x_expand: true});

        this._prevButton = flatIconButton('media-skip-backward-symbolic', 'Previous track');
        this._prevButton.connect('clicked', () => this._player?.previous());
        controls.add_child(this._prevButton);

        this._playButton = flatIconButton('media-playback-start-symbolic', 'Play or pause');
        this._playButton.connect('clicked', () => this._player?.playPause());
        controls.add_child(this._playButton);

        this._nextButton = flatIconButton('media-skip-forward-symbolic', 'Next track');
        this._nextButton.connect('clicked', () => this._player?.next());
        controls.add_child(this._nextButton);

        const volumeDown = flatIconButton('audio-volume-low-symbolic', 'Volume down');
        volumeDown.connect('clicked', () => this._stepVolume(-1));
        controls.add_child(volumeDown);

        const volumeUp = flatIconButton('audio-volume-high-symbolic', 'Volume up');
        volumeUp.connect('clicked', () => this._stepVolume(1));
        controls.add_child(volumeUp);

        media.add_child(controls);
        this._card.add_child(media);
    }

    _buildToolsSection() {
        this._toolsGrid = new St.Widget({
            style_class: 'loco-quick-section loco-tools',
            layout_manager: new TileGridLayout(),
            x_expand: true,
        });
        this._card.add_child(this._toolsGrid);

        // Names the hovered tool, since the tiles only show icons.
        this._hint = new St.Label({
            style_class: 'loco-quick-hint',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._hint);
    }

    _destroyTools() {
        for (const {tool} of this._tools)
            tool.destroy();
        this._tools = [];
        this._toolsGrid.destroy_all_children();
    }

    _rebuildTools() {
        this._destroyTools();

        const ctx = {
            ...this._ctx,
            settings: this._settings,
            customTools: parseCustomTools(this._settings.get_string('custom-tools')),
        };

        for (const id of this._settings.get_strv('quick-tools')) {
            const tool = createTool(id, ctx);
            if (tool)
                this._addToolTile(tool);
        }

        this._toolsGrid.visible = this._tools.length > 0;
        this._showHint(null);
    }

    _addToolTile(tool) {
        const icon = new St.Icon({style_class: 'loco-tool-icon'});
        const button = new St.Button({
            style_class: 'loco-tool',
            child: icon,
            can_focus: true,
            track_hover: true,
            accessible_name: tool.name,
        });

        const sync = () => {
            if (tool.gicon)
                icon.gicon = tool.gicon;
            else
                icon.icon_name = tool.iconName;

            button.checked = tool.toggle && tool.active;
            // Stay reactive so hovering still explains why it is greyed out.
            if (tool.available)
                button.remove_style_pseudo_class('insensitive');
            else
                button.add_style_pseudo_class('insensitive');

            if (button.hover || button.has_key_focus())
                this._showHint(tool);
        };
        tool.onChanged(sync);
        sync();

        button.connect('notify::hover', () => this._showHint(button.hover ? tool : null));
        button.connect('key-focus-in', () => this._showHint(tool));
        button.connect('key-focus-out', () => this._showHint(null));
        button.connect('clicked', () => this._activateTool(tool));

        this._toolsGrid.add_child(button);
        this._tools.push({tool, button});
    }

    _showHint(tool) {
        if (!tool) {
            this._hint.text = '';
            return;
        }

        let state = '';
        if (!tool.available)
            state = ' · Unavailable';
        else if (tool.toggle)
            state = tool.active ? ' · On' : ' · Off';
        this._hint.text = `${tool.name}${state}`;
    }

    _activateTool(tool) {
        if (!tool.available)
            return;

        const run = () => {
            try {
                tool.activate();
            } catch (e) {
                logError(e, `loco-shell: quick tool ${tool.id} failed`);
            }
        };

        if (tool.closesPanel)
            this.close(run);
        else
            run();
    }

    _toolsChanged() {
        if (this.isOpen)
            this._rebuildTools();
    }

    _stepVolume(direction) {
        if (!this._stream)
            return;

        const max = this._mixer.get_vol_max_norm();
        if (direction > 0 && this._stream.is_muted)
            this._stream.change_is_muted(false);
        this._stream.volume = Math.max(0, Math.min(max, this._stream.volume + direction * VOLUME_STEP * max));
        this._stream.push_volume();
    }

    _syncMedia() {
        const players = this._mpris.players;
        for (const player of players) {
            if (!this._players.has(player)) {
                this._players.add(player);
                player.connectObject('changed', () => this._syncMedia(), this);
            }
        }

        this._player = players.find(p => p.status === 'Playing') ?? players[0] ?? null;
        const player = this._player;

        this._mediaTitle.text = player ? player.trackTitle || 'Unknown Title' : 'No media playing';
        this._playButton.child.icon_name = player?.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.reactive = !!player;
        this._prevButton.reactive = !!player?.canGoPrevious;
        this._nextButton.reactive = !!player?.canGoNext;
    }

    _bindBrightness() {
        const scale = Main.brightnessManager.globalScale;
        // No backlight (e.g. a desktop monitor without DDC): hide the section.
        this._brightnessSection.visible = !!scale;
        if (scale === this._brightnessScale)
            return;

        this._brightnessScale?.disconnectObject(this);
        this._brightnessScale = scale;
        if (!scale)
            return;

        scale.connectObject('notify::value', () => this._syncBrightness(), this);
        this._syncBrightness();
    }

    _syncBrightness() {
        const {value} = this._brightnessScale;
        this._syncingSlider = true;
        this._brightnessSlider.value = value;
        this._syncingSlider = false;
        this._brightnessLabel.text = `${Math.round(value * 100)}%`;
    }

    _bindSink() {
        const stream = this._mixer.get_default_sink();
        this._volumeRow.visible = !!stream;
        if (stream === this._stream)
            return;

        this._stream?.disconnectObject(this);
        this._stream = stream;
        if (!stream)
            return;

        stream.connectObject(
            'notify::volume', () => this._syncVolume(),
            'notify::is-muted', () => this._syncVolume(), this);
        this._syncVolume();
    }

    _syncVolume() {
        const muted = this._stream.is_muted;
        const level = this._stream.volume / this._mixer.get_vol_max_norm();

        this._syncingSlider = true;
        this._volumeSlider.value = Math.min(1, level);
        this._syncingSlider = false;

        // Same as the QML: the slider is dimmed and locked while muted.
        this._volumeSlider.reactive = !muted;
        this._volumeSlider.opacity = muted ? 128 : 255;
        this._volumeLabel.text = muted ? 'Muted' : `${Math.round(level * 100)}%`;

        let iconName;
        if (muted || level <= 0)
            iconName = 'audio-volume-muted-symbolic';
        else if (level < 1 / 3)
            iconName = 'audio-volume-low-symbolic';
        else if (level < 2 / 3)
            iconName = 'audio-volume-medium-symbolic';
        else
            iconName = 'audio-volume-high-symbolic';
        this._muteIcon.icon_name = iconName;

        for (const actor of [this._muteButton, this._volumeLabel]) {
            if (muted)
                actor.add_style_class_name('loco-muted');
            else
                actor.remove_style_class_name('loco-muted');
        }
    }

    /**
     * @param {boolean} fromRight - slide in from the right screen edge
     * @param {number} stageY - vertical position of the swipe, in stage coordinates
     */
    open(fromRight, stageY) {
        if (this.isOpen)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const margin = MARGIN * scaleFactor;
        const width = PANEL_WIDTH * scaleFactor;

        // Cut short a running slide-out; its onComplete must not hide us.
        this._card.remove_all_transitions();

        // Tools are built per opening: some (Wi-Fi, Bluetooth, ...) wrap
        // Quick Settings toggles that only exist once the shell has set them up.
        this._rebuildTools();

        this._backdrop.set_position(monitor.x, monitor.y);
        this._backdrop.set_size(monitor.width, monitor.height);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._backdrop, null);
        this._backdrop.show();

        this._card.width = width;
        const [, height] = this._card.get_preferred_height(width);
        const y = Math.max(margin,
            Math.min(monitor.height - height - margin, stageY - monitor.y - height / 2));
        this._card.set_position(fromRight ? monitor.width - width - margin : margin, y);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});

        // Slide in from the edge the swipe came from.
        this._card.translation_x = fromRight ? width + margin : -(width + 2 * margin);
        this._card.ease({
            translation_x: 0,
            duration: SLIDE_IN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._fromRight = fromRight;
    }

    /**
     * @param {Function} [onClosed] - called once the slide-out has finished
     */
    close(onClosed) {
        if (!this.isOpen)
            return;

        Main.popModal(this._grab);
        this._grab = null;

        const width = this._card.width;
        const margin = MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._card.remove_all_transitions();
        this._card.ease({
            translation_x: this._fromRight ? width + margin : -(width + 2 * margin),
            duration: SLIDE_OUT_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._backdrop.hide();
                onClosed?.();
                this._destroyTools();
            },
        });
    }

    _disconnectSignals() {
        for (const {tool} of this._tools)
            tool.destroy();
        this._tools = [];
        this._settings.disconnectObject(this);
        this._mpris.disconnectObject(this);
        for (const player of this._players)
            player.disconnectObject(this);
        this._players.clear();
        Main.brightnessManager.disconnectObject(this);
        this._brightnessScale?.disconnectObject(this);
        this._mixer.disconnectObject(this);
        this._stream?.disconnectObject(this);
    }

    destroy() {
        if (this.isOpen) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._backdrop.destroy();
    }
}

// Port of the left/right edge hotzones from one-hand-op/shell.qml: drag
// inward from a thin strip at the screen edge to open the quick panel, or
// keep dragging to the middle of the screen to open the launcher.



const STRIP_WIDTH = 8;
const TRIGGER_DISTANCE = 45;
const INDICATOR_WIDTH = 55;
const INDICATOR_HEIGHT = 90;
const INDICATOR_TRAVEL = 70;

const EdgeStrip = GObject.registerClass({
    Signals: {
        // distance from the edge, stage y
        'drag-update': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        'drag-end': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    },
}, class EdgeStrip extends St.Widget {
    constructor(fromRight) {
        super({reactive: true});

        this.fromRight = fromRight;
        this._grab = null;
        this._button = 0;
        this._sequence = null;
        this._startX = 0;
        this._lastDistance = 0;
        this._lastY = 0;

        this.connect('destroy', () => this._release());
    }

    _isActiveSequence(button, sequence) {
        return this._grab !== null &&
            this._button === button &&
            this._sequence?.get_slot() === sequence?.get_slot();
    }

    _onPress(event, button, sequence) {
        if (this._grab)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        this._startX = x;
        this._button = button;
        this._sequence = sequence;
        // Keep receiving motion and release once the pointer leaves the strip.
        this._grab = global.stage.grab(this);
        this._report(x, y, 'drag-update');
        return Clutter.EVENT_STOP;
    }

    _onMotion(event, button, sequence) {
        if (!this._isActiveSequence(button, sequence))
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        this._report(x, y, 'drag-update');
        return Clutter.EVENT_STOP;
    }

    _onRelease(event, button, sequence, cancelled) {
        if (!this._isActiveSequence(button, sequence))
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        this._release();
        if (cancelled)
            this.emit('drag-end', 0, this._lastY);
        else
            this._report(x, y, 'drag-end');
        return Clutter.EVENT_STOP;
    }

    _report(x, y, signal) {
        const dx = this.fromRight ? this._startX - x : x - this._startX;
        this._lastDistance = Math.max(0, dx);
        this._lastY = y;
        this.emit(signal, this._lastDistance, y);
    }

    _release() {
        this._grab?.dismiss();
        this._grab = null;
        this._button = 0;
        this._sequence = null;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._onPress(event, Clutter.BUTTON_PRIMARY, null);
    }

    vfunc_motion_event(event) {
        return this._onMotion(event, Clutter.BUTTON_PRIMARY, null);
    }

    vfunc_button_release_event(event) {
        return this._onRelease(event, event.get_button(), null, false);
    }

    vfunc_touch_event(event) {
        const sequence = event.get_event_sequence();
        switch (event.type()) {
        case Clutter.EventType.TOUCH_BEGIN:
            return this._onPress(event, 'touch', sequence);
        case Clutter.EventType.TOUCH_UPDATE:
            return this._onMotion(event, 'touch', sequence);
        case Clutter.EventType.TOUCH_END:
            return this._onRelease(event, 'touch', sequence, false);
        case Clutter.EventType.TOUCH_CANCEL:
            return this._onRelease(event, 'touch', sequence, true);
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
});

export class EdgeSwipe {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     * @param {object} handlers - {onShortSwipe(fromRight, stageY), onLongSwipe()}
     */
    constructor(settings, handlers) {
        this._settings = settings;
        this._handlers = handlers;
        this._strips = [];

        // Pill that follows the finger, like the QML gesture indicator. Its
        // icon says what releasing now will do.
        this._indicatorIcon = new St.Icon({style_class: 'loco-edge-indicator-icon'});
        this._indicator = new St.Bin({
            style_class: 'popup-menu-content loco-edge-indicator',
            child: this._indicatorIcon,
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._indicator);

        this._settings.connectObject(
            'changed::left-edge', () => this._rebuildStrips(),
            'changed::right-edge', () => this._rebuildStrips(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        global.display.connectObject('workareas-changed', () => this._reposition(), this);
        this._rebuildStrips();
    }

    _scaled(value) {
        return value * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // Disabled edges get no strip at all: hiding one would not stick, since
    // the layout manager re-shows fullscreen-tracked chrome.
    _rebuildStrips() {
        this._destroyStrips();
        this._indicator.hide();

        const edges = [];
        if (this._settings.get_boolean('left-edge'))
            edges.push(false);
        if (this._settings.get_boolean('right-edge'))
            edges.push(true);

        for (const fromRight of edges) {
            const strip = new EdgeStrip(fromRight);
            Main.layoutManager.addTopChrome(strip, {trackFullscreen: true});
            strip.connect('drag-update', (s, distance, y) => this._updateIndicator(s, distance, y));
            strip.connect('drag-end', (s, distance, y) => this._onDragEnd(s, distance, y));
            this._strips.push(strip);
        }
        this._reposition();
    }

    _destroyStrips() {
        for (const strip of this._strips) {
            Main.layoutManager.removeChrome(strip);
            strip.destroy();
        }
        this._strips = [];
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // Span only the work area, so the strips never cover a panel's end
        // buttons (top bar, dash-to-panel and the like).
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = this._scaled(STRIP_WIDTH);
        for (const strip of this._strips) {
            strip.set_position(
                strip.fromRight ? monitor.x + monitor.width - width : monitor.x,
                workArea.y);
            strip.set_size(width, workArea.height);
        }
    }

    /**
     * @param {number} distance - how far the swipe has travelled from the edge
     * @returns {string|null} 'launcher' once it reaches the middle of the
     *   screen, 'tools' past the trigger distance, null before that
     */
    _modeFor(distance) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor && this._settings.get_boolean('long-swipe-launcher') &&
            distance >= monitor.width / 2 - this._scaled(STRIP_WIDTH))
            return 'launcher';
        if (distance > this._scaled(TRIGGER_DISTANCE))
            return 'tools';
        return null;
    }

    _onDragEnd(strip, distance, y) {
        this._indicator.hide();
        const mode = this._modeFor(distance);
        if (mode === 'launcher')
            this._handlers.onLongSwipe();
        else if (mode === 'tools')
            this._handlers.onShortSwipe(strip.fromRight, y);
    }

    _updateIndicator(strip, distance, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const width = this._scaled(INDICATOR_WIDTH);
        const height = this._scaled(INDICATOR_HEIGHT);
        const threshold = this._scaled(TRIGGER_DISTANCE);
        const mode = this._modeFor(distance);

        // Peek out from the edge; once the swipe is long enough for the
        // launcher, follow the finger so the switch is obvious.
        const travel = mode === 'launcher'
            ? distance + width / 2
            : Math.min(this._scaled(INDICATOR_TRAVEL), distance * 0.9);

        if (mode === 'launcher')
            this._indicatorIcon.icon_name = 'view-app-grid-symbolic';
        else if (mode === 'tools')
            this._indicatorIcon.icon_name = 'emblem-system-symbolic';
        else
            this._indicatorIcon.icon_name = strip.fromRight ? 'go-previous-symbolic' : 'go-next-symbolic';

        this._indicator.set_size(width, height);
        this._indicator.set_position(
            strip.fromRight ? monitor.x + monitor.width - travel : monitor.x - width + travel,
            y - height / 2);
        this._indicator.opacity = Math.round(255 * Math.min(1, distance / threshold));

        if (mode)
            this._indicator.add_style_class_name('active');
        else
            this._indicator.remove_style_class_name('active');

        if (!this._indicator.visible) {
            Main.layoutManager.uiGroup.set_child_above_sibling(this._indicator, null);
            this._indicator.show();
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._destroyStrips();
        this._indicator.destroy();
    }
}
