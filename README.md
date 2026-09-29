<div align="center">

# 📺 netflix-household-bypass

**Route a Roku's Netflix traffic through a different household's internet connection — and nothing else's.**

Built on OPNsense + WireGuard. Real deployment, real bugs found and fixed, documented in full.

<img src="assets/diagram.gif" alt="Animated diagram: Roku's normal traffic leaves via the home WAN unaffected, while its Netflix traffic is policy-routed through an encrypted WireGuard tunnel to a remote household's OPNsense router and out that household's WAN, so Netflix sees the remote household's IP" width="820" />

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-OPNsense-58a6ff?style=flat-square)](https://opnsense.org)
[![Transport](https://img.shields.io/badge/transport-WireGuard-e50914?style=flat-square)](https://www.wireguard.com)
[![Status](https://img.shields.io/badge/status-verified_working-3fb950?style=flat-square)]()

</div>

---

## The problem

Netflix sometimes prompts a device for **household verification** if it decides the
device has moved to a different network than the one it normally streams from. If a
Roku physically lives at a second location — a family member's house, a vacation
property, wherever — it can get stuck behind that prompt indefinitely, even though a
real person with a real account is standing right in front of it.

## The fix, in one sentence

Give that Roku's Netflix traffic — and *only* its Netflix traffic — a private tunnel
back to the household Netflix actually expects, so Netflix sees that household's IP,
while everything else on both networks (including every other app on the Roku itself)
keeps using its own normal internet connection, completely untouched.

## Why not a whole-network VPN or a commercial VPN service?

- A whole-network VPN pushes **everyone's** traffic through the remote household's
  connection — including the reverse-upload leg of streaming video, which residential
  connections are usually bad at. Fine for a login API call, bad for sustained 4K.
- A commercial VPN's exit IP isn't your actual household. Netflix's check is
  specifically about *which household* — a generic VPN IP doesn't satisfy it and can
  trigger Netflix's own proxy/VPN detection instead (`E106` / `M7111-5059`).
- Scoping this to exactly the Roku(s) and exactly Netflix's traffic means nothing else
  is affected, and the remote household's upload bandwidth only ever has to carry one
  device's video stream, not a whole house's.

---

## Architecture

```
[Roku on Router A's LAN]
        │
        │  (only Netflix-bound traffic gets policy-routed here)
        ▼
[Router A — LAN policy-routing rule --route-to--> WireGuard tunnel]
        │
        │  (site-to-site WireGuard, encrypted, UDP)
        ▼
[Router B — WireGuard peer --route-to--> Router B's own WAN, NAT'd]
        │
        ▼
    Internet → Netflix sees Router B's household IP
```

Two OPNsense routers:
- **Router A** ("home") — where the Roku physically lives.
- **Router B** ("remote household") — whose internet connection Netflix should see.

The guide below uses `10.45.45.0/24` (Router A's LAN), `192.168.1.0/24` (Router B's
LAN), and `10.99.99.0/30` (the WireGuard tunnel's point-to-point subnet) purely as
concrete examples — substitute your own throughout.

---

## What you need

- Two OPNsense routers, reachable from each other over the public internet (at least
  one needs a stable hostname/DDNS or public IP + an open UDP port).
- Admin access to both (GUI or REST API — covered where they differ).
- One or more Roku devices on the "away" household's LAN.

**You do NOT need:** to route all traffic, install anything on the Roku, or touch
Netflix's own settings. This is entirely router-side.

---

## Part 1 — The WireGuard tunnel itself

Standard OPNsense-to-OPNsense WireGuard site-to-site setup — only the details that
matter for *this specific use case* are called out below.

1. On **Router B**, create a WireGuard **server** (Local) instance.
   Tunnel address: `10.99.99.1/30`. Note the listening port.
2. On **Router A**, create a WireGuard **client** instance pointed at Router B's
   public hostname/IP and port. Tunnel address: `10.99.99.2/30`.
   > ⚠️ **Check "Disable routes" on this instance.** Leaving it unchecked makes
   > OPNsense inject `0.0.0.0/1` + `128.0.0.0/1` split-default routes the moment the
   > tunnel comes up — silently hijacking **all** of Router A's household internet
   > traffic through the tunnel, not just the Roku's. The single most dangerous
   > default in this whole setup.
3. Register Router A's public key as a peer on Router B's server instance. Set
   `AllowedIPs` to just the tunnel address for now (`10.99.99.2/32`) — this gets
   deliberately broadened in Part 5, not yet.
4. Assign the WireGuard client interface on Router A (e.g. `WG_REMOTE`), set MSS
   clamp to `1380` (WireGuard's overhead on a 1500-byte-MTU path).
5. Add a firewall **pass** rule on **Router B's** `WireGuard (Group)` interface,
   source `10.99.99.2/32`, any/any. OPNsense does **not** default-allow traffic on an
   assigned WireGuard interface the way it does for LAN — without this rule the
   tunnel handshakes fine and nothing passes.
6. Verify: `ping 10.99.99.1` from Router A. Get 0% loss before building anything else
   on top of an unverified tunnel.

## Part 2 — Make the Roku's IP permanent

DHCP will eventually hand the Roku a different IP, silently breaking every rule below
it. Fix this first.

1. Find the Roku's MAC address from its current DHCP lease (Roku MACs are stable).
2. Create a static DHCP reservation for it.
3. Repeat for **every** Roku — most households have more than one once you actually
   check the lease table.
4. Build a **Host(s) alias** (`roku_devices`) containing just those static IPs. Every
   rule from here on references the alias, never a raw IP.

## Part 3 — Scope exactly what counts as "Netflix traffic"

Two aliases on **Router A**:

| Alias | Type | Content |
|---|---|---|
| `netflix_asn` | BGP ASN | **2906** (Netflix Open Connect — the video CDN) |
| `netflix_domains` | Host(s) | `netflix.com`, `www.netflix.com`, `nflxso.net`, `nflxext.com`, `nflximg.net`, `nflxvideo.net`, `fast.com`, `amazonaws.com` |

`amazonaws.com` is included because Netflix's account/login/DRM backend runs partly on
AWS, outside ASN 2906. Note: a Host(s) alias only resolves the bare domain, not every
rotating subdomain — the best low-effort coverage available, not perfect coverage.

### Block IPv6 on the Roku (closes a real leak)

If the Roku has IPv6, a Netflix hostname lookup can return an AAAA record and the
traffic goes straight out the normal IPv6 WAN — completely bypassing every rule above.
Confirmed real failure mode for Netflix specifically.

> ❌ **What does NOT work:** Unbound host-override entries nulling the AAAA record.
> On OPNsense this makes the resolver **fully authoritative** for that hostname,
> which breaks A-record resolution too — the device can't resolve Netflix at all
> anymore. (Caught via `drill A netflix.com` returning zero answers.)

> ✅ **What works:** a plain firewall rule — LAN, **Block**, IPv6, source
> `roku_devices`, destination any, placed **above** "Default allow LAN IPv6 to any"
> (first-match evaluation — a block below the catch-all never fires).

## Part 4 — The routing rule, and Router A's gateway

1. **Gateway**: interface `WG_REMOTE`, IPv4, target `10.99.99.1`, name it (e.g.
   `GW_REMOTE_HOUSEHOLD`), **monitoring disabled** (not the default route — health
   checks flapping it would be actively harmful).
2. **Two LAN pass rules** (can't OR two aliases in one destination field):
   - source `roku_devices` → destination `netflix_asn` → gateway `GW_REMOTE_HOUSEHOLD`
   - source `roku_devices` → destination `netflix_domains` → gateway `GW_REMOTE_HOUSEHOLD`
3. **Move both above the default "Allow LAN to any" rule.** They land at the bottom
   by default — a rule below a catch-all `pass` never evaluates. Easy silent no-op if
   skipped: everything *looks* configured correctly and nothing routes differently.

## Part 5 — The three gates on Router B that actually matter

This is the part no generic WireGuard tutorial covers, because it only matters when
forwarding *another device's* traffic through the tunnel rather than the router's own.
Router A's `route-to` rule sends the Roku's packets into the tunnel **with their real
source IP intact** — and that source has to clear three independent gates on Router B.
**Missing any one fails silently, with a different symptom each time:**

### 5a. WireGuard's own `AllowedIPs` (crypto-layer source filtering)

`AllowedIPs` does double duty: both "what routes into this peer" and "what source IPs
are accepted as coming from this peer." Broaden Router B's peer entry for Router A:

```
AllowedIPs: 10.99.99.2/32, 10.45.45.51/32, 10.45.45.52/32
```
*(the tunnel address, plus every Roku IP — not a wildcard `/24`, just the specific devices)*

> **Symptom if skipped:** packets vanish with zero trace anywhere — no firewall log,
> no state-table entry, nothing. Dropped at the crypto layer before pf ever sees them.
> The hardest of the three to diagnose, because there's no log line to grep for.

### 5b. A *separate* firewall rule on Router B's WireGuard interface

Even with 5a fixed, Router B's own firewall still gates the traffic like any other
interface. Add a new alias (`roku_devices_via_tunnel`) with the same Roku IPs, and a
new pass rule on the WireGuard interface scoped to it — don't widen an existing rule
something else depends on.

> **Symptom if skipped:** shows up in the live pf state table as `direction: in`
> matching the rule, immediately followed by exiting under a generic self-originated
> rule instead of a proper forward — which is actually gate 5c.

### 5c. Outbound NAT on Router B's WAN

The one that bites hardest, because 5a + 5b being fixed makes everything *look* like
it's working. The Roku's traffic is still sourced from a private, unroutable IP.
Without outbound NAT masquerading it to Router B's public IP, Netflix's servers
receive a SYN they can never reply to — the connection sits at `SYN_SENT` forever, no
error, no block, no log entry anywhere.

Fix: manual outbound NAT rule on Router B's WAN — source `roku_devices_via_tunnel`,
target **interface address** (masquerade). If your outbound NAT mode is "Hybrid" or
"Manual" (common once other manual rules exist), this will **not** auto-generate for
a source that doesn't belong to any of the router's own interface subnets.

> **How this was actually found:** live `tcpdump` on the tunnel interface showed real
> Netflix SYNs leaving repeatedly with zero replies. Cross-referencing Router B's
> **live** pf state table (not the static rule list) showed packets arriving,
> matching the pass rule, then leaving again under a self-originated rule instead of
> a properly NAT'd forward. That mismatch is the signature of missing outbound NAT.

---

## Verification

Don't trust "no errors" — confirm real data moved:

```bash
# On Router A, during Netflix playback on the Roku:
tcpdump -ni <wg-interface> host <roku-ip>
```
Look for a completed TCP handshake (`SYN` → `SYN-ACK` → `ACK`), then a sustained burst
of data (video segments — hundreds of KB to multiple MB per burst is normal). Repeated
`SYN`s with no reply means you're still missing one of the three gates in Part 5.

```bash
wg show <interface>   # check the cumulative transfer counter before/after a test
```

Finally — check the Roku's screen: household-verification prompt gone, playback
starts clean, no `NW-2-5` or `E106`/`M7111-5059`.

---

## Lessons learned

1. **`Disable routes`** on any WireGuard client instance you don't want controlling
   the default route — skipping it can hijack an entire household's internet.
2. **A `pass` rule below a catch-all `pass` rule never fires** — always move new
   specific rules above the default-allow rules on the interface they're added to.
3. **OPNsense doesn't default-allow on assigned/group WireGuard interfaces** the way
   it does on LAN — every WireGuard interface needs its own explicit pass rule(s).
4. **`AllowedIPs` is source validation, not just routing.** Traffic forwarded
   *through* a tunnel on behalf of a device other than the tunnel's own endpoint needs
   that device's IP explicitly added on the far end, or it's dropped invisibly.
5. **A firewall rule allowing traffic in ≠ NAT letting it back out.** Two fully
   independent subsystems. Forwarded, unNAT'd traffic with a private source IP will
   pass a firewall rule and still never get a reply from the public internet.
6. **DNS "null out a record" tricks don't do what you'd expect** — an OPNsense host
   override makes the resolver authoritative for *all* record types for that name,
   not just the one you set. Prefer a firewall-layer block instead.
7. **Static DHCP reservations first, always.** Every alias/rule above silently goes
   stale the moment a device's IP changes, and MAC addresses are the one thing
   guaranteed not to.

---

## License

[MIT](LICENSE) — use this however is useful to you.
