// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences: choose and order the quick tools, create custom tools, and
// configure the edge gestures.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    BUILTIN_TOOLS, CUSTOM_PREFIX, TOOL_CATEGORIES, describeTool, parseCustomTools,
} from './toolCatalog.js';

const FALLBACK_ICON = 'application-x-executable-symbolic';

// Row titles and subtitles are Pango markup ("Sound & Notifications").
const esc = text => GLib.markup_escape_text(text, -1);

// A few tool icons ship inside GNOME Shell only, not in the GTK icon theme.
const PREFS_ICON_OVERRIDES = {
    'dark-mode-symbolic': 'weather-clear-night-symbolic',
};

function toolImage(tool) {
    if (tool?.type === 'app' && !tool.icon) {
        const gicon = Gio.DesktopAppInfo.new(tool.target)?.get_icon();
        if (gicon)
            return new Gtk.Image({gicon});
    }

    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    let name = tool?.icon || (tool?.type === 'command' ? 'system-run-symbolic' : FALLBACK_ICON);
    name = PREFS_ICON_OVERRIDES[name] ?? name;
    return Gtk.Image.new_from_icon_name(theme.has_icon(name) ? name : FALLBACK_ICON);
}

function iconButton(iconName, tooltip, onClicked, sensitive = true) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        sensitive,
    });
    button.connect('clicked', onClicked);
    return button;
}

function customSubtitle(tool) {
    if (tool.type === 'app') {
        const name = Gio.DesktopAppInfo.new(tool.target)?.get_display_name() ?? tool.target;
        return `Custom · opens ${name}`;
    }
    return `Custom · runs ${tool.target}`;
}

function toolSubtitle(tool) {
    if (!tool)
        return 'Unknown tool; remove it';
    if (tool.id.startsWith(CUSTOM_PREFIX))
        return customSubtitle(tool);
    return tool.toggle ? `${tool.category} · on/off` : tool.category;
}

