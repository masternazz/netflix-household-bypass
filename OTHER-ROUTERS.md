# Doing this on a router that isn't OPNsense

The README and [WALKTHROUGH](WALKTHROUGH.md) are OPNsense-specific because
that's what was actually built and tested. The underlying idea has nothing
OPNsense-specific about it, though — it's five general building blocks that
exist on nearly every router OS in some form:

1. A site-to-site WireGuard tunnel between the two routers.
2. A permanent (static) IP for the Roku(s), so rules don't go stale.
3. Something that identifies "Netflix traffic" specifically (an IP set / ASN
   / domain list — naming and mechanics vary a lot here).
4. **Policy-based routing**: mark packets matching (3), and route only
   *marked* packets out the tunnel instead of the default route.
5. On the far router: the tunnel's peer has to accept that traffic's real
   source IP, a firewall rule has to allow it in, and outbound NAT has to
   masquerade it back out — same three gates as the README's Part 5,
   regardless of platform.

This file gives the generic, platform-agnostic version of each piece, plus
notes for the router OSes people most commonly ask about. None of this was
tested on non-OPNsense hardware — verify each command against your specific
platform's current documentation before running it.

---

## The universal, works-anywhere version (any Linux-based router)

If your router runs Linux and gives you shell access (OpenWrt, most
prosumer/DIY router boxes, a Raspberry Pi acting as a router, etc.), this is
the ground-truth mechanism everything else is a GUI wrapper around:

### 1. WireGuard tunnel

```bash
# On both routers:
wg genkey | tee privatekey | wg pubkey > publickey

# Router B (server) — /etc/wireguard/wg0.conf
[Interface]
PrivateKey = <router-b-private-key>
Address = 10.99.99.1/30
ListenPort = 51820

[Peer]
PublicKey = <router-a-public-key>
AllowedIPs = 10.99.99.2/32   # narrow for now, widened later

# Router A (client) — /etc/wireguard/wg0.conf
[Interface]
PrivateKey = <router-a-private-key>
Address = 10.99.99.2/30
# Deliberately NOT setting a default route here —
# do not add 0.0.0.0/0 to AllowedIPs on the peer below.

[Peer]
PublicKey = <router-b-public-key>
Endpoint = <router-b-public-hostname-or-ip>:51820
AllowedIPs = 10.99.99.1/32
PersistentKeepalive = 25
```

```bash
wg-quick up wg0     # on both
```

The `AllowedIPs = 10.99.99.2/32`-not-`0.0.0.0/0` choice on the client is the
Linux/`wg-quick` equivalent of OPNsense's "Disable routes" checkbox — it's
what stops this from becoming a full-tunnel VPN that hijacks the whole
router's default route.

### 2. Static IP for the Roku(s)

Whatever your DHCP server is (`dnsmasq` is extremely common on router Linux),
add a static host mapping:
```
# /etc/dnsmasq.conf or a dnsmasq.d/ include:
dhcp-host=<roku-mac-address>,10.x.x.51
```
Reload dnsmasq after.

### 3. Identify "Netflix traffic"

The portable version of the README's ASN/domain aliases is an `ipset`
(or nftables `set`) populated with Netflix's IP ranges:
```bash
ipset create netflix_ips hash:net

# ASN 2906 (Netflix Open Connect) prefix list changes over time — pull it
# fresh rather than hardcoding, e.g. via a whois/BGP-looking-glass query or
# a maintained community list. Populate the set:
for net in $(cat netflix-asn-2906-prefixes.txt); do
  ipset add netflix_ips "$net"
done
```
For the domain-based coverage gap (login/account/DRM, not just the CDN),
either resolve the domain list periodically into the same `ipset` via a cron
job, or use your firewall's DNS-based matching if it has one (OpenWrt's
`nft` can match against `fw4`'s dynamic sets fed by dnsmasq's
`--ipset=/netflix.com/netflix_ips` style directive — check current `fw4`/
`dnsmasq` docs for the exact syntax on your version).

### 4. Policy routing — mark and route

```bash
# Mark packets from the Roku(s) destined for the Netflix set
nft add rule inet fw4 mangle_prerouting \
  ip saddr 10.x.x.51 ip daddr @netflix_ips meta mark set 0x100

# A separate route table that sends everything through the tunnel
ip rule add fwmark 0x100 table 100
ip route add default via 10.99.99.1 dev wg0 table 100
```
(iptables-only systems: the equivalent is a `mangle` table `PREROUTING`
`MARK` rule plus the same `ip rule`/`ip route` pair — the marking syntax
differs, the routing-table mechanism is identical.)

### 5. The far router's three gates

