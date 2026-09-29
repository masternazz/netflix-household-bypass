import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

// ---- palette ----
const BG = "#0d1117";
const PANEL = "#161b22";
const BORDER = "#30363d";
const TEXT = "#e6edf3";
const MUTED = "#7d8590";
const ACCENT = "#58a6ff"; // tunnel / OPNsense blue
const NETFLIX = "#e50914"; // highlighted path

type Point = [number, number];

const pathLength = (pts: Point[]) =>
  pts.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = p;
    return sum + Math.hypot(x1 - x0, y1 - y0);
  }, 0);

const pointAlong = (pts: Point[], progress: number): Point => {
  const total = pathLength(pts);
  let target = Math.max(0, Math.min(1, progress)) * total;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (target <= segLen || i === pts.length - 1) {
      const t = segLen === 0 ? 0 : target / segLen;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    target -= segLen;
  }
  return pts[pts.length - 1];
};

const Node: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle?: string;
  color: string;
  appearAt: number;
  icon?: string;
}> = ({ x, y, w, h, title, subtitle, color, appearAt, icon }) => {
  const frame = useCurrentFrame();
  const s = spring({
    frame: frame - appearAt,
    fps: 30,
    config: { damping: 14, mass: 0.6 },
  });
  const opacity = interpolate(frame - appearAt, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        opacity,
        transform: `scale(${0.85 + s * 0.15})`,
        transformOrigin: "center",
        background: PANEL,
        border: `2px solid ${color}`,
        borderRadius: 12,
        boxShadow: `0 0 24px ${color}33`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 10,
      }}
    >
      {icon ? <div style={{ fontSize: 26, marginBottom: 4 }}>{icon}</div> : null}
      <div style={{ color: TEXT, fontWeight: 700, fontSize: 18, lineHeight: 1.2 }}>
        {title}
      </div>
      {subtitle ? (
        <div style={{ color: MUTED, fontSize: 12.5, marginTop: 4, lineHeight: 1.3 }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
};

const Wire: React.FC<{
  pts: Point[];
  color: string;
  appearAt: number;
  dashed?: boolean;
}> = ({ pts, color, appearAt, dashed }) => {
  const frame = useCurrentFrame();
  const total = pathLength(pts);
  const drawn = interpolate(frame - appearAt, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const d = pts.reduce(
    (acc, [x, y], i) => acc + `${i === 0 ? "M" : "L"}${x},${y} `,
    ""
  );
  return (
    <svg
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      width={1280}
      height={720}
    >
      <path
        d={d}
        stroke={color}
        strokeWidth={3}
        fill="none"
        strokeDasharray={dashed ? "10 8" : `${total}`}
        strokeDashoffset={dashed ? 0 : total * (1 - drawn)}
        opacity={dashed ? interpolate(frame - appearAt, [0, 15], [0, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1}
      />
    </svg>
  );
};

const Packet: React.FC<{
  pts: Point[];
  color: string;
  startFrame: number;
  durationFrames: number;
}> = ({ pts, color, startFrame, durationFrames }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
  );
  const visible = frame >= startFrame && frame <= startFrame + durationFrames + 6;
  if (!visible) return null;
  const [x, y] = pointAlong(pts, progress);
  const fade = interpolate(
    frame,
    [startFrame, startFrame + 6, startFrame + durationFrames, startFrame + durationFrames + 6],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <div
      style={{
        position: "absolute",
        left: x - 7,
        top: y - 7,
        width: 14,
        height: 14,
        borderRadius: 7,
        background: color,
        opacity: fade,
        boxShadow: `0 0 14px 4px ${color}`,
      }}
    />
  );
};

const Label: React.FC<{
  x: number;
  y: number;
  w: number;
  text: string;
  color: string;
  appearAt: number;
  align?: "left" | "center";
}> = ({ x, y, w, text, color, appearAt, align = "center" }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - appearAt, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        opacity,
        color,
        fontSize: 15,
        fontWeight: 600,
        textAlign: align,
        letterSpacing: 0.2,
      }}
    >
      {text}
    </div>
  );
};

export const NetworkDiagram: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // ---- node coordinates ----
  const roku: Point = [70, 310];
  const rokuC: Point = [145, 360];
  const home: Point = [300, 310];
  const homeC: Point = [400, 360];

  const wan: Point = [590, 130];
  const wanC: Point = [680, 170];
  const netTop: Point = [860, 130];
  const netTopC: Point = [950, 170];

  const tunnel: Point = [590, 510];
  const tunnelC: Point = [680, 550];
  const remote: Point = [810, 510];
  const remoteC: Point = [910, 550];
  const netflix: Point = [1080, 510];
  const netflixC: Point = [1155, 550];

  // ---- timing ----
  const tTitle = 0;
  const tRoku = 25;
  const tHome = 45;
  const tTopLane = 70;
  const tTopPacket1 = 95;
  const tBottomLane = 160;
  const tTunnelPulse = 180;
  const tBottomPacket = 210;
  const tCallout = 300;

  const titleOpacity = interpolate(frame, [tTitle, tTitle + 20, 60, 80], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [tTitle, tTitle + 20], [24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const endOpacity = interpolate(
    frame,
    [durationInFrames - 40, durationInFrames - 10],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const rokuHomePath: Point[] = [rokuC, homeC];
  const topPath: Point[] = [homeC, wanC, netTopC];
  const bottomPath: Point[] = [homeC, tunnelC, remoteC, netflixC];

  const tunnelPulse = 1 + Math.sin((frame - tTunnelPulse) / 6) * 0.06;

  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: "Inter, -apple-system, sans-serif" }}>
      {/* title */}
      <div
        style={{
          position: "absolute",
          top: 32,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
        }}
      >
        <div style={{ color: TEXT, fontSize: 34, fontWeight: 800 }}>
          Selective Netflix Routing
        </div>
        <div style={{ color: MUTED, fontSize: 16, marginTop: 4 }}>
          OPNsense + WireGuard — only the Roku's Netflix traffic takes the detour
        </div>
      </div>

      {/* wires */}
      <Wire pts={rokuHomePath} color={BORDER} appearAt={tRoku + 10} />
      <Wire pts={topPath} color={MUTED} appearAt={tTopLane} />
      <Wire pts={[homeC, tunnelC]} color={ACCENT} appearAt={tBottomLane} />
      <Wire pts={[tunnelC, remoteC]} color={ACCENT} appearAt={tBottomLane + 10} dashed />
      <Wire pts={[remoteC, netflixC]} color={NETFLIX} appearAt={tBottomLane + 20} />

      {/* normal-traffic packet, loops */}
      <Packet pts={topPath} color={MUTED} startFrame={tTopPacket1} durationFrames={45} />
      <Packet pts={topPath} color={MUTED} startFrame={tTopPacket1 + 60} durationFrames={45} />
      <Packet pts={topPath} color={MUTED} startFrame={tTopPacket1 + 120} durationFrames={45} />
      <Packet pts={topPath} color={MUTED} startFrame={tTopPacket1 + 180} durationFrames={45} />

      {/* netflix packet, single deliberate run */}
      <Packet pts={bottomPath} color={NETFLIX} startFrame={tBottomPacket} durationFrames={70} />
      <Packet pts={bottomPath} color={NETFLIX} startFrame={tBottomPacket + 90} durationFrames={70} />

      {/* nodes */}
      <Node x={roku[0]} y={roku[1]} w={150} h={100} title="Roku" subtitle="on the home LAN" color={BORDER} appearAt={tRoku} icon="📺" />
      <Node x={home[0]} y={home[1]} w={200} h={100} title="Home Router" subtitle="OPNsense — policy routes by destination" color={ACCENT} appearAt={tHome} icon="🧭" />

      <Node x={wan[0]} y={wan[1]} w={170} h={80} title="Your WAN" color={BORDER} appearAt={tTopLane} />
      <Node x={netTop[0]} y={netTop[1]} w={170} h={80} title="Everything else" subtitle="unaffected, normal path" color={BORDER} appearAt={tTopLane + 15} />

      <div
        style={{
          position: "absolute",
          left: tunnel[0],
          top: tunnel[1],
          transform: `scale(${tunnelPulse})`,
        }}
      >
        <Node x={0} y={0} w={170} h={80} title="WireGuard Tunnel" subtitle="encrypted, site-to-site" color={ACCENT} appearAt={tBottomLane} icon="🔒" />
      </div>
      <Node x={remote[0]} y={remote[1]} w={210} h={80} title="Remote Router" subtitle="OPNsense, other household" color={ACCENT} appearAt={tBottomLane + 25} icon="🧭" />
      <Node x={netflix[0]} y={netflix[1]} w={150} h={80} title="Netflix" subtitle="sees the remote IP" color={NETFLIX} appearAt={tBottomLane + 45} />

      <Label x={wan[0] - 40} y={wan[1] - 26} w={260} text="Normal traffic — every other device/app" color={MUTED} appearAt={tTopLane + 25} />
      <Label x={tunnel[0] - 40} y={tunnel[1] + 92} w={320} text="Roku's Netflix traffic only — everything else untouched" color={ACCENT} appearAt={tBottomLane + 60} />

      {/* callout */}
      <div
        style={{
          position: "absolute",
          left: 780,
          top: 610,
          width: 460,
          opacity: interpolate(frame, [tCallout, tCallout + 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          background: "#132a1a",
          border: "1.5px solid #2ea043",
          borderRadius: 10,
          padding: "10px 16px",
          color: "#3fb950",
          fontSize: 15,
          fontWeight: 700,
          textAlign: "center",
        }}
      >
        ✓ No household-verification prompt — Netflix sees the remote household's IP
      </div>

      {/* end card */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: BG,
          opacity: endOpacity,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ color: TEXT, fontSize: 30, fontWeight: 800 }}>netflix-household-bypass</div>
        <div style={{ color: MUTED, fontSize: 16, marginTop: 8 }}>
          github.com/masternazz/netflix-household-bypass
        </div>
      </div>
    </AbsoluteFill>
  );
};
