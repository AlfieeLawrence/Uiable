---
title: Using the interface
description: Command palette, keyboard shortcuts, notifications, container pages, undo, phone layout, onboarding and turning the app store on or off.
order: 5
slug: interface
---

# Using the interface

## Command palette — <kbd>Ctrl</kbd> <kbd>K</kbd> / <kbd>⌘</kbd> <kbd>K</kbd>

Opens a search box for everything: **pages** (all apps you can open), **containers** (jump to a container page; operators also get Start / Stop / Restart), **settings** sections and **actions** (switch theme, open notifications, keyboard shortcuts, the tour, new terminal, check for updates, turn the app store on/off, sign out). Type a few letters (fuzzy match), use ↑ ↓ and Enter, or Esc to close. On phones tap **Search** in the bottom tab bar.

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere to see this list. Shortcuts are ignored while you type in a field.

| Keys | Action |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> | Command palette |
| <kbd>/</kbd> | Focus the page's search / filter box |
| <kbd>?</kbd> | Keyboard shortcuts |
| <kbd>g</kbd> then <kbd>h</kbd> / <kbd>a</kbd> / <kbd>d</kbd> / <kbd>f</kbd> / <kbd>l</kbd> / <kbd>t</kbd> / <kbd>m</kbd> / <kbd>s</kbd> / <kbd>u</kbd> | Go to Home / All apps / Docker / Files / Logs / Terminal / Dashboard / Settings / Updates |
| <kbd>n</kbd> | Activity & notifications |
| <kbd>t</kbd> | Cycle theme |
| <kbd>Esc</kbd> | Close the dialog or palette |

Everything is reachable with the keyboard: a **Skip to content** link is the first Tab stop, focus rings are visible, dialogs trap focus and give it back when they close.

## Notifications (the bell)

The bell (Home, top bar, phone tab bar) collects **recent actions** from the audit log, **alerts** that fired, **failed jobs** and **update notices** (Uiable, container images, host packages). Each entry links to where it came from; failed jobs open their output. Non-admins only see their own actions and jobs. The badge counts entries since you last opened it (per browser).

## Dashboard stat details

On **Home** and **Dashboard**, click (or Tab + Enter) a CPU, memory, disk, network, temperature or GPU graph to open a large view with **Live / 1h / 6h / 24h / 7d** ranges from the stored metrics history (ranges longer than your retention are disabled), **current / average / min / max**, a per-core / per-disk / per-interface / per-sensor breakdown and a hover tooltip. Esc or ✕ closes it. Retention is set in [Metrics](metrics.md).

## Containers

The Docker list shows a health dot (healthy / starting / unhealthy) and a live CPU sparkline per container; the dock and tab bar show an overall dot. Click a name for the **container page**:

- **Overview** — live CPU, memory, network and disk graphs; ports (with open links), mounts, networks, restart policy, compose project.
- **Logs** — follow, search with highlighting, timestamps, wrap, tail length, save to a file.
- **Environment** — variables with secrets (passwords, tokens, keys, URL credentials) masked. Admins can **Reveal**, which is audit-logged (`docker.env.reveal`); viewers and operators never receive the values.
- **Redeploy** — pulls the latest image and recreates the container with the same settings (ports, volumes, env, networks, restart policy). Compose containers use `docker compose pull` + `up -d --force-recreate` for that service. If recreating fails, the old container is put back.

### Undo instead of “are you sure?”

**Stop** and **Restart** wait 5 seconds with an **Undo** button in the toast. Closing the page during the countdown still runs the action. **Destructive** actions — removing a container, image, volume or stack, and prune — ask you to **type the name** (or `prune`) to confirm.

## Phones and tablets

Below 640 px the dock becomes a bottom **tab bar** (Home, Apps, Docker, Search, Activity), buttons and fields grow to 44 px touch targets, dialogs can be swiped down from their header to close, and pages never scroll sideways.

## Onboarding

New users get a short **tour** on Home (skip any time; run it again from **Settings → Appearance → Take the tour**) and a **setup checklist**: secure login (2FA, HTTPS), backups, alerts, update checks and linking a Linux account. Hide it from the card; bring it back from **Settings → Appearance**.

## Turning the app store on or off

**Settings → General → Features → App store** (admins). When off, the store disappears from the dock, Home, All apps, the command palette and the dashboard, and every `/api/apps/*` request is refused by the server (`404`, `reason: "feature-off"`). Apps you already installed keep running and are still managed under **Stacks** and **Docker**. Existing installs keep the store **on** after updating; the choice is stored in `config.json` (`settings.features.store`) and the change is audit-logged (`settings.features`).

## Themes and accessibility

All five themes (dark, light, solarized, dracula, monokai) meet WCAG AA contrast for body text, muted text and accent buttons (checked by `test/contrast.test.js`). With **reduce motion** enabled in your OS, animations and transitions are switched off.
