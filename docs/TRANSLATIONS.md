# Interface translations

The web panel ships in English and Turkish (G4.6). The choice is per browser: **Settings → Appearance → Language**, or the switch under the sign-in form. Without a stored choice a browser whose language starts with `tr` gets Turkish; every other browser gets English.

## How it works

- `apps/web/src/lib/i18n.tsx` holds the layer: `LocaleProvider`, `useT()`, `msg()` and `fill()`.
- The English text in the source is the message key. `t('Sign out')` returns the Turkish entry from `apps/web/src/locales/tr.ts` when the locale is Turkish, and the English text otherwise.
- A string that has not been extracted or translated yet renders in English. It never shows a raw key, so pages can move over one at a time.
- `{name}` placeholders are filled from the second argument: `t('{n} running', { n: 3 })`.
- When a sentence wraps a value in markup, translate the whole sentence and put the markup in with `fill()`, so the translation keeps its own word order: `fill(t('If an account exists for {email}, …'), { email: <span>{email}</span> })`.
- Module-level tables (nav labels, option lists, status names) mark their strings with `msg('…')` and pass them through `t()` when they render.

## Adding or changing a string

1. Wrap the English text in `t('…')`, or `msg('…')` for a module-level table.
2. Add the Turkish entry to `locales/tr.ts` under the same English key.
3. Run `pnpm --filter @ninedeploy/web exec vitest run test/i18nCatalog.test.ts`.

The catalogue test fails on:

- a `t()` or `msg()` literal without a Turkish entry;
- a Turkish entry that no code uses any more (after a wording change, move the entry to the new key);
- a translation whose `{placeholders}` differ from the English;
- an empty entry.

Use string literals inside `t()` and `msg()`. The test reads them from the source, so a computed key such as `t(someVariable)` must take its value from a `msg()` table.

## What is translated so far

- the navigation and top bar;
- the events drawer;
- sign-in and password reset;
- Settings → Appearance;
- the dashboard;
- the services list and every service detail tab except the Network tab.

The other pages are still English and move over route by route. Server error messages, help drawer topics and the CLI stay English.
