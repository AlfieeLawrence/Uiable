---
title: Files
description: Host file manager with drag-and-drop upload, editor, and optional sudo for root paths.
order: 25
slug: files
---

# Files

The **Files** app browses the host filesystem (same view the container sees via the host mount / local mode).

## Basics

- Browse folders; double-click a text file to edit (up to **5 MB**; binary files are refused).
- Drag files or folders onto the list to upload. **Upload files** / **Upload folder** buttons work the same way.
- New folder / new file, rename, delete, chmod, download (folders as `.tar.gz`).
- Tick **Hidden files** to show dotfiles (e.g. `.bashrc`).
- Normal **Save** keeps the original owner, group, and mode, and rewrites symlink targets without replacing the link.

## Use sudo / Save as sudo

Some paths (system configs under `/etc`, other users' homes, etc.) need root.

1. Tick **Use sudo** in the Files toolbar.
2. Enter the **host sudo password** when prompted. It is kept **in memory for this browser session only** (never written to `sessions.json` or the audit log).
3. With the box ticked, list / open / download / upload run through `sudo` on the host.
4. In the editor, open the **Save ▾** menu and choose **Save as sudo** to write as root (also available even if **Use sudo** is off, as long as a session sudo password is saved).

Clear the session password by signing out, or by calling `DELETE /api/files/sudo` (signed-in).

Passwordless `sudo -n` on the host works without saving a password.

## Related

[Security and secrets](security.md) · [Uiable Connect files](https://github.com/AlfieeLawrence/Uiable-Connect/blob/main/docs/files-sftp.md) · [Troubleshooting](troubleshooting.md)
