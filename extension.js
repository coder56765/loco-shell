// SPDX-License-Identifier: GPL-2.0-or-later

// Loco Shell: a Poco-style color launcher that takes over GNOME's Show Apps
// grid, plus One Hand Operation+-style edge swipes that open a panel of
// configurable quick tools.
//
// This file only starts and stops the pieces:
//   launcher.js    - the launcher, its color filter and the shared widgets
//   emoji.js       - the launcher's emoji picker and Emoji Kitchen stickers
//   quickTools.js  - the quick tools panel and the edge swipes
// plus prefs.js (the settings window), toolCatalog.js (the tool list, shared
// with prefs.js) and kitchen.txt.gz (the Emoji Kitchen sticker index).

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {ColorIndex, LocoLauncher} from './launcher.js';
import {EdgeSwipe, KeepAwake, QuickPanel} from './quickTools.js';

const KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const SHOW_APPS_KEY = 'toggle-application-view';

export default class LocoShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._keepAwake = new KeepAwake(this._settings);
        this._colorIndex = new ColorIndex();
        this._launcher = new LocoLauncher(this._colorIndex, this._settings, this.dir);
        this._quickPanel = new QuickPanel(this._settings, {launcher: this._launcher, extension: this});
        this._edgeSwipe = new EdgeSwipe(this._settings, {
            onShortSwipe: (fromRight, y) => this._quickPanel.open(fromRight, y),
            onLongSwipe: () => this._openLauncher(),
        });

        this._injections = new InjectionManager();
        this._takeOverShowApps();
    }

    disable() {
        this._injections.clear();
        this._injections = null;
        this._restoreShowAppsKeybinding();

        this._edgeSwipe.destroy();
        this._edgeSwipe = null;
        this._quickPanel.destroy();
        this._quickPanel = null;
        this._launcher.destroy();
        this._launcher = null;
        this._colorIndex.destroy();
        this._colorIndex = null;
        // Releases the inhibitor; the setting stays on, so it comes back
        // after the screen is unlocked and the extension re-enabled.
        this._keepAwake.destroy();
        this._keepAwake = null;
        this._settings = null;
    }

    // From the overview, Loco opens on top of it, like GNOME's own app grid:
    // Escape goes back to the overview and launching an app leaves it.
    _openLauncher() {
        this._launcher.open();
    }

    _takeOverShowApps() {
        const launcher = this._launcher;
        const controls = Main.overview._overview.controls;
        const openLauncher = () => this._openLauncher();

        // Super+A. POPUP mode is allowed so the shortcut can also close Loco,
        // but it must not open Loco on top of some other open menu.
        this._setShowAppsKeybinding(() => {
            if (launcher.isOpen)
                launcher.close();
            else if (Main.actionMode !== Shell.ActionMode.POPUP)
                openLauncher();
        }, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);

        // GNOME's app grid must never appear. Every route to it is redirected
        // to Loco; the dash itself stays.

        // The Show Apps button in the dash, and the Ctrl+Alt+Tab "Apps" entry.
        this._injections.overrideMethod(controls, '_onShowAppsButtonToggled', original => function () {
            if (!this.dash.showAppsButton.checked) {
                original.call(this);
                return;
            }

            this._ignoreShowAppsButtonToggle = true;
            this.dash.showAppsButton.checked = false;
            this._ignoreShowAppsButtonToggle = false;
            openLauncher();
        });

        // Double-tapping Super and Super+Alt+Up move from the window picker up
        // to the app grid.
        this._injections.overrideMethod(controls, '_shiftState', original => function (direction) {
            const {finalState} = this._stateAdjustment.getStateTransitionParams();
            if (direction === Meta.MotionDirection.UP && finalState >= ControlsState.WINDOW_PICKER) {
                openLauncher();
                return;
            }
            original.call(this, direction);
        });

        // Touchpad swipe up: the overview stops at the window picker, and the
        // part of the swipe that would have shown the app grid reveals Loco
        // instead, following the fingers.
        let revealing = false;
        this._injections.overrideMethod(controls, 'gestureProgress', original => function (progress) {
            original.call(this, Math.min(progress, ControlsState.WINDOW_PICKER));

            const reveal = progress - ControlsState.WINDOW_PICKER;
            if (reveal > 0 && !revealing)
                revealing = launcher.beginReveal();
            if (revealing)
                launcher.updateReveal(reveal);
        });
        this._injections.overrideMethod(controls, 'gestureEnd', original => function (target, duration, onComplete) {
            const toLauncher = target === ControlsState.APP_GRID;
            original.call(this, Math.min(target, ControlsState.WINDOW_PICKER), duration, onComplete);

            if (revealing)
                launcher.endReveal(toLauncher, duration);
            else if (toLauncher)
                openLauncher();
            revealing = false;
        });

        // Main.overview.showApps()/selectApp() and anything else that shows
        // the overview directly in the app grid state.
        this._injections.overrideMethod(Main.overview, 'show', original => function (state = ControlsState.WINDOW_PICKER) {
            if (state === ControlsState.APP_GRID) {
                openLauncher();
                return;
            }
            original.call(this, state);
        });
    }

    _setShowAppsKeybinding(handler, modes) {
        Main.wm.removeKeybinding(SHOW_APPS_KEY);
        Main.wm.addKeybinding(SHOW_APPS_KEY,
            new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            modes,
            handler);
    }

    _restoreShowAppsKeybinding() {
        // Same registration as ControlsManager in ui/overviewControls.js.
        const controls = Main.overview._overview.controls;
        this._setShowAppsKeybinding(
            controls._toggleAppsPage.bind(controls),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }
}
