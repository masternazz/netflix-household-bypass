# Routing a Roku's Netflix traffic through a remote household's connection (OPNsense + WireGuard)

How to make one or more Roku devices on your LAN send *only their Netflix
traffic* out through a different household's internet connection, using a
site-to-site WireGuard tunnel between two OPNsense routers — while every
other device, and every other app on the Roku itself, keeps using your
normal internet connection untouched.

This is the real, working setup extracted from a live deployment. It exists
because Netflix will sometimes prompt a device for household verification
if it thinks the device has moved to a different network than usual — this
routes just enough traffic through the "home" household's connection to
satisfy that check, without tunneling the whole house's internet through
someone else's residential upload bandwidth.

**You need:**
- Two OPNsense routers, one at each household, both reachable from each
  other over the public internet (at least one needs a stable
  hostname/DDNS or public IP + an open UDP port).
- Admin access to both (GUI or API — this guide shows both where they
  differ).
- One or more Roku devices on the "away" household's LAN.

**You do NOT need:** to route all traffic, install anything on the Roku, or
touch Netflix's own settings. This is entirely router-side.

---

## Why not just VPN the whole network / use a commercial VPN?

- A whole-network VPN pushes *all* traffic — including everyone else's —
  through the remote household's connection, including download AND the
  return upload leg, which residential connections are usually bad at
  (asymmetric bandwidth). Fine for a login API call, bad for sustained 4K
  video.
- A commercial VPN's exit IP isn't your actual household — Netflix's
  household-verification check is specifically about *which household*
  you're on, so a generic VPN IP doesn't help and often makes it worse
  (VPN/proxy detection, error codes `E106`/`M7111-5059`).
- Scoping it to exactly the Roku(s) and exactly Netflix's traffic means
  nothing else on either network is affected, and the remote household's
  upload bandwidth only has to carry one device's video traffic, not a
  whole house's.

---

## Architecture

```
[Roku on Router A's LAN]
        |
        | (only Netflix-bound traffic gets policy-routed here)
        v
[Router A: LAN policy-routing rule --route-to--> WireGuard tunnel]
        |
        | (site-to-site WireGuard, UDP)
        v
[Router B: WireGuard peer --route-to--> Router B's own WAN, NAT'd]
        |
        v
    [Internet -> Netflix, sees Router B's household IP]
```

Two routers:
- **Router A** ("home") — where the Roku physically lives.
- **Router B** ("remote household") — whose internet connection Netflix
  should see.

Everything below uses `10.45.45.0/24` as Router A's LAN and
`192.168.1.0/24` as Router B's LAN, and `10.99.99.0/30` as the WireGuard
tunnel's point-to-point subnet, purely as concrete examples — substitute
your own.

---

## Part 1 — The WireGuard tunnel itself

This part is standard OPNsense-to-OPNsense WireGuard site-to-site setup,
covered well elsewhere, so only the details that matter for *this* use
case are called out:

1. On **Router B**, create a WireGuard **server** (Local) instance:
   - Name: anything descriptive (e.g. `netflix_roku`)
   - Tunnel address: `10.99.99.1/30`
   - Note the port it listens on
2. On **Router A**, create a WireGuard **client** instance connecting to
   Router B's public hostname/IP and port, tunnel address `10.99.99.2/30`.
   - **Critical**: check "Disable routes" on this instance. Leaving it
     unchecked makes OPNsense inject `0.0.0.0/1` + `128.0.0.0/1`
     split-default routes into the whole router's routing table — this
     will silently hijack **all** of Router A's household internet traffic
     through the tunnel the moment it comes up, not just the Roku's. This
     is the single most dangerous default in this whole setup.
3. Register Router A's public key as a peer on Router B's server instance.
   On Router B's peer entry for Router A, set **AllowedIPs to just the
   tunnel address for now** (`10.99.99.2/32`) — this gets revisited and
   deliberately broadened in Part 4, don't do it yet.
4. Assign the WireGuard client interface on Router A (name it something
   like `WG_REMOTE`), set MSS clamp to `1380` (WireGuard's overhead on a
   1500-byte-MTU path).
5. Add a firewall pass rule on **Router B's** `WireGuard (Group)`
   interface, source `10.99.99.2/32`, any/any. **OPNsense does not
   default-allow traffic arriving on an assigned WireGuard interface** the
   way it does for LAN — without this rule the tunnel handshakes fine but
   nothing passes.
6. Verify: `ping 10.99.99.1` from Router A. Get 0% loss before continuing
   to anything below — don't build routing rules on top of an unverified
   tunnel.

---

## Part 2 — Make the Roku's IP permanent

DHCP will eventually hand the Roku a different IP, silently breaking every
rule you're about to build. Fix this *before* anything else, or every
downstream alias/rule references an address that will eventually go stale.

On Router A:
1. Find the Roku's MAC address (from its current DHCP lease — Roku MACs
   are stable, they don't rotate).
2. Create a static DHCP reservation for it, in whatever "static/reserved"
   IP range your network convention uses (e.g. `10.45.45.50`–`.99`).
