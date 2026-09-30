/**
 * Cross-section of one side-scan ping: two fans of sound, the nadir gap under the vehicle, a strong echo from
 * a wreck and the acoustic shadow behind it, and the single image line that ping produces.
 */
const T = { x: 320, y: 92 }; // transducer
const SEABED = 262;
const WRECK = { x0: 440, x1: 486, top: 232 };
// The ray grazing the wreck's top edge reaches the seabed here; everything in between is shadow.
const SHADOW_END = WRECK.x1 + ((SEABED - WRECK.top) * (WRECK.x1 - T.x)) / (WRECK.top - T.y);

function arc(r, side) {
  const a0 = side > 0 ? Math.atan2(SEABED - T.y, 280) : Math.PI - Math.atan2(SEABED - T.y, 14);
  const a1 = side > 0 ? Math.atan2(SEABED - T.y, 14) : Math.PI - Math.atan2(SEABED - T.y, 280);
  const p = (a) => `${(T.x + r * Math.cos(a)).toFixed(1)} ${(T.y + r * Math.sin(a)).toFixed(1)}`;
  return `M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`;
}

const LINE = [
  // [from x, to x, colour] along the image line produced by this ping (amber sonar palette)
  [40, 306, 'url(#sd-seabed-line)'],
  [306, 334, '#050302'],
  [334, WRECK.x0, '#7a4310'],
  [WRECK.x0, WRECK.x1, '#fff1c9'],
  [WRECK.x1, SHADOW_END, '#050302'],
  [SHADOW_END, 600, '#8a4d12'],
];

