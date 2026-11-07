//! The native menu bar. Its items, titles, and key equivalents come from
//! `fixtures/contract/commands.json`, the same list the frontend command registry
//! reads, so the menu and the keyboard can never disagree. Choosing an item emits
//! [`MENU_COMMAND_EVENT`]; the frontend runs the command exactly as a shortcut or a
//! toolbar click would. The frontend reports which items apply to the current
//! document through [`set_menu_item_states`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{IpcError, IpcResult};

pub const MENU_COMMAND_EVENT: &str = "menu-command";
const SEPARATOR: &str = "separator";
const CONTRACT: &str = include_str!("../../../../fixtures/contract/commands.json");

#[derive(Debug, Deserialize)]
struct Contract {
    menus: Vec<MenuSpec>,
    commands: HashMap<String, CommandSpec>,
}

#[derive(Debug, Deserialize)]
struct MenuSpec {
    id: String,
    title: String,
    items: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandSpec {
    title: String,
    shortcut: Option<String>,
    shortcut_other: Option<String>,
    #[serde(default = "default_true")]
    accelerator: bool,
}

const fn default_true() -> bool {
    true
}

impl CommandSpec {
    /// The key equivalent the menu shows on this platform, if any.
    fn accelerator(&self) -> Option<&str> {
        if !self.accelerator {
            return None;
        }
        if cfg!(target_os = "macos") {
            self.shortcut.as_deref()
        } else {
            self.shortcut_other.as_deref().or(self.shortcut.as_deref())
        }
    }
}

fn contract() -> tauri::Result<Contract> {
    Ok(serde_json::from_str(CONTRACT)?)
}

/// What the frontend receives when a menu item is chosen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandPayload {
    pub command_id: String,
}

/// Whether a menu item applies right now, and an optional context title such as
/// "Exit Full Screen" or "Remove Bookmark".
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuItemState {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub title: Option<String>,
}

/// The app's own items by command id. Predefined items (Copy, Quit, …) are not
/// listed: the OS handles them.
pub struct MenuItems<R: Runtime> {
    items: HashMap<String, MenuItem<R>>,
    default_titles: HashMap<String, String>,
}

/// The payload for a chosen menu id, or `None` for ids that are not app commands
/// (predefined items handle themselves).
pub fn menu_command_payload(id: &str) -> Option<MenuCommandPayload> {
    let contract = contract().ok()?;
    contract
        .commands
        .contains_key(id)
        .then(|| MenuCommandPayload {
            command_id: id.to_owned(),
        })
}