3. Repeat for every Roku you have — most households end up with more than
   one once you actually look at the lease table.
4. Build a **Host(s) alias** (call it `roku_devices`) containing just
   those static IPs. Every rule from here on references this alias, never
   a raw IP — adding a third Roku later is then a one-line change to the
   alias, nothing else.

---

## Part 3 — Scope exactly what counts as "Netflix traffic"

Two aliases on **Router A**:

1. **`netflix_asn`** — a BGP ASN-type alias for Netflix's video CDN,
   ASN **2906** (Netflix Open Connect). This is the bulk of actual video
   traffic.
2. **`netflix_domains`** — a Host(s)-type alias covering the non-CDN
   surface (login, account, household-verification API calls, which don't
   all live on ASN 2906):
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
   `amazonaws.com` is included because Netflix's account/DRM backend runs
   partly on AWS. Note the real limitation here: an OPNsense Host(s) alias
   only resolves the bare domain, not every rotating subdomain — this is
   the best low-effort coverage available, not perfect coverage.

## Part 3b — Block IPv6 on the Roku (closes a real leak)

If the Roku (or anything upstream) has IPv6, a Netflix hostname lookup can
return an AAAA record and the traffic goes straight out your normal IPv6
WAN, completely bypassing every rule above. This is a confirmed real
failure mode for Netflix specifically, not a hypothetical.

**What does NOT work**: adding Unbound host-override entries that return a
null/`::` AAAA record for Netflix's hostnames. On OPNsense this makes
Unbound treat that hostname as *fully authoritative*, which breaks the
**A**-record lookups too — the device can't resolve Netflix at all anymore.
Caught this via `drill A netflix.com` returning zero answers after adding
the overrides. Don't do this.

**What does work**: a plain firewall rule.
- Interface: LAN
- Action: **Block**
- IPv6
- Source: `roku_devices` alias
- Destination: any
- Placed **above** the "Default allow LAN IPv6 to any" rule (OPNsense
  evaluates LAN rules first-match — a block rule below the catch-all
  allow never fires)

This blocks the Rokus' IPv6 entirely, forcing them onto IPv4 where the
routing rules below actually apply. Doesn't touch DNS resolution for
anything, doesn't affect any other device.

---

## Part 4 — The actual routing rule, and Router A's gateway

On **Router A**:

1. **System → Gateways → New**: interface `WG_REMOTE`, IPv4, target
   `10.99.99.1` (Router B's tunnel address), name it (e.g.
   `GW_REMOTE_HOUSEHOLD`), **disable monitoring** (this isn't the default
   route — health-check pings flapping it would be actively harmful).
2. **Firewall → Rules → LAN**, add two rules (can't OR two aliases in one
   destination field, so two rules, same everything else):
   - Pass, IPv4, source `roku_devices`, destination `netflix_asn`, gateway
     `GW_REMOTE_HOUSEHOLD`
   - Pass, IPv4, source `roku_devices`, destination `netflix_domains`,
     gateway `GW_REMOTE_HOUSEHOLD`
3. **Move both rules above the default "Allow LAN to any" rule.** They will
   initially be added at the bottom of the list — a rule below a catch-all
   `pass` never gets evaluated, since first-match wins. This is an easy
   silent no-op if skipped: everything looks configured correctly and
   nothing routes differently.

At this point, traffic *leaves* Router A's LAN correctly headed into the
tunnel. It will not yet work end-to-end — see Part 5.

---

## Part 5 — The three things that actually block the traffic on Router B's side

This is the part no generic WireGuard/OPNsense tutorial covers, because it
only matters when you're forwarding a specific *other device's* traffic
through the tunnel rather than the router's own. Router A's `route-to`
rule sends the Roku's packets into the tunnel **with their real source IP
intact** (`10.45.45.51`, not NAT'd) — and that unNAT'd source has to clear
three independent gates on Router B before anything works. Missing any one
of the three fails *silently*, with a different, confusing symptom each
time:

### 5a. WireGuard's own `AllowedIPs` (crypto-layer source filtering)

WireGuard's `AllowedIPs` field does double duty: it's both "what
destination ranges route into this peer" *and* "what source IPs are
accepted as coming from this peer." Router B's peer entry for Router A was
scoped to just `10.99.99.2/32` in Part 1 — deliberately, so it could be
tested working before broadening it. Now broaden it:

```
AllowedIPs: 10.99.99.2/32, 10.45.45.51/32, 10.45.45.52/32
```//(the tunnel address, plus every Roku IP from the roku_devices alias —
not a wildcard /24, just the specific devices).

**Symptom if you skip this**: packets vanish with zero trace anywhere —
no firewall log, no state table entry, nothing. They're dropped at the
WireGuard crypto layer before pf ever sees them. This is the hardest of
the three to diagnose because there's no log line to grep for.

### 5b. A *separate* firewall rule on Router B's WireGuard interface

