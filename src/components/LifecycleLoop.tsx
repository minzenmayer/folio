// Folio · LifecycleLoop
// The closed-loop architecture diagram from Issue 07.
// Pure SVG, no library. Reusable across pages.

export function LifecycleLoop() {
  return (
    <svg
      viewBox="0 0 720 320"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Folio lifecycle: Capture, Mature, Build, Circulate — connected in a closed loop"
      className="max-w-full h-auto"
    >
      <defs>
        <marker
          id="folio-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b9ad92" />
        </marker>
      </defs>

      {/* arrows along the loop */}
      <path
        d="M 130 145 Q 250 80 370 145"
        stroke="#b9ad92"
        strokeWidth="1.2"
        fill="none"
        markerEnd="url(#folio-arrow)"
      />
      <path
        d="M 370 175 Q 470 175 555 175"
        stroke="#b9ad92"
        strokeWidth="1.2"
        fill="none"
        markerEnd="url(#folio-arrow)"
      />
      <path
        d="M 590 200 Q 590 280 460 280"
        stroke="#b9ad92"
        strokeWidth="1.2"
        fill="none"
        markerEnd="url(#folio-arrow)"
      />
      <path
        d="M 410 280 Q 80 280 95 175"
        stroke="#b9ad92"
        strokeWidth="1.2"
        fill="none"
        markerEnd="url(#folio-arrow)"
      />

      {/* nodes */}
      <g>
        <circle
          cx="115"
          cy="160"
          r="55"
          fill="#fbf7ef"
          stroke="#b8331f"
          strokeWidth="1.5"
        />
        <text
          x="115"
          y="156"
          textAnchor="middle"
          fontFamily="var(--font-fraunces), serif"
          fontSize="16"
          fontWeight="500"
          fill="#15110c"
        >
          Capture
        </text>
        <text
          x="115"
          y="175"
          textAnchor="middle"
          fontFamily="var(--font-inter), sans-serif"
          fontSize="9"
          letterSpacing="1.5"
          fill="#6b5e44"
        >
          SIX SURFACES
        </text>
      </g>

      <g>
        <circle
          cx="385"
          cy="160"
          r="55"
          fill="#fbf7ef"
          stroke="#7a8a3f"
          strokeWidth="1.5"
        />
        <text
          x="385"
          y="156"
          textAnchor="middle"
          fontFamily="var(--font-fraunces), serif"
          fontSize="16"
          fontWeight="500"
          fill="#15110c"
        >
          Mature
        </text>
        <text
          x="385"
          y="175"
          textAnchor="middle"
          fontFamily="var(--font-inter), sans-serif"
          fontSize="9"
          letterSpacing="1.5"
          fill="#6b5e44"
        >
          THE LIBRARY
        </text>
      </g>

      <g>
        <circle
          cx="610"
          cy="190"
          r="55"
          fill="#fbf7ef"
          stroke="#c98a2b"
          strokeWidth="1.5"
        />
        <text
          x="610"
          y="186"
          textAnchor="middle"
          fontFamily="var(--font-fraunces), serif"
          fontSize="16"
          fontWeight="500"
          fill="#15110c"
        >
          Build
        </text>
        <text
          x="610"
          y="205"
          textAnchor="middle"
          fontFamily="var(--font-inter), sans-serif"
          fontSize="9"
          letterSpacing="1.5"
          fill="#6b5e44"
        >
          THE PAGE
        </text>
      </g>

      <g>
        <circle
          cx="430"
          cy="280"
          r="40"
          fill="#15110c"
          stroke="#5b4f88"
          strokeWidth="1.5"
        />
        <text
          x="430"
          y="278"
          textAnchor="middle"
          fontFamily="var(--font-fraunces), serif"
          fontStyle="italic"
          fontSize="14"
          fill="#f6f1e8"
        >
          Circulate
        </text>
        <text
          x="430"
          y="293"
          textAnchor="middle"
          fontFamily="var(--font-inter), sans-serif"
          fontSize="8"
          letterSpacing="1.5"
          fill="#e0c4ad"
        >
          BACK INTO THE BANK
        </text>
      </g>
    </svg>
  );
}
