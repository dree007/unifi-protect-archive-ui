# Selfhosted access boundary

Protect Archive UI contains private camera footage and has no integrated user/session management.
The default is direct access on all IPv4 host interfaces, intended only for a trusted, restricted
LAN. It provides no authentication or HTTPS. Protected proxy mode is an explicit alternative.
Use Linux, Docker Engine **>=28.0.0**, and the Compose plugin **>=5.6.0** (the tested baseline).
Check the daemon with `docker version --format '{{.Server.Version}}'`, and the plugin separately
with `docker compose version`. The CLI version alone says nothing about the daemon.

[Docker documents a localhost-publish exposure before Engine 28](https://docs.docker.com/engine/network/port-publishing/).
Engine 26 may pass functional tests; the separate >=28 security gate remains unaccepted there.
In default 0.0.0.0 LAN mode, access is deliberately open to reachable clients regardless of version.
The version threshold is not authentication or a guarantee about arbitrary host networking.
Keep default bridge/NAT isolation: do not enable `allow-direct-routing`, trusted host interfaces,
`routed`/`nat-unprotected` networks or public forwarding to container addresses.

## What must be protected

For Internet/untrusted access, every request must be authorized **before** reaching the application: dashboard, archive,
event details, cameras, system status, health and all private APIs, especially
`/api/clips/*/thumbnail` and `/api/clips/*/video`. Apply the same rule to GET, HEAD, byte ranges,
conditional requests and alternative URLs. Never exempt `/api/` from the authentication gate.

Caddy + Authentik, Caddy + Authelia, authenticated nginx or a carefully restricted VPN can supply
the external boundary. A VPN grants its admitted peers network access; it does not create app
users/per-camera permissions. Client-supplied identity headers are not authentication.

## Direct access on a trusted LAN

The default `UNIFI_ARCHIVE_BIND_IP=0.0.0.0` publishes on all IPv4 host interfaces. Operators can
optionally bind the server's specific LAN IPv4 address and
`UNIFI_ARCHIVE_PORT` to the desired browser port. This explicit mode grants full archive/API
access to every client able to reach the listener; it does not provide application authentication.
Use it only with a trusted, restricted LAN/VPN boundary. Plain HTTP is not transport encryption.
Do not forward this port from your router or expose it directly to the Internet.
Use `127.0.0.1` explicitly for the protected-proxy mode. See [LAN configuration](selfhosting.md#direct-lan-access).
Do not combine an unprotected direct listener with a proxy policy intended to require login:
the direct listener would bypass that policy.

## Caddy + Authentik example

This example assumes **Caddy runs on the application host**, and a configured Authentik outpost
is reachable there at `127.0.0.1:9000`. Use your actual protected outpost endpoint; this project
does not install an outpost or change Caddy/Authentik. Use TLS for outpost traffic across an
untrusted network, with certificate verification enabled.

In Authentik, create an application and Proxy Provider in **Forward auth (single application)**
mode with external host `https://archive.example.com`. Assign it to the chosen outpost and attach
the intended user/group access policy. Authentication without the intended authorization policy
is insufficient. If you use domain-level mode, configure its domain/policies accordingly.

```caddy
archive.example.com {
    route {
        # Authentik login/callback paths go only to the outpost, never the archive backend.
        reverse_proxy /outpost.goauthentik.io/* http://127.0.0.1:9000

        # No path matcher: every remaining route/method, including /api/, is checked.
        forward_auth http://127.0.0.1:9000 {
            uri /outpost.goauthentik.io/auth/caddy
        }

        # Reached only after the authorization check succeeds.
        reverse_proxy 127.0.0.1:3100
    }
}
```

`route` preserves the specified execution order. Caddy's `forward_auth` performs a GET check
while forwarding the original method/URI to the gateway; non-2xx responses do not reach the
backend. A refused HEAD/Range/conditional request therefore cannot reveal media headers/bytes.
The only intentional path exception is Authentik's own `/outpost.goauthentik.io/*` handler.
Do not add additional unauthenticated application handlers or listeners.

No `copy_headers` is needed: this application does not consume upstream identity headers for
authorization. The gateway makes the decision. Do not copy a JWT or trust all private proxies
without a specific need. If another proxy precedes Caddy, configure only its actual trusted
addresses and verify client identity/forwarded-header handling against the gateway documentation.

Sources: [Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth),
[Authentik Caddy integration](https://docs.goauthentik.io/add-secure-apps/providers/proxy/server_caddy/),
[Authentik forward auth](https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/).
Validate the adapted Caddyfile before reloading your separately managed proxy. No real outpost
or SSO session is represented by the project's synthetic tests.

## Preventing proxy bypass

In proxy-protected mode, explicitly set `UNIFI_ARCHIVE_BIND_IP=127.0.0.1`. Compose then publishes exactly
`127.0.0.1:<configured-port>:3000`, with no wildcard/IPv6
publication. PostgreSQL stays on an internal network; worker and migrate publish no ports.
The application uses bridge networks, not host networking. Keep these isolation measures.

A remote client must not reach the backend via the host's public/LAN IP, IPv6, a second mapped
port, an alternate proxy hostname/listener, or directly routed container IPs. Firewalls and
network changes can invalidate these assumptions even on a supported Engine. Review overrides
and inspect actual port bindings after deployment; do not use an unprotected dev server.

Host-local processes and Docker administrators can reach the backend; containers deliberately
attached to application networks can too. These are trusted host privileges outside the external
proxy boundary. The system is not tenant isolation. A containerized Caddy cannot reach the host's
loopback through its own `127.0.0.1`; arrange a reviewed private connection instead of publishing
the backend on `0.0.0.0`. Protect all alternate routes just as carefully.

## Private media caching and revocation

Thumbnail and video responses send **`Cache-Control: no-store`**. This applies to successful
responses, byte ranges, HEAD, explicit ETag/304 requests and media errors. No `Pragma`/expired-date
workaround is required for the HTTP cache policy. Do not configure a proxy/CDN to override it or
cache private routes independently of authorization. Login redirects/denials should also be
non-cacheable and must not return confidential Content-Range/ETag/Last-Modified metadata.

The server-side thumbnail volume still caches generated JPEGs by clip/file version. That private
persistent cache reduces ffmpeg work and is not a browser/shared-proxy HTTP cache. Fingerprinted
Next.js JS/CSS/font assets may keep immutable caching; do not apply a global no-store override.

After access is revoked, every **new** media request must be checked and denied by the external
gateway. Protect Archive UI has no logout endpoint and cannot invalidate Authentik's sessions itself.
Use Authentik's documented session/policy revocation procedure and check when it takes effect.

Already received footage, older saved/cache entries, screenshots, frames still displayed in a
tab, application/browser in-memory state and an already authorized stream cannot be erased by
`no-store`. Closing a tab is not SSO logout. Old cache entries may require local browser clearing;
new headers cannot retroactively delete them. Use private/separate browser profiles on shared
devices and close sensitive pages after external logout. Avoid claiming retroactive revocation.

## Safe installation acceptance

Use a disposable database, separate test volumes, generated clips and a read-only test archive.
Do not test outages by disconnecting a production NAS or change a production outpost for testing.
Follow [selfhosting NAS mount safeguards](selfhosting.md#nas-mount-and-outage-protection).

1. Check Engine/Compose versions and `docker compose config -q` (avoid printing secrets).
2. Inspect actual web port bindings: only the selected loopback/LAN address; no PostgreSQL/worker/migrate host ports.
3. For direct LAN mode, confirm intended devices can use the configured IP/port and excluded
   networks cannot. For proxy-protected mode, confirm backend host-IP/IPv6/container-IP bypass is denied.
4. In proxy-protected mode, check every page and direct media URL without authorization. Accept an
   appropriate denial/login redirect, never media bytes or confidential metadata. Test HEAD,
   Range and If-None-Match too; follow redirects when assessing the final response.
5. From an allowed client, check JPEG delivery, 206/Content-Range, HEAD, playback and seeking.
6. For an authentication gateway, revoke access and repeat the **same URLs** from the same browser profile without
   Playwright request interception/cache disabling. New requests must reach the gate and be denied.
7. Confirm private responses remain no-store, while fingerprinted Next assets remain cacheable.

Automated coverage uses a test-only streaming authorization gate and synthetic videos, both in
normal production-server E2E and the isolated Docker suite. It checks anonymous/revoked access,
browser cache reuse, HEAD/Range, and cross-network Docker bypass. It does not certify your actual
Authentik policies, host firewall, additional listeners or earlier browser cache history.
