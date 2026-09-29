# Walkthrough — literal click-by-click steps

This is the companion to the [README](README.md). The README explains *what* to
build and *why*, including every failure mode found the hard way. This file is
the beginner-level version: exact menu paths, exact fields, in order.

If you already know your way around OPNsense's WireGuard/Aliases/Rules pages,
you probably don't need this file — the README alone has every value you need.

Throughout, **Router A** is where the Roku lives, **Router B** is the household
whose IP Netflix should see. Every IP/subnet below is the same placeholder
scheme as the README — replace with your own.

---

## Before you start

- **Router B must be reachable from the public internet on one UDP port.** If
  Router B's WAN is a real public IP handed out by its ISP, this is just a port
  forward on Router B itself (covered in Part 1). If Router B is itself sitting
  behind someone else's router, or behind ISP-side CGNAT (common on some cable/
  mobile ISPs — check by comparing the IP shown on Router B's WAN interface page
  against `https://whatismyip.com` from a device on that network; if they don't
  match, you're behind CGNAT or double-NAT), this whole approach needs a
  different entry point — a cheap VPS acting as a relay, or a dynamic-DNS +
  port-forward on whatever device *does* hold the real public IP. That's outside
  this guide's scope; confirm you don't have this problem before continuing.
- **A stable way to reach Router B's public IP.** If it's not static, set up
  Dynamic DNS first: **Services → Dynamic DNS → Add**, pick a provider (many
  registrars and free services like DuckDNS work fine), point it at Router B's
  WAN interface. Use that hostname everywhere below instead of a raw IP.
- **Admin login to both routers' web UI** (`https://<router-ip>`, default port
  varies — check the box's docs/label if unsure).

---

## Part 1 — The WireGuard tunnel

### On Router B: create the server side

1. **VPN → WireGuard → Local** (older versions: **VPN → WireGuard**, "Local"
   tab). Click **+ Add**.
2. Fields:
   - **Name**: something descriptive, e.g. `netflix_roku`
   - **Public/Private Key**: click the small key-generator icon next to the
     field (or leave blank — OPNsense generates one automatically on save).
     After saving, reopen this instance and copy the **Public Key** shown —
     you'll need it in step 3 below.
   - **Listen Port**: any unused UDP port, e.g. `51820`. Check
     **VPN → WireGuard → Local** for existing instances first so you don't
     collide with one already in use.
   - **Tunnel Address**: `10.99.99.1/30`
   - **MTU**: `1420`
   - Leave everything else default. **Save.**
3. **Enable** the instance (toggle at the top of the Local tab if not already
   on), then **Apply**.
