// SPDX-License-Identifier: GPL-2.0-or-later

// Every built-in quick tool, as plain data. Shared by the shell side
// (quickTools.js implements them) and the preferences window, so this file
// must not import anything from the shell.

export const TOOL_CATEGORIES = [
    'Connectivity',
    'Display',
    'Sound & Notifications',
    'Wellbeing',
    'Privacy',
    'Accessibility',
    'Windows & Workspaces',
    'Shell',
    'Session',
    'Apps',
    'Loco',
];

// toggle: true marks tools with an on/off state shown on the tile.
export const BUILTIN_TOOLS = [
    {id: 'wifi', name: 'Wi-Fi', icon: 'network-wireless-symbolic', category: 'Connectivity', toggle: true},
    {id: 'bluetooth', name: 'Bluetooth', icon: 'bluetooth-active-symbolic', category: 'Connectivity', toggle: true},
    {id: 'airplane', name: 'Airplane Mode', icon: 'airplane-mode-symbolic', category: 'Connectivity', toggle: true},
    {id: 'vpn', name: 'VPN', icon: 'network-vpn-symbolic', category: 'Connectivity', toggle: true},

    {id: 'night-light', name: 'Night Light', icon: 'night-light-symbolic', category: 'Display', toggle: true},
    {id: 'dark-style', name: 'Dark Style', icon: 'dark-mode-symbolic', category: 'Display', toggle: true},
    {id: 'auto-rotate', name: 'Auto Rotate', icon: 'rotation-allowed-symbolic', category: 'Display', toggle: true},
    {id: 'power-mode', name: 'Power Mode', icon: 'power-profile-balanced-symbolic', category: 'Display', toggle: true},
    {id: 'keep-awake', name: 'Keep Awake', icon: 'preferences-desktop-screensaver-symbolic', category: 'Display', toggle: true},
    {id: 'animations', name: 'Animations', icon: 'applications-graphics-symbolic', category: 'Display', toggle: true},
    {id: 'hot-corner', name: 'Hot Corner', icon: 'input-mouse-symbolic', category: 'Display', toggle: true},
    {id: 'touchpad', name: 'Touchpad', icon: 'input-touchpad-symbolic', category: 'Display', toggle: true},

    {id: 'dnd', name: 'Do Not Disturb', icon: 'notifications-disabled-symbolic', category: 'Sound & Notifications', toggle: true},
    {id: 'mute', name: 'Mute Sound', icon: 'audio-volume-muted-symbolic', category: 'Sound & Notifications', toggle: true},
    {id: 'mic-mute', name: 'Mute Microphone', icon: 'microphone-disabled-symbolic', category: 'Sound & Notifications', toggle: true},
    {id: 'notifications', name: 'Notifications', icon: 'preferences-system-notifications-symbolic', category: 'Sound & Notifications'},

    {id: 'break-reminders', name: 'Break Reminders', icon: 'alarm-symbolic', category: 'Wellbeing', toggle: true},
    {id: 'screen-time-limit', name: 'Screen Time Limit', icon: 'org.gnome.Settings-screen-time-symbolic', category: 'Wellbeing', toggle: true},
    {id: 'wellbeing-settings', name: 'Wellbeing Settings', icon: 'org.gnome.Settings-wellbeing-symbolic', category: 'Wellbeing'},

    {id: 'location', name: 'Location Services', icon: 'location-services-active-symbolic', category: 'Privacy', toggle: true},
    {id: 'camera', name: 'Camera Access', icon: 'camera-web-symbolic', category: 'Privacy', toggle: true},

    {id: 'high-contrast', name: 'High Contrast', icon: 'preferences-desktop-accessibility-symbolic', category: 'Accessibility', toggle: true},
    {id: 'large-text', name: 'Large Text', icon: 'accessibility-large-text-symbolic', category: 'Accessibility', toggle: true},
    {id: 'screen-reader', name: 'Screen Reader', icon: 'accessibility-screen-reader-symbolic', category: 'Accessibility', toggle: true},
    {id: 'screen-keyboard', name: 'Screen Keyboard', icon: 'input-keyboard-symbolic', category: 'Accessibility', toggle: true},
    {id: 'magnifier', name: 'Zoom', icon: 'zoom-in-symbolic', category: 'Accessibility', toggle: true},

    {id: 'show-desktop', name: 'Show Desktop', icon: 'user-desktop-symbolic', category: 'Windows & Workspaces'},
    {id: 'close-window', name: 'Close Window', icon: 'window-close-symbolic', category: 'Windows & Workspaces'},
    {id: 'minimize-window', name: 'Minimize Window', icon: 'window-minimize-symbolic', category: 'Windows & Workspaces'},
    {id: 'maximize-window', name: 'Maximize Window', icon: 'window-maximize-symbolic', category: 'Windows & Workspaces'},
    {id: 'fullscreen-window', name: 'Fullscreen Window', icon: 'view-fullscreen-symbolic', category: 'Windows & Workspaces'},
    {id: 'always-on-top', name: 'Always on Top', icon: 'go-top-symbolic', category: 'Windows & Workspaces'},
    {id: 'workspace-prev', name: 'Previous Workspace', icon: 'go-previous-symbolic', category: 'Windows & Workspaces'},
    {id: 'workspace-next', name: 'Next Workspace', icon: 'go-next-symbolic', category: 'Windows & Workspaces'},
    {id: 'move-window-prev', name: 'Move Window Left', icon: 'go-first-symbolic', category: 'Windows & Workspaces'},
    {id: 'move-window-next', name: 'Move Window Right', icon: 'go-last-symbolic', category: 'Windows & Workspaces'},

    {id: 'screenshot', name: 'Screenshot', icon: 'applets-screenshooter-symbolic', category: 'Shell'},
    {id: 'screen-record', name: 'Screen Recording', icon: 'record-screen-symbolic', category: 'Shell'},
    {id: 'overview', name: 'Overview', icon: 'view-grid-symbolic', category: 'Shell'},
    {id: 'launcher', name: 'Loco Launcher', icon: 'view-app-grid-symbolic', category: 'Shell'},
    {id: 'quick-settings', name: 'Quick Settings', icon: 'emblem-system-symbolic', category: 'Shell'},
    {id: 'run-dialog', name: 'Run a Command', icon: 'system-run-symbolic', category: 'Shell'},

    {id: 'lock', name: 'Lock Screen', icon: 'system-lock-screen-symbolic', category: 'Session'},
    {id: 'suspend', name: 'Suspend', icon: 'media-playback-pause-symbolic', category: 'Session'},
    {id: 'log-out', name: 'Log Out', icon: 'system-log-out-symbolic', category: 'Session'},
    {id: 'restart', name: 'Restart', icon: 'system-reboot-symbolic', category: 'Session'},
    {id: 'power-off', name: 'Power Off', icon: 'system-shutdown-symbolic', category: 'Session'},

    {id: 'settings', name: 'Settings', icon: 'org.gnome.Settings-symbolic', category: 'Apps'},
    {id: 'files', name: 'Files', icon: 'system-file-manager-symbolic', category: 'Apps'},

    {id: 'loco-settings', name: 'Loco Shell Settings', icon: 'preferences-other-symbolic', category: 'Loco'},
    {id: 'close-panel', name: 'Close Panel', icon: 'window-close-symbolic', category: 'Loco'},
];

const BY_ID = new Map(BUILTIN_TOOLS.map(tool => [tool.id, tool]));

export const CUSTOM_PREFIX = 'custom-';

/**
 * @param {string} id - tool id
 * @returns {object|undefined} the built-in tool's metadata
 */
export function getBuiltinTool(id) {
    return BY_ID.get(id);
}

/**
 * @param {string} json - the custom-tools setting
 * @returns {object[]} custom tools; malformed entries are dropped
 */
export function parseCustomTools(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];

    return list.filter(t =>
        typeof t?.id === 'string' && t.id.startsWith(CUSTOM_PREFIX) &&
        typeof t.name === 'string' &&
        (t.type === 'app' || t.type === 'command') &&
        typeof t.target === 'string');
}

/**
 * @param {string} id - tool id
 * @param {object[]} customTools - from parseCustomTools()
 * @returns {object|undefined} metadata for a built-in or custom tool
 */
export function describeTool(id, customTools) {
    return getBuiltinTool(id) ?? customTools.find(t => t.id === id);
}