Identical concept to the README's Part 5, different syntax:

- **WireGuard AllowedIPs**: widen Router B's peer entry for Router A to
  include the Roku's real IP(s), not just the tunnel address:
  ```
  AllowedIPs = 10.99.99.2/32, 10.x.x.51/32
  ```
  then `wg syncconf wg0 <(wg-quick strip wg0)` or restart the interface.
- **Forwarding rule**: an `nft`/`iptables` `FORWARD` rule (not `INPUT`)
  allowing the Roku's source IP in on the WireGuard interface — router
  firewalls default-deny forwarded traffic on VPN interfaces just like
  OPNsense does.
- **Outbound NAT (masquerade)**: a `POSTROUTING` `MASQUERADE` rule for that
  source IP out the WAN interface. This is the one that's invisible when
  missing — connections complete the handshake with the peer/firewall rule
  fixed, then just sit at `SYN_SENT` forever with zero indication why.

---

## OpenWrt

OpenWrt is Linux underneath, so everything above applies directly. LuCI
(the web UI) has first-class support for the easy parts and thin/no support
for the hard part:

- **WireGuard**: `opkg install wireguard-tools luci-app-wireguard`, then
  **Network → Interfaces → Add new interface → WireGuard VPN**. Maps
  cleanly to the config above.
- **Static DHCP lease**: **Network → DHCP and DNS → Static Leases**.
- **Policy routing**: this is the part LuCI doesn't have a clean page for.
  Either install `mwan3` (`opkg install mwan3 luci-app-mwan3`) and configure
  it as a policy/rule targeting the WireGuard interface for the
  Roku-to-Netflix traffic class, or do it by hand via `/etc/firewall.user`
  (or an `/etc/nftables.d/` include on newer `fw4`-based releases) with the
  `nft`/`ip rule` commands from the universal section above, applied at
  boot via `/etc/hotplug.d/iface/` or a firewall reload script.
- **The far router's three gates**: same as the universal section — OpenWrt
  uses `fw4`/nftables by default on current releases, `iptables` on older
  ones. Forwarding and masquerade rules are ordinary OpenWrt firewall
  zone/forwarding config (**Network → Firewall**), just scoped tightly to
  the Roku's IP instead of the whole zone.

## DD-WRT

Real limitation, stated plainly: DD-WRT's WireGuard support depends heavily
on which build you're running (some builds have none; others, commonly
"Kong" builds, have it under **Services → VPN**), and DD-WRT's GUI has
**no policy-routing feature at all**. Getting this working on DD-WRT means:

1. Confirm your specific build actually has WireGuard (`wg` binary present
   over SSH) before doing anything else.
2. Configure the tunnel via whatever GUI page your build provides, or by
   hand over SSH using the same `wg-quick`/config-file approach as the
   universal section.
3. Policy routing has to be done entirely by hand over SSH, using the same
   `ip rule`/`ip route`/`iptables` (DD-WRT is generally `iptables`, not
   `nftables`) commands from the universal section, and — this is the
   annoying part — reapplied via a **startup script**
   (**Administration → Commands → Startup**) since DD-WRT doesn't persist
   manual `iptables`/`ip rule` state across reboots the way a config file
   would.

If this all sounds like more manual, fragile work than it's worth: it is,
compared to OpenWrt or an actual BSD-based firewall distro. Flashing
OpenWrt (where supported on your hardware) instead of staying on DD-WRT
is a reasonable thing to consider before investing time here.

## pfSense

Practically identical to the OPNsense instructions in the main
[README](README.md)/[WALKTHROUGH](WALKTHROUGH.md) — pfSense and OPNsense
share the same FreeBSD/pf lineage, and WireGuard support was added natively
to recent pfSense (Plus) releases with a nearly identical GUI. Menu wording
differs slightly (e.g. pfSense's WireGuard page layout isn't pixel-identical
to OPNsense's), but every concept — instance/peer split, `AllowedIPs`
double-duty, assigned-interface default-deny, outbound NAT mode — carries
over directly. If you're on pfSense, follow the OPNsense walkthrough and
expect only cosmetic differences.

## Any other router OS

If your platform isn't listed: check for three things before assuming this
approach is possible at all — (1) native or packagable WireGuard support,
(2) some form of policy-based routing (fwmark + routing table, or an
equivalent "route by rule, not just by destination" feature), and (3) shell
access, since GUI-only router firmware rarely exposes fine-grained policy
routing. If a platform has all three, the universal Linux section above is
your starting point; if it's missing (2) or (3) entirely, this specific
approach likely isn't achievable on that hardware without replacing the
firmware.
