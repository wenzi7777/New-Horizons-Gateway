import type { BoardArt } from "@nhgw/host";

// The board, turning the way the calibration wants it turned: a figure-8,
// then each face up in turn (CSS keyframes, .mag-turn-board). Under
// prefers-reduced-motion the CSS holds it still and the caption carries the
// instruction.
//
// It shows the motion, not "this edge next": which way the sensor's axes run
// on each board, and which way the earth's field points in the room, decide
// which pose fills which direction. The coverage sphere beside it shows what
// is still missing, in the sensor's own frame.

const PART_FILL: Record<string, string> = {
  module: "var(--mag-board-module)",
  antenna: "var(--mag-board-antenna)",
  usb: "var(--mag-board-metal)",
  connector: "var(--mag-board-plug)",
  fpc: "var(--mag-board-plug)",
  ic: "var(--mag-board-ic)",
  led: "var(--mag-board-led)",
  switch: "var(--mag-board-metal)",
  button: "var(--mag-board-metal)",
};

function BoardDrawing({ art }: { art: BoardArt | null }) {
  // GCU LTS boards have no drawing: a plain board with the sensor marked.
  const width = art?.width ?? 30;
  const height = art?.height ?? 40;
  const pad = 6;
  return (
    <svg
      className="mag-turn-svg"
      viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
      aria-hidden="true"
    >
      <rect x={0} y={0} width={width} height={height} rx={1.6} className="mag-turn-pcb" />
      {art
        ? art.parts.map((part, index) => (
            <rect
              key={index}
              x={part.x}
              y={part.y}
              width={part.w}
              height={part.h}
              rx={0.4}
              fill={PART_FILL[part.kind] ?? "var(--mag-board-ic)"}
            />
          ))
        : (
          <>
            <rect x={width * 0.3} y={height * 0.12} width={width * 0.4} height={height * 0.3} rx={0.6} fill="var(--mag-board-module)" />
            <rect x={width * 0.42} y={height * 0.6} width={width * 0.16} height={width * 0.16} rx={0.4} fill="var(--mag-board-ic)" />
          </>
        )}
      {art?.holes.map((hole, index) => (
        <circle key={`h${index}`} cx={hole.x} cy={hole.y} r={hole.d / 2} className="mag-turn-hole" />
      ))}
    </svg>
  );
}

export function BoardTurnAnimation({ art, caption }: { art: BoardArt | null; caption: string }) {
  return (
    <figure className="mag-turn">
      <div className="mag-turn-stage">
        <div className="mag-turn-board">
          <div className="mag-turn-face front"><BoardDrawing art={art} /></div>
          <div className="mag-turn-face back" />
        </div>
        <div className="mag-turn-shadow" />
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
