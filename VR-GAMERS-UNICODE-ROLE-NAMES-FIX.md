# VR GAMERS Control Center — role-name display fix

Replace `LEADER-dashboard-v4-connected.html` with the included file.

This update improves fallback font support for Unicode symbols, emoji and decorative alphabets in role names, keeps role labels wrapping instead of overflowing, normalizes role-name search, and identifies role names containing invisible Unicode formatting characters. The underlying role names sent to Discord are not rewritten.

If a character is not installed in the user's device/browser fonts, the page can only use available fallback fonts; a browser cannot force a missing glyph to render perfectly. Test role listing, auto-role selection and role-shortcut selection after replacing the file.