4. **Firewall → NAT → Port Forward** → **+ Add**:
   - Interface: `WAN`
   - Protocol: `UDP`
   - Destination: `WAN address`
   - Destination port range: your chosen port (e.g. `51820`) on both ends
   - Redirect target IP: `127.0.0.1`
   - Redirect target port: same port
   - **Save**, then check the box offered ("also create a corresponding
     firewall rule") if OPNsense offers it — if it doesn't, add the pass rule
     yourself: **Firewall → Rules → WAN** → **+ Add**, Pass, UDP, destination
     port = your port, source `any`.
   - **Apply Changes** on both the NAT and Rules pages.

### On Router A: create the client side

1. **VPN → WireGuard → Local** → **+ Add**:
   - **Name**: `netflix_roku` (or anything)
   - Generate a keypair the same way as above; copy this instance's **Public
     Key** too, you'll need it for the next step on Router B.
   - **Tunnel Address**: `10.99.99.2/30`
   - **MTU**: `1420`
   - **⚠️ Check "Disable routes."** This is the field most easy to skip and
     most dangerous to skip — see the README's Part 1 warning. Skipping it can
     silently hijack the entire router's default route through this tunnel the
     moment it comes up.
   - **Save**, enable the instance, **Apply**.
2. **VPN → WireGuard → Endpoints** (peers) → **+ Add**:
   - **Name**: `router_b`
   - **Public Key**: paste **Router B's** public key from Part 1 step 2/3
   - **Allowed IPs**: `10.99.99.1/32` for now
   - **Endpoint address**: Router B's DDNS hostname or static IP
   - **Endpoint port**: the port you forwarded in Part 1 step 4
   - **Keepalive interval**: `25`
   - **Save**
3. Attach this peer to the Local instance you made in step 1 (some OPNsense
   versions do this automatically from the Endpoints screen; if not, edit the
   Local instance and add the peer under its "Peers" field). **Apply.**
4. **Register Router A's public key on Router B**: go back to
   **Router B's VPN → WireGuard → Endpoints → + Add**:
   - **Public Key**: Router A's public key (from step 1 above)
   - **Allowed IPs**: `10.99.99.2/32` (deliberately narrow for now — this gets
     widened later, in Part 5)
   - Leave endpoint address/port blank (Router A dials out to Router B, not
     the other way around)
   - **Save**, attach to Router B's Local instance the same way, **Apply**.

### Assign the interface (Router A)

1. **Interfaces → Assignments**. Find the new WireGuard device in the
   dropdown (e.g. `wg0`/`wg1`), assign it. Name it something clear, e.g.
   `WG_REMOTE`.
2. Open that new interface's settings page (**Interfaces → WG_REMOTE**),
   check **Enable**, set **MSS** under the advanced/MTU section to `1380`.
   **Save**, **Apply**.

### Allow traffic on Router B's WireGuard interface

1. **Firewall → Rules → WireGuard (Group)** (or the specific assigned
   interface if Router B has it assigned individually) → **+ Add**:
   - Action: **Pass**
   - Protocol: **any**
   - Source: `10.99.99.2/32`
   - Destination: **any**
   - **Save**, **Apply**.
   > Without this, the tunnel will handshake successfully and still pass
   > nothing — OPNsense does not default-allow on WireGuard interfaces the way
   > it does on LAN.

### Verify before continuing

SSH or the GUI's **Interfaces → Diagnostics → Ping** on Router A, target
`10.99.99.1`. Get 3/3 replies before moving on to Part 2 — don't build routing
rules on top of an unverified tunnel.

---

## Part 2 — Static DHCP reservation for the Roku

(Menu path differs slightly depending which DHCP server your OPNsense uses —
Dnsmasq is shown below since it's the current default; Kea/ISC DHCP have the
same idea under **Services → Kea DHCP → Reservations** or
**Services → DHCPv4 → \[interface\]**.)

1. **Services → Dnsmasq DNS & DHCP → Leases**. Find the Roku in the list
   (look for the vendor/hostname column, or match against the MAC printed on
   a sticker under the device). Note its MAC address.
2. Click the small **+** icon on that lease's row (converts it to a static
   host entry) — or, if the Roku isn't currently connected/leased, go to
   **Services → Dnsmasq DNS & DHCP → Settings → Hosts → + Add** and fill it
   in manually.
3. Fields:
   - **Host**: a name for it, e.g. `Roku_LivingRoom`
   - **IP address**: pick an address in whatever range your network reserves
     for static devices (commonly the low end of the DHCP scope, e.g. `.50`–`.99`)
   - **Hardware (MAC) address**: should already be filled in from step 2
   - **Description**: optional, e.g. "static reservation"
4. **Save**, then **Apply** on the Settings page.
5. Repeat for every Roku you have.

### Build the alias

1. **Firewall → Aliases → + Add**:
   - **Name**: `roku_devices`
   - **Type**: `Host(s)`
   - **Content**: add each Roku's static IP from above, one per line/tag
   - **Description**: e.g. "Roku devices — Netflix routing"
2. **Save**, **Apply**.

---

## Part 3 — Netflix aliases (Router A)

1. **Firewall → Aliases → + Add**:
   - **Name**: `netflix_asn`
   - **Type**: `BGP ASN`
   - **Content**: `2906`
   - **Save**
2. **Firewall → Aliases → + Add** again:
   - **Name**: `netflix_domains`
   - **Type**: `Host(s)`
   - **Content** (one per line):
     ```
     netflix.com
     www.netflix.com
     nflxso.net
     nflxext.com
     nflximg.net
     nflxvideo.net
     fast.com
     amazonaws.com
     ```
   - **Save**, **Apply** both.
3. **Verify they actually populated** — SSH in and run:
   ```
   pfctl -t netflix_asn -T show | wc -l
   pfctl -t netflix_domains -T show | wc -l
   ```
   Both should return a nonzero count. If `netflix_asn` comes back empty, your
   OPNsense's ASN-lookup source may need enabling — check
   **Firewall → Aliases → Settings** for a "BGP ASN" data-source option.

### Block IPv6 on the Rokus

