# Security policy

Protect Archive UI stores and serves private camera recordings. By default it has **no login**:
access to its web port grants access to the archive and private APIs. An optional built-in login
for a single account (`APP_LOGIN_USERNAME`, `APP_LOGIN_PASSWORD`) gates every page and API; it has
no user management, roles or per-camera authorization. The project is an independent third-party application, not an official Ubiquiti
service.

## Supported versions

| Version | Security support |
|---|---|
| 2.1.x | Supported |
| Older or unreleased revisions | Not supported |

Fixes are released as new versions of the latest minor release. Install the latest one after reading its release notes.
This is a volunteer project: there is no guaranteed response time.

## Reporting a vulnerability privately

Please report vulnerabilities privately through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/dree007/unifi-protect-archive-ui/security/advisories/new>).
Do not open public issues for security problems, and do not share credentials, recordings or
details of your network. Use minimal synthetic examples. Only test systems you own or are
authorized to test.

## Default LAN mode

The normal Compose configuration publishes one web port on **0.0.0.0:3100** (configurable).
This means **all IPv4 host interfaces**, not automatically only your home LAN. Host firewall,
VLANs, routing, public addresses and other network settings determine who can reach it.

Without the optional login this convenience mode is open to every reachable client, and it
always uses **unencrypted HTTP** (a password typed on plain HTTP crosses the network readable). Use it only in trusted,
appropriately restricted networks. Restrict the port to intended clients using your network boundary
or a specific `UNIFI_ARCHIVE_BIND_IP`. Do not configure router port forwarding or directly expose
this port to the public Internet. A private IP alone is not authentication or proof of isolation.

For untrusted/external access, require authentication and HTTPS through a properly configured
reverse proxy or restricted VPN with an appropriate encrypted transport. Every page and API,
including video/thumbnail GET, HEAD and byte-range requests, must be protected. Caddy/Authentik
is optional for ordinary trusted LAN use. In proxy mode use `UNIFI_ARCHIVE_BIND_IP=127.0.0.1`
or a verified equivalent boundary, so the direct backend cannot bypass authentication.
See [access security](docs/security.md).

## Docker, storage and secrets

The official security baseline is **Docker Engine >=28.0.0** and **Compose plugin >=5.6.0**.
Engine 26 can run functional tests; that is not full host-security acceptance. Older Engines have a
known weakness around localhost-published ports. The all-interface LAN default is deliberately
network-accessible and is not fixed or protected by a version threshold. See
[Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

Only web publishes a host port. PostgreSQL is internal; worker/migrate publish none. Application
containers run non-root with read-only root filesystems, dropped capabilities and no-new-privileges.
Node is PID 1; no init, explicit stop-timeout or logging override is configured.
Logs inherit host defaults; administrators must limit retention/growth appropriately.
No privileged app or Docker-socket mount is required. Keep NAS originals **read-only** and the
thumbnail cache separate. Mount safeguards prevent failed/empty scans from falsely marking all
existing clips missing, but verify your real NAS recovery behavior before relying on automation.

Store `.env` and backups privately with appropriate permissions. Protect API keys belong only in
server/runtime settings; never commit them or include them in public source/image artifacts.
Keep Protect TLS verification enabled where a trusted certificate is available. A per-connection
self-signed exception is not permission to disable TLS verification globally.

Private media use `Cache-Control: no-store`; the independent server-side thumbnail cache remains
persistent. These headers cannot erase prior downloads/screenshots/cache entries and do not replace
authentication. Closing an application tab is not an SSO logout. Review dependency/native package
security and backup/restore procedures when updating; do not apply automatic destructive fixes.

## Image and source integrity

Official images are published only as `ghcr.io/dree007/unifi-protect-archive-ui` with a version
tag for Linux amd64. Use a specific version (for example `1.0.0`) and, where possible, record or pin
its digest. Each GitHub release lists the matching application and native source archives.
Images are published by a manual, protected release job; branch pushes and merges never publish.
You do not need a registry account to pull the image.
