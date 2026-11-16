# studio-v2.12.1

**Finishes the NH Studio icon change from v2.12.0: the sidebar, the splash screen, the Windows/Linux tray and the Windows setup wizard now show the new icon too.**

- v2.12.0 changed the app icon and the About page, but the mark in the top-left of the sidebar, the splash screen and the tray still showed the old icon.
- The Windows setup and uninstall wizards used the stock NSIS pictures for the welcome sidebar and page header; they now show the new icon. The installer, the uninstaller and the macOS disk image name the new icon explicitly.
- The icon script now writes these bundled copies and the wizard pictures itself, so they cannot be missed again.

## Other

- NH Pocket is unchanged (2.12.0, which already has the new icon). Firmware and Desktop need no update.
- If the Dock or Finder on macOS still shows the old icon, that is the system icon cache: restart the Dock (or log out and back in).