const QuickToolsPage = GObject.registerClass(
class QuickToolsPage extends Adw.PreferencesPage {
    constructor(settings) {
        super({title: 'Quick Tools', icon_name: 'view-grid-symbolic'});
        this._settings = settings;
        this._toolRows = [];
        this._customRows = [];

        this._toolsGroup = new Adw.PreferencesGroup({
            title: 'Panel Tools',
            description: 'Shown in the quick tools grid, four per row, in this order. Toggles light up while they are on.',
        });
        const headerButtons = new Gtk.Box({spacing: 6});
        headerButtons.append(iconButton('edit-undo-symbolic', 'Reset to the default tools',
            () => this._settings.reset('quick-tools')));
        headerButtons.append(iconButton('list-add-symbolic', 'Add a tool', () => this._showAddDialog()));
        this._toolsGroup.set_header_suffix(headerButtons);
        this.add(this._toolsGroup);

        this._customGroup = new Adw.PreferencesGroup({
            title: 'Custom Tools',
            description: 'Your own tiles that open an app or run a command.',
        });
        this._customGroup.set_header_suffix(
            iconButton('list-add-symbolic', 'New custom tool', () => this._editCustomTool(null)));
        this.add(this._customGroup);

        this._settings.connect('changed::quick-tools', () => this._syncTools());
        this._settings.connect('changed::custom-tools', () => {
            this._syncTools();
            this._syncCustomTools();
        });
        this._syncTools();
        this._syncCustomTools();
    }

    get _customTools() {
        return parseCustomTools(this._settings.get_string('custom-tools'));
    }

    _setIds(ids) {
        this._settings.set_strv('quick-tools', ids);
    }

    _syncTools() {
        for (const row of this._toolRows)
            this._toolsGroup.remove(row);
        this._toolRows = [];

        const ids = this._settings.get_strv('quick-tools');
        const customTools = this._customTools;

        if (ids.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No tools',
                subtitle: 'Use the + button to add some.',
            });
            this._toolsGroup.add(row);
            this._toolRows.push(row);
            return;
        }

        ids.forEach((id, i) => {
            const tool = describeTool(id, customTools);
            const row = new Adw.ActionRow({
                title: esc(tool?.name ?? id),
                subtitle: esc(toolSubtitle(tool)),
            });
            row.add_prefix(toolImage(tool));

            const move = delta => {
                const next = [...ids];
                [next[i], next[i + delta]] = [next[i + delta], next[i]];
                this._setIds(next);
            };
            row.add_suffix(iconButton('go-up-symbolic', 'Move up', () => move(-1), i > 0));
            row.add_suffix(iconButton('go-down-symbolic', 'Move down', () => move(1), i < ids.length - 1));
            row.add_suffix(iconButton('list-remove-symbolic', 'Remove from the panel',
                () => this._setIds(ids.filter((_, j) => j !== i))));

            this._toolsGroup.add(row);
            this._toolRows.push(row);
        });
    }

    _syncCustomTools() {
        for (const row of this._customRows)
            this._customGroup.remove(row);
        this._customRows = [];

        const customTools = this._customTools;
        if (customTools.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No custom tools',
                subtitle: 'Use the + button to make one.',
            });
            this._customGroup.add(row);
            this._customRows.push(row);
            return;
        }

        for (const tool of customTools) {
            const row = new Adw.ActionRow({
                title: esc(tool.name),
                subtitle: esc(customSubtitle(tool)),
            });
            row.add_prefix(toolImage(tool));
            row.add_suffix(iconButton('document-edit-symbolic', 'Edit', () => this._editCustomTool(tool)));
            row.add_suffix(iconButton('user-trash-symbolic', 'Delete', () => this._deleteCustomTool(tool)));
            this._customGroup.add(row);
            this._customRows.push(row);
        }
    }

    _showAddDialog() {
        const current = new Set(this._settings.get_strv('quick-tools'));
        const dialog = new Adw.Dialog({title: 'Add Tool', content_width: 440, content_height: 640});
        const page = new Adw.PreferencesPage();

        const add = id => {
            this._setIds([...this._settings.get_strv('quick-tools'), id]);
            dialog.close();
        };

        const sections = TOOL_CATEGORIES.map(category =>
            [category, BUILTIN_TOOLS.filter(t => t.category === category)]);
        sections.push(['Custom', this._customTools]);

        const groups = [];
        for (const [title, tools] of sections) {
            const addable = tools.filter(t => !current.has(t.id));
            if (addable.length === 0)
                continue;

            const group = new Adw.PreferencesGroup({title: esc(title)});
            const rows = [];
            for (const tool of addable) {
                const row = new Adw.ActionRow({
                    title: esc(tool.name),
                    subtitle: esc(tool.id.startsWith(CUSTOM_PREFIX) ? customSubtitle(tool) : (tool.toggle ? 'On/off toggle' : '')),
                        activatable: true,
                });
                row.add_prefix(toolImage(tool));
                row.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
                row.connect('activated', () => add(tool.id));
                group.add(row);
                rows.push([tool.name.toLowerCase(), row]);
            }
            page.add(group);
            groups.push([group, rows]);
        }

        const search = new Gtk.SearchEntry({placeholder_text: 'Search tools', hexpand: true});
        search.connect('search-changed', () => {
            const query = search.text.trim().toLowerCase();
            for (const [group, rows] of groups) {
                let any = false;
                for (const [name, row] of rows) {
                    row.visible = name.includes(query);
                    any ||= row.visible;
                }
                group.visible = any;
            }
        });

        const header = new Adw.HeaderBar({title_widget: search});
        const view = new Adw.ToolbarView({
            content: groups.length > 0 ? page : new Adw.StatusPage({
                icon_name: 'object-select-symbolic',
                title: 'Everything is already in the panel',
            }),
        });
        view.add_top_bar(header);
        dialog.set_child(view);
        dialog.present(this.get_root());
    }

    _editCustomTool(existing) {
        const dialog = new Adw.Dialog({
            title: existing ? 'Edit Custom Tool' : 'New Custom Tool',
            content_width: 440,
        });

        const group = new Adw.PreferencesGroup();
        const nameRow = new Adw.EntryRow({title: 'Name', text: existing?.name ?? ''});
        group.add(nameRow);

        const typeRow = new Adw.ComboRow({
            title: 'Action',
            model: Gtk.StringList.new(['Open an app', 'Run a command']),
            selected: existing?.type === 'command' ? 1 : 0,
        });
        group.add(typeRow);

        const apps = Gio.AppInfo.get_all()
            .filter(app => app.should_show())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
        const appRow = new Adw.ComboRow({
            title: 'App',
            model: Gtk.StringList.new(apps.map(app => app.get_display_name())),
            enable_search: true,
            expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
        });
        if (existing?.type === 'app') {
            const index = apps.findIndex(app => app.get_id() === existing.target);
            if (index >= 0)
                appRow.selected = index;
        }
        group.add(appRow);

        const commandRow = new Adw.EntryRow({
            title: 'Command',
            text: existing?.type === 'command' ? existing.target : '',
        });
        group.add(commandRow);

        const iconRow = new Adw.EntryRow({
            title: 'Icon name (empty: use the app\'s icon)',
            text: existing?.icon ?? '',
        });
        const preview = new Gtk.Image({valign: Gtk.Align.CENTER});
        iconRow.add_suffix(preview);
        group.add(iconRow);

        const draft = () => {
            const isApp = typeRow.selected === 0;
            return {
                id: existing?.id ?? `${CUSTOM_PREFIX}${GLib.uuid_string_random().slice(0, 8)}`,
                name: nameRow.text.trim(),
                icon: iconRow.text.trim(),
                type: isApp ? 'app' : 'command',
                target: isApp ? apps[appRow.selected]?.get_id() ?? '' : commandRow.text.trim(),
            };
        };

        const sync = () => {
            const isApp = typeRow.selected === 0;
            appRow.visible = isApp;
            commandRow.visible = !isApp;
            const image = toolImage(draft());
            if (image.gicon)
                preview.set_from_gicon(image.gicon);
            else
                preview.set_from_icon_name(image.icon_name);
        };
        typeRow.connect('notify::selected', sync);
        appRow.connect('notify::selected', sync);
        iconRow.connect('changed', sync);
        sync();

        const saveButton = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        saveButton.connect('clicked', () => {
            const tool = draft();
            nameRow.remove_css_class('error');
            commandRow.remove_css_class('error');
            let valid = true;
            if (!tool.name) {
                nameRow.add_css_class('error');
                valid = false;
            }
            if (!tool.target) {
                (tool.type === 'app' ? appRow : commandRow).add_css_class('error');
                valid = false;
            }
            if (!valid)
                return;

            const list = this._customTools;
            const index = list.findIndex(t => t.id === tool.id);
            if (index >= 0)
                list[index] = tool;
            else
                list.push(tool);
            this._settings.set_string('custom-tools', JSON.stringify(list));

            // A brand-new tool goes straight into the panel.
            if (!existing)
                this._setIds([...this._settings.get_strv('quick-tools'), tool.id]);
            dialog.close();
        });

        const cancelButton = new Gtk.Button({label: 'Cancel'});
        cancelButton.connect('clicked', () => dialog.close());

        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancelButton);
        header.pack_end(saveButton);

        const page = new Adw.PreferencesPage();
        page.add(group);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        dialog.set_child(view);
        dialog.present(this.get_root());
    }

    _deleteCustomTool(tool) {
        const alert = new Adw.AlertDialog({
            heading: `Delete “${tool.name}”?`,
            body: 'It is also removed from the panel.',
        });
        alert.add_response('cancel', 'Cancel');
        alert.add_response('delete', 'Delete');
        alert.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        alert.connect('response', (dialog, response) => {
            if (response !== 'delete')
                return;
            this._settings.set_string('custom-tools',
                JSON.stringify(this._customTools.filter(t => t.id !== tool.id)));
            this._setIds(this._settings.get_strv('quick-tools').filter(id => id !== tool.id));
        });
        alert.present(this.get_root());
    }
});

const GesturesPage = GObject.registerClass(
class GesturesPage extends Adw.PreferencesPage {
    constructor(settings) {
        super({title: 'Gestures', icon_name: 'input-touchpad-symbolic'});

        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const edges = new Adw.PreferencesGroup({
            title: 'Screen Edges',
            description: 'Swipe inward from a screen edge, with the mouse or a finger, to open the quick tools.',
        });
        edges.add(switchRow('left-edge', 'Left edge'));
        edges.add(switchRow('right-edge', 'Right edge'));
        this.add(edges);

        const longSwipe = new Adw.PreferencesGroup({title: 'Long Swipe'});
        longSwipe.add(switchRow('long-swipe-launcher', 'Swipe to the middle for the launcher',
            'Keep dragging to the middle of the screen and let go to open Loco instead of the quick tools.'));
        this.add(longSwipe);
    }
});

export default class LocoShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 760);
        window.add(new QuickToolsPage(settings));
        window.add(new GesturesPage(settings));
    }
}
