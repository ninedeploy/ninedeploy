# Desktop client (R6)

The NineDeploy desktop app opens the panel of an instance you choose in its own window. You don't need a browser tab for it, and your sign-in is kept in the operating system's credential store. It uses the panel's existing web UI and API, and nothing on the server has to be enabled for it.

The code is in [`desktop/`](../desktop). It has its own lockfile and is not part of the panel's pnpm workspace, so Electron and its packaging tools never enter the dependency tree of the panel image or of the npm packages.

## Installing

| Platform | Package | Built and exercised |
| --- | --- | --- |
| Windows 10/11 x64 | `NineDeploy Setup <version>.exe` (NSIS, per user, no admin rights) | Yes. Silent install, sign-in, restart, uninstall. |
| Debian/Ubuntu x64 | `ninedeploy-desktop_<version>_amd64.deb` | Yes. Installed with apt on a clean Debian 12, then run with and without a keyring. |
| Linux x64 | `NineDeploy-<version>.AppImage` | Built only. |
| macOS (Intel and Apple silicon) | `NineDeploy-<version>.dmg` | Not yet. The Desktop workflow builds and launches it on a macOS runner, but it has not run, and nobody has tried it on a Mac. |

The installers are **unsigned**:

- Windows SmartScreen warns about an unknown publisher.
- macOS Gatekeeper refuses to open the app until you allow it under System Settings → Privacy & Security.

The [Desktop workflow](../.github/workflows/desktop.yml) builds all of them on each platform's own runner and uploads them as build artifacts. Release publishing is not wired yet.

To build one yourself, on the platform you want it for:

```sh
cd desktop
pnpm install --frozen-lockfile
pnpm test && pnpm dist      # installers in desktop/release/
pnpm smoke                  # launch the packaged app once
```

## Choosing an instance

The first window lists your instances. To add one, enter the panel's address, for example `https://panel.example.com`:

- The app reduces it to an origin and refuses a path, a query or credentials in the address.
- It then asks `<address>/health` whether a NineDeploy panel answers there. A redirect is not followed: add the address it redirects to instead.
- Plain `http` to another machine is marked "unencrypted" before and after you add it. Its sign-in is never kept. Otherwise anyone able to alter that traffic could inject a script at any later launch and read the kept token. `http://localhost` and `127.0.0.1` are treated like https.
- Add the panel by the same address as its public URL. SSO sign-ins return to the public URL; a window opened on another address (an IP, say) ends up there after signing in.

Each instance opens in its own window with its own cookie and storage partition, so two panels never share a session. **File → Instances…** (Ctrl/Cmd+Shift+O) brings the list back.

## Where the sign-in is kept

In a browser the panel keeps its tokens in `sessionStorage`, so closing the tab signs you out. In the desktop app the panel also hands its **refresh token** to the app, which seals it with Electron's `safeStorage`:

| OS | Store |
| --- | --- |
| Windows | DPAPI, bound to your Windows account |
| macOS | Keychain |
| Linux | Secret Service (GNOME Keyring, KWallet) via libsecret |

The sealed token is written to `credentials.json` in the app's user-data folder. That folder is `%APPDATA%\NineDeploy` on Windows, `~/Library/Application Support/NineDeploy` on macOS and `~/.config/NineDeploy` on Linux. When the window is reopened, the panel trades the token for a new session, and each rotation is sealed again. The access token is never stored.

If there is no real OS store, the app writes nothing to disk and you sign in each time a window opens. The instance list says so. This happens on Linux without a keyring, where Chromium falls back to `basic_text`, a fixed key that anyone with the file could reproduce. It can also happen on a desktop environment Chromium does not recognise. There you can start the app with `--password-store=gnome-libsecret` or `--password-store=kwallet5`.

A token sealed under another account or keyring cannot be opened, so it is dropped and you sign in again.

On the Windows test machine, killing the app by force right after the very first sign-in meant the next start asked for a sign-in again. A normal quit kept it. The likely cause is that Chromium writes the DPAPI-wrapped key behind the sealed token to its `Local State` file on shutdown.

## Signing out and removing an instance

- **Sign out** in the panel works as in the browser: it ends every session of your account on that panel. The app also deletes its sealed token.
- **Remove** in the instance list ends **only this computer's session**. It trades the kept token for an access token, finds the session marked current under `/v1/auth/sessions`, and revokes that one. Your browser and other devices stay signed in. It then deletes the sealed token, clears the instance's storage partition (cookies, storage, cache) and closes its window.

  If the panel can't be reached, the local data is still deleted and the list says the session ends when it expires.
- **Uninstalling** on Windows deletes the user-data folder as well. The panel sessions are not revoked; remove the instances first if that matters.

## What a panel page can and cannot do

**Process and isolation**

- Every window is sandboxed with context isolation and no Node integration. The panel page has no `require` and no `process`.
- The only thing it gets is `window.ninedeployDesktop`: load, save and clear its own refresh token.
- The main process answers those calls only for the top frame of that instance's window and origin. Iframes, other windows and an identity provider's pages are refused, and the preload doesn't expose the bridge on other origins in the first place.

**Navigation**

- The window stays on the instance's origin.
- Links to other `http(s)` addresses open in the system browser.
- `file:`, `javascript:`, `data:` and custom schemes go nowhere.
- `window.open` never creates an app window.
- There is one exception: an SSO sign-in started on the panel (`/v1/auth/…`) may visit the identity provider over https until it returns to the panel. After ten minutes, foreign pages go to the browser again. During the sign-in, a panel page still can't send the window elsewhere: the panel leaves only through a server redirect, and after that the provider's own pages navigate.

  What remains is an open redirect at the identity provider, which could show another https page inside the window for that time. Such a page gets no bridge, permissions or downloads.

**Downloads**

- Only pages of the instance itself can start a download.
- The instance list cannot start one.

**Permissions**

- Only clipboard writes (copy buttons) and fullscreen are granted, and only to the instance.
- Notifications, camera, microphone, location, USB, HID, serial and the rest are refused.
- `<webview>` cannot be attached.

**Packaged builds**

The packaged app has these Electron fuses set:

| Fuse | Setting |
| --- | --- |
| `RunAsNode` | off |
| `EnableNodeOptionsEnvironmentVariable` | off |
| `EnableNodeCliInspectArguments` | off |
| `GrantFileProtocolExtraPrivileges` | off |
| `EnableCookieEncryption` | on |
| `EnableEmbeddedAsarIntegrityValidation` | on |
| `OnlyLoadAppFromAsar` | on |

The instance list is served from the app's own `nd-app://` scheme, which answers three known files and nothing else. DevTools are only in the menu of unpackaged builds.

## Compatibility

Keeping the sign-in needs a panel whose web UI includes the bridge (the release after 0.18.13). An older panel works in the app as well, but it behaves like a browser tab: you sign in each time its window opens. **Remove** works against any panel version.