Even with 5a fixed, Router B's own firewall rules still gate the traffic
like any other interface. If there's an existing rule on the WireGuard
interface scoped only to `10.99.99.2/32` (e.g. left over from testing the
tunnel itself), it won't match the Roku's real IP either. Don't widen an
existing rule that something else depends on — add a new one:

- Create a Host(s) alias on Router B (e.g. `roku_devices_via_tunnel`)
  containing the same Roku IPs.
- Firewall rule: interface `WireGuard (Group)` (or whatever the tunnel's
  assigned interface is), direction in, IPv4, source
  `roku_devices_via_tunnel`, destination any, action pass.

**Symptom if you skip this**: this one *does* show up — check
`pfctl -ss` / the live state table on Router B and you'll see the
connection matching the rule with `direction: in`, immediately followed by
it exiting under a generic "let out anything from firewall host itself"
rule — which is actually gate 5c, not this one. If 5b alone were missing
(5a fixed, 5c fixed), it'd show as a block in the firewall log instead.

### 5c. Outbound NAT on Router B's WAN

This is the one that actually bit hardest in practice, because 5a and 5b
being fixed makes everything *look* like it's working — the tunnel is up,
the firewall rule matches, packets are "passing." But the Roku's traffic
is still sourced from a private, unroutable IP (`10.45.45.51`). Without
outbound NAT masquerading it to Router B's own public IP, Netflix's
servers receive a SYN from an address they can never route a reply back
to. The connection sits at `SYN_SENT` forever — no error, no firewall
block, no log entry anywhere. It just never completes.

Fix: a manual outbound NAT rule on Router B's WAN interface:
- Source: `roku_devices_via_tunnel` (the same alias from 5b)
- Destination: any
- Translation / target: **interface address** (i.e. masquerade — leave the
  target field blank in OPNsense's outbound NAT rule editor, that's what
  blank means here)

If your outbound NAT mode is "Automatic," this may already be covered —
but "Hybrid" or "Manual" mode (common once you have other manual NAT rules
for other purposes) will **not** auto-generate this for a source that
doesn't belong to any of the router's own configured interface subnets.
Check explicitly rather than assuming.

**How this was actually found**, since none of it shows up as an obvious
error: live `tcpdump` on the tunnel interface, on Router A's side, showed
real Netflix SYNs leaving repeatedly with zero replies. Cross-referencing
Router B's live firewall state table (not the static rule list — the
*live pf states*) showed the packets arriving, matching the pass rule
correctly, then leaving again under a self-originated "let out anything
from firewall host itself" rule instead of going out properly NAT'd. That
mismatch — traffic pf treats as "from the firewall itself" rather than
"forwarded and translated" — is the signature of missing outbound NAT
specifically. If you're stuck with connections that hang at `SYN_SENT`
and nothing else points at why, check this first.

---

## Verification

Don't trust "no errors" — confirm real data actually moved:

```
# On Router A, during Netflix playback on the Roku:
tcpdump -ni <wg-interface> host <roku-ip>
```
Look for a completed TCP handshake (`SYN` → `SYN-ACK` → `ACK`), then a
sustained burst of data packets (video segments are large — hundreds of
KB to multiple MB per burst is normal). If you only ever see repeated
`SYN`s with no reply, you're still missing one of the three gates in
Part 5.

Also check the tunnel's cumulative transfer counter before/after a test —
a jump of multiple MB confirms real video data moved, not just a
handshake:
```
wg show <interface>
```

Finally, check the Roku's screen: household-verification prompt gone,
playback starts without `NW-2-5` or `E106`/`M7111-5059` errors.

---

## Lessons learned / summary of gotchas

1. **`Disable routes` on any WireGuard client instance you don't want
   controlling the default route.** Skipping this can hijack an entire
   household's internet, not just the intended device's.
2. **A `pass` rule below a catch-all `pass` rule never fires.** Always
   move new specific rules above the default-allow rules on the interface
   they're added to.
3. **OPNsense doesn't default-allow on assigned/group WireGuard
   interfaces** the way it does on LAN — every WireGuard interface needs
   its own explicit pass rule(s).
4. **WireGuard's `AllowedIPs` is not just routing — it's also source
   validation.** Any traffic forwarded *through* a tunnel on behalf of a
   device other than the tunnel's own endpoint needs that device's IP
   explicitly added to the peer's `AllowedIPs` on the far end, or it's
   dropped invisibly.
5. **A firewall rule allowing traffic in is not the same as NAT letting
   it back out.** These are two fully independent OPNsense subsystems.
   Forwarded, unNAT'd traffic with a private source IP will pass a
   firewall rule and still never get a reply from the public internet.
6. **DNS/host-override tricks for "null out a record type" don't
   necessarily do what you'd expect** — on OPNsense, a host override
   makes the resolver authoritative for *all* record types for that name,
   not just the one you set. Prefer a firewall-layer block when the goal
   is "stop this traffic," not a DNS-layer trick.
7. **Static DHCP reservations first, always.** Every alias/rule above
   silently goes stale the moment a device's IP changes, and Roku MAC
   addresses are the one thing guaranteed not to.
