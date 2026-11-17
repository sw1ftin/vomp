# VPN for Vomp on Linux

The Vomp fork can route a Vomp process and the tools it launches through one Xray profile. It uses a private VLESS gateway and a TUN interface in a separate Linux network namespace. Xray opens its server connections using the host's existing routes and DNS. A device VPN can therefore continue to handle any traffic its policy already covers, including Xray's upstream connection. Vomp leaves the host's interfaces, routes, DNS, firewall, and proxy settings alone.

## Setup

Use a Vomp build on Linux x64 or arm64 as an unprivileged user. The launcher needs unprivileged user and network namespaces, `/dev/net/tun`, Python 3.11+, `ip` from iproute2, `unshare`, `setpriv` and `mount` from util-linux, `curl`, and `unzip`.

1. Run `/vpn add` and paste the HTTPS subscription URL into the masked prompt.
2. Open `/vpn` and select a profile. The first connection downloads and verifies the pinned Xray release. Restart Vomp when prompted. The footer then shows the active profile or `VPN · blocked`.
3. Run `/vpn doctor` to check HTTPS through the gateway and DNS and HTTPS from inside the isolated process.

The importer accepts plain-text or Base64 lists of VLESS share links using raw TCP and TLS or REALITY, including XTLS Vision. Each usable link appears in the picker with its profile ID. Subscriptions are managed separately for each Vomp configuration profile (`vomp --profile …`).

## Commands

| Command | Behavior |
| --- | --- |
| `/vpn`, `/proxy`, `/tunnel` | Open the interactive picker and VPN actions. |
| `/vpn add` | Import or update a subscription in a masked input. |
| `/vpn list` | Open the profile picker. |
| `/vpn connect [profile-id]` | Connect to the selected or last-used profile. |
| `/vpn disconnect` | Close the profile connection. The current and subsequent Vomp launches stay isolated. |
| `/vpn off` | Disable isolation for the next launch. The current process stays isolated. |
| `/vpn status` | Show the connection state, Xray version, subscription timestamps and network exceptions. |
| `/vpn doctor` | Check the active gateway and the isolated process's DNS and HTTPS. |
| `/vpn refresh` | Refresh cached subscriptions. |
| `/vpn allow localhost <port>` | Forward that port on `192.0.2.1` to the host's IPv4 loopback. |
| `/vpn allow lan <IPv4/CIDR>` | Use the host route for a private IPv4 address or subnet. |
| `/vpn deny localhost <port>` or `/vpn deny lan <IPv4/CIDR>` | Remove an exception. |
| `/vpn core install [version SHA-256]` | Install the pinned release or a newer release with the official archive digest. |

The `vomp vpn` CLI accepts the same verbs. `vomp vpn list` prints ID and label. For noninteractive imports, provide the URL on stdin, such as `vomp vpn add < /path/to/owner-only-url-file`. Prefer the masked TUI input for manual import. A host `vomp vpn` command edits the next-launch settings. Run these commands inside the isolated process or its shell to manage a live gateway. Separate Vomp processes each own their tunnel and apply saved changes at their next launch or explicit reconnect.

## Network and switching behavior

- The namespace has loopback and a TUN route for IPv4 and IPv6. TCP, UDP and DNS from Vomp, local subprocesses and tools that open their own network sockets use that route. A failed gateway or profile leaves the process isolated. Protocols that Xray or the selected profile cannot carry fail within the namespace.
- The existing host VPN keeps control of host routes. If its rules block a profile's server, the profile check fails. Vomp checks candidates via HTTPS before switching its gateway socket. A failed check keeps the previous connection and open streams. A successful switch closes connections carried by the old profile, including model streams and remote MCP connections. Clients need to reconnect or retry those requests.
- The gateway checks HTTPS about every 30 seconds. Subscriptions refresh after 24 hours while the VPN is connected, with another attempt after an hour if a refresh fails. Cached profiles remain available after a refresh failure. A refreshed profile takes effect on reconnect or the next launch. The diagnostic endpoint is `https://www.gstatic.com/generate_204`.
- The host-side gateway uses host DNS for the VPN server hostname. An explicit import or core install from an ordinary host terminal uses the host connection. Subscription refresh and core downloads from a protected session use the active profile. Inherited host proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `PI_PROXY`) are cleared in the isolated process so that they do not point applications at the wrong loopback.

### Local MCP and LAN

Services and stdio MCP processes launched by the protected Vomp session share its network namespace. Services started there can keep using `localhost`. For an MCP server already running on the host at `127.0.0.1:3000`, run `/vpn allow localhost 3000` and set its URL in Vomp to `http://192.0.2.1:3000`. Use `/vpn allow lan 192.168.1.0/24` for a private LAN behind the host. These exceptions are visible in `/vpn status` and require the gateway. DNS inside Vomp uses public resolvers through the selected profile. Use LAN IPs or local `/etc/hosts` names for services with private DNS names.

Connected host browsers, remote daemons, and other services that receive requests through existing IPC sockets or explicit network exceptions make their own outbound connections. The VPN covers the Vomp process tree and does not change those services' network policy.

## Secrets and core integrity

The subscription URL and imported credentials are stored in the Vomp profile's `vpn/state.json` with owner-only file and directory permissions. Keep that directory private when backing it up. Xray receives profile configuration on stdin with logging disabled. The masked prompt is separate from the composer, extension input hooks, the transcript and command history.

The default core is Xray `26.11.9`. The installer uses pinned SHA-256 digests for both Linux architectures. For a newer release, fetch the archive's SHA-256 from the official release and run `vomp vpn core install <version> <sha256>`. The archive is checked before extraction, and the installed executable is checked before launch. Reconnect to use the updated gateway, or restart Vomp to replace both Xray processes. Run `vomp vpn core install` again to restore the pinned version. [Official Xray releases](https://github.com/XTLS/Xray-core/releases)

## Updating the fork

Keep the VPN commits on top of the upstream history. The VPN code lives under `packages/coding-agent/src/vpn/`. The upstream integration points are CLI bootstrap, the slash registry and input controller, the footer, and the daemon runtime paths. The profile state and Xray installation live outside the source tree.

With a clean checkout, update from the upstream remote and reapply the fork commits with `git fetch upstream` followed by `git rebase upstream/main`. Rebuild from the fork after rebasing and rerun the VPN smoke checks. Use the [Vomp installation instructions](../README.md#install) to rebuild or upgrade the fork.