/// Builds the menu bar. Every app item starts disabled; the frontend enables what
/// the active document supports as soon as it registers its commands.
pub fn build<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<(Menu<R>, MenuItems<R>)> {
    let contract = contract()?;
    let menu = Menu::new(manager)?;
    let mut items = HashMap::new();
    let mut default_titles = HashMap::new();

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::new(manager, "SynapseRead", true)?;
        app_menu.append(&PredefinedMenuItem::about(manager, None, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(manager)?)?;
        app_menu.append(&PredefinedMenuItem::services(manager, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(manager)?)?;
        app_menu.append(&PredefinedMenuItem::hide(manager, None)?)?;
        app_menu.append(&PredefinedMenuItem::hide_others(manager, None)?)?;
        app_menu.append(&PredefinedMenuItem::show_all(manager, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(manager)?)?;
        app_menu.append(&PredefinedMenuItem::quit(manager, None)?)?;
        menu.append(&app_menu)?;
    }

    for spec in &contract.menus {
        let submenu = Submenu::new(manager, &spec.title, true)?;
        if spec.id == "edit" {
            // Without these, text fields lose Cut, Copy, Paste, and Undo on macOS.
            submenu.append(&PredefinedMenuItem::undo(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::redo(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::separator(manager)?)?;
            submenu.append(&PredefinedMenuItem::cut(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::copy(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::paste(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::select_all(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::separator(manager)?)?;
        }
        if spec.id == "window" {
            submenu.append(&PredefinedMenuItem::minimize(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::maximize(manager, None)?)?;
            submenu.append(&PredefinedMenuItem::separator(manager)?)?;
        }
        for id in &spec.items {
            if id == SEPARATOR {
                submenu.append(&PredefinedMenuItem::separator(manager)?)?;
                continue;
            }
            // `every_menu_entry_names_a_command_once` keeps this from skipping anything.
            let Some(command) = contract.commands.get(id) else {
                continue;
            };
            let item = MenuItem::with_id(
                manager,
                id.as_str(),
                &command.title,
                false,
                command.accelerator(),
            )?;
            submenu.append(&item)?;
            items.insert(id.clone(), item);
            default_titles.insert(id.clone(), command.title.clone());
        }
        #[cfg(not(target_os = "macos"))]
        if spec.id == "file" {
            submenu.append(&PredefinedMenuItem::separator(manager)?)?;
            submenu.append(&PredefinedMenuItem::quit(manager, None)?)?;
        }
        #[cfg(target_os = "macos")]
        match spec.id.as_str() {
            "window" => submenu.set_as_windows_menu_for_nsapp()?,
            "help" => submenu.set_as_help_menu_for_nsapp()?,
            _ => {}
        }
        menu.append(&submenu)?;
    }

    Ok((
        menu,
        MenuItems {
            items,
            default_titles,
        },
    ))
}

/// Enables, disables, and retitles menu items to match the active document. A
/// missing menu (tests, or a platform without one) is not an error.
#[tauri::command]
pub fn set_menu_item_states<R: Runtime>(
    app: AppHandle<R>,
    states: Vec<MenuItemState>,
) -> IpcResult<()> {
    let Some(menu_items) = app.try_state::<MenuItems<R>>() else {
        return Ok(());
    };
    for state in states {
        let Some(item) = menu_items.items.get(&state.id) else {
            continue;
        };
        item.set_enabled(state.enabled).map_err(menu_error)?;
        let title = state
            .title
            .as_deref()
            .or_else(|| menu_items.default_titles.get(&state.id).map(String::as_str));
        if let Some(title) = title {
            item.set_text(title).map_err(menu_error)?;
        }
    }
    Ok(())
}

fn menu_error(error: tauri::Error) -> IpcError {
    IpcError::internal(format!("could not update the menu: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::str::FromStr;

    use super::*;

    #[test]
    fn every_menu_entry_names_a_command_once() {
        let contract = contract().unwrap();
        let mut seen = HashSet::new();
        for menu in &contract.menus {
            for id in &menu.items {
                if id == SEPARATOR {
                    continue;
                }
                assert!(contract.commands.contains_key(id), "unknown command {id}");
                assert!(seen.insert(id.clone()), "{id} is in the menu twice");
            }
        }
        for id in contract.commands.keys() {
            assert!(seen.contains(id), "{id} is in no menu");
        }
    }

    #[test]
    fn every_accelerator_parses_and_none_repeat() {
        let contract = contract().unwrap();
        let mut seen = HashMap::new();
        for (id, command) in &contract.commands {
            for shortcut in [
                command.shortcut.as_deref(),
                command.shortcut_other.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                // Keyboard-only keys need not be valid accelerators, but they are.
                muda::accelerator::Accelerator::from_str(shortcut)
                    .unwrap_or_else(|error| panic!("{id}: {shortcut}: {error}"));
            }
            if let Some(accelerator) = command.accelerator()
                && let Some(other) = seen.insert(accelerator.to_owned(), id.clone())
            {
                panic!("{id} and {other} share {accelerator}");
            }
        }
    }

    #[test]
    fn keyboard_only_commands_have_no_accelerator() {
        let contract = contract().unwrap();
        let previous = &contract.commands["go.previousPage"];
        assert_eq!(previous.accelerator(), None);
        let full_screen = &contract.commands["view.fullScreen"];
        let expected = if cfg!(target_os = "macos") {
            "Ctrl+Cmd+F"
        } else {
            "F11"
        };
        assert_eq!(full_screen.accelerator(), Some(expected));
    }

    #[test]
    fn only_app_commands_reach_the_frontend() {
        assert_eq!(
            menu_command_payload("bookmarks.toggle"),
            Some(MenuCommandPayload {
                command_id: "bookmarks.toggle".to_owned()
            })
        );
        assert_eq!(menu_command_payload("copy"), None);
        assert_eq!(
            serde_json::to_value(menu_command_payload("file.open").unwrap()).unwrap(),
            serde_json::json!({ "commandId": "file.open" })
        );
    }
}
