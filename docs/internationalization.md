# Internationalization

Unifi Protect Archive UI supports German (`de`) and English (`en`). The product name,
user-supplied camera names, filenames, IDs, environment variables and stored status codes
are never translated. Existing routes such as `/archive` have no language prefix.

## Request locale

The server uses a validated `ui_locale` cookie first, then the supported languages in
`Accept-Language`, ordered by quality (`q`) and original order. Regional variants such as
`de-AT` and `en-US` resolve to `de` and `en`. Invalid preferences and excluded (`q=0`)
languages are ignored. English is the fallback.

The first server render, HTML `lang`, metadata and client provider receive the same locale.
Cookie/header-dependent pages render per request; dictionaries do not select a locale through
process-global mutable state. Static versioned Next.js assets retain their usual caching.

## Architecture

A small typed dictionary implementation fits these two locales and unchanged URLs without
adding a dependency. `src/i18n/core.ts` defines locale validation, typed message keys,
interpolation and `Intl.PluralRules` selection. The two JSON catalogs in
`src/i18n/messages/` share keys and placeholder names. Dotted keys are grouped by UI domain:
common, navigation, dashboard, archive, filters, cameras, events, system, status, detections,
errors, metadata and count/unit forms.

Server Components call the request-memoized `getI18n()` in `src/i18n/server.ts`.
Only the selected dictionary is passed to `I18nProvider`. Client Components use `useI18n()`;
they never independently negotiate the browser language. Presentation components are shared
between locales; database queries, matching and persisted domain values remain language-neutral.

Existing pure formatting/query callers retain German defaults for compatibility. Every web
request explicitly supplies the negotiated locale. Legacy exported German labels remain for
non-web callers; web components use the central catalog keys. Free-text detection search uses a
small locale-independent alias map in `src/lib/archive-filters.ts`, not the translation catalogs.
DE/EN labels and technical type names match regardless of the selected UI language. For plate
detections, `Licence plate`, `License plate`, `Kennzeichen` and `licensePlate` are equivalent.

## Manual choice and switching

The global DE/EN control is in the mobile header and the desktop sidebar's global action area.
Its buttons have native keyboard support, focus rings, 44px minimum touch targets,
`Deutsch`/`English` accessible names and `aria-pressed`. The selected choice also uses
weight and an underline, so colour is not the only indication.

The Server Action accepts only `de` or `en` and writes a host-only, HttpOnly cookie with
`Path=/`, `SameSite=Lax` and a one-year lifetime. HTTPS requests set `Secure`.
Deploy behind a proxy that preserves the original Origin/protocol, as described in
[Security](security.md). The locale preference is not an authentication credential.

Next.js updates the current server tree after the cookie action in one roundtrip. No hard
reload, extra polling, locale redirect or additional `router.refresh()` is needed. The URL,
search parameters and local React state remain intact. Archive pagination and selected clips
are not reset. Loaded event cards retain the original request clock, UTC timestamps and app
zone, allowing their date labels to change language without discarding or requerying pages.

## Dates, numbers and plurals

Display locales are `de-DE` and `en-GB`. `APP_TIME_ZONE` remains independent, with
`Europe/Berlin` as the default. `Intl.DateTimeFormat`, `Intl.NumberFormat` and
`Intl.RelativeTimeFormat` format dates, counts, sizes and relative times. Switching language
never changes UTC timestamps, date-filter boundaries or 23-/25-hour DST days.

Plural messages have `one` and `other` forms and require a numeric `count`, for example
`t("counts.events", { count: 2 })`. Interpolated numbers use the selected number locale.
Parameters are text rendered by React, not HTML. Do not use `dangerouslySetInnerHTML` for
translations. Unknown Protect detection types are safely humanized rather than replaced by
raw translation keys. Stored status codes remain unchanged.

## Adding a message or locale

Add a meaningful dotted key to both catalogs. Keep identical placeholders in both translations,
and use a plural object where singular and plural differ. Import `useI18n()` in interactive
presentation components or `getI18n()` in server pages; use the typed `t` function at the display
boundary. Do not translate user data or move translations into matching/database code.

A further language requires an explicit update to `Locale`, validation, dictionary loading,
display locale mapping, controls, plural forms and tests. Unsupported languages currently fall
back to English. The formatter compatibility defaults do not define the application's fallback.

## Test strategy and limits

Unit tests verify key/form/parameter parity, missing-key failures, plurals, locale negotiation,
cookie policy, localized formatting, status values, unknown detections and DST boundaries.
A TypeScript-AST coverage test catches literal JSX prose and accessible descriptions bypassing
the catalogs, with narrow exceptions for product names and technical values.

Playwright checks first-render language, metadata, DE/EN navigation and core pages, search,
filters, loaded pagination, reload/new-context persistence, keyboard controls and widths of
390, 820 and 1440px. Existing media/proxy security tests continue to assert `no-store`, Range,
HEAD and access revocation. Tests use synthetic videos and an isolated PostgreSQL database.

Native browser date-input presentation and built-in video-control labels are controlled by the
browser/OS language; application labels and values are localized. Raw unknown technical Protect
states are humanized, not given invented translations. Technical logs remain in their original
language. UI operation errors show a translated explanation and, where available, a bounded
technical error code; file paths and raw diagnostic messages remain out of the displayed text.
