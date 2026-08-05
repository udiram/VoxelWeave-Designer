import { useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Orientation, SceneObject, ToolId } from "../types";
import { Icon } from "./icons";
import type { MprPlaneResult, VolumePreviewResult } from "../services/sidecarClient";

const orange = "#b94c23";
const teal = "#18818a";
const ink = "#d7dadd";

export function SyntheticSlice({ plane, index = 42, onSelect, selected = false }: { plane: Orientation; index?: number; onSelect?: () => void; selected?: boolean }) {
  const labels = plane === "axial" ? { top: "A", bottom: "P", left: "R", right: "L", position: `z: ${(index - 80).toFixed(2)} mm` } : plane === "sagittal" ? { top: "S", bottom: "I", left: "A", right: "P", position: `x: ${(index / 2.1).toFixed(2)} mm` } : { top: "S", bottom: "I", left: "R", right: "L", position: `y: ${(index / -2.1).toFixed(2)} mm` };
  const lungs = plane === "axial" ? "M74 141 C60 102 85 64 145 61 C182 58 210 83 211 121 C210 163 181 194 142 194 C104 194 82 178 74 141ZM426 141 C440 102 415 64 355 61 C318 58 290 83 289 121 C290 163 319 194 358 194 C396 194 418 178 426 141Z" : plane === "sagittal" ? "M182 70 C244 57 299 80 315 137 C322 164 310 193 278 207 C234 225 181 189 168 143 C160 111 161 82 182 70Z" : "M132 82 C168 50 215 58 236 101 C250 128 244 177 212 200 C174 226 127 203 112 163 C101 133 107 103 132 82ZM368 82 C332 50 285 58 264 101 C250 128 256 177 288 200 C326 226 373 203 388 163 C399 133 393 103 368 82Z";
  const ribs = Array.from({ length: 12 }, (_, rib) => {
    const x = 80 + rib * 31;
    return <ellipse key={rib} cx={x} cy={44 + (rib % 2) * 4} rx="14" ry="5" transform={`rotate(${rib % 2 ? -14 : 14} ${x} ${44 + (rib % 2) * 4})`} />;
  });
  return <button type="button" className={`ct-pane ${selected ? "selected" : ""}`} onClick={onSelect} aria-label={`${plane} synthetic CT slice`}>
    <svg viewBox="0 0 500 300" role="img" aria-label={`${plane} preview from full-resolution signed-HU cache`} preserveAspectRatio="none">
      <rect width="500" height="300" fill="#0f1112" />
      <path d="M70 46 C90 27 410 27 430 46 L447 252 C414 275 86 275 53 252Z" fill="#5a5c5d" opacity=".6" />
      <path d={lungs} fill="#151718" stroke="#999b9d" strokeWidth="2.2" />
      <path d="M252 48 C242 98 239 155 250 224" stroke="#bbbdbf" strokeWidth="15" opacity=".76" fill="none" />
      <path d="M252 51 C257 98 264 155 249 222" stroke="#303334" strokeWidth="10" opacity=".9" fill="none" />
      <path d="M73 128 Q252 113 427 128M70 171 Q252 185 430 171" stroke="#848789" strokeWidth="1.4" opacity=".5" fill="none" />
      <g fill="none" stroke="#777a7c" strokeWidth="2" opacity=".7">{ribs}</g>
      <g stroke={orange} strokeWidth="1.15" opacity=".9"><path d="M252 24v252"/><path d="M35 148h430"/></g>
      <text x="12" y="24" fill="#ebedef" fontSize="14" fontWeight="600">{plane[0].toUpperCase() + plane.slice(1)}</text>
      <text x="487" y="24" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.top}</text>
      <text x="487" y="288" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.bottom}</text>
      <text x="12" y="158" fill="#e6e8e9" fontSize="13">{labels.left}</text>
      <text x="482" y="158" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.right}</text>
      <text x="14" y="282" fill="#aeb1b4" fontSize="12">{index} / 150</text>
      <text x="486" y="282" textAnchor="end" fill="#aeb1b4" fontSize="12">{labels.position}</text>
      <text x="486" y="44" textAnchor="end" fill="#aeb1b4" fontSize="11">W: 1600  L: −600</text>
    </svg>
  </button>;
}