export default function SonarDiagram() {
  return (
    <svg viewBox="0 0 640 372" className="h-auto w-full" role="img" aria-labelledby="sonar-diagram-title sonar-diagram-desc">
      <title id="sonar-diagram-title">How one side-scan ping images the seabed</title>
      <desc id="sonar-diagram-desc">
        An AUV 8 metres above the seabed sends a fan of sound 30 metres to each side. A wreck returns a strong echo and
        casts an acoustic shadow behind it. The ping becomes one line of the sonar image.
      </desc>
      <defs>
        <linearGradient id="sd-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c3d55" />
          <stop offset="1" stopColor="#04151f" />
        </linearGradient>
        <linearGradient id="sd-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b6450" />
          <stop offset="1" stopColor="#26241d" />
        </linearGradient>
        <linearGradient id="sd-beam-r" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.42" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="sd-beam-l" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.42" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="sd-seabed-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#5a300a" />
          <stop offset="0.5" stopColor="#9a5a16" />
          <stop offset="1" stopColor="#7a4310" />
        </linearGradient>
        <clipPath id="sd-water-clip">
          <rect width="640" height={SEABED} />
        </clipPath>
        <marker id="sd-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" fill="#94a3b8" />
        </marker>
      </defs>

      <rect width="640" height="300" rx="14" fill="url(#sd-water)" />

      {/* Two fans of sound, with the unreachable wedge behind the wreck cut out. */}
      <polygon points={`${T.x},${T.y} 306,${SEABED} 40,${SEABED}`} fill="url(#sd-beam-l)" />
      <polygon points={`${T.x},${T.y} 334,${SEABED} 600,${SEABED}`} fill="url(#sd-beam-r)" />
      <polygon points={`${WRECK.x1},${WRECK.top} ${SHADOW_END},${SEABED} ${WRECK.x1},${SEABED}`} fill="#061b27" />
      <g clipPath="url(#sd-water-clip)" fill="none" stroke="#67e8f9" strokeWidth="1.6" strokeLinecap="round">
        {[70, 135, 200].map((r, i) => (
          <g key={r} className="sd-pulse" style={{ animationDelay: `${i * 0.45}s` }}>
            <path d={arc(r, 1)} />
            <path d={arc(r, -1)} />
          </g>
        ))}
      </g>
      <line x1={T.x} y1={T.y} x2={SHADOW_END} y2={SEABED} stroke="#e2e8f0" strokeOpacity="0.45" strokeDasharray="4 5" />

      {/* Seabed and the wreck. */}
      <path d={`M0 ${SEABED} Q80 256 160 ${SEABED} T320 ${SEABED} T480 ${SEABED} T640 ${SEABED} V300 H0 Z`} fill="url(#sd-sand)" />
      <rect x={WRECK.x1} y={SEABED - 1.5} width={SHADOW_END - WRECK.x1} height="4" fill="#020608" />
      <path
        d={`M${WRECK.x0} ${SEABED} L${WRECK.x0 + 5} ${WRECK.top + 6} L${WRECK.x0 + 16} ${WRECK.top + 2} L${WRECK.x0 + 18} ${WRECK.top - 10} L${WRECK.x0 + 32} ${WRECK.top - 10} L${WRECK.x0 + 33} ${WRECK.top} L${WRECK.x1} ${WRECK.top} L${WRECK.x1 + 3} ${SEABED} Z`}
        fill="#3f3226"
        stroke="#fde68a"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* The AUV. */}
      <g transform={`translate(${T.x} ${T.y - 8})`}>
        <rect x="-34" y="-8" width="68" height="16" rx="8" fill="#f4b000" />
        <rect x="18" y="-8" width="16" height="16" rx="8" fill="#0c0e11" />
        <rect x="-38" y="-5" width="8" height="10" rx="2" fill="#23272d" />
        <rect x="-26" y="-15" width="4" height="8" rx="1" fill="#23272d" />
        <circle cx="-24" cy="-17" r="2.2" fill="#e0f7ff" />
      </g>
      <text x={T.x} y="60" textAnchor="middle" className="fill-slate-200 text-[12px] font-semibold">AUV</text>

      {/* Dimensions and callouts. */}
      <line x1="300" y1="112" x2="300" y2={SEABED - 4} stroke="#94a3b8" strokeWidth="1.2" markerStart="url(#sd-arrow)" markerEnd="url(#sd-arrow)" />
      <text x="292" y="190" textAnchor="end" className="fill-slate-300 text-[11px]">8 m altitude</text>
      <line x1="338" y1="284" x2="598" y2="284" stroke="#94a3b8" strokeWidth="1.2" markerStart="url(#sd-arrow)" markerEnd="url(#sd-arrow)" />
      <text x="468" y="296" textAnchor="middle" className="fill-slate-300 text-[11px]">30 m range, starboard</text>
      <line x1="42" y1="284" x2="302" y2="284" stroke="#94a3b8" strokeWidth="1.2" markerStart="url(#sd-arrow)" markerEnd="url(#sd-arrow)" />
      <text x="172" y="296" textAnchor="middle" className="fill-slate-300 text-[11px]">30 m range, port</text>
      <text x="320" y="276" textAnchor="middle" className="fill-slate-400 text-[10px]">nadir gap</text>

      <path d={`M402 176 L${WRECK.x0 + 2} ${WRECK.top + 8}`} stroke="#fde68a" strokeWidth="1" fill="none" />
      <text x="398" y="172" textAnchor="end" className="fill-amber-200 text-[11px] font-semibold">strong echo</text>
      <path d={`M556 208 L${(WRECK.x1 + SHADOW_END) / 2} ${SEABED - 8}`} stroke="#cbd5e1" strokeWidth="1" fill="none" />
      <text x="560" y="204" className="fill-slate-200 text-[11px] font-semibold">acoustic shadow</text>

      {/* The image line this ping produces. */}
      <text x="40" y="322" className="fill-slate-500 text-[11px] font-semibold uppercase tracking-wider">One ping → one image line</text>
      {LINE.map(([x0, x1, fill]) => (
        <rect key={x0} x={x0} y="330" width={x1 - x0} height="16" fill={fill} />
      ))}
      <rect x="40" y="330" width="560" height="16" fill="none" stroke="#cbd5e1" strokeOpacity="0.5" rx="2" />
      <text x="320" y="364" textAnchor="middle" className="fill-slate-500 text-[10.5px]">
        dark gap · seabed · bright echo · black shadow · seabed
      </text>
    </svg>
  );
}