1. **Firewall → Rules → LAN → + Add**:
   - Action: **Block**
   - TCP/IP Version: **IPv6**
   - Protocol: **any**
   - Source: `roku_devices` (select the alias)
   - Destination: **any**
   - Description: "Block IPv6 — closes Netflix routing bypass"
2. **Save.** Then, in the rule list, use the row's **move** control (usually
   a small icon, or drag-and-drop depending on version) to place this rule
   **above** the existing "Default allow LAN IPv6 to any" rule.
3. **Apply Changes.**

---

## Part 4 — The gateway and routing rules (Router A)

### Gateway

1. **System → Gateways → Configuration → + Add**:
   - **Interface**: `WG_REMOTE` (the one from Part 1)
   - **Address Family**: `IPv4`
   - **IP Address**: `10.99.99.1`
   - **Name**: `GW_REMOTE_HOUSEHOLD`
   - Check **Disable Gateway Monitoring** (this isn't a default-route
     candidate; health-check pings flapping it would only cause harm)
   - **Save**, **Apply**.

### Routing rules

1. **Firewall → Rules → LAN → + Add**:
   - Action: **Pass**
   - Source: `roku_devices`
   - Destination: `netflix_asn`
   - Gateway (under the "Advanced"/bottom section of the rule form):
     `GW_REMOTE_HOUSEHOLD`
   - **Save**
2. Repeat, this time destination `netflix_domains`, same gateway. **Save.**
3. In the rule list, move **both** new rules above the "Default allow LAN to
   any" rule (same move/drag control as Part 3). **Apply Changes.**

---

## Part 5 — Router B's three gates

### 5a. Widen the WireGuard peer's Allowed IPs

**VPN → WireGuard → Endpoints**, edit the peer entry you made for Router A
back in Part 1 step 4. Change **Allowed IPs** from just `10.99.99.2/32` to:
```
10.99.99.2/32, 10.45.45.51/32, 10.45.45.52/32
```
(the tunnel address, plus every Roku's static IP from Part 2 — list them all
individually). **Save**, **Apply** ("Reconfigure" the WireGuard service if
there's a separate button for it).

### 5b. A dedicated firewall rule for that traffic

1. **Firewall → Aliases → + Add**:
   - Name: `roku_devices_via_tunnel`
   - Type: `Host(s)`
   - Content: the same Roku IPs as above
   - **Save**, **Apply**
2. **Firewall → Rules → WireGuard (Group)** → **+ Add**:
   - Action: **Pass**
   - Direction: **in**
   - Protocol: **any**
   - Source: `roku_devices_via_tunnel`
   - Destination: **any**
   - **Save**, **Apply**.

### 5c. Outbound NAT

1. Check your NAT mode first: **Firewall → NAT → Outbound**. If it says
   "Automatic," this may already work — test Part 6's verification before
   changing anything. If it says "Hybrid" or "Manual," continue below.
2. **Firewall → NAT → Outbound → + Add**:
   - Interface: `WAN`
   - Source: `roku_devices_via_tunnel`
   - Destination: **any**
   - Translation / Target: leave blank, or explicitly choose **Interface
     address** — this means masquerade/NAT to whatever Router B's WAN IP is.
   - **Save**, **Apply.**

---

## Part 6 — Verify it actually works

You need shell access to Router A for this (SSH — enable under
**System → Settings → Administration** if not already on, or use the GUI's
**Interfaces → Diagnostics → Packet Capture** page as a no-SSH alternative,
filtered to the WireGuard interface and the Roku's IP).

```bash
ssh root@<router-a-ip>
tcpdump -ni <wg-interface-name> host <roku-static-ip>
```

Start Netflix playback on the Roku while this is running. You're looking for:
- A completed handshake: a `SYN`, then a reply `SYN, ACK` from a Netflix
  IP (`45.57.x.x` and similar — ASN 2906), then an `ACK`.
- Immediately after, a large burst of data packets (hundreds of KB to
  multiple MB) — that's the actual video stream.

If you only see repeated outgoing `SYN`s and never a reply, one of the three
gates in Part 5 still isn't right — re-check each one in order, since each
fails with a different (and differently invisible) symptom, all documented in
the README's Part 5.

Finally, check the Roku's screen itself: no household-verification prompt,
clean playback, no `NW-2-5` or `E106`/`M7111-5059`.