function windowLevel(value: number, windowWidth: number, windowCenter: number): number {
  return Math.max(0, Math.min(255, ((value - (windowCenter - windowWidth / 2)) / windowWidth) * 255));
}

async function readBinaryArtifact(path: string): Promise<{ values: Float32Array; shape: number[] }> {
  const bytes = await readFile(path);
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 6)) !== "VWBF\x01\x00") throw new Error("Unsupported VoxelWeave binary artifact");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 6, 4).getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(10, 10 + headerLength))) as { shape: number[]; dtype: string };
  const payload = bytes.slice(10 + headerLength);
  if (!header.shape?.length || !header.dtype?.includes("f4")) throw new Error("Artifact is not a float HU plane");
  return { values: new Float32Array(payload.buffer, payload.byteOffset, Math.floor(payload.byteLength / 4)), shape: header.shape };
}

export function InteractiveMprPane({ plane, result, selected = false, index, windowWidth = 1600, windowCenter = -600, onSelect, onCrosshair, testAdapter = false }: { plane: Orientation; result?: MprPlaneResult; selected?: boolean; index: number; windowWidth?: number; windowCenter?: number; onSelect?: () => void; onCrosshair?: (x: number, y: number) => void; testAdapter?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof window !== "undefined" && window.location.hostname === "localhost") return;
    const draw = async () => {
      let context: CanvasRenderingContext2D | null = null;
      try { context = canvas.getContext("2d"); } catch { return; }
      if (!context) return;
      const width = 512;
      const height = 320;
      canvas.width = width;
      canvas.height = height;
      let values: Float32Array | undefined;
      let shape = result?.shapeYx ?? [height, width];
      if (result?.artifactPath) {
        try {
          const artifact = await readBinaryArtifact(result.artifactPath);
          values = artifact.values;
          shape = [artifact.shape[0], artifact.shape[1]];
          if (!cancelled) setError(undefined);
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read MPR artifact");
        }
      }
      const image = context.createImageData(width, height);
      const sourceHeight = shape[0] || height;
      const sourceWidth = shape[1] || width;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sx = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
          const sy = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
          const sourceIndex = sy * sourceWidth + sx;
          const value = values ? values[sourceIndex] : -1000 + (((sx * 13 + sy * 7 + index * 17) % 1200));
          const gray = windowLevel(value, windowWidth, windowCenter);
          const offset = (y * width + x) * 4;
          image.data[offset] = gray;
          image.data[offset + 1] = gray;
          image.data[offset + 2] = gray;
          image.data[offset + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
      context.strokeStyle = orange;
      context.lineWidth = 1;
      context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2, height); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
      context.fillStyle = "#ecf0f1"; context.font = "600 14px system-ui"; context.fillText(plane[0].toUpperCase() + plane.slice(1), 12, 22);
      context.font = "12px system-ui"; context.fillText(`${index} · ${result?.coordinateMm?.toFixed(2) ?? "—"} mm`, 12, height - 12); context.textAlign = "right"; context.fillText(`W ${windowWidth} / L ${windowCenter}`, width - 12, height - 12); context.textAlign = "left";
    };
    void draw();
    return () => { cancelled = true; };
  }, [index, plane, result, windowCenter, windowWidth]);
  return <button type="button" className={`ct-pane interactive-mpr ${selected ? "selected" : ""}`} onClick={onSelect} onDoubleClick={() => onCrosshair?.(0.5, 0.5)} aria-label={testAdapter ? `${plane} synthetic CT slice` : `${plane} DICOM MPR pane`}>
    <canvas ref={canvasRef} role="img" aria-label={`${plane} MPR from ${result?.source ?? "sidecar"}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onCrosshair?.((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height); }} />
    <span className="mpr-orientation-labels" aria-hidden="true">L/R · A/P · S/I</span>
    {error && <span className="mpr-artifact-error">{error}</span>}
  </button>;
}

export function VolumePreview({ cropActive = true }: { cropActive?: boolean }) {
  return <div className="volume-preview" role="img" aria-label="Synthetic 3D volume preview with physical crop box">
    <svg viewBox="0 0 520 330" preserveAspectRatio="none">
      <rect width="520" height="330" fill="#101314" />
      <path d="M140 56 371 34l89 52-230 33-90-63Z" fill="#899092" opacity=".34" />
      <path d="m140 56 90 63v166l-90-62V56ZM230 119l230-33v166l-230 33V119Z" fill="#4f585a" stroke="#afb4b6" strokeWidth="1.2" opacity=".85" />
      <path d="M146 71 374 50l71 40-226 32-73-51ZM153 96l220-20 59 32-219 29-60-41ZM158 123l210-18 55 29-205 26-60-37ZM166 151l198-16 51 27-194 24-55-35" fill="none" stroke="#c4c7c8" strokeWidth="1" opacity=".32" />
      <path d="M228 119v166M284 111v166M343 102v164M401 95v163" stroke="#9fa3a5" opacity=".3" />
      {cropActive && <><path d="M108 62 362 36l103 57-258 34-99-65ZM114 234l99 65 258-35-103-57-254 27Z" fill="none" stroke={orange} strokeWidth="1.5" strokeDasharray="6 5" /><g fill={orange}>{[[108,62],[362,36],[465,93],[210,127],[114,234],[213,299],[471,264],[217,242]].map(([x, y], i) => <rect key={i} x={x - 4} y={y - 4} width="8" height="8" rx="1" />)}</g><path d="M111 176h356" stroke={orange} strokeWidth="1.1" opacity=".8" /></>}
      <g transform="translate(28 254)"><path d="m0 28 28-16 28 16-28 16L0 28Z" fill="none" stroke="#e2e4e5"/><path d="M28 12v32M0 28v34M56 28v34" stroke="#e2e4e5"/><text x="28" y="8" textAnchor="middle" fill="#d7e4f0" fontSize="11">S</text><text x="-4" y="30" fill="#d7e4f0" fontSize="11">R</text><text x="58" y="30" fill="#d7e4f0" fontSize="11">A</text></g>
      <text x="490" y="26" textAnchor="end" fill="#d1d5d6" fontSize="12">Refined preview · 256³</text>
      <text x="490" y="312" textAnchor="end" fill="#9ca1a3" fontSize="12">Crop in patient coordinates</text>
    </svg>
  </div>;
}

export function InteractiveVolumePreview({ result, onReset }: { result?: VolumePreviewResult; onReset?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [angle, setAngle] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (typeof window !== "undefined" && window.location.hostname === "localhost") return;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas?.getContext("2d") ?? null; } catch { return; }
    if (!canvas || !context) return;
    canvas.width = 520; canvas.height = 330;
    context.fillStyle = "#101314"; context.fillRect(0, 0, canvas.width, canvas.height);
    const cx = 260 + Math.sin(angle) * 20;
    const cy = 168;
    const sx = 160 + Math.cos(angle) * 12;
    context.strokeStyle = "#8db4b5"; context.lineWidth = 2; context.globalAlpha = 0.8;
    context.beginPath(); context.ellipse(cx, cy, sx, 100, angle, 0, Math.PI * 2); context.stroke();
    context.strokeStyle = orange; context.setLineDash([6, 5]); context.strokeRect(92, 62, 336, 208); context.setLineDash([]);
    context.fillStyle = "#d1d5d6"; context.font = "12px system-ui"; context.fillText(`3D volume · ${result?.resolution ?? "waiting for sidecar"}`, 14, 24); context.fillText(result?.artifactPath ? "Refined preview artifact · preview only" : "Controlled test preview · preview only", 14, 312);
  }, [angle, result]);
  return <div className="volume-preview interactive-volume" role="img" aria-label={`Interactive ${result?.artifactPath ? "DICOM" : "controlled test"} 3D volume preview`} onWheel={(event) => { event.preventDefault(); setAngle((value) => value + event.deltaY * 0.01); }} onDoubleClick={() => { setAngle(0); onReset?.(); }}><canvas ref={canvasRef} /><button type="button" className="volume-reset" aria-label="Reset volume view" onClick={() => setAngle(0)}><Icon name="fit" size={14} /></button></div>;
}

export function DesignViewport({ selectedId, onSelect, scene = [] }: { selectedId: string; onSelect: (id: string) => void; scene?: SceneObject[] }) {
  const visible = scene.filter((object) => object.visible);
  const extent = Math.max(1, ...visible.map((object) => {
    const dimensions = object.dimensionsMm ?? object.transform.scale;
    return Math.max(Math.abs(dimensions.x), Math.abs(dimensions.y), Math.abs(object.transform.position.x), Math.abs(object.transform.position.y));
  }));
  const unit = Math.min(1.6, 285 / extent);
  const project = (value: number, axis: "x" | "y") => axis === "x" ? 370 + value * unit : 258 - value * unit;
  const drawPrimitive = (object: SceneObject) => {
    const dimensions = object.dimensionsMm ?? object.transform.scale;
    const width = Math.max(8, Math.abs(dimensions.x) * unit);
    const height = Math.max(8, Math.abs(dimensions.y) * unit);
    const cx = project(object.transform.position.x, "x");
    const cy = project(object.transform.position.y, "y");
    const x = cx - width / 2;
    const y = cy - height / 2;
    const fill = object.tool === "T1" ? "#3f4f53" : object.kind === "dicom" ? "#1f3a3c" : "#303a3d";
    const stroke = object.id === selectedId ? orange : object.kind === "dicom" ? "#58a9a7" : "#aeb6b8";
    const transform = `rotate(${object.transform.rotation.z} ${cx} ${cy})`;
    const common = { onClick: () => onSelect(object.id), style: { cursor: "pointer" as const }, opacity: object.kind === "group" ? 0.55 : 0.88 };
    if (object.kind === "cylinder") return <g key={object.id} transform={transform} {...common}><ellipse cx={cx} cy={cy} rx={width / 2} ry={height / 2} fill={fill} stroke={stroke} strokeWidth={object.id === selectedId ? 2.4 : 1.2} /><path d={`M${x + width / 2} ${y}v${height}`} stroke={stroke} strokeWidth="1" opacity=".6" /><text x={cx} y={cy + 4} textAnchor="middle" fill="#dce1e2" fontSize="11">{object.name}</text></g>;
    if (object.kind === "wedge") return <g key={object.id} transform={transform} {...common}><path d={`M${x} ${y + height}L${x} ${y + height * 0.2}L${x + width} ${y}L${x + width} ${y + height}Z`} fill={fill} stroke={stroke} strokeWidth={object.id === selectedId ? 2.4 : 1.2} /><text x={cx} y={cy + 4} textAnchor="middle" fill="#dce1e2" fontSize="11">{object.name}</text></g>;
    if (object.kind === "polygon-prism") {
      const sides = Math.max(3, object.polygonSides ?? 6);
      const points = Array.from({ length: sides }, (_, index) => { const angle = -Math.PI / 2 + index * (Math.PI * 2 / sides); return `${cx + Math.cos(angle) * width / 2},${cy + Math.sin(angle) * height / 2}`; }).join(" ");
      return <g key={object.id} transform={transform} {...common}><polygon points={points} fill={fill} stroke={stroke} strokeWidth={object.id === selectedId ? 2.4 : 1.2} /><text x={cx} y={cy + 4} textAnchor="middle" fill="#dce1e2" fontSize="11">{object.name}</text></g>;
    }
    return <g key={object.id} transform={transform} {...common}><rect x={x} y={y} width={width} height={height} rx={object.kind === "group" ? 10 : 2} fill={fill} stroke={stroke} strokeWidth={object.id === selectedId ? 2.4 : 1.2} strokeDasharray={object.kind === "group" ? "5 3" : undefined} /><text x={cx} y={cy + 4} textAnchor="middle" fill="#dce1e2" fontSize="11">{object.name}</text></g>;
  };
  return <div className="design-viewport" role="img" aria-label="Interactive parametric design scene preview" data-testid="design-scene-viewport">
    <svg viewBox="0 0 740 510" preserveAspectRatio="none">
      <defs><pattern id="design-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#4c5255" strokeWidth=".6" /></pattern></defs>
      <rect width="740" height="510" fill="#141719" /><rect x="28" y="25" width="684" height="450" rx="4" fill="url(#design-grid)" opacity=".52" />
      {visible.length ? visible.map(drawPrimitive) : <text x="370" y="250" textAnchor="middle" fill="#aeb5b7" fontSize="14">Add a primitive or import a validated solid</text>}
      <g fill="#dfe3e5" fontSize="12"><text x="42" y="50">Scene preview · physical coordinates</text><text x="50" y="493">X {visible.length ? "mapped" : "0.0"} mm</text><text x="352" y="493">Y {visible.length ? "mapped" : "0.0"} mm</text><text x="650" y="493">Z {visible.length ? "mapped" : "0.0"} mm</text></g>
      <g transform="translate(28 58)"><circle cx="0" cy="0" r="15" fill="#202426" stroke="#72787b"/><path d="M0-9v18M-9 0h18" stroke="#d2d5d6"/><circle cx="0" cy="0" r="3" fill={orange}/></g>
    </svg>
  </div>;
}

export function ToolpathCanvas({ selectedLayer, activeTool = "T0", generated = true, totalLayers }: { selectedLayer: number; activeTool?: ToolId; generated?: boolean; totalLayers?: number }) {
  const lanes = Array.from({ length: 16 }, (_, row) => {
    const y = 110 + row * 19;
    const points = Array.from({ length: 12 }, (_, col) => `${115 + col * 43},${y + Math.sin(col * 1.7 + row) * 4}`).join(" ");
    return <polyline key={row} points={points} fill="none" stroke={row % 3 === 0 ? teal : "#bfc4c6"} strokeWidth={row % 3 === 0 ? 3 : 2} strokeLinecap="round" opacity={row % 5 === 0 ? .94 : .73} />;
  });
  const vertical = Array.from({ length: 13 }, (_, col) => {
    const x = 115 + col * 43;
    return <polyline key={col} points={Array.from({ length: 11 }, (_, row) => `${x + Math.cos(row * 1.4 + col) * 3},${105 + row * 24}`).join(" ")} fill="none" stroke={col === 6 ? orange : "#a8afb1"} strokeWidth={col === 6 ? 3 : 1.4} opacity={col === 6 ? 1 : .48} />;
  });
  return <div className="toolpath-canvas" role="img" aria-label={`Generated segment preview for layer ${selectedLayer}`}>
    <svg viewBox="0 0 760 560" preserveAspectRatio="none">
      <defs><pattern id="toolpath-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#394043" strokeWidth=".7" /></pattern></defs>
      <rect width="760" height="560" fill="#101314" /><path d="M70 62 673 42l44 408-620 42L70 62Z" fill="url(#toolpath-grid)" stroke="#5e686b" strokeWidth="1.4" />
      <path d="M108 100 655 83l31 330-563 35-15-348Z" fill="#15191a" stroke="#e0e4e4" strokeWidth="1.2" strokeDasharray="7 5" />
      <path d="M126 112 638 97l26 300-528 31-10-316Z" fill="none" stroke="#8b989b" strokeWidth="1" opacity=".42" />
      <g>{lanes}{vertical}</g>
      <path d="M121 356 C230 344 288 373 351 327 S466 278 617 288" fill="none" stroke={orange} strokeWidth="6" strokeLinecap="round" />
      <g transform="translate(24 22)"><path d="m0 25 23-13 23 13-23 13L0 25Z" fill="#f4f4f2" stroke="#9da3a5"/><path d="M23 12v26M0 25v28M46 25v28" stroke="#899093"/><text x="23" y="9" textAnchor="middle" fill="#2a4b8d" fontSize="11">Z</text><text x="-2" y="29" fill="#418053" fontSize="11">Y</text><text x="48" y="29" fill="#b94c23" fontSize="11">X</text></g>
      <text x="690" y="32" textAnchor="end" fill="#d8dddf" fontSize="13">Layer {selectedLayer}{totalLayers ? ` / ${totalLayers}` : ""} · {activeTool} selected</text>
      <g fill="#a9b0b3" fontSize="12"><text x="102" y="506">ORIGINAL PRUSA XL · local sidecar bed coordinates</text><text x="650" y="530" textAnchor="end">{generated ? "Generated-segment stream · source-bound" : "Preview canvas · awaiting sidecar generation"}</text></g>
      <g transform="translate(670 475)"><path d="M0 30V0M0 30h28M0 30l-18 14" stroke="#5583c2" strokeWidth="2"/><text x="2" y="-5" fill="#5583c2" fontSize="11">Z</text><text x="31" y="34" fill="#b94c23" fontSize="11">X</text><text x="-28" y="48" fill="#4d987a" fontSize="11">Y</text></g>
    </svg>
  </div>;
}

export function CalibrationPlot({ tool = "T0", samples }: { tool?: ToolId; samples?: Array<{ widthMm: number; measuredHu: number }> }) {
  const points = samples?.length ? samples.map((sample) => [64 + Math.max(0, Math.min(1, (sample.widthMm - 0.4) / 0.8)) * 234, 186 - Math.max(0, Math.min(1, (sample.measuredHu + 900) / 900)) * 168] as [number, number]) : tool === "T0" ? [[64, 178], [142, 158], [223, 128], [298, 101]] : [[64, 191], [142, 163], [223, 131], [298, 104]];
  return <div className="calibration-plot" role="img" aria-label={`${tool} calibration width to HU plot`}>
    <svg viewBox="0 0 350 220" preserveAspectRatio="none"><path d="M44 18v168h280M44 55h280M44 97h280M44 139h280" fill="none" stroke="#dce0e0" strokeWidth="1"/><path d="M44 18v168h280" fill="none" stroke="#9ba2a4" strokeWidth="1.2"/><polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={teal} strokeWidth="2.5" />{points.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="5" fill="#fff" stroke={teal} strokeWidth="2" />)}<text x="48" y="16" fill="#596266" fontSize="11">HU</text><text x="278" y="207" fill="#596266" fontSize="11">commanded width · mm</text><text x="12" y="190" fill="#596266" fontSize="10">−900</text><text x="16" y="99" fill="#596266" fontSize="10">−450</text><text x="23" y="22" fill="#596266" fontSize="10">0</text><text x="49" y="206" fill="#596266" fontSize="10">0.4</text><text x="153" y="206" fill="#596266" fontSize="10">0.7</text><text x="258" y="206" fill="#596266" fontSize="10">1.0</text></svg>
  </div>;
}

export function ComparisonViewport({ mode }: { mode: "overlay" | "difference" | "profile" }) {
  return <div className={`comparison-viewport mode-${mode}`} role="img" aria-label={`Registered scan-back ${mode} comparison`}>
    <svg viewBox="0 0 560 300" preserveAspectRatio="none"><rect width="560" height="300" fill="#121617"/><path d="M80 186C70 127 119 72 185 78c38 4 64 29 76 63 12-36 39-60 77-63 65-5 113 49 103 108-9 51-57 76-104 64-38-10-63-31-76-67-13 36-38 57-76 67-47 12-95-13-105-64Z" fill={mode === "difference" ? "#544b2c" : "#4a5356"} stroke="#bec4c5" strokeWidth="2"/><path d="M146 104c29-26 62-19 77 17 13 30 10 68-19 86-31 19-64 7-78-28-12-29-8-56 20-75ZM414 104c-29-26-62-19-77 17-13 30-10 68 19 86 31 19 64 7 78-28 12-29 8-56-20-75Z" fill="#171a1b" stroke="#a4abad" strokeWidth="1.5"/>{mode === "overlay" && <path d="M278 76c-23 58-24 121 1 178" stroke={orange} strokeWidth="3" opacity=".9"/>}{mode === "difference" && <path d="M92 173c110-42 270-42 376 0" stroke="#d19c21" strokeWidth="9" opacity=".35" fill="none"/>}{mode === "profile" && <path d="M54 221c52-25 82-12 119-36s67-3 102-30 62-4 97-27 64-14 108-36" stroke={teal} strokeWidth="3" fill="none"/>}<text x="14" y="24" fill="#e2e5e6" fontSize="13">Scan-back · {mode}</text><text x="14" y="282" fill="#a8afb1" fontSize="11">registered evidence · no diagnostic interpretation</text></svg>
  </div>;
}

export function OrientationCube({ plane }: { plane: Orientation }) {
  return <div className="orientation-cube" aria-label={`${plane} orientation cube`}><Icon name="cube" size={28} /><span>{plane[0].toUpperCase()}</span></div>;
}
